/**
 * 控制台脚本片段：首页工作台：员工目录、工位、头像、分组与排序、轮询、未读（含视图路由）
 *
 * 本段对应原文件的连续行区间，内容与原文件逐字节相同（拆分时用黄金基线比对过）。
 *
 * 为什么拆成文件：这一段原来是 src/web/ui.ts 里那个 8k 行 String.raw 字符串的一部分 ——
 * 单文件没有边界，两个会话并行改会互相踩（真实撞过：edit 被"file changed"打断、提交时
 * 只能按 hunk 挑自己的改动）。拆开后每段各占一个文件，边界就是文件名。
 *
 * 拼接顺序 = 原来的物理顺序，由 ui.ts 里的 CONTROL_UI_SCRIPT 组装；**顺序不能动**：
 * 函数声明会提升，但顶层 var 的赋值不会（state、注册表这类必须在用它的代码之前）。
 */
export const CHUNK_30_OFFICE = String.raw`
function pickArray(payload, keys) {
  if (Array.isArray(payload)) return payload
  if (payload === null || typeof payload !== 'object') return []
  for (var i = 0; i < keys.length; i += 1) {
    var value = payload[keys[i]]
    if (Array.isArray(value)) return value
  }
  return []
}

function loadEmployees() {
  if (state.phase !== 'ready') return Promise.resolve([])
  return rpc('employee.list', {})
    .then(function (payload) {
      var list = pickArray(payload, ['employees', 'items', 'list'])
      state.employees = list.filter(function (item) {
        return item !== null && typeof item === 'object'
      })
      state.employeeNames = new Map()
      state.employees.forEach(function (employee) {
        if (typeof employee.id === 'string') state.employeeNames.set(employee.id, String(employee.name || employee.id))
      })
      pruneAvatarCache(state.employees)
      renderEmployees()
      if (typeof renderSessions === 'function') renderSessions()
      if (typeof loadSessionTree === 'function') loadSessionTree()
      renderApprovals()
      updateEffectivePreset()
      loadNodeOptions()
      loadPositions()
      if (state.view === 'llm') renderLlmConfig()
      /* 选中的那位刚好从离线变回在线：把会话重新接上（强制重订 + 重读历史）。
         必须在 state.employees 更新之后判 —— 判定读的就是这里的 nodeOnline。 */
      if (noteNodeOnline(state.employees) === true) resumeSelectedSession()
      /* 员工清单到位后立刻补一轮工位轮询：onHelloOk 里的首次轮询跑在
         employee.list 返回之前（emps=0），后台标签页的定时器又会被浏览器节流，
         不补这一轮的话首屏忙碌状态要等很久才出现 */
      pollDeskStatus()
      return state.employees
    })
    .catch(function (error) {
      reportRpcError('employee.list', error)
      return []
    })
}

/** 卡了多久的人话（只用于徽章上那一小格，所以粗粒度就够）。 */
function formatIdleMinutes(idleMs) {
  var minutes = Math.round(Number(idleMs || 0) / 60000)
  if (minutes < 60) return String(minutes) + ' 分钟'
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  return String(hours) + ' 小时' + (rest === 0 ? '' : String(rest) + ' 分')
}

function availabilityBadge(employee) {
  if (employee.status === 'missing-dir') return { text: '工作区缺失', kind: 'warn' }
  if (employee.available === true) return { text: '在线可用', kind: 'ok' }
  if (employee.nodeOnline === false) return { text: '节点离线', kind: 'off' }
  return { text: '不可用', kind: 'off' }
}

/* ── 默认头像：白底圆形 + 黑色手绘线稿人脸（Kimi Work 子 Agent 风）──
 *
 * 确定性：同一套 fnv1a(employee.id)，用不同位段分别抽发型/眼型/眉型/嘴型 ——
 * 同一员工永远同一张脸，不需要 PRNG 库。
 * 深色主题下也保持"白纸上的素描"观感（浅色圆底 + 近黑线），不做反色。
 * 自定义头像（avatar.* 上传）是主力路径，这只是占位默认。
 */

/** FNV-1a 32 位哈希：小、稳定、到处都能实现，做「id → 部件选择」刚刚好。 */
function fnv1a(text) {
  var hash = 0x811c9dc5
  for (var i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

var DOODLE_INK = '#2b2f36'
var DOODLE_PAPER = '#fbfcfe'

/* 发型 6 种（弧线/锯齿线表达；控制点刻意避开整数几何，手绘感来自"不准"） */
var DOODLE_HAIR = [
  /* 短平头：一道头顶弧 */
  ['M13 20 C14.5 12.5 20 8.6 24 8.7 C28.6 8.5 33.8 12.8 35 20'],
  /* 中分：左右两弧 + 中缝 */
  ['M24 8.2 C18 8.6 13.6 13 13 20', 'M24 8.2 C30 8.6 34.4 13 35 20', 'M24 8.2 L24 12.5'],
  /* 刘海：顶弧 + 锯齿刘海线 */
  ['M13 19 C15.5 11 32.5 11 35 19', 'M14.5 17 L17 14.6 L19.8 17 L23 14.6 L25.8 17 L29 14.6 L31.8 17 L34 15.2'],
  /* 背头：两道后掠弧 + 内侧一道 */
  ['M13 18.5 C15 9.5 23.5 7.2 24 7.2', 'M24 7.2 C31 7.6 34 12.2 35 18.5', 'M16.5 13.5 C22 10.8 29.5 11.2 32.5 14'],
  /* 爆炸卷：云朵状凹凸弧 */
  ['M12.5 20 Q11.8 12.5 17 10.2 Q16.2 6.2 21 7.2 Q24 3.8 27 7.2 Q31.8 6.2 31 10.2 Q36.2 12.5 35.5 20'],
  /* 光头 + 帽线（针织帽：弧顶 + 一道帽檐直线） */
  ['M14 15.5 C16 8.2 32 8.2 34 15.5', 'M14 15.5 L34 15.5']
]

/* 眉毛 3 种（平 / 弯 / 挑） */
var DOODLE_BROWS = [
  ['M16.5 20 L21.5 20', 'M26.5 20 L31.5 20'],
  ['M16.5 20.5 Q19 18.4 21.5 20.5', 'M26.5 20.5 Q29 18.4 31.5 20.5'],
  ['M16.5 21.2 L21.5 19', 'M26.5 19 L31.5 21.2']
]

/* 嘴 4 种（微笑弧 / 平直 / 张嘴小圆 / 抿嘴波线；小圆用 circle 单独处理） */
var DOODLE_MOUTHS = [
  ['M20 32.4 Q24 36.2 28 32.4'],
  ['M20.5 33.5 L27.5 33.5'],
  [],
  ['M20 33.5 Q22 32.4 24 33.5 Q26 34.6 28 33.5']
]

/** 手绘线稿人脸：白底圆形 + 单色细黑线部件，全部确定性派生自 employee.id。 */
function doodleFaceSvg(employee, size) {
  var hash = fnv1a(String(employee.id || ''))
  var hairStyle = hash % DOODLE_HAIR.length
  var eyeStyle = (hash >>> 4) % 4
  var browStyle = (hash >>> 8) % DOODLE_BROWS.length
  var mouthStyle = (hash >>> 12) % DOODLE_MOUTHS.length

  var ns = 'http://www.w3.org/2000/svg'
  var svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 48 48')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('class', 'desk-avatar')

  var strokePath = function (d) {
    var p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', DOODLE_INK)
    p.setAttribute('stroke-width', '1.8')
    p.setAttribute('stroke-linecap', 'round')
    return p
  }
  var dot = function (cx, cy, r) {
    var c = document.createElementNS(ns, 'circle')
    c.setAttribute('cx', String(cx))
    c.setAttribute('cy', String(cy))
    c.setAttribute('r', String(r))
    c.setAttribute('fill', DOODLE_INK)
    return c
  }

  /* 纸面：浅色圆底 + 细描边 */
  var paper = document.createElementNS(ns, 'circle')
  paper.setAttribute('cx', '24')
  paper.setAttribute('cy', '24')
  paper.setAttribute('r', '22.5')
  paper.setAttribute('fill', DOODLE_PAPER)
  paper.setAttribute('stroke', DOODLE_INK)
  paper.setAttribute('stroke-width', '2')
  svg.appendChild(paper)

  /* 脸廓：略不规则的圆（控制点偏移即手绘感） */
  svg.appendChild(
    strokePath('M24 14.2 C18.4 13.8 12.9 19.6 12.5 26.6 C12.1 33.9 17.6 39.6 24 39.9 C30.7 40.3 35.7 34.1 35.5 26.9 C35.3 19.3 30.1 14.6 24 14.2 Z')
  )

  /* 发型 */
  DOODLE_HAIR[hairStyle].forEach(function (d) {
    svg.appendChild(strokePath(d))
  })

  /* 眉毛 */
  DOODLE_BROWS[browStyle].forEach(function (d) {
    svg.appendChild(strokePath(d))
  })

  /* 眼睛：左眼 x≈19、右眼 x≈29，y≈25 */
  if (eyeStyle === 0) {
    /* 圆点 */
    svg.appendChild(dot(19, 25, 1.3))
    svg.appendChild(dot(29, 25, 1.3))
  } else if (eyeStyle === 1) {
    /* 弯月笑眼 */
    svg.appendChild(strokePath('M17 25.2 Q19 22.6 21 25.2'))
    svg.appendChild(strokePath('M27 25.2 Q29 22.6 31 25.2'))
  } else if (eyeStyle === 2) {
    /* 横线眯眯眼 */
    svg.appendChild(strokePath('M17 25 L21 25'))
    svg.appendChild(strokePath('M27 25 L31 25'))
  } else {
    /* 大眼 + 瞳点 */
    ;[19, 29].forEach(function (cx) {
      var ring = document.createElementNS(ns, 'circle')
      ring.setAttribute('cx', String(cx))
      ring.setAttribute('cy', '25')
      ring.setAttribute('r', '2.2')
      ring.setAttribute('fill', 'none')
      ring.setAttribute('stroke', DOODLE_INK)
      ring.setAttribute('stroke-width', '1.6')
      svg.appendChild(ring)
      svg.appendChild(dot(cx, 25.3, 0.8))
    })
  }

  /* 嘴 */
  if (mouthStyle === 2) {
    /* 张嘴小圆 */
    var mouth = document.createElementNS(ns, 'circle')
    mouth.setAttribute('cx', '24')
    mouth.setAttribute('cy', '33.5')
    mouth.setAttribute('r', '1.8')
    mouth.setAttribute('fill', 'none')
    mouth.setAttribute('stroke', DOODLE_INK)
    mouth.setAttribute('stroke-width', '1.6')
    svg.appendChild(mouth)
  } else {
    DOODLE_MOUTHS[mouthStyle].forEach(function (d) {
      svg.appendChild(strokePath(d))
    })
  }

  return svg
}

/* ── 自定义头像：本地缓存 + 版本校验 + 懒加载 + 原地替换 ──
 *
 * hasAvatar 由节点注册时上报（employee.list 带出），控制台据此免探测。
 *
 * **为什么要本地缓存 + 版本号**（真实体感问题："点进去先是线稿，等一下才刷出照片"）：
 * 头像是几百 KB 的图，而 Hub 侧只有 RPC 一条路（没有 HTTP 缓存可借），
 * 于是每次刷新、每个视图都把所有员工的头像重新拉一遍 —— 实测 9 个员工约 4.2 MB
 * base64，走一遍公网往返才轮到画到屏幕上。现在：
 *   · 节点上报 avatarUpdatedAtMs / avatarBytes（文件 mtime + 字节数）当版本号；
 *   · 版本没变 ⇒ **一个字节都不传**，直接用 localStorage 里那份画出来（不再有线稿闪烁）；
 *   · 版本变了/没有缓存 ⇒ 才发 RPC，并顺手把图缩到 256px 再存 —— 一张 350KB 的照片
 *     缩完约 30KB，既省流量也让 localStorage（约 5MB 配额）装得下所有人的头像。
 *
 * 缓存条目形如 dse.avatar.<员工id> → {"v":"版本","d":"data:image/...;base64,..."}。
 * 解析失败一律当没有缓存（隐私模式、配额满、别的版本写坏过 —— 都不能让头像把页面带崩）。
 */
var AVATAR_CACHE_PREFIX = 'dse.avatar.'
/** 本地缓存/上传前缩到的最长边（显示最大 110px，256 足够高清屏） */
var AVATAR_CACHE_PX = 256
/** 上传前缩到多大：稍大一点留给将来的大屏，同时把"手机原图"压到几十 KB */
var AVATAR_UPLOAD_PX = 320

function avatarCacheKey(employeeId) {
  return AVATAR_CACHE_PREFIX + String(employeeId || '')
}

/** 员工身上的版本号；Hub/节点还没上报时返回 ''（= 无从判断，只能老实下载）。 */
function avatarVersionOf(employee) {
  if (employee === null || typeof employee !== 'object') return ''
  var at = typeof employee.avatarUpdatedAtMs === 'number' ? employee.avatarUpdatedAtMs : 0
  if (at <= 0) return ''
  var bytes = typeof employee.avatarBytes === 'number' ? employee.avatarBytes : 0
  return String(at) + '-' + String(bytes)
}

/** 读一条缓存；坏数据当没有（绝不让它把渲染打断）。 */
function readAvatarCache(employeeId) {
  var raw = readLocal(avatarCacheKey(employeeId))
  if (raw === null || raw === '') return null
  try {
    var parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.d !== 'string' || parsed.d.indexOf('data:image/') !== 0) return null
    return { version: typeof parsed.v === 'string' ? parsed.v : '', dataUrl: parsed.d }
  } catch (error) {
    return null
  }
}

/** 单条缓存的上限：localStorage 一共约 5MB，不能把"没缩成功的那张原图"塞进去。 */
var AVATAR_CACHE_MAX_CHARS = 400 * 1024

function writeAvatarCache(employeeId, version, dataUrl) {
  var body = String(dataUrl || '')
  /* 太大就不落盘（内存里照常显示）：写失败会被 writeLocal 静默吞掉，
     那样既没缓存也说不清为什么 —— 这里直接不做，行为是可预期的。 */
  if (body === '' || body.length > AVATAR_CACHE_MAX_CHARS) return
  writeLocal(avatarCacheKey(employeeId), JSON.stringify({ v: String(version || ''), d: body }))
}

function dropAvatarCache(employeeId) {
  writeLocal(avatarCacheKey(employeeId), null)
}

/**
 * 把"已经没有头像 / 员工已被删掉"的缓存清掉。
 *
 * **必须扫 localStorage 本身**，不能只扫内存里那份：被删掉的员工不会再被渲染，
 * 于是它的缓存条目永远进不了内存 —— 只按内存清理的话，那些几十 KB 的图会一直占着
 * 那约 5MB 的配额，直到某天写新头像时静默失败。
 */
function pruneAvatarCache(employees) {
  var alive = {}
  var list = Array.isArray(employees) ? employees : []
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] !== null && typeof list[i] === 'object' && list[i].hasAvatar === true) {
      alive[String(list[i].id || '')] = true
    }
  }
  var keys = []
  try {
    for (var k = 0; k < localStorage.length; k += 1) {
      var name = localStorage.key(k)
      if (name !== null && name.indexOf(AVATAR_CACHE_PREFIX) === 0) keys.push(name)
    }
  } catch (error) {
    /* 隐私模式 / 存储被禁：内存那条路照常走 */
  }
  keys.forEach(function (name) {
    var id = name.slice(AVATAR_CACHE_PREFIX.length)
    if (alive[id] === true) return
    delete state.avatars[id]
    delete state.avatarVersions[id]
    writeLocal(name, null)
  })
}

/** 本地缓存还能不能用：版本非空且一致就不必再问 Hub。 */
function avatarCacheFresh(cachedVersion, currentVersion) {
  return currentVersion !== '' && cachedVersion !== undefined && cachedVersion === currentVersion
}

/**
 * 把一张图缩到 maxPx 以内再编码（返回 dataURL 的 Promise）。
 *
 * 为什么在浏览器里做：节点侧没有任何图像库（运行时依赖只有 ws + zod），
 * 而浏览器天生会解码和缩放 —— 顺手就能把 350 KB 的照片变成约 30 KB。
 * 任何一步失败（老浏览器、canvas 被污染、编码超时）都**原样返回输入**：
 * 缩图是优化，不是功能本身。
 */
function shrinkImageDataUrl(dataUrl, maxPx, mimeType) {
  return new Promise(function (resolve) {
    try {
      if (typeof Image === 'undefined' || typeof document === 'undefined') {
        resolve(dataUrl)
        return
      }
      var img = new Image()
      var done = false
      var finish = function (value) {
        if (done === true) return
        done = true
        resolve(value)
      }
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width
          var h = img.naturalHeight || img.height
          if (w <= 0 || h <= 0) {
            finish(dataUrl)
            return
          }
          var scale = Math.min(1, maxPx / Math.max(w, h))
          var tw = Math.max(1, Math.round(w * scale))
          var th = Math.max(1, Math.round(h * scale))
          var canvas = document.createElement('canvas')
          canvas.width = tw
          canvas.height = th
          var ctx = canvas.getContext('2d')
          if (ctx === null) {
            finish(dataUrl)
            return
          }
          ctx.drawImage(img, 0, 0, tw, th)
          var want = typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'image/png'
          var out = canvas.toDataURL(want, 0.9)
          /* 浏览器不支持这个编码时会**静默回落成 png**：只有真拿到了才用 */
          if (out.indexOf('data:' + want) !== 0) out = canvas.toDataURL('image/png')
          /* 缩完反而更大（小图、纯色图）就别折腾 */
          finish(out.length < dataUrl.length ? out : dataUrl)
        } catch (error) {
          finish(dataUrl)
        }
      }
      img.onerror = function () {
        finish(dataUrl)
      }
      /* 别让一张坏图把调用方的 Promise 悬在那里 */
      setTimeout(function () {
        finish(dataUrl)
      }, 4000)
      img.src = dataUrl
    } catch (error) {
      resolve(dataUrl)
    }
  })
}

function avatarNode(employee, size) {
  /* 包一层 span 是为了换头像时原地换内容，而不动工位卡片其余部分 */
  var box = el('span', 'desk-avatar-box')
  box.setAttribute('data-avatar-for', String(employee.id || ''))
  box.setAttribute('data-size', String(size))
  fillAvatarBox(box, employee)
  return box
}

function fillAvatarBox(box, employee) {
  var id = String(employee.id || '')
  var cached = state.avatars[id]
  clear(box)
  if (employee.hasAvatar === true && typeof cached === 'string') {
    var img = el('img', 'desk-avatar')
    img.src = cached
    img.alt = ''
    box.appendChild(img)
  } else {
    box.appendChild(doodleFaceSvg(employee, Number(box.getAttribute('data-size') || '48')))
  }
}

function ensureAvatar(employee) {
  var id = String(employee.id || '')
  if (id === '') return
  if (employee.hasAvatar !== true) {
    /* 头像被移除了：内存与本地缓存一起清，免得画着旧照片 */
    if (state.avatars[id] !== undefined) {
      delete state.avatars[id]
      delete state.avatarVersions[id]
      paintAvatar(id)
    }
    dropAvatarCache(id)
    return
  }
  var version = avatarVersionOf(employee)

  /* 1) 内存里没有就看本地缓存 —— 有就先画上去（**这是"不再闪线稿"的关键一步**），
        即便版本已经过期也先画：过期的照片也比一闪而过的线稿更接近事实。 */
  if (state.avatars[id] === undefined) {
    var cached = readAvatarCache(id)
    if (cached !== null) {
      state.avatars[id] = cached.dataUrl
      state.avatarVersions[id] = cached.version
      paintAvatar(id)
    }
  }

  /* 2) 版本一致 ⇒ 到此为止，一个字节都不用传。 */
  if (avatarCacheFresh(state.avatarVersions[id], version)) return
  if (state.avatarLoading[id] === true) return
  state.avatarLoading[id] = true
  rpc('employee.avatar.get', { employeeId: id })
    .then(function (payload) {
      delete state.avatarLoading[id]
      if (payload === null || typeof payload !== 'object' || payload.exists !== true) return
      var mime = String(payload.mimeType || 'image/png')
      var dataUrl = 'data:' + mime + ';base64,' + String(payload.dataBase64 || '')
      /* 顺手缩到显示尺寸再落缓存：下一次刷新就只读本地那几十 KB。
         **动图不缩**（缩放会把它变成静帧 —— 那是改内容，不是优化）。 */
      var shrink = mime === 'image/gif'
        ? Promise.resolve(dataUrl)
        : shrinkImageDataUrl(dataUrl, AVATAR_CACHE_PX, 'image/webp')
      return shrink.then(function (small) {
        state.avatars[id] = small
        state.avatarVersions[id] = version
        writeAvatarCache(id, version, small)
        paintAvatar(id)
      })
    })
    .catch(function () {
      delete state.avatarLoading[id]
    })
}

function paintAvatar(employeeId) {
  var employee = employeeById(employeeId)
  if (employee === null) return
  /* 工位卡片与模型配置页各有一份头像节点，一起换 */
  var boxes = document.querySelectorAll('[data-avatar-for="' + employeeId + '"]')
  for (var i = 0; i < boxes.length; i += 1) {
    fillAvatarBox(boxes[i], employee)
  }
}

/* 换头像行内面板（与「改分组」同款就地展开，不用弹窗） */
function uploadAvatar(employeeId, fileInput) {
  var file = fileInput.files !== null && fileInput.files !== undefined ? fileInput.files[0] : undefined
  if (file === undefined) return
  if (file.size > 2 * 1024 * 1024) {
    toast('图片超过 2MB 上限（' + Math.round(file.size / 1024) + 'KB），请换一张小一点的', 'warn')
    return
  }
  var reader = new FileReader()
  reader.onload = function () {
    var original = String(reader.result || '')
    var comma = original.indexOf(',')
    if (comma < 0) {
      toast('读取图片失败', 'bad')
      return
    }
    /* **先缩再传**：头像在界面上最大只显示 110px，却常常是手机拍的几 MB 原图。
       缩到 256px（约 30KB）既省上传时间，也让"别人看到这张头像"从"等几秒"变成"立刻"。
       webp 编码不支持时 shrinkImageDataUrl 会回落成 png —— 两种节点都收（AVATAR_EXT_BY_MIME）。 */
    shrinkImageDataUrl(original, AVATAR_UPLOAD_PX, 'image/webp').then(function (shrunk) {
      var dataUrl = shrunk !== '' ? shrunk : original
      var head = dataUrl.slice(0, dataUrl.indexOf(',')).toLowerCase()
      var mimeType = head.indexOf('image/webp') >= 0
        ? 'image/webp'
        : head.indexOf('image/jpeg') >= 0
          ? 'image/jpeg'
          : 'image/png'
      return rpc('employee.avatar.set', {
        employeeId: employeeId,
        mimeType: mimeType,
        dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1)
      })
        .then(function () {
          /* 本地先按"刚上传的这份"显示与缓存；版本号等 loadEmployees 带回来再对齐 */
          var employee = employeeById(employeeId)
          var version = employee === null ? '' : avatarVersionOf(employee)
          state.avatars[employeeId] = dataUrl
          writeAvatarCache(employeeId, version, dataUrl)
          paintAvatar(employeeId)
          toast('头像已更新', 'ok')
          return loadEmployees() // hasAvatar 与版本号随注册上报刷新
        })
    }).catch(function (error) {
      reportRpcError('employee.avatar.set', error)
    })
  }
  reader.onerror = function () {
    toast('读取图片失败', 'bad')
  }
  reader.readAsDataURL(file)
}

function removeAvatar(employeeId) {
  rpc('employee.avatar.remove', { employeeId: employeeId })
    .then(function () {
      delete state.avatars[employeeId]
      delete state.avatarVersions[employeeId]
      dropAvatarCache(employeeId)
      toast('已恢复程序生成头像', 'ok')
      return loadEmployees()
    })
    .catch(function (error) {
      reportRpcError('employee.avatar.remove', error)
    })
}

/* ── 分组选择器（下拉 + 行内新建）──
 *
 * 新建员工表单与工位「编辑」共用同一个组件，别复制两遍。
 * 形态：「（不分组）」+ 现有分组（zh-Hans-CN 排序）+「＋ 新建分组」；
 * 选新建时行内展开一个小文本框（用户明确讨厌弹窗，也不用 prompt()）。
 */

/** 现有员工的去重分组名，按中文排序。 */
function listGroupNames() {
  var seen = {}
  state.employees.forEach(function (employee) {
    var group = typeof employee.group === 'string' ? employee.group.trim() : ''
    if (group !== '') seen[group] = true
  })
  return Object.keys(seen).sort(function (a, b) {
    return a.localeCompare(b, 'zh-Hans-CN')
  })
}

/**
 * 造一个分组选择器。read() 返回 ''（不分组）或组名（trim 过、≤64 字符；
 * 新建名与现有组重名时等于选了那个组 —— 返回同一个字符串，天然去重）。
 */
function buildGroupPicker(currentGroup) {
  var NEW = '__new_group__'
  var root = el('span', 'group-picker')
  var select = el('select', '')
  var noneOption = el('option', '', '（不分组）')
  noneOption.value = ''
  select.appendChild(noneOption)

  var names = listGroupNames()
  var current = typeof currentGroup === 'string' ? currentGroup.trim() : ''
  /* 当前组若已不在集合里（比如全员迁出后组消失），补进选项让选择仍然可见 */
  if (current !== '' && names.indexOf(current) < 0) names.push(current)
  names.forEach(function (name) {
    var option = el('option', '', name)
    option.value = name
    select.appendChild(option)
  })
  var newOption = el('option', '', '＋ 新建分组')
  newOption.value = NEW
  select.appendChild(newOption)
  select.value = current

  var newInput = el('input', 'group-new hidden')
  newInput.type = 'text'
  newInput.maxLength = 64
  newInput.placeholder = '新分组名'
  select.onchange = function () {
    var creating = select.value === NEW
    newInput.classList.toggle('hidden', !creating)
    if (creating) newInput.focus()
  }
  root.appendChild(select)
  root.appendChild(newInput)

  return {
    root: root,
    read: function () {
      if (select.value !== NEW) return select.value
      return String(newInput.value || '').trim().slice(0, 64)
    }
  }
}

/* 密度切换：只切类 + 写 localStorage，两档样式全部挂在 CSS 的 .office--compact 下 */
function applyDensity(density) {
  state.density = density === 'comfortable' ? 'comfortable' : 'compact'
  writeLocal(LS.density, state.density)
  var office = $('viewOffice')
  if (office !== null) office.classList.toggle('office--compact', state.density === 'compact')
  var button = $('btnDensity')
  if (button !== null) {
    button.textContent = state.density === 'compact' ? '紧凑' : '舒适'
    button.classList.toggle('primary', state.density === 'compact')
  }
}

function toggleDensity() {
  applyDensity(state.density === 'compact' ? 'comfortable' : 'compact')
}

/* ── 右栏（员工上下文）折叠 ──
 *
 * 与密度同款：JS 只切 #viewChat 上的一个类 + 写 localStorage，各档怎么收由 CSS 决定
 *   · ≥1200px：三栏，收起右栏后中间列吃满（左栏仍常驻）
 *   · 641–1199px：两栏（对话 + 右栏），收起后变单栏
 *   · ≤640px：本来就没有右栏，按钮由 CSS 藏起来
 * 状态**不**跟会话/员工走：它是"这块屏幕想不想看见上下文"，换员工不该把它变回来。 */
function currentAsideVisible() {
  return readLocal(LS.aside) !== 'hidden'
}

function syncAsideToggle() {
  var chat = $('viewChat')
  var visible = state.asideVisible === true
  if (chat !== null) chat.classList.toggle('aside-collapsed', !visible)
  var button = $('btnAside')
  if (button === null) return
  button.setAttribute('aria-pressed', visible ? 'true' : 'false')
  button.classList.toggle('primary', visible)
  /* 文案跟着状态走，理由见 markup.ts 那段：只写「上下文」时真实反馈是"找不到收侧栏的按钮"；
     而收起之后还喊"折叠"就是假话（那一下点下去其实是展开）。 */
  button.textContent = visible ? '上下文栏折叠' : '上下文栏展开'
  button.title = visible ? '收起右侧的上下文栏' : '展开右侧的上下文栏'
}

function applyAsideVisible(visible) {
  state.asideVisible = visible === true
  writeLocal(LS.aside, state.asideVisible ? 'shown' : 'hidden')
  syncAsideToggle()
}

function toggleAside() {
  applyAsideVisible(currentAsideVisible() !== true)
}

/* 公共员工导航：桌面展开偏好跨岗位沿用；窄屏抽屉临时打开，互不覆盖。
   员工内部的会话展开是另一份状态，不因侧栏收放或切换岗位而改变。 */
var CHAT_NAV_DOCK_QUERY = '(min-width: 1200px)'

function sessionNavDocked() {
  return typeof window.matchMedia === 'function' ? window.matchMedia(CHAT_NAV_DOCK_QUERY).matches : window.innerWidth >= 1200
}

function currentPanelVisible() {
  return readLocal(LS.panel) !== 'hidden'
}

function syncPanelToggle() {
  var docked = sessionNavDocked()
  var drawer = !docked && state.sessionNavOpen === true
  var visible = docked ? state.panelVisible === true : drawer
  var shell = $('viewChatShell')
  if (shell !== null) {
    shell.classList.toggle('panel-collapsed', state.panelVisible !== true)
    shell.classList.toggle('drawer-open', drawer)
  }
  var panel = $('sessionPanel')
  var returnFocus = panel !== null && !visible && panel.contains(document.activeElement)
  if (panel !== null) {
    panel.classList.toggle('hidden', !visible)
    panel.setAttribute('role', drawer ? 'dialog' : 'navigation')
    if (drawer) panel.setAttribute('aria-modal', 'true')
    else panel.removeAttribute('aria-modal')
  }
  var backdrop = $('employeeNavBackdrop')
  if (backdrop !== null) backdrop.classList.toggle('hidden', !drawer)
  /* 抽屉打开时，键盘与点击都留在导航内；桌面常驻导航不限制工作区。 */
  var workspace = $('viewChat')
  if (workspace !== null) workspace.inert = drawer
  var rail = $('employeeNavRail')
  if (rail !== null) rail.inert = drawer
  ;['btnChatSessions', 'btnNavCurrent', 'btnPanel'].forEach(function (id) {
    var button = $(id)
    if (button !== null) button.setAttribute('aria-expanded', visible ? 'true' : 'false')
  })
  if (returnFocus) {
    var opener = $('btnChatSessions')
    if (opener !== null) opener.focus()
  }
}

function applyPanelVisible(visible) {
  state.panelVisible = visible === true
  writeLocal(LS.panel, state.panelVisible ? 'shown' : 'hidden')
  syncPanelToggle()
}

function closeSessionNavDrawer() {
  var wasOpen = state.sessionNavOpen === true
  state.sessionNavOpen = false
  syncPanelToggle()
  if (wasOpen && !sessionNavDocked()) {
    var button = $('btnChatSessions')
    if (button !== null) button.focus()
  }
}

function updateEmployeeNavigation() {
  var employee = state.selectedEmployeeId === null ? null : employeeById(state.selectedEmployeeId)
  var name = employee === null ? '员工' : String(employee.name || shortId(employee.id))
  var role = employee === null ? '' : (positionName(employee.position) || '通用')
  var label = $('navCurrentName')
  if (label !== null) label.textContent = name
  var button = $('btnNavCurrent')
  if (button !== null) {
    button.title = employee === null ? '展开员工与会话' : '当前：' + name + '（' + role + '）· 展开员工与会话'
    button.setAttribute('aria-label', button.title)
  }
  var avatar = $('navCurrentAvatar')
  var id = employee === null ? '' : String(employee.id || '')
  if (avatar !== null && avatar.getAttribute('data-peer') !== id) {
    clear(avatar)
    avatar.setAttribute('data-peer', id)
    if (employee !== null) {
      avatar.appendChild(avatarNode(employee, 30))
      ensureAvatar(employee)
    }
  }
}

function bindEmployeeNavigationUi() {
  var open = $('btnChatSessions')
  if (open !== null) open.onclick = function () { toggleSessionPanel() }
  var current = $('btnNavCurrent')
  if (current !== null) current.onclick = function () { toggleSessionPanel(true) }
  var close = $('btnPanel')
  if (close !== null) close.onclick = function () { toggleSessionPanel(false) }
  var backdrop = $('employeeNavBackdrop')
  if (backdrop !== null) backdrop.onclick = closeSessionNavDrawer
  document.addEventListener('keydown', function (event) {
    if (state.view !== 'chat' || sessionNavDocked() || state.sessionNavOpen !== true) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSessionNavDrawer()
      return
    }
    if (event.key !== 'Tab') return
    var panel = $('sessionPanel')
    if (panel === null) return
    var focusable = Array.from(panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"], summary')).filter(function (node) {
      return node.getClientRects().length > 0
    })
    if (focusable.length === 0) return
    var first = focusable[0]
    var last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  })
  if (typeof window.matchMedia === 'function') {
    var query = window.matchMedia(CHAT_NAV_DOCK_QUERY)
    var resizeNavigation = function () { closeSessionNavDrawer() }
    if (typeof query.addEventListener === 'function') query.addEventListener('change', resizeNavigation)
    else if (typeof query.addListener === 'function') query.addListener(resizeNavigation)
  }
}

/* ── 办公区（分组工位视图）── */

function groupOf(employee) {
  var text = typeof employee.group === 'string' ? employee.group.trim() : ''
  return text === '' ? '未分组' : text
}

/**
 * 员工所属分组的**键**（'' = 未分组）。
 *
 * 分组不是实体：它只是员工工作区 .dsemployee/employee.json 里的 group 字段。
 * 所以"分组"是**从员工身上聚合出来的**，而键的定义必须只有一处 ——
 * 办公区分区（officeSections）与"给分组改名"（renameGroup）都要用它，
 * 两处各写一遍 trim/空串判断，迟早在某个边界（前后空格、全角空格）上分叉。
 */
function groupKeyOf(employee) {
  if (employee === null || typeof employee !== 'object') return ''
  return typeof employee.group === 'string' && employee.group.trim() !== '' ? employee.group.trim() : ''
}

/**
 * 一级视图 → 容器 id 的**唯一**映射。
 *
 * 为什么要有这张表：视图从两个（办公区 / 模型配置）变成五个之后，"哪个标签对应哪个容器、
 * 进入时该拉什么数据"如果继续散着写 if，加第六个视图时必然漏一处 ——
 * 漏掉的两种表现都不会报错：标签点了没反应，或者页面切过去了但内容永远是空的。
 * 标签按钮的 data-view、setView 的显隐、进入时的数据加载，三处都从这张表读。
 *
 * chat 也在表里，但它**不是标签**：它是点工位进的临时视图（返回键回办公区），
 * 所以标签条上没有它的按钮。
 */
var VIEW_IDS = {
  office: 'viewOffice',
  officeRoom: 'viewOfficeRoom',
  approvals: 'viewApprovals',
  jobs: 'viewJobs',
  devices: 'viewDevices',
  health: 'viewHealth',
  llm: 'viewLlm',
  chat: 'viewChatShell'
}

/**
 * 进入某个视图时要拉的数据。
 *
 * 各面板原本的约定是"展开那一刻才拉"（不给 Hub 添常态负担），换成一级页之后
 * "展开"就等于"切到这一页"，所以统一挂在这里。没列进来的视图（办公区 / 对话）
 * 不进这里：它们的数据由连接时和事件推送维护，切回来不该重新拉一遍。
 */
var VIEW_LOADERS = {
  /* 办公室不是"拉数据"，而是"重画一遍"：它用的员工与忙闲状态由连接与轮询维护，
     切回来时数据本来就是新的，只是场景 DOM 可能停在离开那一刻（忙闲/在线状态变了）。
     所以这里挂的是重绘，不是 RPC —— 它不产生任何请求，也就不违反"进入哪一页只拉那一页"的约定。 */
  officeRoom: function () {
    renderOfficeRoom()
  },
  approvals: function () {
    loadApprovals()
  },
  jobs: function () {
    loadJobs()
  },
  devices: function () {
    /* 再挡一次 scope：标签在没权限时是藏着的（syncControls），这里防的是
       将来有别的入口把用户送进来 —— 那样只会看到一串权限报错。 */
    if (state.scopes.indexOf('device.pair') >= 0) {
      loadDevices()
      /* 注册窗口那张卡片必须**每次进页面都重读**：它只在 bindEvents 里加载过一次，
         而那时脚本跑在连接建立之前 —— 卡片会永远停在"（需要 device.pair 权限）"。
         实机冒烟就是这样撞出来的：开关看起来不存在，其实只是没人让它刷新。 */
      loadPairingWindow()
    }
  },
  health: function () {
    refreshHealth()
  },
  llm: function () {
    openEmployeeConfig()
  }
}

function setView(view) {
  /* 只认表里有的视图；未知的一律回落到办公区。
     不回落的话会变成"所有页面一起隐身"—— 一屏空白，且没有任何报错。 */
  var target = Object.prototype.hasOwnProperty.call(VIEW_IDS, view) ? view : 'office'
  state.view = target
  if (target !== 'chat') closeSessionNavDrawer()
  writeLocal(LS.lastView, target)
  /* 离开办公区就作废"正在改名"的意图：否则回到办公区时编辑器会突然弹回来 */
  if (target !== 'office') groupRenameIntent = null
  Object.keys(VIEW_IDS).forEach(function (key) {
    var node = $(VIEW_IDS[key])
    if (node !== null) node.classList.toggle('hidden', key !== target)
  })
  var tabs = $('viewTabs')
  if (tabs !== null) {
    var buttons = tabs.querySelectorAll('button.tab')
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-view') === target)
    }
  }
  var loader = VIEW_LOADERS[target]
  if (loader !== undefined) loader()
  /* 切回对话页：重对一次岗位外壳（秘书页的立绘要按"她此刻在不在干活"重新摆）。
     立绘在离开这一页时不会自己更新 —— 不重对就会停在上次那一帧（比如永远在敲键盘）。
     applyPositionShell 在后面的片段里（67-secretary），函数声明提升到整个脚本，
     运行时调用没问题；重复调也安全（读结论有 employeeId 守卫，不会重复拉）。 */
  if (target === 'chat' && state.selectedEmployeeId !== null && typeof applyPositionShell === 'function') {
    applyPositionShell(employeeById(state.selectedEmployeeId))
  }
}

/** 单个工位卡片：上半部是左右两栏网格 —— 左头像右小屏（等高），
 *  下一行左名字右状态徽章，再下一行「编辑 / 换头像」两个操作。 */
function buildDesk(employee, groupKey) {
  var id = String(employee.id || '')
  var deskInfo = state.desk[id]
  var busy = deskInfo !== undefined && deskInfo.busy === true
  var desk = el('div', 'desk' + (id === state.selectedEmployeeId ? ' active' : ''))
  desk.setAttribute('data-emp', id)
  desk.tabIndex = 0

  /* 排序模式：左上角浮现组内上移/下移把手 */
  if (state.orderMode === true) {
    desk.appendChild(
      buildOrderButtons(function (dir) {
        moveEmployee(groupKey, id, dir)
      })
    )
  }

  /* 上半部：两栏网格。
     头像：有自定义头像用图片（圆形裁切），否则程序线稿脸（本身就是白底圆形），
     110px，占左栏；小屏占右栏，与头像同行等高（操作行减半后省下的高度给了这里）。 */
  var top = el('div', 'desk-top')
  top.appendChild(avatarNode(employee, 110))
  ensureAvatar(employee)
  /* 忙碌小屏常驻占位（不再是忙时才渲染）：忙时滚屏显示实时输出，
     闲时保留最近一次输出、从未有过输出则显示「空闲中」——避免忙闲切换时布局跳动。
     初始内容直接填好，不等下一轮绘制。 */
  var screen = el('div', 'desk-screen')
  top.appendChild(screen)
  fillDeskScreen(screen, id, busy)

  /* 名字行：左名字右状态徽章（忙碌优先） */
  var nameCell = el('div', 'desk-name')
  nameCell.appendChild(el('span', 'desk-name-text', String(employee.name || id)))
  top.appendChild(nameCell)
  /* 卡死优先于「忙碌」：只显示「忙碌」时，用户分不清它是真的在动、还是卡住了
     （线上事故现场就是这样：工位一直忙碌，谁都没发现那个回合其实已经死了）。 */
  var stalled = deskStallMs(deskInfo)
  var badge =
    stalled === null
      ? busy
        ? { text: '忙碌', kind: 'busy' }
        : availabilityBadge(employee)
      : { text: formatIdleMinutes(stalled) + '无输出', kind: 'stall' }
  var badgeCell = el('div', 'desk-badges')
  /* 岗位徽章：只在真的设了非「通用」岗位时出现 —— 一眼分清工种（docs/06 §3.3）。
     通用岗位不显示，免得每张卡上都挂一枚没有信息量的标签。 */
  var positionLabel = positionName(employee.position)
  if (positionLabel !== '') badgeCell.appendChild(el('span', 'badge', positionLabel))
  badgeCell.appendChild(el('span', 'badge ' + badge.kind, badge.text))
  top.appendChild(badgeCell)
  /* 岗位/节点行：网格里占满整行，跟在名字行之后、操作行之前（紧凑档由 CSS 隐藏） */
  top.appendChild(el('div', 'desk-role', String(employee.role || '（未填写岗位说明）')))
  top.appendChild(
    el('div', 'desk-meta', '节点 ' + String(employee.nodeName || employee.nodeId || '?') + (busy ? ' · 正在处理…' : ''))
  )
  desk.appendChild(top)
  if (employee.status === 'missing-dir') {
    desk.appendChild(el('div', 'warn', '工作区目录缺失'))
  }

  /* 未读红点：该员工有新输出而用户不在他的对话框里时累计 */
  var unreadCount = state.unread[id] || 0
  if (unreadCount > 0) {
    desk.appendChild(el('span', 'desk-unread', unreadCount > 99 ? '99+' : String(unreadCount)))
  }

  /* 管理动作统一受 employee.manage 控制：只读控制台不应该先显示一个必然失败的编辑器。 */
  var canManage = state.scopes.indexOf('employee.manage') >= 0
  var editButton = el('button', 'ghost desk-action', '编辑')
  editButton.onclick = function (event) {
    event.stopPropagation()
    state.configEmployeeId = id
    state.configTab = 'identity'
    writeLocal(LS.configEmployee + '.' + BOOT.hubId, id)
    setView('llm')
    renderLlmConfig(true)
  }

  /* 换头像：与「改分组」同款就地展开小面板（用户明确讨厌弹窗） */
  var avatarButton = el('button', 'ghost desk-action', '换头像')
  var avatarEditor = el('div', 'desk-group-edit hidden')
  var fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/png,image/webp,image/gif,image/jpeg'
  fileInput.onchange = function () {
    uploadAvatar(id, fileInput)
  }
  avatarEditor.appendChild(fileInput)
  if (employee.hasAvatar === true) {
    var resetButton = el('button', 'ghost', '恢复默认（像素小人）')
    resetButton.onclick = function (event) {
      event.stopPropagation()
      removeAvatar(id)
    }
    avatarEditor.appendChild(resetButton)
  }
  avatarButton.onclick = function (event) {
    event.stopPropagation()
    avatarEditor.classList.toggle('hidden')
  }
  fileInput.onclick = function (event) {
    event.stopPropagation()
  }
  /* 编辑进入统一的员工设置；头像保留工位上的快捷入口。 */
  if (canManage) {
    var actions = el('div', 'desk-actions')
    actions.appendChild(editButton)
    actions.appendChild(avatarButton)
    top.appendChild(actions)
    desk.appendChild(avatarEditor)
  }

  desk.onclick = function () {
    /* 排序模式下点卡片是调序不是进聊天（防误触）；退出排序模式恢复 */
    if (state.orderMode === true) return
    selectEmployee(id)
  }
  desk.onkeydown = function (event) {
    if (event.key === 'Enter' && state.orderMode !== true) selectEmployee(id)
  }
  return desk
}

function renderEmployees() {
  /* 办公室场景跟着同一份员工数据重画（只在正看着那一页时才动手，见 maybeRenderOfficeRoom）。
     接在这里而不是各加载路径上：办公区渲染是"员工数据/忙闲状态变了"的**唯一**汇合点，
     挂在这里，办公室就不会漏掉任何一次变化。放在最前面是因为下面的 early return
     （办公区容器缺失时）不该顺带把办公室也跳过。 */
  maybeRenderOfficeRoom()
  var floor = $('officeFloor')
  if (floor === null) return
  clear(floor)
  if (state.employees.length === 0) {
    floor.appendChild(el('div', 'empty', state.phase === 'ready' ? '（暂无员工：确认终端节点已上线并上报目录）' : '（未连接）'))
    return
  }

  officeSections().forEach(function (section) {
    var block = el('div', 'office-group')
    var head = el('div', 'office-group-head')
    head.appendChild(el('span', 'office-group-name', section.name))
    head.appendChild(el('span', 'chip', String(section.members.length) + ' 人'))
    /* 改名入口：只在真实分组上给（未分组不是一个可写的字段，见 buildGroupRenameButton） */
    if (section.key !== '') head.appendChild(buildGroupRenameButton(section, head))
    /* 排序模式：组整体上移/下移 */
    if (state.orderMode === true) {
      head.appendChild(buildOrderButtons(function (dir) {
        moveGroup(section.key, dir)
      }))
    }
    block.appendChild(head)
    var grid = el('div', 'office-grid')
    section.members.forEach(function (employee) {
      grid.appendChild(buildDesk(employee, section.key))
    })
    block.appendChild(grid)
    floor.appendChild(block)
  })
  /* 记录本次渲染的状态签名：轮询结果没变时就不再重建 DOM（见 maybeRenderDesks） */
  state.deskSig = deskSignature()
  /* 重建会把用户正在用的行内编辑器一起抹掉 —— 若刚才正在给某组改名，按原样恢复现场
     （含已输入的值）。这是"编辑器不被自动更新吃掉"的最后一道保障。 */
  restoreGroupRenameEditor()
}

/* ── 办公区排序（偏好存 Hub，跨设备一致）──
 *
 * 渲染顺序 = office.order 里出现的组/员工按序 + 未列出的按默认序（组名中文序、
 * 员工名字序）追加在后；偏好里引用已删除的组/员工自然被过滤（目录是现实，
 * 偏好是视图层，见 Hub 侧 OfficePrefs 的注释）。
 * 未分组的键约定为 ''（显示名「未分组」）。
 */

function officeSections() {
  var byKey = new Map()
  state.employees.forEach(function (employee) {
    var key = groupKeyOf(employee)
    var bucket = byKey.get(key)
    if (bucket === undefined) {
      bucket = []
      byKey.set(key, bucket)
    }
    bucket.push(employee)
  })

  var order = state.officeOrder.groupOrder
  var keys = []
  order.forEach(function (key) {
    if (byKey.has(key)) keys.push(key)
  })
  var rest = Array.from(byKey.keys()).filter(function (key) {
    return order.indexOf(key) < 0
  })
  rest.sort(function (a, b) {
    var an = a === '' ? '未分组' : a
    var bn = b === '' ? '未分组' : b
    return an.localeCompare(bn, 'zh-Hans-CN')
  })

  return keys.concat(rest).map(function (key) {
    var members = byKey.get(key) || []
    var idOrder = state.officeOrder.employeeOrder[key]
    if (Array.isArray(idOrder)) {
      /* order 里的 id 按序在前（已删的跳过），未列出的按名字追加在后 */
      var first = []
      idOrder.forEach(function (id) {
        var hit = members.find(function (employee) {
          return String(employee.id || '') === id
        })
        if (hit !== undefined) first.push(hit)
      })
      var restMembers = members.filter(function (employee) {
        return idOrder.indexOf(String(employee.id || '')) < 0
      })
      members = first.concat(restMembers)
    }
    return { key: key, name: key === '' ? '未分组' : key, members: members }
  })
}

function loadOfficeOrder() {
  if (state.phase !== 'ready' || state.scopes.indexOf('employee.read') < 0) return
  rpc('office.order.get', {})
    .then(function (payload) {
      state.officeOrder = {
        groupOrder: Array.isArray(payload.groupOrder) ? payload.groupOrder : [],
        employeeOrder:
          payload !== null && typeof payload === 'object' && typeof payload.employeeOrder === 'object' && payload.employeeOrder !== null
            ? payload.employeeOrder
            : {}
      }
      renderEmployees()
      if (typeof renderSessions === 'function') renderSessions()
    })
    .catch(function (error) {
      reportRpcError('office.order.get', error)
    })
}

/* 上移/下移一对小按钮（组标题与工位卡共用） */
function buildOrderButtons(onMove) {
  var box = el('span', 'ord-btns')
  var up = el('button', '', '↑')
  var down = el('button', '', '↓')
  up.onclick = function (event) {
    event.stopPropagation()
    onMove(-1)
  }
  down.onclick = function (event) {
    event.stopPropagation()
    onMove(1)
  }
  box.appendChild(up)
  box.appendChild(down)
  return box
}

function swapAdjacent(list, index, dir) {
  var target = index + dir
  if (index < 0 || target < 0 || target >= list.length) return null
  var next = list.slice()
  var tmp = next[index]
  next[index] = next[target]
  next[target] = tmp
  return next
}

function moveGroup(key, dir) {
  var keys = officeSections().map(function (section) {
    return section.key
  })
  var next = swapAdjacent(keys, keys.indexOf(key), dir)
  if (next === null) return
  saveOfficeOrder(next, state.officeOrder.employeeOrder)
}

function moveEmployee(groupKey, employeeId, dir) {
  var section = officeSections().find(function (item) {
    return item.key === groupKey
  })
  if (section === undefined) return
  var ids = section.members.map(function (employee) {
    return String(employee.id || '')
  })
  var next = swapAdjacent(ids, ids.indexOf(employeeId), dir)
  if (next === null) return
  var employeeOrder = {}
  Object.keys(state.officeOrder.employeeOrder).forEach(function (key) {
    employeeOrder[key] = state.officeOrder.employeeOrder[key]
  })
  employeeOrder[groupKey] = next
  saveOfficeOrder(state.officeOrder.groupOrder, employeeOrder)
}

/* 本地先应用（不等回包），再持久化；office.order.changed 事件回环会再同步一次，幂等 */
function saveOfficeOrder(groupOrder, employeeOrder) {
  state.officeOrder = { groupOrder: groupOrder.slice(), employeeOrder: employeeOrder }
  renderEmployees()
  rpc('office.order.set', { groupOrder: groupOrder, employeeOrder: employeeOrder }).catch(function (error) {
    reportRpcError('office.order.set', error)
  })
}

/* ── 给已有分组改名 ──
 *
 * 为什么"改名"是一次**批量写**而不是改一个字段：分组不是实体，它只是每个员工工作区里
 * .dsemployee/employee.json 的 group 字段（见 groupKeyOf）。所以把「A 组」改成「B 组」
 * ＝ 逐个调 employee.update { employeeId, group:'B' }。没有别的地方要动：
 * AGENTS.md 不含 group（renderAgentsMd 只用 name/role/intro），Hub 侧只是目录缓存。
 *
 * 由此带来两个必须如实处理的后果：
 *   1. 员工可能分散在**多台节点**上，其中一台离线就会部分失败 —— 那就如实报告几个成功、
 *      几个失败、卡在谁身上，并且**不**假装原子成功（本仓库一贯的"失败要响"）；
 *   2. 目标名与已有分组重名时，语义上就是**并入**（两组成员合一，谁都不会丢）。
 *      做成"拒绝重名"反而会挖一个坑：部分失败后再试一次，目标组已存在，就永远改不动了。
 *      所以这里并入，并在提示里说清是"并入"而不是"改名"。
 */

/** 分组名的唯一校验口：trim 后非空、≤64 字（与 Hub 侧 employee.update 的 schema 上限一致）。 */
function normalizeGroupName(raw) {
  var name = String(raw === undefined || raw === null ? '' : raw).trim()
  if (name === '') return null
  if (name.length > 64) return null
  return name
}

/**
 * 排序偏好里的 from 键改名成 to（纯函数，便于单测）。
 *
 * 为什么必须迁移：officeSections() 只用偏好里的键**排序**，键对不上就掉进"按名字排"的
 * 末尾 —— 用户改个名却发现分组跑到最后，会以为排序被弄丢了。
 * 目标是已存在的组时：groupOrder 去重保首个位置，employeeOrder 两组 id 依次拼接
 * （id 全局唯一，不会重复），这样并入后组成员仍按各自的既有顺序排。
 */
function renameGroupInOrder(prefs, from, to) {
  var groupOrder = []
  var source = prefs !== null && typeof prefs === 'object' && Array.isArray(prefs.groupOrder) ? prefs.groupOrder : []
  source.forEach(function (key) {
    var next = key === from ? to : key
    if (groupOrder.indexOf(next) < 0) groupOrder.push(next)
  })
  var employeeOrder = {}
  var sourceIds =
    prefs !== null && typeof prefs === 'object' && prefs.employeeOrder !== null && typeof prefs.employeeOrder === 'object'
      ? prefs.employeeOrder
      : {}
  Object.keys(sourceIds).forEach(function (key) {
    var next = key === from ? to : key
    var ids = Array.isArray(sourceIds[key]) ? sourceIds[key] : []
    employeeOrder[next] = (employeeOrder[next] || []).concat(ids)
  })
  return { groupOrder: groupOrder, employeeOrder: employeeOrder }
}

/**
 * 把 fromKey 这组员工的 group 改成 rawName。
 * 全成功 → 排序键跟着迁移；**部分失败 → 不动偏好**（老键对剩下的成员仍然有效，
 * 用户看得到"还有几个人没改过来"，再执行一次即可继续），返回 false。
 */
function renameGroup(fromKey, rawName) {
  var name = normalizeGroupName(rawName)
  if (name === null) {
    setBanner('分组名不能为空，且最多 64 字', 'bad')
    return Promise.resolve(false)
  }
  if (name === fromKey) return Promise.resolve(false)
  if (state.scopes.indexOf('employee.manage') < 0) {
    setBanner('需要 employee.manage 权限才能改分组名', 'bad')
    return Promise.resolve(false)
  }
  var members = state.employees.filter(function (employee) {
    return groupKeyOf(employee) === fromKey
  })
  if (members.length === 0) {
    setBanner('「' + fromKey + '」下没有员工，无需改名', 'warn')
    return Promise.resolve(false)
  }
  var merging = listGroupNames().indexOf(name) >= 0
  var done = 0
  var failed = []
  /* 串行：这些请求会转发到各节点去改工作区文件，别在同一台节点上打并发尖峰 */
  var chain = Promise.resolve()
  members.forEach(function (employee) {
    chain = chain.then(function () {
      return rpc('employee.update', { employeeId: String(employee.id || ''), group: name })
        .then(function (payload) {
          pushRaw('employee.update（分组）结果', payload)
          done += 1
        })
        .catch(function (error) {
          failed.push(String(employee.name || employee.id || '?') + '：' + describeError(error))
        })
    })
  })
  return chain.then(function () {
    if (failed.length === 0) {
      var next = renameGroupInOrder(state.officeOrder, fromKey, name)
      saveOfficeOrder(next.groupOrder, next.employeeOrder)
    }
    return loadEmployees().then(function () {
      if (failed.length > 0) {
        var head = (merging ? '并入「' + name + '」' : '改名') + '部分完成'
        setBanner(
          head + '：' + done + '/' + members.length + ' 个员工已更新，' + failed.length + ' 个失败（' +
            failed[0] + '）。排序偏好未改动 —— 修好后可以再执行一次。',
          'bad',
        )
        toast(head + '：' + failed[0], 'bad')
        return false
      }
      toast(
        merging
          ? '已把「' + fromKey + '」并入「' + name + '」（' + done + ' 人）'
          : '分组「' + fromKey + '」已改名为「' + name + '」（' + done + ' 人）',
        'ok',
      )
      return true
    })
  })
}

/**
 * "正在给这一组改名"的意图（null=没有），形状 { key, value }。
 *
 * 为什么需要它：办公区会被**很多**事件重建 —— 工位轮询（3–8s）、employee.changed、
 * 改排序、员工目录刷新。而"改名部分失败"恰好会触发 employee.changed（各节点重新上报目录），
 * 于是任何"失败后手动把编辑器打开一次"的做法都会被紧接着的那次重建抹掉（实测确认）。
 * 正确做法是把意图记在渲染之外：谁重建都由 renderEmployees 收尾按它恢复现场，
 * 连用户已敲进去的内容一起恢复。
 */
var groupRenameIntent = null

/** 组头右侧那支笔。空分组（未分组）不给 —— "未分组"不是一个可写的字段。 */
function buildGroupRenameButton(section, head) {
  var button = el('button', 'ghost group-rename', '✎')
  button.type = 'button'
  button.title = '给分组「' + section.name + '」改名'
  button.setAttribute('aria-label', '给分组改名')
  button.onclick = function (event) {
    event.stopPropagation()
    startGroupRename(section, head)
  }
  return button
}

/** 行内改名编辑器：Enter 提交、Esc 取消、失焦取消（与「会话改名」同一套约定）。 */
function startGroupRename(section, head, initialValue) {
  var nameNode = head.querySelector('.office-group-name')
  if (nameNode === null) return
  var start = typeof initialValue === 'string' ? initialValue : section.key
  var editor = el('span', 'group-rename-editor')
  var input = el('input', '')
  input.type = 'text'
  input.value = start
  groupRenameIntent = { key: section.key, value: start }
  input.maxLength = 64
  input.placeholder = '分组名（最多 64 字）'
  input.setAttribute('aria-label', '分组名')
  var save = el('button', 'primary', '保存')
  save.type = 'button'
  var busy = false
  var cancelled = false
  function cancel() {
    if (busy) return
    cancelled = true
    groupRenameIntent = null
    renderEmployees()
  }
  /** 提交在途的视觉反馈。**注意不能用 input.disabled** —— 给一个正获得焦点的输入框
      置 disabled 会当场触发 blur，而 blur 走的是"取消"那条路（实测：那样会让下面的
      cancelled 变真，于是部分失败后的"重开编辑器"被自己挡掉）。所以只切换类，不禁用。 */
  function setEditorBusy(on) {
    editor.classList.toggle('busy', on)
    save.disabled = on
  }
  function submit() {
    if (busy || cancelled) return
    if (normalizeGroupName(input.value) === null) {
      toast('分组名不能为空，且最多 64 字', 'warn')
      return
    }
    var attempted = String(input.value || '')
    /* 意图跟到"这一次提交的内容"上：人打字时 input 事件本来就在同步，但**程序化改值
       （不触发 input 事件）不会** —— 实测踩到：部分失败后编辑器恢复了，值却是打开时的旧名字。
       提交这一瞬间同步一次，恢复的必然是用户刚才要改成的名字。 */
    groupRenameIntent = { key: section.key, value: attempted }
    busy = true
    setEditorBusy(true)
    renameGroup(section.key, attempted).then(function (ok) {
      busy = false
      setEditorBusy(false)
      if (ok === true) {
        groupRenameIntent = null
        renderEmployees()
        return
      }
      /* 走到这里说明"批次跑过了但没全成"：renameGroup 内部的 loadEmployees 已经重建过一次
         办公区，而各节点还会因这次改动重新上报目录（employee.changed）再触发一次重建 ——
         所以**不在这里手动重开编辑器**，那会被紧接着的重建抹掉（实测确认过）。
         改由 renderEmployees 收尾时按 groupRenameIntent 恢复现场，见 restoreGroupRenameEditor。 */
      pushRaw('分组改名未全成：编辑器将随下一次重绘自动恢复', {
        group: section.key,
        attempted: attempted,
      })
    })
  }
  /* 打字时同步意图：任何一次重建都要把用户**已经敲进去的内容**一起恢复，
     而不是恢复成打开时那个旧名字 */
  input.oninput = function () {
    if (groupRenameIntent !== null) groupRenameIntent.value = String(input.value || '')
  }
  input.onkeydown = function (event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key !== 'Enter') return
    /* 输入法组词中的 Enter 是选字，不是提交 */
    if (event.isComposing === true || event.keyCode === 229) return
    event.preventDefault()
    submit()
  }
  save.onclick = submit
  /* mousedown 先 preventDefault：否则点「保存」会先把输入框 blur 掉，而 blur 是取消 */
  save.onmousedown = function (event) {
    event.preventDefault()
  }
  input.onblur = function () {
    if (busy !== true) cancel()
  }
  editor.appendChild(input)
  editor.appendChild(save)
  nameNode.parentNode.replaceChild(editor, nameNode)
  input.focus()
  input.select()
}

/**
 * 重开改名编辑器（部分失败后用）：在**重建后的 DOM** 里按组名找到那一组的组头，
 * 把编辑器连同"刚才输入的名字"一起打开。
 *
 * 为什么需要它：部分失败时 renameGroup 内部的 loadEmployees → renderEmployees 会把整个
 * 办公区重建，原来那个编辑器节点已经不在文档里 —— 用户会觉得"一点保存，编辑器就没了，
 * 也不说清到底改没改成"。重开一次就变成"编辑器还在、值还留着、改完直接回车续做"。
 * 传进去的 section 只用 key（startGroupRename 读的也是 key），所以这里给个最小对象即可。
 */
function restoreGroupRenameEditor() {
  if (groupRenameIntent === null) return
  var intent = groupRenameIntent
  var blocks = document.querySelectorAll('.office-group')
  for (var i = 0; i < blocks.length; i += 1) {
    var nameNode = blocks[i].querySelector('.office-group-name')
    if (nameNode === null || nameNode.textContent !== intent.key) continue
    var head = blocks[i].querySelector('.office-group-head')
    if (head === null) {
      groupRenameIntent = null
      return
    }
    startGroupRename({ key: intent.key }, head, intent.value)
    return
  }
  /* 那一组已不在页面上（改名成功 / 被并入 / 员工被删）：意图作废，别再弹回来 */
  groupRenameIntent = null
}

/* ── 工位状态：忙碌轮询、未读红点、小屏滚屏 ──
 *
 * 数据通路的选择：Hub 没有"会话变忙/变闲"的广播（节点也只转发**已订阅**会话的
 * 事件，见 agent.ts 的 pushSessionEvent），新加一路广播要动协议与节点 ——
 * 而 session.list 是现成的、语义正好。于是：对每个员工轮询 session.list 拿
 * running 标志，再只对**正在 running 的那个会话**做 session.subscribe 拿实时事件
 * 喂小屏与未读。不给每个员工常驻订阅空会话：那会让节点为永远不会有事件的会话
 * 白维持 watch，纯属泄漏。
 *
 * 节奏是自适应的（setTimeout 链而不是固定 setInterval）：有人忙 3s 一轮，
 * 尽快捕捉收尾与换订；全闲 8s 一轮压底噪。订阅建立后立刻用一小页
 * session.history 回填小屏 —— 轮询有粒度，回合开始后的头几秒 delta 注定错过，
 * 不回填的话小屏在回合前半段（往往全是工具调用）会一直空白。
 */

var DESK_POLL_IDLE_MS = 8000
/** 工位「疑似卡死」的阈值：与聊天页回合看门狗一致（3 分钟）。 */
var DESK_STALL_MS = 180000
var DESK_POLL_BUSY_MS = 3000

function startDeskPolling() {
  stopDeskPolling()
  pollDeskStatus()
}

function stopDeskPolling() {
  if (state.deskPollTimer !== null) {
    clearTimeout(state.deskPollTimer)
    state.deskPollTimer = null
  }
}

function pollDeskStatus() {
  if (state.phase !== 'ready' || state.scopes.indexOf('employee.read') < 0) return
  /* 串行而不是 Promise.all：这些请求会转发到各节点的 dsh，别打出尖峰 */
  var chain = Promise.resolve()
  state.employees.slice().forEach(function (employee) {
    chain = chain.then(function () {
      return pollOneDesk(employee)
    })
  })
  chain.then(function () {
    /* 员工被删或变闲后，残留的订阅要摘掉 */
    Object.keys(state.deskWatch).forEach(function (employeeId) {
      var info = state.desk[employeeId]
      if (info === undefined || info.busy !== true) deskUnsubscribe(employeeId)
    })
    maybeRenderDesks()
    /* 排下一轮：先清掉可能并存的定时器（页面从后台切回时会手动触发一轮），
       保证任何时刻至多一个在途 */
    if (state.deskPollTimer !== null) {
      clearTimeout(state.deskPollTimer)
      state.deskPollTimer = null
    }
    if (state.phase !== 'ready') return
    var anyBusy = Object.keys(state.desk).some(function (id) {
      return state.desk[id].busy === true
    })
    state.deskPollTimer = setTimeout(
      function () {
        state.deskPollTimer = null
        pollDeskStatus()
      },
      anyBusy ? DESK_POLL_BUSY_MS : DESK_POLL_IDLE_MS
    )
  })
}

function pollOneDesk(employee) {
  var id = String(employee.id || '')
  if (id === '') return Promise.resolve()
  if (employee.available === false) {
    state.desk[id] = { busy: false, sessionId: null }
    syncDeskWatch(id)
    return Promise.resolve()
  }
  var sessionRevision = typeof employeeSessionState === 'function' ? employeeSessionState(id).revision || 0 : 0
  return rpc('session.list', { employeeId: id })
    .then(function (payload) {
      var sessions = pickArray(payload, ['sessions', 'items', 'list'])
      if (typeof cacheEmployeeSessions === 'function') cacheEmployeeSessions(id, sessions, sessionRevision)
      /* 同一员工多个 running 会话时取最近更新的一个 —— 小屏只有一块，显示此刻最活跃的 */
      var best = null
      sessions.forEach(function (session) {
        if (session === null || typeof session !== 'object' || session.running !== true) return
        var sid = sessionIdOf(session)
        if (sid === '') return
        var updated =
          typeof session.updatedAt === 'number'
            ? session.updatedAt
            : typeof session.updatedAtMs === 'number'
              ? session.updatedAtMs
              : 0
        var lastEvent = typeof session.lastEventAtMs === 'number' ? session.lastEventAtMs : null
        if (best === null || updated > best.updated) {
          best = { sessionId: sid, updated: updated, lastEventAtMs: lastEvent }
        }
      })
      state.desk[id] = {
        busy: best !== null,
        sessionId: best === null ? null : best.sessionId,
        lastEventAtMs: best === null ? null : best.lastEventAtMs
      }
      syncDeskWatch(id)
    })
    .catch(function () {
      /* 节点掉线/转发失败：按空闲处理，下一轮轮询再纠 */
      state.desk[id] = { busy: false, sessionId: null }
      syncDeskWatch(id)
    })
}

/**
 * 这个工位是不是「疑似卡死」：回合在跑，却已经很久没有任何事件。
 *
 * 与聊天页那个看门狗**同一个阈值**（3 分钟）与同一个理由：dsh 侧卡住时不会有
 * turn/end，界面就一直显示「运行中」，用户不知道该等还是该处理。区别在于 ——
 * 聊天页的看门狗只在你**正开着那个对话**时才提示，而线上事故恰恰发生在没人盯着的
 * 会话上（员工卡在 bash 上，工位一直显示忙碌，谁都没发现）。所以这里补工位级的。
 *
 * 没有 lastEventAtMs（旧节点不报这个字段）时一律返回 null：不猜、也不误报。
 */
function deskStallMs(info) {
  if (info === undefined || info.busy !== true) return null
  if (typeof info.lastEventAtMs !== 'number' || info.lastEventAtMs <= 0) return null
  var idleMs = Date.now() - info.lastEventAtMs
  return idleMs >= DESK_STALL_MS ? idleMs : null
}

/* 订阅生命周期：跟着"忙碌会话"走 —— 忙才订，闲即退，目标会话换了就换订 */
function syncDeskWatch(employeeId) {
  var info = state.desk[employeeId]
  var want = info !== undefined && info.busy === true ? info.sessionId : null
  var have = state.deskWatch[employeeId]
  if (have !== undefined && have !== want) deskUnsubscribe(employeeId)
  if (want !== null && state.deskWatch[employeeId] !== want) deskSubscribe(employeeId, want)
}

function deskSubscribe(employeeId, sessionId) {
  state.deskWatch[employeeId] = sessionId
  rpc('session.subscribe', { employeeId: employeeId, sessionId: sessionId })
    .then(function () {
      if (state.deskWatch[employeeId] !== sessionId) return
      backfillDeskTail(employeeId, sessionId)
    })
    .catch(function (error) {
      /* 订阅失败就当没订上，下一轮轮询会重试 */
      if (state.deskWatch[employeeId] === sessionId) delete state.deskWatch[employeeId]
      pushRaw('工位订阅失败 ' + employeeId, error)
    })
}

/* 订阅成功后回填一小页历史：轮询发现忙碌有最多数秒的延迟，回合开头的事件
   已经错过；不回填的话小屏要等下一条实时事件才有内容（工具调用阶段可能
   几十秒没有 assistant 文本）。已有实时输出（tail 非空）就不覆盖。 */
function backfillDeskTail(employeeId, sessionId) {
  rpc('session.history', { employeeId: employeeId, sessionId: sessionId, maxEvents: 60 })
    .then(function (payload) {
      if (state.deskWatch[employeeId] !== sessionId) return
      if ((state.deskTail[employeeId] || []).length > 0) return
      var events = pickArray(payload, ['events', 'items', 'messages', 'history'])
      events.forEach(function (item) {
        var n = normalizeEvent(item)
        /* 回填跳过流式增量碎片：同一段文本会以 assistant/message 定稿再出现一次 */
        if (n.kind === 'assistant' && n.stream === 'delta') return
        var line = deskLineOf(n)
        if (line !== '') appendDeskTail(employeeId, line)
      })
    })
    .catch(function () {
      /* 回填失败（历史过大/节点重连中）不致命：等实时事件即可 */
    })
}

/* 归一化事件 → 小屏上的一行。空串 = 不值得上屏（ping、投影、内部帧）。
   小屏的定位是"正在做什么"：assistant 文本之外，工具调用/回合起止也喂进来，
   否则纯工具阶段（往往占回合大头）屏上什么都没有 —— 实测曾因此整屏空白。 */
function deskLineOf(n) {
  if (n.kind === 'assistant') {
    /* block 与 delta 同文，跳过避免重影（与 onSessionEvent 的约定一致） */
    if (n.stream === 'block') return ''
    return n.text
  }
  if (n.kind === 'tool') {
    if (n.phase === 'call') return '调用 ' + n.name + deskToolBrief(n.detail)
    return n.name + (n.failed === true ? ' 失败' : ' 完成')
  }
  if (n.kind === 'error') return '回合失败：' + n.text
  if (n.kind === 'interaction') {
    if (n.phase === 'resolved') return n.text
    return n.what === 'approval' ? '⏸ 等你批准' + (n.toolName === '' ? '' : '：' + n.toolName) : '❓ 等你回答'
  }
  if (n.kind === 'status' && n.text !== '') return n.text
  if (n.type === 'turn/start') return '开始处理…'
  return ''
}

/* 工具参数里挑一条最像"在干什么"的短文本（命令/路径/查询词），没有就算了。
   dsh 的 tool/call 把参数嵌在 data.message.content[i] 里（实测 docs/04 §10.3），
   所以递归向下找，深度钳在 4 层，避免在大 payload 里漫游。 */
function deskToolBrief(detail) {
  if (typeof detail !== 'string' || detail === '') return ''
  var value
  try {
    value = JSON.parse(detail)
  } catch (error) {
    return ''
  }
  /* dsh 实测：tool/call 的 arguments 本身是 JSON **字符串**（docs/04 §10.3），
     经 safeJson 再包一层后是双重编码 —— 解出字符串就再 parse 一次 */
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (error) {
      return ''
    }
  }
  var found = deskToolBriefFind(value, 0)
  return found === '' ? '' : ' · ' + found
}

var DESK_TOOL_BRIEF_KEYS = ['command', 'cmd', 'path', 'filePath', 'file', 'url', 'query', 'pattern', 'prompt', 'description', 'title']

function deskToolBriefFind(value, depth) {
  if (value === null || typeof value !== 'object' || depth > 3) return ''
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i += 1) {
      var fromItem = deskToolBriefFind(value[i], depth + 1)
      if (fromItem !== '') return fromItem
    }
    return ''
  }
  for (var k = 0; k < DESK_TOOL_BRIEF_KEYS.length; k += 1) {
    var v = value[DESK_TOOL_BRIEF_KEYS[k]]
    if (typeof v === 'string' && v.trim() !== '') return v.trim().split('\n')[0].slice(0, 60)
  }
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    var fromChild = deskToolBriefFind(value[key], depth + 1)
    if (fromChild !== '') return fromChild
  }
  return ''
}

function deskUnsubscribe(employeeId) {
  var sessionId = state.deskWatch[employeeId]
  if (sessionId === undefined) return
  delete state.deskWatch[employeeId]
  /* 注意：服务端的订阅是连接级共享集合。若用户正在聊天视图里看的恰好是这个会话，
     这里退订会把聊天的事件流一起掐掉 —— 那种情况跳过，聊天的退订由聊天自己管。 */
  if (state.view === 'chat' && state.selectedSessionId === sessionId) return
  rpc('session.unsubscribe', { employeeId: employeeId, sessionId: sessionId }).catch(function () {})
}

function employeeOfDeskWatch(sessionId) {
  var ids = Object.keys(state.deskWatch)
  for (var i = 0; i < ids.length; i += 1) {
    if (state.deskWatch[ids[i]] === sessionId) return ids[i]
  }
  return null
}

function deskSignature() {
  var parts = []
  state.employees.forEach(function (employee) {
    var id = String(employee.id || '')
    var info = state.desk[id]
    parts.push(id + ':' + (info !== undefined && info.busy === true ? '1' : '0'))
  })
  /* 排序模式与排序偏好都算进签名：点了上移/退出排序必须触发重绘 */
  return parts.join('|') + '|' + (state.orderMode === true ? 'R' : '') + JSON.stringify(state.officeOrder)
}

/**
 * 办公区里是否有**正在编辑**的行内编辑器（工位「编辑」面板 / 分组改名）。
 *
 * 为什么需要这个判断：原来 maybeRenderDesks 只比状态签名，签名变了就重建 ——
 * 而工位轮询每 3–8 秒刷新一次忙闲，**一次忙闲变化就能把用户正在填的编辑器连同输入一起收掉**
 * （本次实测：点开「给分组改名」后，几秒内编辑器就被一次轮询清掉）。签名只能挡"什么都没变"，
 * 挡不住"变了、但不是非重建不可"。
 */
function officeHasOpenEditor() {
  if (document.querySelector('.group-rename-editor') !== null) return true
  var panels = document.querySelectorAll('.desk-group-edit')
  for (var i = 0; i < panels.length; i += 1) {
    if (panels[i].classList.contains('hidden') !== true) return true
  }
  return false
}

function maybeRenderDesks() {
  /* 有编辑器开着就**不重建**：用户正在输入时把 DOM 换掉是最糟的一种"自动更新"。
     代价是这几秒内工位的忙闲徽章不刷新 —— deskSig 故意不更新，等编辑器关掉后的
     下一次轮询自然补上这次重绘。 */
  if (officeHasOpenEditor()) return
  var sig = deskSignature()
  if (sig !== state.deskSig) {
    renderEmployees()
    paintAllDeskScreens()
  }
}

/* ── 未读红点 ──
 *
 * 存的是"计数"而不是事件序号游标：dsh 的会话事件形状未定稿，没有可靠序号；
 * 而未读只在"在线且订阅期间"产生 —— 计数本身就是游标，进对话框即清零。
 * 持久化到 localStorage，刷新页面不丢。
 */

function loadUnread() {
  try {
    var raw = readLocal(LS.unread)
    if (raw === null || raw === '') return
    var parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return
    Object.keys(parsed).forEach(function (id) {
      var n = Number(parsed[id])
      if (Number.isFinite(n) && n > 0) state.unread[id] = Math.min(Math.floor(n), 999)
    })
  } catch (error) {
    /* 本地数据损坏即丢弃，未读数丢了不是大事 */
  }
}

function saveUnread() {
  writeLocal(LS.unread, JSON.stringify(state.unread))
}

function bumpUnread(employeeId) {
  state.unread[employeeId] = (state.unread[employeeId] || 0) + 1
  saveUnread()
  paintUnread(employeeId)
}

function clearUnread(employeeId) {
  if ((state.unread[employeeId] || 0) === 0) return
  delete state.unread[employeeId]
  saveUnread()
  paintUnread(employeeId)
}

/* 红点只原地增删，不触发整个办公区重建 */
function paintUnread(employeeId) {
  var desk = document.querySelector('.desk[data-emp="' + employeeId + '"]')
  if (desk === null) return
  var dot = desk.querySelector('.desk-unread')
  var count = state.unread[employeeId] || 0
  if (count <= 0) {
    if (dot !== null && dot.parentNode !== null) dot.parentNode.removeChild(dot)
    return
  }
  if (dot === null) {
    dot = el('span', 'desk-unread')
    desk.appendChild(dot)
  }
  dot.textContent = count > 99 ? '99+' : String(count)
}

/* ── 工位小屏（显示器区域滚屏）── */

function appendDeskTail(employeeId, text) {
  var lines = String(text).split('\n')
  var tail = state.deskTail[employeeId]
  if (tail === undefined) {
    tail = []
    state.deskTail[employeeId] = tail
  }
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i].replace(/\s+$/, '')
    if (line.trim() === '') continue
    tail.push(line.slice(0, 200))
  }
  while (tail.length > 6) tail.shift()
  state.deskDirty[employeeId] = true
  scheduleDeskPaint()
}

/* text-delta 可能每几十毫秒就来一条：攒 100ms 一批再碰 DOM，而不是每个 delta 都改 */
function scheduleDeskPaint() {
  if (state.deskPaintTimer !== null) return
  state.deskPaintTimer = setTimeout(function () {
    state.deskPaintTimer = null
    paintDeskScreens()
  }, 100)
}

function paintDeskScreens() {
  var ids = Object.keys(state.deskDirty)
  state.deskDirty = {}
  ids.forEach(function (employeeId) {
    paintDeskScreen(employeeId)
  })
}

function paintAllDeskScreens() {
  Object.keys(state.deskTail).forEach(function (employeeId) {
    paintDeskScreen(employeeId)
  })
}

/* 小屏内容的唯一填充入口：buildDesk 首绘与 paintDeskScreen 增量重绘都走这里。
   忙时滚屏最新输出；闲时保留最近一次输出（屏常驻，不随忙闲出现/消失）；
   从未有过输出时显示占位「空闲中」。最新一行锚在底部（flex-end）。 */
function fillDeskScreen(screen, employeeId, busy) {
  clear(screen)
  screen.classList.toggle('idle', busy !== true)
  var info = state.desk[employeeId]
  var stalled = deskStallMs(info)
  if (stalled !== null) {
    /* 卡住时小屏上先给结论，再给最后的输出 —— 否则用户盯着一段不再变化的文字
       只会以为"还在跑"。第一行写清楚 + 该按「停止」。 */
    /* 徽章只陈述事实（"X 分钟无输出"），这里才给判断与下一步 ——
       一段跑了几分钟的 build 与一个卡死的回合在数据上长得一样，别把结论当事实说。 */
    screen.appendChild(
      el(
        'div',
        'desk-screen-line stall',
        formatIdleMinutes(stalled) + '没有任何输出：可能在跑长命令，也可能卡住了（可在对话里点停止）',
      ),
    )
  }
  var tail = state.deskTail[employeeId] || []
  if (tail.length === 0 && stalled === null) {
    screen.appendChild(el('div', 'desk-screen-line dim', '空闲中'))
    return
  }
  tail.slice(-6).forEach(function (line) {
    screen.appendChild(el('div', 'desk-screen-line', line))
  })
}

/* 员工 id 是服务端生成的 emp_xxx 形式，直接拼选择器是安全的 */
function paintDeskScreen(employeeId) {
  var desk = document.querySelector('.desk[data-emp="' + employeeId + '"]')
  if (desk === null) return
  var screen = desk.querySelector('.desk-screen')
  if (screen === null) return
  var info = state.desk[employeeId]
  fillDeskScreen(screen, employeeId, info !== undefined && info.busy === true)
}
`
