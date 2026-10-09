/**
 * 控制台脚本片段：秘书页外壳（岗位 `layout: 'secretary'`）—— 左立绘 / 右对话 / 顶部下拉看板
 *
 * 本段是**新增功能**，不是从旧单文件搬来的（其余片段都能与拆分前的单文件逐字节对上）。
 *
 * 为什么单独一个文件：它只服务一个岗位的外壳，与对话页本体（65-chat）分开 ——
 * 改秘书页不该碰对话页，反之亦然（拆文件就是为了这个）。
 *
 * 拼接顺序：排在 65-chat 之后、70-attach 之前；本段只定义函数与一个状态对象，
 * 顶层不执行任何副作用（真正生效靠 65-chat/60-sessions 里调用 applyPositionShell）。
 */
export const CHUNK_67_SECRETARY = String.raw`
/**
 * 秘书页外壳的逻辑（岗位 「layout: 'secretary'」）。
 *
 * 这一页只换**外壳**：左立绘、右对话（气泡区独立滚动 + galgame 对话框）、顶部下拉箭头
 * 拉出全屏「上次结论」看板。气泡、流式、附件、会话抽屉、断线提示、IME、主题、动效偏好
 * 全部复用 「65-chat.ts」 / 「70-attach.ts」 等既有实现 —— 一份真相，不复制第二份。
 * 设计稿：design/秘书页-设计稿.md。
 *
 * 三处刻意的设计（都不是随便定的）：
 *
 *   1. **看板是覆盖式的「上次结论」**：她每次产出结论就覆盖写一份
 *      「memory/ref/结论.md」，箭头拉下来永远是最近那一份；她从没写过就是空白（如实说明）。
 *      不做"今日/近期"两栏 —— 那需要她维护结构化待办，是另一件事。
 *   2. **时间戳写进文件首行**，不靠文件 mtime：「employee.files.list/get」 只回
 *      「{path, type, size}」，拿不到 mtime。拿不到就判断不了"这份结论有多旧"，
 *      而"看起来没问题的旧数据"正是本项目最防的一类失败。
 *   3. **箭头自己喊**：有新结论没看过时带一个红点（比对 localStorage 里上次看的时间），
 *      否则它会变成一个没人点的按钮。
 *
 * 立绘现在是**占位剪影**（本地画的 SVG）：真素材是"部件式帧图 + SVG 叠加"（设计稿 §6），
 * 到位后只换 「renderStageArt()」 与下面的状态机，外壳与 CSS 不动。
 */

/** SVG 命名空间（本段自己声明，不跨段依赖别的片段里的同名常量） */
var STAGE_NS = 'http://www.w3.org/2000/svg'
/** 页面外壳 id：岗位目录里 「layout」 写的就是它 */
var SECRETARY_LAYOUT = 'secretary'
/** 结论文件：她维护、覆盖式写入、首行带时间戳注释 */
var CONCLUSION_PATH = 'memory/ref/结论.md'
/** 结论首行的时间戳注释：「<!-- 更新于 2026-09-23 19:05 -->」 */
var CONCLUSION_STAMP_RE = /<!--\s*更新于\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/
/** 超过这么多天没更新 → 看板上挂黄字（她忘了写时不许看起来一切正常） */
var CONCLUSION_STALE_DAYS = 7

/** 秘书页的运行期状态（不进 state：它只属于这一页） */
var secretaryState = {
  employeeId: '',
  /** 结论正文（markdown 原文，已剥掉首行时间戳） */
  text: null,
  /** '2026-09-23 19:05'；'' = 文件里没写时间戳（要如实报出来） */
  stamp: '',
  /** 读文件失败的原因；'' = 没失败 */
  error: '',
  /** 文件不存在（与"读到空内容"是两件事） */
  missing: false,
  /** 这一页读过结论没有：区分「还没读过」与「读过但是空的」——
      决定她干活干完时要不要播「抬头给你看」（见 stageTurn） */
  loaded: false,
  open: false,
}

/** 该员工的岗位声明的页面外壳（没绑岗位 / 目录里没有 → ''，即默认对话页） */
function positionLayoutOf(employee) {
  var entry = positionEntryOf(employee)
  if (entry === null) return ''
  return typeof entry.layout === 'string' ? entry.layout.trim() : ''
}

/**
 * 切换这一页的外壳。**每个入口都要调**（进对话页、岗位目录刷新后）——
 * 漏掉一处就会出现"岗位配了秘书页、但页面还是老样子"，而且不报错。
 */
function applyPositionShell(employee) {
  var chat = $('viewChat')
  if (chat === null) return
  var layout = positionLayoutOf(employee)
  var isSecretary = layout === SECRETARY_LAYOUT
  /* QUAD_LAYOUT 在后面的片段（68-quad）里 —— 函数声明会提升，但顶层 var 的赋值在它之后。
     这里用 typeof 兜一层：控制台是**整份脚本**跑的，兜底只在"单函数被抽出来测"时才生效。 */
  var isQuad = typeof QUAD_LAYOUT === 'string' && layout === QUAD_LAYOUT
  /* 四宫格的第二种排法（岗位 layout: 'quad-chat'）：对话占右半边全高。
     与 quad 共用格位、面板、皮肤、抽屉，**只差网格**（见 css.ts 的两块 grid 定义）。
     所以这里只多一个类名，其余一行都不用改。 */
  var isQuadChat = typeof QUAD_CHAT_LAYOUT === 'string' && layout === QUAD_CHAT_LAYOUT
  chat.classList.toggle('layout-secretary', isSecretary)
  chat.classList.toggle('layout-quad', isQuad || isQuadChat)
  chat.classList.toggle('layout-quad-chat', isQuadChat)
  if (typeof renderSessions === 'function') renderSessions()
  if (typeof loadSessionTree === 'function') loadSessionTree()
  setHidden($('secretaryStage'), !isSecretary)
  setHidden($('btnBoard'), !isSecretary)
  /* 另一个外壳的收尾：退出四宫格要把格位状态清干净（否则下次进来会闪旧数字），
     退出秘书页要停掉立绘的定时器（否则它在看不见的页面上继续换图）。
     两件事都必须做，且**都只在离开时做** —— 所以这里是两条独立的 if，不是 else。 */
  if (!isQuad && !isQuadChat && typeof leaveQuadShell === 'function') leaveQuadShell()
  if (!isSecretary) {
    setSecretaryKeyboardOpen(false)
    stopStageRevert()
    stopStageTransition()
    stopStandbyTimer()
    stageRenderToken += 1
    stageImgNode = null
    stageVisibleSrc = ''
    closeBoard()
    secretaryState = { employeeId: '', text: null, stamp: '', error: '', missing: false, loaded: false, open: false }
  }
  if ((isQuad || isQuadChat) && typeof applyQuadShell === 'function') {
    applyQuadShell(employee)
    return
  }
  if (!isSecretary) return
  setSecretaryKeyboardOpen(false)
  var secretaryName = String(employee === null ? '秘书' : employee.name || '秘书')
  var stageName = $('stageName')
  if (stageName !== null) stageName.textContent = secretaryName
  var boardAuthor = $('boardAuthor')
  if (boardAuthor !== null) boardAuthor.textContent = secretaryName
  var boardSignature = $('boardSignature')
  if (boardSignature !== null) boardSignature.textContent = secretaryName
  renderStageArt()
  /* 切回来时她可能还在干活（回合没结束就切走了）：那就别显示"空闲"，如实显示"正在处理" */
  setStageState(typeof turnRunning !== 'undefined' && turnRunning === true ? 'thinking' : 'idle')
  stageTouch()
  if (secretaryState.employeeId !== String(employee === null ? '' : employee.id)) {
    /* 换了员工：清掉上一份结论，标记为"正在载入"，然后去读她的文件 */
    secretaryState = { employeeId: String(employee === null ? '' : employee.id), text: null, stamp: '', error: '', missing: false, loaded: false, open: false }
    renderBoard()
    void loadConclusion(secretaryState.employeeId)
  } else {
    renderBoard()
  }
  updateBoardDot()
}

/** 小工具：按需切 hidden（「setHidden」 已在 00-core 里？没有 —— 这里就地实现，避免跨段依赖） */
function setHidden(node, hidden) {
  if (node === null) return
  node.classList.toggle('hidden', hidden === true)
}

/* ── 立绘（每状态一张 WebP；多帧由出图那边合成动图，客户端只换 src）── */

/**
 * 立绘表：每个状态一个文件 —— **含多帧时是一张动图 WebP**（帧间压缩，浏览器自己播）。
 *
 * 为什么不做"JS 逐帧播放"：
 *   · 一组 6 帧 PNG 各拉一次请求，动图 WebP 只拉一次，字节差好几倍（帧间压缩）；
 *   · JS 定时器切 src 会闪（解码来不及），要双缓冲才不闪 —— 而这些浏览器原生就做好了；
 *   · 少一个定时器就少一类 bug（切页/切员工时忘了停，两个定时器一起改 src）。
 * 一次性动作（如"有新东西"抬头）用 「holdMs」：到点自动回到 idle，不需要帧里写"回到第一帧"。
 *
 * 「still」 是给 「prefers-reduced-motion」 用的静态图（关掉动效的人不该看到一直在动的人物）；
 * 缺 still 就退回动图 —— 有动效总比空白好，但会在下面写一行说明。
 *
 * 素材缺失 → 降级成占位剪影 + 写明缺哪个文件。**绝不留破图。**
 */
var STAGE_ANIM = {
  idle: { file: 'stage-idle.webp', still: 'stage-idle-still.webp', holdMs: 0 },
  /* 她在工作 / 在输出 —— 都是"敲笔记本"这一个动作。
     为什么不做"说话的嘴"：产品里没有语音，嘴在动而文字在另一边滚会很怪（用户原话）。
     改成"她在打字"更贴：打字机在吐字，她在敲键盘，两边是同一件事。 */
  thinking: { file: 'stage-typing.webp', still: 'stage-typing-still.webp', holdMs: 0 },
  speaking: { file: 'stage-typing.webp', still: 'stage-typing-still.webp', holdMs: 0 },
  /* 一次性动作：播完自动回 idle（holdMs 是"停留多久"，不是帧时长） */
  notify: { file: 'stage-notify.webp', still: 'stage-notify-still.webp', holdMs: 1400, then: 'idle' },
  /* 待命（趴着看你）：你点输入框、或她闲着没事时趴下来 —— **不自动回 idle**，
     因为"趴着待命"是一个可以一直保持的姿态（回常态的时机是她开始干活）。
     所以 holdMs 是 0：0 在这里的含义是"没有回退"，不是"立刻回退"。 */
  standby: { file: 'stage-standby.webp', still: 'stage-standby-still.webp', holdMs: 0 }
}

/** 素材地址：带界面指纹 —— 服务器对 /assets/ 是长缓存（immutable），靠查询串换版本。 */
function stageAssetUrl(file) {
  return '/assets/secretary/' + file + '?v=' + UI_VERSION
}

/** 当前状态与它的回退定时器（切状态/离开页面都要清掉，否则两套动作打架） */
var stageFrame = ''
var stageRevertTimer = null
/** 立绘切换用的令牌：旧图片晚到的 onload/onerror 不能覆盖新状态。 */
var stageRenderToken = 0
/** 当前正在显示的图片节点；切换时用它留下一个 CSS 背景做交叉淡化。 */
var stageImgNode = null
/** 最近一次真正加载完成的图片地址；没有它就不做假背景。 */
var stageVisibleSrc = ''
var stageTransitionTimer = null
var STAGE_TRANSITION_MS = 220

/** 关了动效的人在系统里是明确的偏好，这里照做（拿不到 API 时按"没关"处理） */
function stagePrefersStill() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches === true
  } catch (error) {
    return false
  }
}

function stopStageTransition() {
  if (stageTransitionTimer !== null) {
    clearTimeout(stageTransitionTimer)
    stageTransitionTimer = null
  }
}

/** 把立绘换成某个状态；素材缺失时退回占位剪影。
 *
 * 这里故意不再「clear → 立刻插入新 img」：原来的写法在状态切换时会出现一帧白画布，
 * 尤其是 notify/typing 这种动图第一次解码较慢时，用户会看到人物闪掉。现在保留最近一帧
 * 作为 stage-art 的 CSS 背景，新的帧图加载完成后再淡入；同时用令牌挡住过期的回调。
 */
function renderStageArt(state) {
  var box = $('stageArt')
  if (box === null) return
  var wanted = state === undefined || state === null ? 'idle' : String(state)
  var spec = STAGE_ANIM[wanted] === undefined ? STAGE_ANIM.idle : STAGE_ANIM[wanted]
  if (STAGE_ANIM[wanted] === undefined) wanted = 'idle'
  stageFrame = wanted
  var file = stagePrefersStill() ? spec.still : spec.file
  var src = stageAssetUrl(file)
  var current = stageImgNode
  if (current !== null && stageVisibleSrc === src && stageFrame === wanted) {
    box.setAttribute('data-stage', wanted)
    return
  }

  var token = stageRenderToken + 1
  stageRenderToken = token
  stopStageTransition()
  var oldSrc = stageVisibleSrc
  var hasPrevious = current !== null && oldSrc !== ''
  box.setAttribute('data-stage', wanted)
  if (hasPrevious) {
    box.style.backgroundImage = 'url("' + oldSrc.replace(/"/g, '\\"') + '")'
    box.classList.add('is-switching')
  } else {
    box.style.backgroundImage = ''
    box.classList.remove('is-switching')
  }

  clear(box)
  var img = el('img', hasPrevious ? 'stage-img stage-img-enter' : 'stage-img stage-img-ready')
  img.setAttribute('alt', '')
  img.setAttribute('draggable', 'false')
  img.setAttribute('decoding', 'async')
  img.setAttribute('data-stage-file', file)
  img.onerror = function () {
    if (token !== stageRenderToken || stageImgNode !== img) return
    stageImgNode = null
    stageVisibleSrc = ''
    box.style.backgroundImage = ''
    box.classList.remove('is-switching')
    /* 某个状态的图还没出（比如"敲笔记本"那张）：**退回 idle**，而不是把人物换成剪影 ——
       "她在处理"时人忽然变成一个灰轮廓，比不动更糟。idle 自己也缺时才用占位剪影。 */
    if (wanted !== 'idle') {
      renderStageArt('idle')
      var note = $('stageArt')
      if (note !== null) note.appendChild(el('div', 'stage-note', '（' + wanted + ' 的立绘还没出，暂用常态）'))
      return
    }
    clear(box)
    box.appendChild(placeholderArt())
    box.appendChild(el('div', 'stage-note', '立绘素材未接入（缺 ' + file + '）—— 见 assets/secretary/README.md'))
  }
  img.onload = function () {
    if (token !== stageRenderToken || stageImgNode !== img) return
    stageVisibleSrc = src
    img.classList.remove('stage-img-enter')
    img.classList.add('stage-img-ready')
    if (!hasPrevious) return
    var wait = stagePrefersStill() ? 0 : STAGE_TRANSITION_MS
    stageTransitionTimer = setTimeout(function () {
      if (token !== stageRenderToken || stageImgNode !== img) return
      stageTransitionTimer = null
      box.style.backgroundImage = ''
      box.classList.remove('is-switching')
    }, wait)
  }
  stageImgNode = img
  img.setAttribute('src', src)
  box.appendChild(img)
}

/**
 * 占位剪影：一眼看出"这里将来是立绘"，而不是让人以为页面坏了。
 * 画法与工位头像同源（手绘线稿 + 主题色），所以风格不会打架。
 */
function placeholderArt() {
  var box = el('div', 'stage-placeholder')
  var svg = document.createElementNS(STAGE_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 200 300')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', '立绘占位（素材待接入）')
  var parts = [
    { tag: 'circle', attrs: { cx: '100', cy: '78', r: '34' } },
    { tag: 'path', attrs: { d: 'M52 300 C52 208 74 168 100 168 C126 168 148 208 148 300 Z' } },
    { tag: 'path', attrs: { d: 'M86 172 L100 196 L114 172' } },
  ]
  parts.forEach(function (part) {
    var node = document.createElementNS(STAGE_NS, part.tag)
    Object.keys(part.attrs).forEach(function (key) {
      node.setAttribute(key, part.attrs[key])
    })
    node.setAttribute('fill', 'none')
    node.setAttribute('stroke', 'var(--muted)')
    node.setAttribute('stroke-width', '2')
    node.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(node)
  })
  box.appendChild(svg)
  return box
}

/** 停掉"一次性动作→回 idle"的定时器（切页、切员工、切状态都要调） */
function stopStageRevert() {
  if (stageRevertTimer !== null) {
    clearTimeout(stageRevertTimer)
    stageRevertTimer = null
  }
}

/**
 * 状态机：idle / thinking / speaking / notify / standby。
 * 干两件事 —— 换立绘、写状态文字；一次性动作到点自己回 idle。
 *
 * 谁调它（都在下面的「立绘与真实的联动」一节里，本段不自己去听事件）：
 * 你按了发送（thinking）、她开始吐字（speaking）、她写完新结论（notify）、
 * 你点了输入框或她闲下来了（standby）。P4（打字机）接进来后 speaking 会跟着吐字节奏走。
 */
function setStageState(next) {
  var wanted = typeof next === 'string' && next !== '' ? next : 'idle'
  if (STAGE_ANIM[wanted] === undefined) wanted = 'idle'
  stopStageRevert()
  var node = $('stageState')
  if (node !== null) {
    var labels = { idle: '空闲', thinking: '正在处理', speaking: '说话中', notify: '有东西给你', standby: '待命' }
    node.textContent = labels[wanted]
  }
  renderStageArt(wanted)
  var spec = STAGE_ANIM[wanted]
  if (spec.holdMs > 0) {
    stageRevertTimer = setTimeout(function () {
      stageRevertTimer = null
      setStageState(spec.then === undefined ? 'idle' : spec.then)
    }, spec.holdMs)
  }
}

/* ── 立绘与真实的联动（"她什么时候动"全部收在这一节）──
 *
 * 三条纪律，都是踩过或想过才写的：
 *
 *   1. **只在她这一页上动**：切到办公区/别的岗位时「stageOnScreen()」为假，一律不换图 ——
 *      否则后台会去拉一张几百 KB 的动图，而屏幕上看不见；而且回来时状态早就错了。
 *   2. **只认真实事件**：翻旧会话（历史回放）绝不碰立绘 —— 不然你翻开昨天那段对话，
 *      她会永远停在那里敲键盘。所以调用点必须由 65-chat 在**实时分支**里喊。
 *   3. **一次性动作不许被掐断**：回合结束时如果 notify 正在播，就让它播完
 *      （它自己 holdMs 到点回 idle），别用一句 idle 把它顶掉。
 *
 * 谁会在运行时调这些函数：「65-chat.ts」 的 setRunning（回合起止）与 renderNormalized（开始吐字）。
 * 拼接顺序上 65 在 67 之前，但函数声明会提升，且调用都发生在事件回调里（脚本早已跑完）。
 */

/** 闲多久算"她没事干" → 趴下来待命。太短会在你读字的时候忽然趴下，太长又像卡住了 */
var STAGE_STANDBY_MS = 30000
/** "闲着就趴下"的计时器（任何交互都会把它重置） */
var stageStandbyTimer = null

/** 秘书页是不是正在眼前（切到别的视图、别的岗位都是 false，拿不到 state 时按"是"处理不了，故为假） */
function stageOnScreen() {
  var chat = $('viewChat')
  if (chat === null || !chat.classList.contains('layout-secretary')) return false
  if (typeof state !== 'object' || state === null) return false
  return state.view === 'chat'
}

/** 停掉"闲着就趴下"的计时（切页、切员工、开始干活都要停） */
function stopStandbyTimer() {
  if (stageStandbyTimer !== null) {
    clearTimeout(stageStandbyTimer)
    stageStandbyTimer = null
  }
}

/**
 * 你在这一页有任何动作 → 计时重来。
 * 只有**此刻是 idle** 才排"趴下"：她正敲着键盘、或一次性动作正在播时不该被趴下打断。
 */
function stageTouch() {
  stopStandbyTimer()
  if (!stageOnScreen()) return
  if (stageFrame !== 'idle') return
  stageStandbyTimer = setTimeout(function () {
    stageStandbyTimer = null
    if (stageOnScreen() && stageFrame === 'idle') setStageState('standby')
  }, STAGE_STANDBY_MS)
}

/** 你点了输入框：她趴下来待命（一直保持，直到她开始干活） */
function stageStandby() {
  stopStandbyTimer()
  if (!stageOnScreen()) return
  if (stageFrame === 'idle') setStageState('standby')
}

/** 她开始吐字：把状态文字从"正在处理"换成"说话中"（立绘是同一张"敲笔记本"） */
function stageSpeaking() {
  if (!stageOnScreen()) return
  if (stageFrame === 'thinking') setStageState('speaking')
}

/**
 * 回合起止（你发了指令 / 她干完了）。调用点：65-chat 的 setRunning，只在真实翻转时喊。
 *
 * 干完这一半是关键：**先看她有没有写新结论** —— 写了就播一次「抬头给你看」，
 * 没写就回常态。所以顺序是"先回 idle 再读文件"，读回来发现变了才盖成 notify；
 * 反过来写会被那句 idle 顶掉（或者更糟：把已经在播的 notify 掐掉）。
 */
function stageTurn(running) {
  stopStandbyTimer()
  if (!stageOnScreen()) return
  if (running === true) {
    setStageState('thinking')
    return
  }
  if (stageFrame !== 'notify') setStageState('idle')
  /* 干完这一轮之后重新开始"闲着就趴下"的计时 —— 否则发过一条消息以后，
     计时器在回合开始时就停了、再也没人排新的（实测就是这么漏的）。 */
  stageTouch()
  var employeeId = secretaryState.employeeId
  if (employeeId === '') return
  var snapshot = secretaryState
  /* 「读过没有」在重读之前取：这一页的第一次读不算"她刚写了新结论"（否则一进来就抬头） */
  var wasLoaded = secretaryState.loaded === true
  var before = secretaryState.stamp + '\u0000' + String(secretaryState.text === null ? '' : secretaryState.text)
  void loadConclusion(employeeId).then(function () {
    if (wasLoaded !== true) return
    if (secretaryState !== snapshot || secretaryState.employeeId !== employeeId) return
    var after = secretaryState.stamp + '\u0000' + String(secretaryState.text === null ? '' : secretaryState.text)
    if (after === before) return
    if (secretaryState.text === null || String(secretaryState.text).trim() === '') return
    setStageState('notify')
  })
}

/* ── 上看板：读她的结论 ── */

function loadConclusion(employeeId) {
  if (employeeId === '') return Promise.resolve()
  var snapshot = secretaryState
  var revision = snapshot.readRevision = (snapshot.readRevision || 0) + 1
  function stillReading() {
    return secretaryState === snapshot && snapshot.employeeId === employeeId && snapshot.readRevision === revision
  }
  return rpc('employee.files.get', { employeeId: employeeId, path: CONCLUSION_PATH }).then(
    function (payload) {
      if (!stillReading()) return
      var content = payload !== null && typeof payload === 'object' ? String(payload.content === undefined ? '' : payload.content) : ''
      var parsed = parseConclusion(content)
      secretaryState.text = parsed.text
      secretaryState.stamp = parsed.stamp
      secretaryState.missing = false
      secretaryState.error = ''
      secretaryState.loaded = true
      renderBoard()
      updateBoardDot()
    },
    function (error) {
      if (!stillReading()) return
      /* 文件不存在 ≠ 读失败：前者是"她还没写过"（正常空态），后者是"读不到"（要说原因）。
         **不能只看 error.code**：实测（生产、Windows 节点）文件不存在时回来的 code 是别的值，
         ENOENT 只出现在 message 里 —— 于是"她还没写过"被显示成一长串 ENOENT 报错。
         所以 code 与 message 都要认；两个都不像"文件不存在"才当失败。 */
      var code = error !== null && typeof error === 'object' ? String(error.code || '') : ''
      var message = error !== null && typeof error === 'object' ? String(error.message || '') : String(error === null ? '' : error)
      var looksMissing = /ENOENT|no such file|not exist|cannot find|not-found/i.test(code + ' ' + message)
      var missing = code === 'not-found' || code === 'enoent' || code === 'ENOENT' || looksMissing
      secretaryState.missing = missing
      secretaryState.error = missing ? '' : describeError(error)
      secretaryState.text = missing ? null : secretaryState.text
      /* 读失败也是"读过了"：否则她干完活重读一次仍失败时，会把这份坏状态当成"她刚写了新结论" */
      secretaryState.loaded = true
      renderBoard()
      updateBoardDot()
    },
  )
}

/**
 * 解析结论文件：首行的 「<!-- 更新于 … -->」 是时间戳，正文是 markdown。
 * 时间戳缺失**不修不猜**：照常显示正文，但在看板元信息里写明"文件里没有更新时间"。
 */
function parseConclusion(raw) {
  var text = raw === undefined || raw === null ? '' : String(raw)
  var stamp = ''
  var body = text
  var match = CONCLUSION_STAMP_RE.exec(text.slice(0, 200))
  if (match !== null) {
    stamp = String(match[1]) + ' ' + String(match[2])
    /* 连同那一整行一起去掉（含行尾换行），避免看板上多一行给机器看的注释 */
    var lineEnd = text.indexOf('\n')
    body = lineEnd < 0 ? '' : text.slice(lineEnd + 1)
  }
  return { stamp: stamp, text: body.replace(/^\s+/, '') }
}

/** 结论有多旧（天）。没有时间戳或解析不了 → null（调用方要如实说明） */
function conclusionAgeDays() {
  if (secretaryState.stamp === '') return null
  var match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(secretaryState.stamp)
  if (match === null) return null
  var then = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
  if (isNaN(then.getTime())) return null
  var days = Math.floor((Date.now() - then.getTime()) / 86400000)
  return days < 0 ? 0 : days
}

/* ── 看板的渲染与开关 ── */

function renderBoard() {
  var body = $('boardBody')
  var meta = $('boardMeta')
  if (body === null || meta === null) return
  clear(body)
  meta.className = 'board-meta'
  var age = conclusionAgeDays()

  if (secretaryState.error !== '') {
    meta.textContent = ''
    body.appendChild(el('div', 'board-empty bad', '读不到她的结论：' + secretaryState.error))
    return
  }
  if (secretaryState.text === null) {
    meta.textContent = ''
    if (secretaryState.missing) {
      body.appendChild(el('div', 'board-empty', '她还没写过结论。'))
      body.appendChild(el('div', 'board-hint', '等她产出一次结论（例如「帮我总结一下这周」），她会覆盖写进 ' + CONCLUSION_PATH + '，这个箭头里就会是最近那一份。'))
    } else {
      body.appendChild(el('div', 'board-empty', '（正在载入…）'))
    }
    return
  }
  if (secretaryState.text.trim() === '') {
    meta.textContent = secretaryState.stamp === '' ? '' : '更新于 ' + secretaryState.stamp
    body.appendChild(el('div', 'board-empty', '结论文件是空的（她写过，但没写内容）。'))
    return
  }

  meta.textContent =
    secretaryState.stamp === ''
      ? '文件里没有「更新于」时间戳 —— 让她按 skill 约定补上首行，否则看不出这份结论有多旧'
      : '更新于 ' + secretaryState.stamp + (age === null ? '' : age === 0 ? '（今天）' : '（' + String(age) + ' 天前）')
  if (secretaryState.stamp !== '' && age !== null && age > CONCLUSION_STALE_DAYS) {
    meta.className = 'board-meta warn'
    meta.textContent = '⚠️ ' + meta.textContent + ' —— 超过 ' + String(CONCLUSION_STALE_DAYS) + ' 天没更新了'
  } else {
    meta.className = 'board-meta'
  }
  renderMarkdown(body, secretaryState.text, secretaryState.employeeId)
}

/** 红点：有新结论没看过（比对她写的时间戳 vs 本机上次打开看板的时间） */
function updateBoardDot(dot) {
  var node = dot === undefined ? $('boardDot') : dot
  if (node === null) return
  var key = 'dse.boardSeen.' + secretaryState.employeeId
  var seen = readLocal(key)
  var has = secretaryState.text !== null && secretaryState.text.trim() !== '' && secretaryState.stamp !== ''
  node.classList.toggle('hidden', !(has && String(seen === null ? '' : seen) !== secretaryState.stamp))
}

function markBoardSeen() {
  if (secretaryState.employeeId !== '' && secretaryState.stamp !== '') {
    writeLocal('dse.boardSeen.' + secretaryState.employeeId, secretaryState.stamp)
  }
  updateBoardDot()
}

function openBoard() {
  var sheet = $('boardSheet')
  var pull = $('btnBoard')
  if (sheet === null) return
  secretaryState.open = true
  /* 看板接管右侧阅读区；只关闭临时导航抽屉，保留桌面侧栏。 */
  closeSessionNavDrawer()
  sheet.classList.remove('hidden')
  /* 触发过渡要**先让浏览器记录"元素此刻在屏幕外"这一帧**，否则同一次样式计算里
     改 transform 不产生过渡。这里用"读一次布局属性强制回流"，不用 requestAnimationFrame ——
     实测踩过：后台标签页里 rAF 会被节流，看板点了不滑下来（类没加上，页面看着像坏了）。 */
  void sheet.offsetHeight
  sheet.classList.add('open')
  if (pull !== null) pull.setAttribute('aria-expanded', 'true')
  markBoardSeen()
}

function closeBoard() {
  var sheet = $('boardSheet')
  var pull = $('btnBoard')
  if (sheet === null) return
  secretaryState.open = false
  sheet.classList.remove('open')
  if (pull !== null) pull.setAttribute('aria-expanded', 'false')
  /* 过渡结束后再藏，避免"啪"地消失 */
  var done = function () {
    if (secretaryState.open !== true) sheet.classList.add('hidden')
  }
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') window.setTimeout(done, 240)
  else done()
}

function toggleBoard() {
  if (secretaryState.open) closeBoard()
  else openBoard()
}

/** 收起简报并回到输入框；seed 非空且输入框为空时，预填一句追问开头，但绝不自动发送。 */
function resumeBoardConversation(seed) {
  closeBoard()
  var input = $('promptInput')
  if (input === null) return
  var prefix = typeof seed === 'string' ? seed : ''
  if (prefix !== '' && String(input.value || '').trim() === '') {
    input.value = prefix
    if (typeof autoGrowPrompt === 'function') autoGrowPrompt()
  }
  if (typeof input.focus === 'function') input.focus()
  if (prefix !== '' && typeof input.setSelectionRange === 'function') {
    var at = String(input.value || '').length
    input.setSelectionRange(at, at)
  }
}

/** 手机键盘状态：只在 ≤640px 的秘书页收缩立绘舞台；显式 false 在任何尺寸都负责清理类。 */
function setSecretaryKeyboardOpen(open, narrowOverride) {
  var chat = $('viewChat')
  if (chat === null) return false
  var narrow = false
  if (typeof narrowOverride === 'boolean') narrow = narrowOverride
  else {
    try {
      narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches === true
    } catch (error) {
      narrow = false
    }
  }
  var active = open === true && narrow && chat.classList.contains('layout-secretary')
  chat.classList.toggle('secretary-keyboard-open', active)
  return active
}

/** 事件绑定（在 bindEvents 里调用一次） */
function bindSecretaryUi() {
  var pull = $('btnBoard')
  if (pull !== null) {
    pull.onclick = function () {
      toggleBoard()
      stageTouch()
    }
  }
  var close = $('btnBoardClose')
  if (close !== null) close.onclick = closeBoard
  var resume = $('btnBoardResume')
  if (resume !== null) resume.onclick = function () { resumeBoardConversation('') }
  var followup = $('btnBoardFollowup')
  if (followup !== null) followup.onclick = function () { resumeBoardConversation('基于上次结论，') }
  /* 输入框：**点一下就趴下来待命**（她做好听你说的准备了），打字过程中保持趴着 ——
     所以 focus 喊 stageStandby、敲键只重置计时（她开始干活时 stageTurn 会把她叫起来）。 */
  var input = $('promptInput')
  if (input !== null) {
    input.addEventListener('focus', function () {
      /* 输入是当前任务：手机舞台缩成窄带，公共导航的桌面偏好保持不变。 */
      closeSessionNavDrawer()
      setSecretaryKeyboardOpen(true)
      stageStandby()
    })
    input.addEventListener('blur', function () {
      setSecretaryKeyboardOpen(false)
    })
    input.addEventListener('keydown', function () {
      stageTouch()
    })
    input.addEventListener('input', function () {
      stageTouch()
    })
  }
  /* Esc 收起看板：它铺满整屏，键盘用户必须有出口（另有 ✕ 按钮） */
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || event.defaultPrevented || state.sessionNavOpen === true) return
    if (secretaryState.open) {
      closeBoard()
      return
    }
  })
}
`
