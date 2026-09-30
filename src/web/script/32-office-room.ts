/* 32-office-room：「全景」页 —— 一间会自己动的办公室
 *
 * 这一页只做一件事：**让同事们的头像在屋子里到处走，点一下他就会说句话**。
 * 上一版把它画成了等距伪 3D 的立体工位（桌子、椅子、两面墙、台灯、小地图），
 * 结果是"看着像工程图，点着像报表" —— 老板的原话是"太丑了、太无趣了、太没意思了"。
 * 所以这一版反过来：**去掉所有像报表的东西**，只留活气。
 *
 * 依然坚持的几件事：
 *   1. 数据全是真的。走位、说哪句话都是这页自己的乐趣，但"谁在线、谁在忙、谁有未读"
 *      一律来自 state 与办公区同一套判定（roomStatusOf 复用 availabilityBadge）——
 *      头像上那颗小灯与未读气泡就是他们的真实状态，绝不为好看编一个。
 *   2. 不生图。头像用的是员工自己的头像（avatarNode），其余全由 DOM + CSS 画出来。
 *   3. 不重建节点。忙闲/未读一变就重建会让所有人瞬间回到起点（走路被打断最明显），
 *      所以每轮只改属性与文字，节点的增删只在"人变了"时发生。
 *   4. 走位与台词都是**确定性**的（由 id 的哈希推出来）：同一份数据每次渲染都得到同一套走位，
 *      不会一刷新就换个人站你面前；测试也才断言得动。
 *
 * 想调手感的三个旋钮：
 *   ROOM_WALK_MS    一个人走完一圈要多久（越小越活泼）
 *   ROOM_TALK_MS    一句话在气泡里停多久
 *   ROOM_LINES      他会说的话（改这里就换性格）
 */

/** 人数 → 头像大小与走位密度：人越多，头像越小、地方越挤。 */

export const CHUNK_32_OFFICE_ROOM = String.raw`
var ROOM_TIERS = [
  { id: 't10', max: 10, avatar: 72 },
  { id: 't20', max: 20, avatar: 62 },
  { id: 't30', max: 30, avatar: 54 },
  { id: 't40', max: 40, avatar: 48 },
  { id: 't50', max: 50, avatar: 42 }
]

/** 一圈走多久（毫秒）。每个头像在此基础上浮动 ±40%，免得整屋人像仪仗队一样同步。 */
var ROOM_WALK_MS = 22000
/** 一句话在气泡里停多久（毫秒）。 */
var ROOM_TALK_MS = 3600
/** 头像与场地边缘的最小距离（按头像尺寸的比例算）：不许走到贴边、也不许走出屋子。 */
var ROOM_EDGE = 0.9

/**
 * 他会说的话。
 *
 * 写这批台词的规矩：**只说"反应"，不说"状态"**。
 * 上一版吃过亏 —— 一句"我正在写代码"如果和真实忙碌状态对不上，那这页的可信度就没了；
 * 而"怎么了老板""要不要来杯咖啡"这种话永远不会和任何事实冲突。
 * 100 条以上：连点一百下都不该重样（见 roomNextLine）。
 */
var ROOM_LINES = [
  '怎么了老板',
  '在呢在呢',
  '老板你说',
  '随叫随到',
  '有什么吩咐',
  '我我我，我来',
  '需要我搭把手吗',
  '交给我吧',
  '这个我会',
  '让我想想',
  '收到收到',
  '好嘞',
  '得嘞',
  '没问题',
  '包在我身上',
  '稍等，我理一理',
  '你先说，我记着',
  '我听着呢',
  '嗯嗯，然后呢',
  '你说了算',
  '老板英明',
  '老板今天气色真好',
  '老板的发型真好看',
  '老板喝咖啡了吗',
  '要不要来杯咖啡',
  '我请你喝水',
  '我这儿有饼干',
  '分你一半',
  '中午吃什么',
  '我吃什么都行',
  '有点饿了',
  '一起点外卖吗',
  '摸鱼一下下',
  '就一下下',
  '别告诉老板……啊你就是老板',
  '我什么都没说',
  '嘿嘿',
  '哈哈',
  '你真幽默',
  '我笑点低',
  '今天天气不错',
  '外面好像要下雨了',
  '记得带伞',
  '天冷了多穿点',
  '我这儿暖和',
  '手有点凉',
  '搓搓手',
  '醒醒，不能睡',
  '再撑一会儿',
  '快下班了吧',
  '还有多久下班',
  '我精力充沛',
  '我随时可以开工',
  '吩咐一声就行',
  '我准备好了',
  '你说往哪打',
  '冲呀',
  '加油加油',
  '你也要注意休息',
  '别太累了',
  '记得按时吃饭',
  '累了就歇会儿',
  '我帮你盯着',
  '有情况我叫你',
  '我记住这个了',
  '忘不了',
  '我把它记本子上了',
  '笔呢，我的笔呢',
  '找到了',
  '在这儿呢',
  '咦，你还在啊',
  '我一直都在',
  '我没走',
  '别怕，有我',
  '淡定',
  '小场面',
  '这都不是事儿',
  '稳的',
  '妥妥的',
  '我很有信心',
  '让我来露一手',
  '看我的',
  '献丑了',
  '我尽力而为',
  '我尽量，真的尽量',
  '我可能会慢一点',
  '别催我，我在想',
  '想好了，我说了啊',
  '一二三……',
  '突然忘了要说啥',
  '你刚才问什么来着',
  '我这记性',
  '算了，不重要',
  '反正我会努力',
  '谢谢你叫醒我',
  '我刚在发呆',
  '发呆也是一种思考',
  '我在思考人生',
  '人生嘛，慢慢来',
  '有事叫我，我马上到',
  '你先忙，我在这儿'
]

/** 人数 → 档位。超过 50 人不截断、不丢人：回落到最密的一档继续排。 */
function roomTierOf(count) {
  var n = Number(count)
  if (!Number.isFinite(n) || n <= 0) return ROOM_TIERS[0]
  for (var index = 0; index < ROOM_TIERS.length; index += 1) {
    var tier = ROOM_TIERS[index]
    if (tier !== undefined && n <= tier.max) return tier
  }
  return ROOM_TIERS[ROOM_TIERS.length - 1]
}

/** 稳定哈希：同一个 id 永远得到同一套走位与同一批台词（刷新不该换个人站你面前）。 */
function roomHash(text) {
  var value = 2166136261
  var source = String(text)
  for (var index = 0; index < source.length; index += 1) {
    value ^= source.charCodeAt(index)
    value = (value * 16777619) >>> 0
  }
  return value >>> 0
}

/** 把 [0, span) 里的一格取出来（span 为 0 时给 0，免得除零）。 */
function roomPick(seed, span) {
  var size = Math.floor(Number(span))
  if (!Number.isFinite(size) || size <= 0) return 0
  return Math.abs(Math.floor(Number(seed) || 0)) % size
}

function roomClamp(value, min, max) {
  var low = Number(min)
  var high = Number(max)
  if (high < low) return low
  return Math.max(low, Math.min(high, Number(value)))
}

/**
 * 排位：把 n 个人撒进场地。
 *
 * 为什么用"抖动网格"而不是纯随机：纯随机会挤成一团、还会留下大片空白（100 个头像时尤其明显）。
 * 网格保证铺得开，抖动保证不像队列；再按 id 的哈希取抖动，于是每个人的位置是稳定的。
 *
 * 返回的每一项描述一个人的**整条路线**：起点（x, y，像素）、三个绕圈用的相对位移、
 * 一圈的时长与起始相位、以及层次（越靠下越在前面）。
 */
function roomWalkersOf(ordered, sceneW, sceneH, tier) {
  var list = Array.isArray(ordered) ? ordered : []
  var count = list.length
  if (count === 0) return []
  var width = Math.max(1, Number(sceneW) || 1)
  var height = Math.max(1, Number(sceneH) || 1)
  var avatar = Number(tier.avatar) || 48
  /* 头像要在格子里放得下：格子边长至少得比头像大一圈 */
  var cols = Math.max(1, Math.ceil(Math.sqrt((count * width) / height)))
  var rows = Math.max(1, Math.ceil(count / cols))
  var cellW = width / cols
  var cellH = height / rows
  var margin = avatar * ROOM_EDGE
  var walkers = []

  list.forEach(function (employee, index) {
    var id = String(employee.id || '')
    var seed = roomHash('walker:' + id)
    var col = index % cols
    var row = Math.floor(index / cols)
    /* 抖动幅度留在格子内（±0.32 格），间距还在，看着就散 */
    var jitterX = (roomPick(seed, 65) / 100 - 0.32) * cellW
    var jitterY = (roomPick(seed >> 5, 65) / 100 - 0.32) * cellH
    var startX = roomClamp(col * cellW + cellW / 2 + jitterX, margin, width - margin)
    var startY = roomClamp(row * cellH + cellH / 2 + jitterY, margin, height - margin)
    /* 三个绕圈点：以起点为中心，半径取格子的一部分，且**每一个都夹回场地内** ——
       一个头像走出屋子比它站得挤难看一百倍。 */
    var radiusX = cellW * (0.26 + roomPick(seed >> 7, 24) / 100)
    var radiusY = cellH * (0.24 + roomPick(seed >> 11, 22) / 100)
    var path = []
    for (var step = 0; step < 3; step += 1) {
      var angle = (step / 3) * Math.PI * 2 + (roomPick(seed >> (step + 3), 100) / 100) * 0.9
      var targetX = roomClamp(startX + Math.cos(angle) * radiusX, margin, width - margin)
      var targetY = roomClamp(startY + Math.sin(angle) * radiusY, margin, height - margin)
      path.push({ x: Math.round(targetX - startX), y: Math.round(targetY - startY) })
    }
    walkers.push({
      id: id,
      x: Math.round(startX),
      y: Math.round(startY),
      path: path,
      /* 一圈 21~31 秒：慢一点才像"在屋里转悠"，快一点就像有人在追他 */
      duration: Math.round(13 + (ROOM_WALK_MS / 1000 - 9) * (0.6 + roomPick(seed >> 13, 80) / 100)),
      /* 负的延时 = "他已经在路上走了这么久"：一屋人不会同时出发 */
      delay: -Math.round(roomPick(seed >> 17, 22000) / 1000),
      depth: Math.round(startY)
    })
  })
  return walkers
}

/**
 * 一个人的状态：忙碌 / 在线 / 离线 / 卡住 / 工作区缺失 / 有未读。
 *
 * 判定与办公区**共用** availabilityBadge 与 deskStallMs（两页对"谁在线"必须永远说同一句话）。
 * lamp 是头像上那颗小灯的颜色，pose 决定他的小动作，text 是气泡标题里那句真话。
 */
function roomStatusOf(employee) {
  var id = String(employee.id || '')
  var info = state.desk[id]
  var stalled = deskStallMs(info)
  var unread = Number(state.unread[id] || 0)
  if (stalled !== null) {
    return { kind: 'error', lamp: 'bad', pose: 'alert', prop: 'bang', text: formatIdleMinutes(stalled) + '无响应', unread: unread }
  }
  if (info !== undefined && info.busy === true) {
    return { kind: 'busy', lamp: 'busy', pose: 'type', prop: '', text: '忙碌', unread: unread }
  }
  var badge = availabilityBadge(employee)
  if (badge.kind === 'ok') {
    /* 有未读就举手：这是全屋唯一"要你行动"的动作，必须一眼看见 */
    if (unread > 0) return { kind: 'online', lamp: 'ok', pose: 'call', prop: 'wave', text: '等你回话', unread: unread }
    return { kind: 'online', lamp: 'ok', pose: 'work', prop: '', text: '在线', unread: unread }
  }
  if (badge.kind === 'warn') {
    return { kind: 'error', lamp: 'bad', pose: 'gone', prop: 'dust', text: badge.text, unread: unread }
  }
  return { kind: 'offline', lamp: 'off', pose: 'sleep', prop: 'zzz', text: '离线', unread: unread }
}

/**
 * 门牌上的一句话：多少人、几个在忙、几条未读。
 * 只列**非零**的项（"0 条未读"没有信息量，还会让门牌在安静的时候变长）。
 */
function roomSummary(employees) {
  var list = Array.isArray(employees) ? employees : []
  var busy = 0
  var offline = 0
  var error = 0
  var unread = 0
  list.forEach(function (employee) {
    var status = roomStatusOf(employee)
    if (status.kind === 'busy') busy += 1
    else if (status.kind === 'offline') offline += 1
    else if (status.kind === 'error') error += 1
    unread += status.unread
  })
  var parts = [String(list.length) + ' 位同事']
  if (busy > 0) parts.push(String(busy) + ' 位在忙')
  if (offline > 0) parts.push(String(offline) + ' 位离线')
  if (error > 0) parts.push(String(error) + ' 位需处理')
  if (unread > 0) parts.push(String(unread) + ' 条未读')
  return parts.join(' · ')
}

/**
 * 真实时刻 → 天色。用**本地时钟**：这页是给坐在屏幕前的人看的，
 * 他窗外的天色和他电脑上的钟一致，屋子才会"跟外面一样"。
 */
function roomDaypartOf(hour) {
  var h = Number(hour)
  if (!Number.isFinite(h)) return 'day'
  h = ((Math.floor(h) % 24) + 24) % 24
  if (h >= 5 && h < 8) return 'dawn'
  if (h >= 8 && h < 17) return 'day'
  if (h >= 17 && h < 20) return 'dusk'
  return 'night'
}

/**
 * 下一句说什么。**连着点一百下都不该重样**，所以不是"随机取一条"：
 * 游标每次 +1 再乘一个与 100 互质的步长（37），于是它会走遍整个台词表；
 * 起点再加一段 id 哈希 —— 所以两个人同时点，说的话也不一样。
 * 万一还是撞上刚才那句（同一轮里），就往后挪一格。
 */
function roomNextLine(employee) {
  var seed = roomHash('line:' + String(employee.id || ''))
  var count = ROOM_LINES.length
  if (count === 0) return ''
  var index = roomPick(seed + roomView.said * 37, count)
  if (index === roomView.lastLine && count > 1) index = (index + 1) % count
  roomView.said += 1
  roomView.lastLine = index
  return ROOM_LINES[index] === undefined ? '' : ROOM_LINES[index]
}

/** 房间的运行时状态。放片段作用域里（不进 state）：它是**视图层的临时状态**。 */
var roomView = {
  layoutKey: '',
  order: '',
  nodes: {},
  talkTimers: {},
  /* 每个人的落位（由 roomWalkersOf 算出来，布局变了才重算） */
  spots: [],
  said: 0,
  lastLine: -1,
  timer: null
}

/* ═══ 渲染 ═══ */

/** 一个人的头像节点：真头像（员工自己的），带一圈柔和的描边与影子。 */
function buildRoomWalker(employee, tier, spot) {
  var id = String(employee.id || '')
  var name = String(employee.name || id)
  var status = roomStatusOf(employee)

  /* 用 div + role=button，而不是 <button>：气泡里还有一个"聊两句"按钮，
     按钮里套按钮是无效 HTML（读屏与键盘都会乱） */
  var walker = el('div', 'walker')
  walker.setAttribute('role', 'button')
  walker.setAttribute('tabindex', '0')
  walker.setAttribute('data-emp', id)
  walker.style.setProperty('--walker-av', String(tier.avatar) + 'px')
  walker.style.setProperty('--walk-dur', String(spot.duration) + 's')
  walker.style.setProperty('--walk-delay', String(spot.delay) + 's')
  walker.style.setProperty('--w-x', String(spot.x) + 'px')
  walker.style.setProperty('--w-y', String(spot.y) + 'px')
  walker.style.setProperty('--w-1x', String(roomPathAt(spot.path, 0).x) + 'px')
  walker.style.setProperty('--w-1y', String(roomPathAt(spot.path, 0).y) + 'px')
  walker.style.setProperty('--w-2x', String(roomPathAt(spot.path, 1).x) + 'px')
  walker.style.setProperty('--w-2y', String(roomPathAt(spot.path, 1).y) + 'px')
  walker.style.setProperty('--w-3x', String(roomPathAt(spot.path, 2).x) + 'px')
  walker.style.setProperty('--w-3y', String(roomPathAt(spot.path, 2).y) + 'px')
  walker.style.setProperty('z-index', String(spot.depth))

  walker.appendChild(el('span', 'walker-shadow'))

  var body = el('span', 'walker-body')
  var face = el('span', 'walker-face')
  face.appendChild(avatarNode(employee, tier.avatar))
  body.appendChild(face)
  body.appendChild(el('span', 'walker-dot'))
  var badge = el('span', 'walker-badge')
  body.appendChild(badge)
  body.appendChild(el('span', 'walker-prop'))
  walker.appendChild(body)

  walker.appendChild(el('span', 'walker-name', name))

  /* 气泡：默认藏着，点一下才出来。它是那个"点一下他就跟你说话"的地方 */
  var bubble = el('span', 'walker-bubble')
  var head = el('span', 'walker-bubble-head', name)
  bubble.appendChild(head)
  var line = el('span', 'walker-line', '')
  bubble.appendChild(line)
  var talk = el('button', 'walker-talk', '聊两句')
  talk.setAttribute('type', 'button')
  talk.setAttribute('aria-label', '和「' + name + '」开始对话')
  bubble.appendChild(talk)
  walker.appendChild(bubble)

  walker.title = '点一下让「' + name + '」说句话（双击直接进对话）'
  /* 头像是异步缓存的：确保取一次（沿用办公区同一条路径），否则全是线稿脸 */
  ensureAvatar(employee)
  return walker
}

/**
 * 刷新一个人：**只改属性与文字，不重建节点**。
 * 重建会让正在走的动画、正在飘的气泡全部回到起点 —— 满屋人一起"卡一下"最伤观感。
 */
function patchRoomWalker(walker, employee) {
  var id = String(employee.id || '')
  var name = String(employee.name || id)
  var status = roomStatusOf(employee)
  walker.setAttribute('data-pose', status.pose)
  walker.setAttribute('data-lamp', status.lamp)
  walker.setAttribute('data-unread', status.unread > 0 ? '1' : '0')
  walker.setAttribute('aria-label', name + '：' + status.text + '。点一下让他说句话，双击开始对话')
  var badge = walker.querySelector('.walker-badge')
  if (badge !== null) {
    badge.textContent = status.unread > 0 ? (status.unread > 99 ? '99+' : String(status.unread)) : ''
  }
  var prop = walker.querySelector('.walker-prop')
  if (prop !== null) {
    /* 三个小道具各说一件事：Zzz=离线、!=卡住、×=工作区没了 */
    prop.setAttribute('data-kind', status.prop)
    prop.textContent = status.prop === 'zzz' ? 'Zzz' : status.prop === 'bang' ? '!' : status.prop === 'dust' ? '×' : ''
  }
  var head = walker.querySelector('.walker-bubble-head')
  if (head !== null) head.textContent = name + ' · ' + status.text
  if (id === String(state.selectedEmployeeId || '')) walker.classList.add('active')
  else walker.classList.remove('active')
}

/** 从路线里安全取一项（越界就报错，不要静默变成 undefined 把坐标写坏）。 */
function roomPathAt(list, index) {
  var value = list[index]
  if (value === undefined) throw new Error('房间布局缺少第 ' + index + ' 项')
  return value
}

/** 点一下：他的话冒出来。再点一下换一句（同一个人的话不会连着重复）。 */
function roomSay(walker, employee) {
  if (walker === null || walker === undefined) return
  var line = walker.querySelector('.walker-line')
  if (line !== null) line.textContent = roomNextLine(employee)
  walker.setAttribute('data-talk', '1')
  var id = String(employee.id || '')
  if (typeof setTimeout !== 'function') return
  if (roomView.talkTimers[id] !== undefined && typeof clearTimeout === 'function') {
    clearTimeout(roomView.talkTimers[id])
  }
  roomView.talkTimers[id] = setTimeout(function () {
    walker.setAttribute('data-talk', '0')
  }, ROOM_TALK_MS)
}

/**
 * 把点击行为挂上去。
 *
 * 为什么单独抽成一个函数（而不是建节点时顺手写 onclick）：预览页是把场景**序列化成 HTML** 的，
 * 事件处理器不会跟着过去 —— 预览页里点谁都不说话，"看着一样、点着不一样"。
 * 抽出来之后，真页面与预览页调用的是同一份绑定逻辑。
 */
function roomWalkersBind(root) {
  if (root === null || root === undefined) return
  var walkers = root.querySelectorAll('.walker')
  for (var index = 0; index < walkers.length; index += 1) {
    var walker = walkers[index]
    if (walker === undefined) continue
    roomWalkerBind(walker, walker.getAttribute('data-emp') || '')
  }
}

/** 单个头像的绑定：点一下说话，双击进对话，键盘回车/空格也算点一下。 */
function roomWalkerBind(walker, id) {
  var employeeOf = function () {
    var found = null
    state.employees.forEach(function (item) {
      if (String(item.id || '') === String(id)) found = item
    })
    return found
  }
  walker.onclick = function () {
    var employee = employeeOf()
    if (employee === null) return
    roomSay(walker, employee)
  }
  walker.ondblclick = function () {
    selectEmployee(String(id))
  }
  walker.onkeydown = function (event) {
    var key = event === undefined || event === null ? '' : String(event.key || '')
    if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    var employee = employeeOf()
    if (employee === null) return
    roomSay(walker, employee)
  }
  var talk = walker.querySelector('.walker-talk')
  if (talk !== null) {
    talk.onclick = function (event) {
      /* 气泡里的按钮自己处理，不要让点击再冒到外层去（否则会边说边跳页） */
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      selectEmployee(String(id))
    }
  }
}

/**
 * 重画（或增量刷新）整间屋子。
 *
 * 分三种情况，都是刻意的：
 *   · 场地或人数变了（布局变了）→ 全部重建：走位本来就要重排；
 *   · 人数变了（多了 / 少了员工）→ 只增删差的那些，其余原地保留（走路的动画不重启）；
 *   · 其它（忙闲、未读、改名、选中）→ 只改属性与文字，一个节点都不动。
 */
function renderOfficeRoom() {
  var stage = $('roomRoom')
  var scene = $('roomFloor')
  if (stage === null || scene === null) return
  var employees = state.employees
  var tier = roomTierOf(employees.length)

  stage.setAttribute('data-tier', tier.id)
  stage.setAttribute('data-count', String(employees.length))
  stage.setAttribute('data-daypart', roomDaypartOf(new Date().getHours()))
  stage.style.setProperty('--walker-av', String(tier.avatar) + 'px')

  var sign = $('roomSummary')
  if (sign !== null) sign.textContent = employees.length === 0 ? '' : roomSummary(employees)

  if (employees.length === 0) {
    clear(scene)
    roomView.nodes = {}
    roomView.talkTimers = {}
    roomView.order = ''
    roomView.layoutKey = ''
    scene.appendChild(
      el('div', 'empty walker-empty', state.phase === 'ready' ? '（暂无员工：确认终端节点已上线并上报目录）' : '（未连接）')
    )
    return
  }
  clear(scene.querySelector('.walker-empty'))

  /* 排位顺序跟着办公区走（officeSections 已经应用了用户存的组序与组内序）：
     谁排在前谁先落位，两页不该各排各的。 */
  var ordered = []
  officeSections().forEach(function (section) {
    section.members.forEach(function (employee) {
      ordered.push(employee)
    })
  })

  var size = roomStageSize(stage)
  var layoutKey = [tier.id, size.w, size.h, ordered.length].join('|')
  if (roomView.layoutKey !== layoutKey) {
    clear(scene)
    roomView.nodes = {}
    roomView.talkTimers = {}
    roomView.order = ''
    roomView.layoutKey = layoutKey
    scene.style.setProperty('--room-w', String(Math.round(size.w)) + 'px')
    scene.style.setProperty('--room-h', String(Math.round(size.h)) + 'px')
    roomView.spots = roomWalkersOf(ordered, size.w, size.h, tier)
  }
  var spots = Array.isArray(roomView.spots) ? roomView.spots : []

  var orderKey = ordered
    .map(function (employee) {
      return String(employee.id || '')
    })
    .join(',')
  var orderChanged = roomView.order !== orderKey
  roomView.order = orderKey

  var alive = {}
  ordered.forEach(function (employee, index) {
    var id = String(employee.id || '')
    alive[id] = true
    var spot = spots[index]
    if (spot === undefined) return
    var walker = roomView.nodes[id]
    var created = false
    if (walker === undefined) {
      walker = buildRoomWalker(employee, tier, spot)
      roomView.nodes[id] = walker
      created = true
    }
    patchRoomWalker(walker, employee)
    /* 顺序变了要重排 DOM（键盘 Tab 的顺序才会跟视觉一致），平时一个节点都不动 */
    if (created || orderChanged) scene.appendChild(walker)
  })

  Object.keys(roomView.nodes).forEach(function (id) {
    if (alive[id] === true) return
    var node = roomView.nodes[id]
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    delete roomView.nodes[id]
  })

  roomWalkersBind(scene)
  roomClockStart()
}

/** 只在**正看着这一页**时画：办公区的忙闲轮询每几秒就跑一次，没人看的场景不该跟着重建。 */
function maybeRenderOfficeRoom() {
  if (state.view !== 'officeRoom') return
  renderOfficeRoom()
}

/** 场地尺寸（视口被拉大拉小时头像要重新撒一遍，不然会挤在一角）。 */
function roomStageSize(stage) {
  if (stage === null) return { w: 0, h: 0 }
  return { w: Math.max(0, Number(stage.clientWidth) || 0), h: Math.max(0, Number(stage.clientHeight) || 0) }
}

/**
 * 每十分钟看一眼天色：跨过 20:00 就入夜，不用等数据刷新。
 * 只在自己这一页可见时动 DOM（否则纯属浪费）。
 */
function roomClockStart() {
  if (roomView.timer !== null || typeof setInterval !== 'function') return
  roomView.timer = setInterval(function () {
    if (state.view !== 'officeRoom') return
    var stage = $('roomRoom')
    if (stage === null) return
    stage.setAttribute('data-daypart', roomDaypartOf(new Date().getHours()))
  }, 600000)
}

/* 窗口尺寸变了要重新撒一遍：场地变宽了而人还挤在旧位置上，看着就像没人管这一页。
   只在正看着这一页时重排（切回来时 renderOfficeRoom 自己会算）。 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', function () {
    if (state.view !== 'officeRoom') return
    roomView.layoutKey = ''
    renderOfficeRoom()
  })
}
`
