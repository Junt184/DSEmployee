/**
 * 控制台脚本片段：岗位面板：技能台账三张图 + 周报归档
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
export const CHUNK_80_PANELS = String.raw`
/* ═══════════ 9.7 岗位面板：技能台账（员工维护数据 / 前端只读渲染）═══════════
 *
 * 面向「汇报助理」（小艾）。这一页要回答的不是"这周干了多少小时" —— 日报口径里
 * "不满 8 小时也得写 8 小时"，绝对值已经被污染；要回答的是**这一周的投入里有多少
 * 落在刚接触的新东西上**：边干边成长，还是纯干。
 *
 * 三条边界，越界就会长成一个没人维护的假仪表盘：
 *   1. **数据由员工自己维护**（她生成周报时顺带更新工作区里的 memory/ref/技能表.json）。
 *      控制台只读、不提供编辑：一处可写，就不存在两边打架。
 *   2. **面板由岗位决定**：岗位目录（Hub 侧 positions.json）的 panels 写面板 id，
 *      控制台有一张 id → 渲染函数的注册表。不认识的 id **如实显示出来**，不静默跳过 ——
 *      静默跳过等于"配了但没出现"，没人查得出来。
 *   3. **图表是前端渲染**（每次从文件现算），不落任何后端状态；数据留在工作区文件里，
 *      这本身就是"归档留存"。
 *
 * 版面前提：这些块只出现在右栏，而右栏按现有断点出现（≥1200px 三栏；641–1199px 且
 * 高度 ≥500px 两栏；手机与矮屏没有右栏）。所以"手机上不做"不需要额外代码 ——
 * 窄屏这一页本来就只有对话。
 */

/** 台账文件路径（员工维护、控制台只读）。 */
var SKILL_TABLE_PATH = 'memory/ref/技能表.json'
/** 周报归档目录（她写进去，控制台只列出来）。 */
var REPORT_ARCHIVE_DIR = '周报'
/** 图表窗口：最近 8 周。三张图共用同一个时间尺度，免得互相打架。 */
var SKILL_WINDOW_WEEKS = 8
/** 「新技能」口径：首现 ≤4 周（含本周）。 */
var SKILL_NEW_WEEKS = 4
/** 「深耕」口径：同一技能连续 ≥3 周都有投入。 */
var SKILL_DEEP_WEEKS = 3
/** 每周占比合计的容差（±1 个百分点内算正常，超了就如实报出来）。 */
var SKILL_PCT_TOLERANCE = 1.5
var WEEK_RE = /^(\d{4})-W(\d{2})$/
var SVG_NS = 'http://www.w3.org/2000/svg'

/* ── 周键工具（全部按 UTC 算，"今天是第几周"是唯一的本地时间入口）── */

/**
 * 日期 → ISO 周键（'2026-W39'）。
 *
 * 为什么需要它：图表窗口是"最近 8 周"，周键要能**连续推演**（跨年、跨月都得对）。
 * 为什么按 UTC：「weekKeyToTime」 返回周一 00:00 UTC 的毫秒，若再用本地字段去读它，
 * 西半球时区会落到"上一周的周日"，整张图错一格而且不容易看出来。所以除了
 * 「currentWeekKey()」（把本地"今天"的 Y/M/D 装进 UTC），其余一律按 UTC 算。
 */
function weekKeyOf(date) {
  var day = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
  /* 移到同一 ISO 周的周四：ISO 规定"含当年第一个周四的那一周是 W01" */
  var thursday = new Date(date.getTime() + (4 - day) * 86400000)
  var year = thursday.getUTCFullYear()
  var yearStart = Date.UTC(year, 0, 1)
  var week = Math.ceil(((thursday.getTime() - yearStart) / 86400000 + 1) / 7)
  return String(year) + '-W' + (week < 10 ? '0' + String(week) : String(week))
}

/** 本地"今天"是第几周 —— 全流程唯一读本地时间的地方。 */
function currentWeekKey() {
  var now = new Date()
  return weekKeyOf(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())))
}

/** 周键 → 那一周**周一** 00:00 UTC 的毫秒；非法返回 null。 */
function weekKeyToTime(key) {
  var text = key === undefined || key === null ? '' : String(key)
  var match = WEEK_RE.exec(text)
  if (match === null) return null
  var year = Number(match[1])
  var week = Number(match[2])
  if (week < 1 || week > 53) return null
  /* 1 月 4 日必定在 W01；W01 的周一 = 1 月 4 日所在周的周一 */
  var jan4 = new Date(Date.UTC(year, 0, 4))
  var jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay()
  return jan4.getTime() - (jan4Day - 1) * 86400000 + (week - 1) * 7 * 86400000
}

/** 周键前后挪 delta 周（跨年不用特判：周键自带年份）。 */
function weekKeyShift(key, delta) {
  var time = weekKeyToTime(key)
  if (time === null) return ''
  return weekKeyOf(new Date(time + delta * 7 * 86400000))
}

/** from 到 to 差几周（to 更晚为正）；任一非法返回 null。 */
function weeksBetween(fromKey, toKey) {
  var from = weekKeyToTime(fromKey)
  var to = weekKeyToTime(toKey)
  if (from === null || to === null) return null
  return Math.round((to - from) / (7 * 86400000))
}

/** 连续 count 周的周键，旧的在前、含 endKey 那一周。 */
function recentWeekKeys(endKey, count) {
  var keys = []
  for (var i = count - 1; i >= 0; i -= 1) keys.push(weekKeyShift(endKey, -i))
  return keys
}

/** '2026-W39' → 'W39'（图表里列宽只有十几像素）。 */
function shortWeek(key) {
  var text = key === undefined || key === null ? '' : String(key)
  var match = WEEK_RE.exec(text)
  return match === null ? text : 'W' + match[2]
}

/* ── 台账解析与校验（纯函数，可单独测）── */

function round1(value) {
  return Math.round(Number(value) * 10) / 10
}

/**
 * 解析技能台账，返回 「{ ok: true, table }」 或 「{ ok: false, reason }」。
 *
 * 校验到什么程度：JSON 能解析、「updatedWeek」 / 「skills」 齐、周键格式对、
 * 占比是 0–100 的数，以及**每一周的占比合计 ≈ 100**。
 * 最后一条是"她写漏了/写重了"唯一能自动发现的信号，所以**不修不猜、如实报出来**：
 * 图表照画，但块里挂一条黄字（「issues」 / 「sumIssues」）。
 */
function parseSkillTable(text) {
  var raw = text === undefined || text === null ? '' : String(text)
  if (raw.trim() === '') return { ok: false, reason: 'empty' }
  var data = null
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: 'bad-json' }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'bad-shape' }
  var updatedWeek = typeof data.updatedWeek === 'string' ? data.updatedWeek.trim() : ''
  if (WEEK_RE.exec(updatedWeek) === null) return { ok: false, reason: 'bad-week' }
  var skills = data.skills
  if (skills === null || typeof skills !== 'object' || Array.isArray(skills)) return { ok: false, reason: 'bad-skills' }

  var rows = []
  var issues = []
  var sums = {}
  Object.keys(skills).forEach(function (id) {
    var entry = skills[id]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(id + '：不是对象')
      return
    }
    var name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id
    var category = typeof entry.category === 'string' ? entry.category.trim() : ''
    var firstWeek = typeof entry.firstWeek === 'string' ? entry.firstWeek.trim() : ''
    if (firstWeek !== '' && WEEK_RE.exec(firstWeek) === null) {
      issues.push(name + '：firstWeek「' + firstWeek + '」不是 YYYY-Www')
      firstWeek = ''
    } else if (firstWeek !== '') {
      /* firstWeek 晚于 updatedWeek = 台账自相矛盾（"数据只写到 W36，却有个技能是 W38 才出现的"）。
         实测见过：面板照着渲染成"最近一次接触新技能：W38"，而同一块上写着"数据截至 W36"。
         这不是能自动修的东西（到底哪边错只有她知道），所以如实记一条。 */
      var ahead = weeksBetween(updatedWeek, firstWeek)
      if (ahead !== null && ahead > 0) {
        issues.push(name + '：firstWeek（' + firstWeek + '）晚于 updatedWeek（' + updatedWeek + '）')
      }
    }
    var weeks = {}
    var source = entry.weeks === null || entry.weeks === undefined ? {} : entry.weeks
    if (typeof source === 'object' && !Array.isArray(source)) {
      Object.keys(source).forEach(function (key) {
        var pct = Number(source[key])
        if (WEEK_RE.exec(key) === null) {
          issues.push(name + '：周键「' + key + '」不合法')
          return
        }
        if (!isFinite(pct) || pct < 0 || pct > 100) {
          issues.push(name + '：' + shortWeek(key) + ' 的占比「' + String(source[key]) + '」不在 0–100')
          return
        }
        weeks[key] = pct
        sums[key] = (sums[key] === undefined ? 0 : sums[key]) + pct
      })
    } else {
      issues.push(name + '：weeks 不是对象')
    }
    rows.push({ id: id, name: name, category: category, firstWeek: firstWeek, weeks: weeks })
  })

  var sumIssues = []
  Object.keys(sums).forEach(function (key) {
    if (Math.abs(sums[key] - 100) > SKILL_PCT_TOLERANCE) {
      sumIssues.push(shortWeek(key) + ' 合计 ' + String(round1(sums[key])) + '%')
    }
  })

  return { ok: true, table: { updatedWeek: updatedWeek, rows: rows, issues: issues, sumIssues: sumIssues } }
}

/** 某技能在第 weekKey 周是否"深耕"：这一周与前两周**连续**都有投入。 */
function skillDeepAt(row, weekKey) {
  for (var i = 0; i < SKILL_DEEP_WEEKS; i += 1) {
    var pct = row.weeks[weekKeyShift(weekKey, -i)]
    if (pct === undefined || pct <= 0) return false
  }
  return true
}

/**
 * 是不是"杂事档"（id 或类别叫 other / 其他）。
 *
 * 为什么要单独认它：这一档是**故意留的排气口** —— 记"这周有多少活没有技能含量"，
 * 否则占比会被假性抬高（都算成技能投入）。所以它既不算"新"也不算"深耕"，
 * 永远落在"其余"那一段里，排序时也钉在最后一行。
 */
function skillRowIsOther(row) {
  var id = String(row.id || '').toLowerCase()
  var category = String(row.category || '')
  return id === 'other' || category === '其他' || category.toLowerCase() === 'other'
}

/**
 * 把台账算成三张图要用的形状（纯函数）。
 *
 * 口径（写死在这里，界面上也照这个说法写）：
 *   · **新**：投入到"首现 ≤4 周"的技能上的占比 —— 新鲜度就是它；
 *   · **深耕**：投入到一个连续 ≥3 周在做的技能上（且它不是"新"）；
 *   · **其余**：这一周剩下的部分（含她记在 other 那一档的杂事）。
 * 三段互不重叠、加起来是 100（用 Math.max 夹住，绝不给负数）。
 */
function skillAnalysis(table, windowEndKey) {
  var endText = windowEndKey === undefined || windowEndKey === null ? '' : String(windowEndKey)
  var end = WEEK_RE.exec(endText) !== null ? endText : table.updatedWeek
  var weeks = recentWeekKeys(end, SKILL_WINDOW_WEEKS)
  var current = currentWeekKey()
  var behind = weeksBetween(table.updatedWeek, current)
  var staleWeeks = behind === null ? 0 : Math.max(0, behind)

  var rows = []
  var lastNewWeek = ''
  table.rows.forEach(function (row) {
    var cells = []
    var total = 0
    var lastActive = ''
    weeks.forEach(function (key) {
      var pct = row.weeks[key]
      if (pct === undefined || pct <= 0) {
        cells.push({ key: key, pct: null })
        return
      }
      cells.push({ key: key, pct: pct })
      total += pct
      lastActive = key
    })
    var age = row.firstWeek === '' ? null : weeksBetween(row.firstWeek, end)
    var isOther = skillRowIsOther(row)
    /* "最近一次接触新技能"只认真技能：杂事档也有 firstWeek（它总得从某周开始记），
       让它参与进来，"我多久没碰新东西"就会被杂事满足掉 —— 那正是这个数字要防的事。
       实测踩到：夹具里 other 的 firstWeek 落在窗口第一周，时间轴上就多了一个"新技能"。 */
    if (!isOther && row.firstWeek !== '' && (lastNewWeek === '' || weeksBetween(lastNewWeek, row.firstWeek) > 0)) {
      lastNewWeek = row.firstWeek
    }
    rows.push({
      id: row.id,
      name: row.name,
      category: row.category,
      firstWeek: row.firstWeek,
      weeks: row.weeks,
      cells: cells,
      total: round1(total),
      lastActive: lastActive,
      isOther: isOther,
      isNew: !isOther && age !== null && age >= 0 && age < SKILL_NEW_WEEKS,
    })
  })

  /* 排序：杂事档钉死在最后，其余按窗口内累计占比降序、同分按名字。
     顺序稳定，用户才能"扫一眼看出哪一行变了"。 */
  rows.sort(function (a, b) {
    var aOther = skillRowIsOther(a) ? 1 : 0
    var bOther = skillRowIsOther(b) ? 1 : 0
    if (aOther !== bOther) return aOther - bOther
    if (b.total !== a.total) return b.total - a.total
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  var freshness = weeks.map(function (key) {
    var newPct = 0
    var deepPct = 0
    var total = 0
    rows.forEach(function (row) {
      var pct = row.weeks[key]
      if (pct === undefined || pct <= 0) return
      total += pct
      /* 杂事档只计入分母，永不算"新/深耕"（见 skillRowIsOther） */
      if (skillRowIsOther(row)) return
      var age = row.firstWeek === '' ? null : weeksBetween(row.firstWeek, key)
      if (age !== null && age >= 0 && age < SKILL_NEW_WEEKS) newPct += pct
      else if (skillDeepAt(row, key)) deepPct += pct
    })
    return {
      key: key,
      newPct: round1(newPct),
      deepPct: round1(deepPct),
      restPct: round1(Math.max(0, 100 - newPct - deepPct)),
      total: round1(total),
    }
  })

  var firstSeen = weeks.map(function (key) {
    return {
      key: key,
      names: rows
        .filter(function (row) {
          /* 杂事档不算"新技能"（理由同 lastNewWeek） */
          return row.isOther !== true && row.firstWeek === key
        })
        .map(function (row) {
          return row.name
        }),
    }
  })

  var coveredWeeks = 0
  freshness.forEach(function (entry) {
    if (entry.total > 0) coveredWeeks += 1
  })
  var latest = null
  freshness.forEach(function (entry) {
    if (entry.key === table.updatedWeek) latest = entry
  })

  return {
    table: table,
    weeks: weeks,
    rows: rows,
    freshness: freshness,
    firstSeen: firstSeen,
    lastNewWeek: lastNewWeek,
    latest: latest,
    staleWeeks: staleWeeks,
    coveredWeeks: coveredWeeks,
  }
}

/* ── 三个技能图 + 周报归档的渲染，以及面板注册表 ── */

/** 占比 → 色阶档（1–4），对应 CSS 里 .l1–.l4 四级蓝。 */
function skillCellLevel(pct) {
  if (pct <= 5) return 1
  if (pct <= 15) return 2
  if (pct <= 30) return 3
  return 4
}

function skillFailText(reason) {
  if (reason === 'empty') return '技能台账是空文件（' + SKILL_TABLE_PATH + '）'
  if (reason === 'bad-json') return '技能台账不是合法 JSON —— 让她按 skill-ledger 技能重写一份'
  if (reason === 'bad-shape') return '技能台账的顶层不是对象'
  if (reason === 'bad-week') return '技能台账缺 updatedWeek（或不是 YYYY-Www 格式）'
  if (reason === 'bad-skills') return '技能台账的 skills 不是对象'
  if (reason === 'missing') return '工作区里还没有技能台账（' + SKILL_TABLE_PATH + '）—— 让她生成一次周报，她会按 skill-ledger 回填最近 6 周'
  return '技能台账读不了（' + String(reason) + '）'
}

/**
 * 三个技能面板共用的前置检查：数据没到/读坏了就如实说明，返回 true 表示"别画了"。
 * 单独抽出来是因为失败文案必须**一致** —— 同一个原因在三张图上写三种说法，
 * 只会让人以为是三种不同的毛病。
 */
function skillPanelBlocked(box, ctx) {
  var snapshot = ctx.snapshot
  if (snapshot === null || snapshot === undefined) {
    box.appendChild(el('div', 'aside-note', '（正在载入…）'))
    return true
  }
  if (snapshot.skillTableError !== '') {
    box.appendChild(el('div', 'aside-bad', '读不到技能台账：' + snapshot.skillTableError))
    return true
  }
  if (snapshot.skillTable === null || snapshot.skillTable === undefined) {
    box.appendChild(el('div', 'aside-note', '（正在载入…）'))
    return true
  }
  if (snapshot.skillTable.ok !== true) {
    box.appendChild(el('div', 'aside-bad', skillFailText(snapshot.skillTable.reason)))
    return true
  }
  var analysis = ctx.analysis
  if (analysis === null) {
    box.appendChild(el('div', 'aside-note', '（正在载入…）'))
    return true
  }
  if (analysis.rows.length === 0) {
    box.appendChild(
      el('div', 'aside-note', '台账里还没有技能。让小艾生成一次周报，她会按 skill-ledger 技能把最近 6 周回填进去。'),
    )
    return true
  }
  return false
}

/**
 * 台账的状态（写到哪一周、有没有格式问题）**整栏只挂一次**，挂在第一个画出来的技能块上。
 *
 * 为什么不每块都挂：三张图读的是同一份台账，「数据截至 2026-W36（落后 3 周）」这句话
 * 在 340px 宽的右栏里连着出现三次、黄字格式问题再出现三次 —— 实测就是这副样子，
 * 读起来像界面坏了，而不是像"数据旧了"。所以：**一条事实说一次**，
 * 挂在最上面那块（不滚动就能看见），其余两块只管画自己的图。
 */
function skillStaleNote(box, analysis, ctx) {
  if (ctx !== undefined && ctx !== null) {
    if (ctx.statusShown === true) return
    ctx.statusShown = true
  }
  var weeks = analysis.staleWeeks
  var text = '数据截至 ' + analysis.table.updatedWeek + (weeks <= 0 ? '（本周）' : '（落后 ' + String(weeks) + ' 周）')
  box.appendChild(el('div', weeks <= 0 ? 'aside-note' : 'aside-bad', text))
  if (analysis.table.sumIssues.length > 0) {
    box.appendChild(el('div', 'aside-warn', '占比合计不是 100%：' + analysis.table.sumIssues.slice(0, 3).join('、')))
  }
  if (analysis.table.issues.length > 0) {
    box.appendChild(
      el('div', 'aside-warn', '台账有 ' + String(analysis.table.issues.length) + ' 处格式问题：' + analysis.table.issues.slice(0, 2).join('；')),
    )
  }
}

/** ① 技能 × 周 热力网格：行=技能、列=最近 8 周、格子深浅=当周占比。 */
function renderPanelSkillGrid(aside, ctx) {
  var box = asideBlock(aside, '技能 × 周')
  if (skillPanelBlocked(box, ctx)) return
  var analysis = ctx.analysis
  skillStaleNote(box, analysis, ctx)

  var grid = el('div', 'skill-grid')
  grid.appendChild(el('div', 'skill-cell head', ''))
  analysis.weeks.forEach(function (key) {
    grid.appendChild(el('div', 'skill-cell head', shortWeek(key)))
  })
  analysis.rows.forEach(function (row) {
    var nameCell = el('div', 'skill-cell name', row.name)
    nameCell.title = row.name + (row.category === '' ? '' : ' · ' + row.category)
    if (row.isNew) nameCell.appendChild(el('span', 'skill-new', '新'))
    grid.appendChild(nameCell)
    row.cells.forEach(function (cell) {
      if (cell.pct === null) {
        grid.appendChild(el('div', 'skill-cell cell empty'))
        return
      }
      /* 绿框只给真技能的首次出现：杂事档不是"接触了新东西"（见 skillRowIsOther） */
      var isFirst = row.isOther !== true && row.firstWeek !== '' && cell.key === row.firstWeek
      var node = el('div', 'skill-cell cell l' + String(skillCellLevel(cell.pct)) + (isFirst ? ' first' : ''))
      node.title = row.name + ' · ' + cell.key + ' · ' + String(round1(cell.pct)) + '%' + (isFirst ? '（首次出现）' : '')
      grid.appendChild(node)
    })
  })
  box.appendChild(grid)
  box.appendChild(
    el('div', 'aside-note', '格子越深 = 当周占比越高；绿框那格是它第一次出现。行首「新」= 首现 ≤' + String(SKILL_NEW_WEEKS) + ' 周。'),
  )
}

/** ② 新鲜度：一根条（新 / 深耕 / 其余）+ 最近 8 周"新"占比折线。 */
function renderPanelFreshness(aside, ctx) {
  var box = asideBlock(aside, '新鲜度')
  if (skillPanelBlocked(box, ctx)) return
  var analysis = ctx.analysis
  var latest = analysis.latest
  skillStaleNote(box, analysis, ctx)
  if (latest === null) {
    box.appendChild(el('div', 'aside-note', '台账没有覆盖这一周（' + shortWeek(analysis.weeks[analysis.weeks.length - 1]) + '），三段算不出来。'))
    return
  }

  var head = el('div', 'aside-row')
  head.appendChild(el('span', 'k', '新鲜度（' + shortWeek(latest.key) + '）'))
  head.appendChild(el('span', 'v', String(latest.newPct) + '%'))
  box.appendChild(head)

  var bar = el('div', 'fresh-bar')
  var segments = [
    { cls: 'seg-new', pct: latest.newPct, label: '新' },
    { cls: 'seg-deep', pct: latest.deepPct, label: '深耕' },
    { cls: 'seg-rest', pct: latest.restPct, label: '其余' },
  ]
  segments.forEach(function (segment) {
    var node = el('span', 'fresh-seg ' + segment.cls)
    node.style.width = String(segment.pct) + '%'
    node.title = segment.label + ' ' + String(segment.pct) + '%'
    bar.appendChild(node)
  })
  box.appendChild(bar)
  box.appendChild(
    el('div', 'aside-note', '新 ' + String(latest.newPct) + '% · 深耕 ' + String(latest.deepPct) + '% · 其余 ' + String(latest.restPct) + '%'),
  )

  var maxPct = 0
  analysis.freshness.forEach(function (entry) {
    if (entry.newPct > maxPct) maxPct = entry.newPct
  })
  /* 纵轴取 25% 起、按 10% 向上取整：全是 0 时也要有一条平线，而不是一条贴边的斜线 */
  var axisMax = Math.max(25, Math.ceil(maxPct / 10) * 10)
  var count = analysis.freshness.length
  var points = []
  var dots = []
  analysis.freshness.forEach(function (entry, index) {
    var x = count <= 1 ? 0 : (index / (count - 1)) * 100
    var y = 23 - (entry.newPct / axisMax) * 21
    points.push(String(round1(x)) + ',' + String(round1(y)))
    dots.push({ x: x, y: y, entry: entry })
  })
  var svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'fresh-line')
  svg.setAttribute('viewBox', '0 0 100 24')
  svg.setAttribute('preserveAspectRatio', 'none')
  var poly = document.createElementNS(SVG_NS, 'polyline')
  poly.setAttribute('points', points.join(' '))
  poly.setAttribute('vector-effect', 'non-scaling-stroke')
  svg.appendChild(poly)
  dots.forEach(function (dot) {
    var circle = document.createElementNS(SVG_NS, 'circle')
    circle.setAttribute('cx', String(round1(dot.x)))
    circle.setAttribute('cy', String(round1(dot.y)))
    circle.setAttribute('r', '1.6')
    circle.setAttribute('vector-effect', 'non-scaling-stroke')
    var tip = document.createElementNS(SVG_NS, 'title')
    tip.textContent = dot.entry.key + ' · 新 ' + String(dot.entry.newPct) + '%'
    circle.appendChild(tip)
    svg.appendChild(circle)
  })
  box.appendChild(svg)
  box.appendChild(
    el('div', 'aside-note', '折线 = 每周的「新」占比（刻度 0–' + String(axisMax) + '%）· 窗口内 ' + String(analysis.coveredWeeks) + '/' + String(SKILL_WINDOW_WEEKS) + ' 周有数据'),
  )
}

/** ③ 新技能首现时间轴：哪一周第一次碰了什么。 */
function renderPanelFirstSeen(aside, ctx) {
  var box = asideBlock(aside, '新技能')
  if (skillPanelBlocked(box, ctx)) return
  var analysis = ctx.analysis
  skillStaleNote(box, analysis, ctx)
  if (analysis.lastNewWeek === '') {
    box.appendChild(el('div', 'aside-note', '台账里没有 firstWeek —— 让她补上，否则"多久没碰新东西"算不出来。'))
    return
  }
  var ageWeeks = weeksBetween(analysis.lastNewWeek, currentWeekKey())
  box.appendChild(
    el(
      'div',
      'aside-role',
      '最近一次接触新技能：' + shortWeek(analysis.lastNewWeek) +
        (ageWeeks === null ? '' : ageWeeks <= 0 ? '（本周）' : '（' + String(ageWeeks) + ' 周前）'),
    ),
  )

  var track = el('div', 'firstseen-track')
  analysis.firstSeen.forEach(function (entry) {
    var cell = el('div', 'firstseen-cell' + (entry.names.length > 0 ? ' has' : ''))
    if (entry.names.length > 0) {
      cell.appendChild(el('span', 'firstseen-dot'))
      cell.title = entry.key + '：' + entry.names.join('、')
    }
    cell.appendChild(el('span', 'firstseen-week', shortWeek(entry.key)))
    track.appendChild(cell)
  })
  box.appendChild(track)

  var recent = []
  for (var i = analysis.firstSeen.length - 1; i >= 0 && recent.length < 3; i -= 1) {
    if (analysis.firstSeen[i].names.length > 0) recent.push(analysis.firstSeen[i])
  }
  if (recent.length === 0) {
    box.appendChild(el('div', 'aside-note', '最近 ' + String(SKILL_WINDOW_WEEKS) + ' 周没有新技能 —— 要么在深耕，要么在重复。'))
  } else {
    recent.forEach(function (entry) {
      asideRow(box, shortWeek(entry.key), entry.names.join('、'))
    })
  }
}

/** ④ 周报归档：她写进 周报/ 目录的周报（控制台只列出来，不读正文）。 */
function renderPanelReportArchive(aside, ctx) {
  var box = asideBlock(aside, '周报归档')
  var snapshot = ctx.snapshot
  if (snapshot === null || snapshot === undefined || snapshot.reports === undefined) {
    box.appendChild(el('div', 'aside-note', '（正在载入…）'))
    return
  }
  if (snapshot.reportsError !== '') {
    box.appendChild(el('div', 'aside-bad', '拉取失败：' + snapshot.reportsError))
    return
  }
  if (snapshot.reports === null || snapshot.reports.length === 0) {
    box.appendChild(el('div', 'aside-note', '还没有归档的周报（让她把周报写进 ' + REPORT_ARCHIVE_DIR + '/ 目录）'))
    return
  }
  snapshot.reports.slice(0, ASIDE_ROWS_MAX).forEach(function (entry) {
    var row = asideRow(box, entry.name, formatBytes(Number(entry.size) || 0))
    row.title = entry.path
  })
  if (snapshot.reports.length > ASIDE_ROWS_MAX) {
    box.appendChild(el('div', 'aside-note', '…共 ' + String(snapshot.reports.length) + ' 份'))
  }
}

/* ═══════════ 9.8 渗透测试岗位面板（四宫格左上 / 左下）═══════════
 *
 * 这两个面板回答的是"她此刻在打什么、下一步做什么"，数据来自两个**完全不同的地方**：
 *
 *   左上「当前目标」← 工作区文件：scope.json（**人写**：授权范围/时间窗/允许与禁止）
 *                     + board.json（**员工写**：进度与发现计数）。
 *   左下「下一步」  ← dsh 的 todos 投影（员工每写一次计划就推一帧，谁都不用维护文件）。
 *
 * 四条边界，越界这两个面板就会长成没人维护的假仪表盘：
 *   1. **授权范围必须由人写**。让被测方自己声明授权 = 自己给自己发许可证 ——
 *      这一格的空态文案是产品的一部分，不许改成"暂无目标"这种含糊话。
 *   2. **读不到 != 没问题**。文件不存在、JSON 语法错、节点离线、方法不存在，四种分开说，
 *      因为"下一步该做什么"完全不同（同 9.7 的规矩）。
 *   3. **不解析对话正文**。结构化事实只从文件与投影来：正文里 grep 出来的"目标"必然漂。
 *   4. **投影只推不补**，且每轮清空 —— 所以这一格自带"上一轮"与"还没收到实时帧"的交代。
 */

/** 授权范围/边界（人写） */
var SCOPE_PATH = 'scope.json'
/** 进度与发现计数（员工写） */
var BOARD_PATH = 'board.json'
/** 发现分级顺序（显示用；四档齐全才看得出"哪一档在长"） */
var FINDING_LEVELS = [
  { key: 'critical', label: '严重', cls: 'lv1' },
  { key: 'high', label: '高', cls: 'lv2' },
  { key: 'medium', label: '中', cls: 'lv3' },
  { key: 'low', label: '低', cls: 'lv4' },
]
/** scope.json 的最小写法（空态里给人抄的，不是规范文档） */
var SCOPE_HINT =
  '这一格读工作区里的 ' + SCOPE_PATH + '：授权范围必须由人登记，员工不能给自己授权。' +
  '最小写法 {"targets":["app.demo.local"],"range":"10.0.0.0/24",' +
  '"window":{"from":"2026-02-01","to":"2026-03-15"},"allow":["端口扫描"],"deny":["拒绝服务"]}'

/** 读一个工作区 JSON 文件，把"读不到"的几种原因分开带回来（调用方各自如实显示）。 */
function readWorkspaceJson(employeeId, path) {
  return rpc('employee.files.get', { employeeId: employeeId, path: path }).then(
    function (payload) {
      var content =
        payload !== null && typeof payload === 'object' && payload.content !== undefined ? String(payload.content) : ''
      if (content.trim() === '') return { ok: false, reason: 'empty' }
      var value = null
      try {
        value = JSON.parse(content)
      } catch (error) {
        var message = error !== null && error !== undefined && error.message ? String(error.message) : String(error)
        return { ok: false, reason: 'bad-json', detail: message }
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'shape', detail: '顶层必须是一个 JSON 对象' }
      }
      return { ok: true, value: value }
    },
    function (error) {
      var detail = describeError(error)
      /* 文件不存在是**正常状态**（人还没登记授权），与"读不到"必须分开：
         前者要引导人去写，后者要报出真正的原因（节点离线/无权限/方法不存在）。 */
      if (/ENOENT|no such file/i.test(detail)) return { ok: false, reason: 'missing' }
      return { ok: false, reason: 'unreadable', detail: detail }
    },
  )
}

/** 把任意值变成一行可读文本（对象/数组不硬转成 [object Object]）。 */
function cellText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (!Array.isArray(value)) return ''
  var parts = []
  for (var i = 0; i < value.length; i += 1) {
    var one = value[i]
    if (one === null || one === undefined) continue
    if (typeof one === 'object') {
      /* 目标写成对象时挑几个认识的键拼一行，别把 JSON 原样糊到屏幕上 */
      var bits = []
      var keys = ['host', 'target', 'url', 'ip', 'name', 'kind', 'note']
      for (var k = 0; k < keys.length; k += 1) {
        if (one[keys[k]] !== undefined && one[keys[k]] !== null && one[keys[k]] !== '') bits.push(String(one[keys[k]]))
      }
      if (bits.length > 0) parts.push(bits.join(' · '))
      continue
    }
    parts.push(String(one))
  }
  return parts.join('、')
}

/** scope.json → 显示模型（缺的字段就是空，不编默认值）。 */
function scopeView(scope) {
  var view = { targets: '', range: '', window: '', grantedBy: '', allow: '', deny: '', note: '' }
  if (scope === null || typeof scope !== 'object') return view
  view.targets = cellText(scope.targets !== undefined ? scope.targets : scope.target)
  view.range = cellText(scope.range !== undefined ? scope.range : scope.cidr)
  var win = scope.window
  if (win !== null && win !== undefined && typeof win === 'object') {
    var to = cellText(win.to)
    view.window = cellText(win.from) + (to === '' ? '' : ' ~ ' + to)
  } else {
    view.window = cellText(win)
  }
  view.grantedBy = cellText(scope.grantedBy !== undefined ? scope.grantedBy : scope.contact)
  view.allow = cellText(scope.allow)
  view.deny = cellText(scope.deny !== undefined ? scope.deny : scope.forbidden)
  view.note = cellText(scope.note)
  return view
}

/** board.json → { done, total, findings, updatedAt }（findings 支持对象与数组两种写法）。 */
function boardView(board) {
  var view = { done: null, total: null, findings: null, updatedAt: '' }
  if (board === null || typeof board !== 'object') return view
  var progress = board.progress
  if (progress !== null && progress !== undefined && typeof progress === 'object') {
    if (progress.done !== undefined || progress.total !== undefined) {
      view.done = Number(progress.done)
      view.total = Number(progress.total)
    } else if (progress.tested !== undefined || progress.entriesTotal !== undefined) {
      view.done = Number(progress.tested)
      view.total = Number(progress.entriesTotal)
    }
  } else if (progress !== undefined) {
    view.done = Number(progress)
    if (board.total !== undefined) view.total = Number(board.total)
  }
  var counts = null
  var findings = board.findings
  if (findings !== null && findings !== undefined && typeof findings === 'object' && !Array.isArray(findings)) {
    counts = {}
    for (var i = 0; i < FINDING_LEVELS.length; i += 1) {
      var level = FINDING_LEVELS[i]
      var raw = findings[level.key]
      if (raw === undefined) raw = findings[level.label]
      counts[level.key] = Number(raw)
    }
  } else if (Array.isArray(findings)) {
    /* 也接受"发现清单数组"：按 severity 现数 —— 员工更可能顺手写成数组。 */
    counts = { critical: 0, high: 0, medium: 0, low: 0 }
    for (var f = 0; f < findings.length; f += 1) {
      var entry = findings[f]
      if (entry === null || typeof entry !== 'object') continue
      var sev = String(entry.severity !== undefined ? entry.severity : entry.level !== undefined ? entry.level : '').toLowerCase()
      if (sev === 'critical' || sev === '严重' || sev === 'p0') counts.critical += 1
      else if (sev === 'high' || sev === '高' || sev === 'p1') counts.high += 1
      else if (sev === 'medium' || sev === '中' || sev === 'p2') counts.medium += 1
      else if (sev === 'low' || sev === '低' || sev === 'p3') counts.low += 1
    }
  }
  /* 一格都没数出来 → 当作没给（不显示一排 0，那是在编数字） */
  if (counts !== null) {
    var any = false
    for (var c = 0; c < FINDING_LEVELS.length; c += 1) {
      if (isFinite(counts[FINDING_LEVELS[c].key])) any = true
    }
    view.findings = any ? counts : null
  }
  view.updatedAt = cellText(board.updatedAt !== undefined ? board.updatedAt : board.updated_at)
  return view
}

/** 一行「文件没读到」的如实说明：原因不同，下一步该做的事也不同。 */
function appendFileState(box, result, schemaHint) {
  if (result === null || result === undefined) {
    box.appendChild(el('div', 'aside-note', '（正在载入…）'))
    return
  }
  if (result.ok === true) return
  if (result.reason === 'missing') {
    box.appendChild(el('div', 'quad-empty', '工作区里还没有这个文件。'))
    box.appendChild(el('div', 'aside-note', schemaHint))
    return
  }
  if (result.reason === 'empty') {
    box.appendChild(el('div', 'aside-warn', '文件是空的（0 字节）—— 建了但没写内容。'))
    box.appendChild(el('div', 'aside-note', schemaHint))
    return
  }
  if (result.reason === 'bad-json') {
    box.appendChild(el('div', 'aside-bad', 'JSON 语法错：' + String(result.detail || '')))
    box.appendChild(el('div', 'aside-note', '修好语法这一格就会自己出现；在那之前一个数字都不显示。'))
    return
  }
  if (result.reason === 'shape') {
    box.appendChild(el('div', 'aside-bad', '格式不对：' + String(result.detail || '')))
    box.appendChild(el('div', 'aside-note', schemaHint))
    return
  }
  box.appendChild(el('div', 'aside-bad', '读不到：' + String(result.detail || '')))
}

/** 左上「当前目标」：授权范围（人写）+ 进度与发现（员工写）。 */
function renderPanelPentestTarget(container, ctx) {
  var box = asideBlock(container, '当前目标')
  var scopeResult = ctx.scopeResult
  var boardResult = ctx.boardResult
  var scope = scopeResult !== null && scopeResult !== undefined && scopeResult.ok === true ? scopeResult.value : null
  var board = boardResult !== null && boardResult !== undefined && boardResult.ok === true ? boardResult.value : null
  var view = scopeView(scope)
  var progress = boardView(board)

  if (view.targets !== '') box.appendChild(el('div', 'quad-target', view.targets))
  if (view.range !== '') asideRow(box, '范围', view.range)
  if (view.window !== '') asideRow(box, '授权窗口', view.window)
  if (view.grantedBy !== '') asideRow(box, '授权方', view.grantedBy)
  if (view.allow !== '') asideRow(box, '允许', view.allow)
  if (view.deny !== '') asideRow(box, '禁止', view.deny)
  if (view.note !== '') box.appendChild(el('div', 'aside-note', view.note))
  /* scope.json 那一侧没读到 → 把原因摆在这一格最显眼的位置（不编"暂无目标"） */
  appendFileState(box, scopeResult, SCOPE_HINT)

  var done = progress.done
  var total = progress.total
  if (isFinite(done) && isFinite(total) && total > 0) {
    box.appendChild(el('div', 'aside-sep'))
    var progressRow = el('div', 'quad-progress')
    progressRow.appendChild(el('span', 'quad-progress-label', '已测入口'))
    progressRow.appendChild(el('span', 'quad-progress-count', String(done) + ' / ' + String(total)))
    box.appendChild(progressRow)
    var bars = el('div', 'quad-bars')
    /* 格子数封顶 24：入口很多时条数不再长，靠数字看比例（否则一条 1px 的条没有意义） */
    var cells = Math.min(total, 24)
    var filled = Math.round((Math.min(done, total) / total) * cells)
    for (var i = 0; i < cells; i += 1) bars.appendChild(el('i', i < filled ? 'f' : ''))
    box.appendChild(bars)
  }
  if (progress.findings !== null) {
    box.appendChild(el('div', 'aside-sep'))
    var sev = el('div', 'quad-sev')
    for (var s = 0; s < FINDING_LEVELS.length; s += 1) {
      var level = FINDING_LEVELS[s]
      var cell = el('div', level.cls)
      var raw = progress.findings[level.key]
      cell.appendChild(el('strong', '', isFinite(raw) ? String(raw) : '—'))
      cell.appendChild(el('span', '', level.label))
      sev.appendChild(cell)
    }
    box.appendChild(sev)
  }
  /* board.json 这一侧：只在它本身没读到、或两条都拿不出来时才说话 */
  if (boardResult === null || boardResult === undefined || boardResult.ok !== true) {
    appendFileState(box, boardResult, '进度与发现计数由员工写在工作区的 ' + BOARD_PATH + '（控制台只读）。')
  } else if (progress.findings === null && !isFinite(done)) {
    box.appendChild(
      el('div', 'aside-note', BOARD_PATH + ' 里没有能显示的字段（进度 progress.done/total、发现计数 findings）。'),
    )
  }
  if (progress.updatedAt !== '') box.appendChild(el('div', 'aside-note', '进度更新于 ' + progress.updatedAt))
  box.appendChild(el('div', 'aside-note', '数据：' + SCOPE_PATH + '（人写）+ ' + BOARD_PATH + '（员工写）'))
}

/** 左下「下一步」：dsh 的 todos 投影（本轮实时）+ 上一轮的收尾状态。 */
function renderPanelPentestPlan(container, ctx) {
  var plan = ctx.plan
  var todos = plan !== null && plan !== undefined && Array.isArray(plan.todos) ? plan.todos : null
  var prev = plan !== null && plan !== undefined && Array.isArray(plan.prev) ? plan.prev : null
  var done = 0
  if (todos !== null) {
    for (var i = 0; i < todos.length; i += 1) {
      if (todos[i] !== null && typeof todos[i] === 'object' && todos[i].status === 'completed') done += 1
    }
  }
  var badge = todos !== null && todos.length > 0 ? String(done) + ' / ' + String(todos.length) : ''
  var box = asideBlock(container, '下一步', badge, 'ok')
  var running = typeof turnRunning !== 'undefined' && turnRunning === true
  if (todos === null || todos.length === 0) {
    box.appendChild(
      el(
        'div',
        'quad-empty',
        running
          ? '这一轮她还没写计划（正在干活，计划可能就在路上）。'
          : '这一轮没有计划：dsh 的 todo 列表在每轮开始时清空，空闲时本来就是空的。',
      ),
    )
    box.appendChild(
      el('div', 'aside-note', '数据来自 dsh 的 todos 投影 —— 她写计划时自动出现在这里，不需要谁维护文件。'),
    )
  } else {
    for (var t = 0; t < todos.length; t += 1) {
      var one = todos[t]
      if (one === null || typeof one !== 'object') continue
      var status = String(one.status || '')
      var row = el('div', 'quad-todo' + (status === 'in_progress' ? ' now' : status === 'completed' ? ' done' : ''))
      row.appendChild(el('span', 'quad-todo-box', status === 'completed' ? '✓' : status === 'in_progress' ? '▶' : '○'))
      row.appendChild(el('span', 'quad-todo-text', String(one.content === undefined ? '' : one.content)))
      box.appendChild(row)
    }
    /* 投影只推不补：这份数字是"打开会话那一刻的快照"时必须说出来，别让它看起来是实时的 */
    if (plan.live !== true) box.appendChild(el('div', 'aside-note', '（来自会话列表的快照，还没收到实时帧）'))
  }
  if (prev !== null && prev.length > 0) {
    var prevDone = 0
    for (var p = 0; p < prev.length; p += 1) {
      if (prev[p] !== null && typeof prev[p] === 'object' && prev[p].status === 'completed') prevDone += 1
    }
    var at = plan !== null && plan !== undefined ? Number(plan.prevAtMs) : 0
    box.appendChild(el('div', 'aside-sep'))
    box.appendChild(
      el('div', 'aside-note', '上一轮：' + String(prevDone) + ' / ' + String(prev.length) + ' 完成' + (at > 0 ? ' · ' + approvalRelativeTime(at) : '')),
    )
  }
}

/**
 * 三张图共用同一份台账数据：读一次文件，画三张图（不是一张图一个请求）。
 * 这个清单也决定"岗位只配了 report-archive 时不必去读台账文件"。
 */
var SKILL_PANEL_IDS = ['skill-grid', 'skill-freshness', 'skill-firstseen']

/**
 * 面板注册表：岗位目录里的 panels 写的就是这些 id。
 * 加一个面板 = 这里加一条 + 岗位目录里勾上它；未登记的 id 会如实显示成"不认识"。
 */
var PANEL_RENDERERS = {
  'skill-grid': renderPanelSkillGrid,
  'skill-freshness': renderPanelFreshness,
  'skill-firstseen': renderPanelFirstSeen,
  'report-archive': renderPanelReportArchive,
  /* 四宫格（layout:'quad'）的格位面板：由岗位的 cells 声明放在哪一格 */
  'pentest-target': renderPanelPentestTarget,
  'pentest-plan': renderPanelPentestPlan,
  /* 安全监测（同一个外壳，换内容）：顶部徽章 + 三个格位 */
  'capability-badge': renderPanelCapabilityBadge,
  'monitor-post': renderPanelMonitorPost,
  'monitor-findings': renderPanelMonitorFindings,
  'monitor-watch': renderPanelMonitorWatch,
  /* 应急响应（第三个用户）：能动手，但每一步都要人批 */
  'incident-post': renderPanelIncidentPost,
  'incident-steps': renderPanelIncidentSteps,
  'incident-timeline': renderPanelIncidentTimeline,
}

/** 岗位目录里那条记录（没绑岗位 / 目录里没有 → null）。 */
function positionEntryOf(employee) {
  if (employee === null || typeof employee !== 'object') return null
  var id = typeof employee.position === 'string' ? employee.position.trim() : ''
  if (id === '') return null
  var list = positionList()
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] !== null && typeof list[i] === 'object' && String(list[i].id || '') === id) return list[i]
  }
  return null
}

/** 该员工岗位声明的面板 id（没绑岗位、目录没到位 → 空数组，页面上什么都不加）。 */
function positionPanelsOf(employee) {
  var entry = positionEntryOf(employee)
  if (entry === null || !Array.isArray(entry.panels)) return []
  return entry.panels.filter(function (id) {
    return typeof id === 'string' && id !== ''
  })
}

/** 该员工岗位声明的**格位**面板 id（layout:'quad'；缺省/没绑岗位 → 空数组）。 */
function positionCellsOf(employee) {
  var entry = positionEntryOf(employee)
  if (entry === null || entry.cells === null || typeof entry.cells !== 'object') {
    return { tl: [], bl: [], tr: [], top: [] }
  }
  var pick = function (ids) {
    if (!Array.isArray(ids)) return []
    return ids.filter(function (id) {
      return typeof id === 'string' && id !== ''
    })
  }
  return { tl: pick(entry.cells.tl), bl: pick(entry.cells.bl), tr: pick(entry.cells.tr), top: pick(entry.cells.top) }
}

/**
 * 把一组面板 id 渲染进任意容器（右栏与四宫格格位共用这一条路径）。
 *
 * 未登记的 id **如实显示"不认识"**：静默跳过等于"配了但没出现"，没人查得出来
 * （这条红线是 9.7 定下的，格位面板同样适用）。
 */
function renderPanelsInto(container, ctx, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return
  ids.forEach(function (id) {
    var render = PANEL_RENDERERS[id]
    if (render === undefined) {
      var box = asideBlock(container, '未实现的面板')
      box.appendChild(el('div', 'aside-bad', '「' + id + '」：Hub 上这个岗位配了它，但控制台不认识这个面板 id。'))
      return
    }
    render(container, ctx)
  })
}

/** 渲染岗位声明的面板（在右栏里按声明顺序排列）。 */
function renderPositionPanels(aside, employee, snapshot) {
  var panels = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.panels) ? snapshot.panels : []
  if (panels.length === 0) return
  var analysis = null
  if (snapshot.skillTable !== null && snapshot.skillTable !== undefined && snapshot.skillTable.ok === true) {
    analysis = skillAnalysis(snapshot.skillTable.table, currentWeekKey())
  }
  renderPanelsInto(aside, { snapshot: snapshot, analysis: analysis, employee: employee }, panels)
}

/* ── 面板数据的装载 ── */

/** 读技能台账（员工维护的文件）。读不到 != 没问题：读不到就如实说读不到。 */
function loadSkillTable(employeeId) {
  return rpc('employee.files.get', { employeeId: employeeId, path: SKILL_TABLE_PATH }).then(
    function (payload) {
      var content = payload !== null && typeof payload === 'object' ? String(payload.content === undefined ? '' : payload.content) : ''
      return parseSkillTable(content)
    },
    function () {
      return { ok: false, reason: 'missing' }
    },
  )
}

/**
 * 列周报归档：先看 周报/ 目录，没有就回落到工作区根目录里按名字挑（她现在写在根目录）。
 * 两处都没有 = "还没有归档"，不是错误。
 */
function loadReportArchive(employeeId) {
  var pick = function (entries) {
    return entries
      .filter(function (entry) {
        if (entry === null || typeof entry !== 'object') return false
        if (entry.type === 'dir') return false
        var path = String(entry.path || '')
        var fileName = path.split('/').pop()
        return /^(周报|日报)_/.test(fileName) && /\.(md|txt|html|pdf|docx)$/i.test(fileName)
      })
      .map(function (entry) {
        var path = String(entry.path || '')
        return { path: path, name: path.split('/').pop(), size: Number(entry.size) || 0 }
      })
      .sort(function (a, b) {
        return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
      })
  }
  return rpc('employee.files.list', { employeeId: employeeId, path: REPORT_ARCHIVE_DIR }).then(
    function (payload) {
      return pick(pickArray(payload, ['entries', 'items', 'list']))
    },
    function () {
      return rpc('employee.files.list', { employeeId: employeeId, path: '.' }).then(function (payload) {
        return pick(pickArray(payload, ['entries', 'items', 'list']))
      })
    },
  )
}

/* ═══════════ 9.9 安全监测岗位面板（四宫格：顶部徽章 / 左上哨兵台 / 左下异常台账 / 右上值守记录）═══════════
 *
 * 这一页回答四个问题：**现在有没有人在盯 / 盯着哪几台 / 盯出什么了 / 它能不能自己动手**。
 * 最后半句是重点：监测岗没有处置权限，这件事必须在页面上看得见，而不是一句口头承诺。
 *
 * 六条边界（越界就会长成一个"看起来很安心"的假仪表盘）：
 *   1. **凡是结论都由控制台从原始数据现算**：新鲜度（now − 检查时刻 vs 周期）、缺轮（按周期推）、
 *      与上一轮的差异（两轮 snapshot 之差）、证据可信度（按资产种类判）。
 *      员工的自报一律不采信 —— 否则页面显示的不是事实，而是它的自我评价。
 *   2. **无数据 != 正常**：陈旧 / 失联 / 从没跑过 / 文件读不到，四种分开说，绝不用一片绿糊过去。
 *   3. **这一页没有处置动词**：按钮只有「看证据 / 生成处置申请 / 已阅」，且都不代你发指令。
 *   4. **监测范围必须由人写**（monitor.json）：盯谁、多久一次、钥匙是什么；员工不能自己决定盯谁。
 *   5. **本机自证只作线索**：员工跑在被监测的那台机器上时，它交上来的报告可以是改过的；
 *      只有服务器侧留痕的那部分才算"可核验"。标签由控制台按资产种类判，不读员工写的字段。
 *   6. **监测岗的产出是变化，不是快照**："与上一轮相比没有变化" 比 "无异常" 有信息量得多 ——
 *      前者说明它真的比过了。所以 findings.json 每轮要留可比对的 snapshot。
 */

/** 监测范围（**人写**：盯谁、多久一次、钥匙是什么） */
var MONITOR_PATH = 'monitor.json'
/** 每轮巡检结果（**员工写**：结果 + 证据路径 + 可比对的快照） */
var FINDINGS_PATH = 'findings.json'
/** 轮次带窗口长度：最近 N 轮（按周期推，60 分钟一轮 = 一天） */
var MONITOR_WINDOW_ROUNDS = 24
/**
 * 台账一屏最多列几条（更多的去对话里问，别把这一格挤成滚动条）。
 *
 * 为什么是 3：实测这一格高 411px（1280×830 的窗口），一条发现约 93px（标题行 + 元信息 +
 * 证据 + 三个按钮）。4 条时整格会溢出 ~50px 变成格内滚动 —— 而"最后一条被切掉"正是台账
 * 最不该发生的事（那一条往往就是最新的）。3 条 + 一行"…本轮共 N 条"能装下。
 */
var MONITOR_FINDINGS_MAX = 3
/** 等级：中英文都认（员工写中文更顺手，不逼它记英文枚举） */
var MONITOR_LEVELS = [
  { key: 'critical', label: '严重', words: ['严重', 'critical', 'p0'] },
  { key: 'high', label: '高', words: ['高', 'high', 'p1'] },
  { key: 'medium', label: '中', words: ['中', 'medium', 'p2'] },
  { key: 'low', label: '低', words: ['低', 'low', 'p3'] },
]
/** 等级键 → 显示名（不认识的等级**如实显示原文**，不塞进"中"里） */
var MONITOR_LEVEL_LABELS = { critical: '严重', high: '高', medium: '中', low: '低' }
/** 证据可信度：本机（自证）与服务器（外部可核验） */
var MONITOR_PROV_SELF = '自证'
var MONITOR_PROV_EXT = '可核验'
/** 空态里给人抄的最小写法（不是规范文档） */
var MONITOR_HINT =
  '这一格读工作区里的 ' + MONITOR_PATH + '：盯谁、多久一次、用哪把钥匙，必须由人登记 —— ' +
  '员工不能自己决定监测范围。最小写法 {"defaultIntervalMinutes":60,"assets":[' +
  '{"id":"local","kind":"local","name":"本机"},' +
  '{"id":"srv-1","kind":"ssh","name":"生产","host":"1.2.3.4","readonlyAccount":"dsh_ro"}]}'
/** 徽章文案（岗位没写 capabilities.label 时的中性默认 —— 控制台不替岗位编产品口径） */
var MONITOR_BADGE_FALLBACK = '权限边界'
/** 事件登记的最小写法（空态里给人抄的，不是规范文档） */
var INCIDENT_HINT =
  '这一格读工作区里的 incident.json：事件是谁指挥、什么级别、能处置什么，必须由人登记 —— ' +
  '员工不能自己扩大处置范围。最小写法 {"incidentId":"IR-2026-0925-01","title":"…","level":"高",' +
  '"commander":"张总","openedAtMs":1758780000000,"stages":["发现","遏制","清除","恢复","复盘"],' +
  '"scope":{"assets":["srv-hub"],"allow":["改防火墙规则","停用账号"],"deny":["重装系统","删除数据"]}}'

/* ── 纯函数：时间、等级、字符串列表 ── */

/**
 * 任意时间写法 → 毫秒。
 *
 * 为什么容忍这么多种：写文件的是员工，不是数据库。**秒级时间戳是真实会出现的**
 * （2026 年的秒级是 1.75e9，毫秒是 1.75e12），写成秒会让整页算成"1970 年"，
 * 所以小于 1e11 的数按秒处理；ISO 字符串与 Date 也认。认不出来返回 0（= 没有时间）。
 */
function monitorTimeMs(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') {
    if (!isFinite(value) || value <= 0) return 0
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }
  var text = String(value).trim()
  if (text === '') return 0
  if (/^[0-9]+$/.test(text)) return monitorTimeMs(Number(text))
  var parsed = Date.parse(text)
  return isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 等级原文 → 等级键（不认识的返回空串：调用方如实显示原文） */
function monitorLevelKey(raw) {
  var text = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase()
  if (text === '') return ''
  for (var i = 0; i < MONITOR_LEVELS.length; i += 1) {
    var level = MONITOR_LEVELS[i]
    for (var w = 0; w < level.words.length; w += 1) {
      if (text === String(level.words[w]).toLowerCase()) return level.key
    }
  }
  return ''
}

/** 时长 → 「刚刚 / 12 分钟前 / 3 小时 12 分钟前 / 2 天前」（负数按 0：时钟偏差不显示成"未来"） */
function monitorAgoText(ms) {
  var value = Number(ms)
  if (!isFinite(value) || value < 0) value = 0
  var minutes = Math.floor(value / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return String(minutes) + ' 分钟前'
  var hours = Math.floor(minutes / 60)
  if (hours < 24) {
    var rest = minutes % 60
    return String(hours) + ' 小时' + (rest > 0 ? ' ' + String(rest) + ' 分钟' : '') + '前'
  }
  var days = Math.floor(hours / 24)
  var restHours = hours % 24
  return String(days) + ' 天' + (restHours > 0 ? ' ' + String(restHours) + ' 小时' : '') + '前'
}

/** 时刻 → 「14:12」（当天）或「09-23 14:12」（不是今天） */
function monitorClockText(ms, nowMs) {
  var at = Number(ms)
  if (!isFinite(at) || at <= 0) return ''
  var date = new Date(at)
  var now = new Date(Number(nowMs) || Date.now())
  var hh = date.getHours() < 10 ? '0' + String(date.getHours()) : String(date.getHours())
  var mm = date.getMinutes() < 10 ? '0' + String(date.getMinutes()) : String(date.getMinutes())
  var sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return hh + ':' + mm
  var mo = date.getMonth() + 1 < 10 ? '0' + String(date.getMonth() + 1) : String(date.getMonth() + 1)
  var dd = date.getDate() < 10 ? '0' + String(date.getDate()) : String(date.getDate())
  return mo + '-' + dd + ' ' + hh + ':' + mm
}

/** 数组 → 字符串数组（对象/空值一律丢掉，别把 [object Object] 摆到界面上） */
function monitorStringList(value) {
  if (!Array.isArray(value)) return []
  var out = []
  for (var i = 0; i < value.length; i += 1) {
    var text = cellText(value[i])
    if (text !== '') out.push(text)
  }
  return out
}

/* ── 纯函数：两个文件的形状 ── */

/** monitor.json → 显示模型（缺的字段就是空，不编默认值；周期缺省 60 分钟并在界面上说明） */
function monitorView(monitor) {
  var view = { intervalMinutes: 60, intervalFromFile: false, assets: [], allow: [], deny: [], note: '', label: '', expectPreset: '', localCount: 0 }
  if (monitor === null || typeof monitor !== 'object') return view
  var def = Number(monitor.defaultIntervalMinutes)
  if (isFinite(def) && def > 0) {
    view.intervalMinutes = def
    view.intervalFromFile = true
  }
  var assets = Array.isArray(monitor.assets) ? monitor.assets : []
  for (var i = 0; i < assets.length; i += 1) {
    var one = assets[i]
    if (one === null || typeof one !== 'object') continue
    var id = String(one.id === undefined || one.id === null ? '' : one.id).trim()
    if (id === '') continue
    var kind = String(one.kind === undefined ? '' : one.kind).trim().toLowerCase() === 'local' ? 'local' : 'ssh'
    var own = Number(one.intervalMinutes)
    var detail = []
    if (kind === 'ssh' && cellText(one.host) !== '') detail.push(cellText(one.host))
    if (cellText(one.os) !== '') detail.push(cellText(one.os))
    view.assets.push({
      id: id,
      kind: kind,
      name: cellText(one.name) === '' ? id : cellText(one.name),
      detail: detail.join(' · '),
      intervalMinutes: isFinite(own) && own > 0 ? own : view.intervalMinutes,
      account: cellText(one.readonlyAccount),
      constraint: cellText(one.readonlyConstraint),
    })
    if (kind === 'local') view.localCount += 1
  }
  var caps = monitor.capabilities
  if (caps !== null && caps !== undefined && typeof caps === 'object' && !Array.isArray(caps)) {
    view.allow = monitorStringList(caps.allow)
    view.deny = monitorStringList(caps.deny)
    view.note = cellText(caps.note)
    view.label = cellText(caps.label)
    view.expectPreset = cellText(caps.expectPreset)
  }
  return view
}

/** 一条发现 → 规整形状（认中英文等级；标题从 title/summary/name 里第一个有值的取） */
function monitorParseFindings(raw) {
  var out = []
  if (!Array.isArray(raw)) return out
  for (var i = 0; i < raw.length; i += 1) {
    var one = raw[i]
    if (one === null || typeof one !== 'object' || Array.isArray(one)) continue
    var levelRaw = cellText(one.level !== undefined ? one.level : one.severity)
    var title = cellText(one.title)
    if (title === '') title = cellText(one.summary)
    if (title === '') title = cellText(one.name)
    out.push({
      id: cellText(one.id) === '' ? 'f-' + String(i) : cellText(one.id),
      assetId: cellText(one.assetId !== undefined ? one.assetId : one.asset),
      levelKey: monitorLevelKey(levelRaw),
      levelRaw: levelRaw,
      title: title === '' ? '（没写标题）' : title,
      detail: cellText(one.detail !== undefined ? one.detail : one.note),
      detectedAtMs: monitorTimeMs(one.detectedAtMs !== undefined ? one.detectedAtMs : one.atMs),
      evidence: cellText(one.evidence !== undefined ? one.evidence : one.evidencePath),
      sha: cellText(one.evidenceSha256 !== undefined ? one.evidenceSha256 : one.sha256),
      notifiedAtMs: monitorTimeMs(one.notifiedAtMs),
      cannotAct: cellText(one.cannotAct),
    })
  }
  return out
}

/** 一轮里的一个资产记录 → 规整形状（summary 只认四个等级键，其余不猜） */
function monitorParseAssetRecord(raw) {
  var summary = { critical: 0, high: 0, medium: 0, low: 0 }
  var raw2 = raw.summary
  if (raw2 !== null && raw2 !== undefined && typeof raw2 === 'object' && !Array.isArray(raw2)) {
    for (var i = 0; i < MONITOR_LEVELS.length; i += 1) {
      var level = MONITOR_LEVELS[i]
      var value = raw2[level.key]
      if (value === undefined) value = raw2[level.label]
      var num = Number(value)
      if (isFinite(num) && num > 0) summary[level.key] = num
    }
  }
  var snapshot = {}
  if (raw.snapshot !== null && raw.snapshot !== undefined && typeof raw.snapshot === 'object' && !Array.isArray(raw.snapshot)) {
    snapshot = raw.snapshot
  }
  return {
    assetId: cellText(raw.assetId !== undefined ? raw.assetId : raw.id),
    checkedAtMs: monitorTimeMs(raw.checkedAtMs !== undefined ? raw.checkedAtMs : raw.atMs),
    summary: summary,
    snapshot: snapshot,
  }
}

/**
 * findings.json → { rounds }（一轮 = 一次巡检）。
 *
 * 两种写法都认：
 *   · 规范写法：rounds[]，每轮带 atMs / assets[] / findings[]
 *   · 偷懒写法：顶层直接一个 findings[]（那就当"一轮"，时间取里面最新的一条）
 * 为什么要迁就后者：**这一页的价值取决于员工愿不愿意写**。它顺手写成扁平数组时，
 * 页面该做的是照常显示并标明"没有分轮"，而不是白屏。
 */
function findingsView(findings) {
  var view = { rounds: [], generatedAtMs: 0 }
  if (findings === null || typeof findings !== 'object') return view
  view.generatedAtMs = monitorTimeMs(findings.generatedAtMs)
  var list = Array.isArray(findings.rounds) ? findings.rounds : []
  for (var i = 0; i < list.length; i += 1) {
    var one = list[i]
    if (one === null || typeof one !== 'object' || Array.isArray(one)) continue
    var round = {
      atMs: monitorTimeMs(one.atMs !== undefined ? one.atMs : one.startedAtMs),
      assets: [],
      findings: monitorParseFindings(one.findings),
    }
    var assets = Array.isArray(one.assets) ? one.assets : []
    for (var a = 0; a < assets.length; a += 1) {
      if (assets[a] === null || typeof assets[a] !== 'object' || Array.isArray(assets[a])) continue
      var record = monitorParseAssetRecord(assets[a])
      if (record.assetId === '') continue
      round.assets.push(record)
      if (record.checkedAtMs > round.atMs) round.atMs = record.checkedAtMs
    }
    view.rounds.push(round)
  }
  view.rounds.sort(function (a, b) {
    return a.atMs - b.atMs
  })
  var flat = monitorParseFindings(findings.findings)
  if (flat.length > 0) {
    var last = view.rounds.length > 0 ? view.rounds[view.rounds.length - 1] : null
    if (last === null) {
      var newest = 0
      for (var f = 0; f < flat.length; f += 1) {
        if (flat[f].detectedAtMs > newest) newest = flat[f].detectedAtMs
      }
      view.rounds.push({ atMs: newest, assets: [], findings: flat })
    } else if (last.findings.length === 0) {
      /* 顶层扁平数组 + 最后一轮没写发现 → 当成本轮发现（两份都写时以轮内的为准） */
      last.findings = flat
    }
  }
  return view
}

/** 一个资产此刻的状态：四种态 + 上次检查时刻 + 迟了多久（**控制台现算**） */
function monitorAssetState(asset, view, nowMs, nodeOnline) {
  var lastAtMs = 0
  var roundAtMs = 0
  if (view !== null && view !== undefined) {
    for (var r = view.rounds.length - 1; r >= 0; r -= 1) {
      var round = view.rounds[r]
      for (var a = 0; a < round.assets.length; a += 1) {
        if (round.assets[a].assetId === asset.id) {
          lastAtMs = round.assets[a].checkedAtMs > 0 ? round.assets[a].checkedAtMs : round.atMs
          roundAtMs = round.atMs
          break
        }
      }
      if (lastAtMs > 0) break
    }
  }
  var counts = null
  var extra = 0
  if (view !== null && view !== undefined && view.rounds.length > 0) {
    var latest = view.rounds[view.rounds.length - 1]
    var tally = { critical: 0, high: 0, medium: 0, low: 0 }
    var found = false
    for (var f = 0; f < latest.findings.length; f += 1) {
      var item = latest.findings[f]
      /* 没写 assetId 的发现不往任何一台身上算：宁可少算，也不能给某一台扣帽子 */
      if (item.assetId !== asset.id) continue
      found = true
      if (item.levelKey === '') extra += 1
      else tally[item.levelKey] += 1
    }
    if (found) counts = tally
  }
  var intervalMs = asset.intervalMinutes > 0 ? asset.intervalMinutes * 60000 : 3600000
  var lateMs = lastAtMs > 0 ? Number(nowMs) - lastAtMs : 0
  var state = 'ok'
  var label = '正常'
  if (nodeOnline !== true) {
    state = 'off'
    label = '失联'
  } else if (lastAtMs === 0) {
    state = 'none'
    label = '还没跑过'
  } else if (lateMs > intervalMs) {
    state = 'stale'
    label = '陈旧'
  } else if (counts !== null && (counts.critical > 0 || counts.high > 0)) {
    state = 'bad'
    label = '有异常'
  } else if (counts !== null && (counts.medium > 0 || counts.low > 0)) {
    state = 'warn'
    label = '有异常'
  }
  var total = 0
  if (counts !== null) total = counts.critical + counts.high + counts.medium + counts.low + extra
  return {
    state: state,
    label: label,
    lastAtMs: lastAtMs,
    roundAtMs: roundAtMs,
    lateMs: lateMs,
    intervalMs: intervalMs,
    counts: counts,
    unknownLevels: extra,
    total: total,
    provenance: asset.kind === 'local' ? MONITOR_PROV_SELF : MONITOR_PROV_EXT,
  }
}

/** 轮次带：最近 N 个周期槽各是什么结果（**缺口由控制台按周期推**，不采信自报） */
function monitorSlots(view, intervalMs, nowMs, count) {
  var slotMs = intervalMs > 0 ? intervalMs : 3600000
  var newest = 0
  if (view !== null && view !== undefined) {
    for (var i = 0; i < view.rounds.length; i += 1) {
      if (view.rounds[i].atMs > newest) newest = view.rounds[i].atMs
    }
  }
  var currentStart = Math.floor(Number(nowMs) / slotMs) * slotMs
  var slots = []
  for (var back = count - 1; back >= 0; back -= 1) {
    var start = currentStart - back * slotMs
    var end = start + slotMs
    var hit = null
    if (view !== null && view !== undefined) {
      for (var r = view.rounds.length - 1; r >= 0; r -= 1) {
        var at = view.rounds[r].atMs
        if (at >= start && at < end) {
          hit = view.rounds[r]
          break
        }
      }
    }
    var state = 'miss'
    if (hit !== null) {
      var counts = monitorRoundLevelCounts(hit)
      state = counts.critical > 0 || counts.high > 0 ? 'bad' : 'ok'
    } else if (end > Number(nowMs)) {
      /* 当前这一格还没到点：只有"已经迟了"才算缺轮（否则每一页刚打开都在冤枉员工） */
      state = newest > 0 && Number(nowMs) - newest <= slotMs ? 'due' : 'miss'
    }
    slots.push({ start: start, end: end, state: state, atMs: hit === null ? 0 : hit.atMs })
  }
  return slots
}

/**
 * 两轮的差异（**控制台现算**：不读员工写的 changes 字段）。
 *
 * 只比对两份 snapshot 里都出现过的键；列表按集合比（新增/消失），标量按值比。
 * 上一轮没有这个资产/没写 snapshot → 返回 kind 'unknown'，如实说"比不了"。
 */
function monitorDiff(prevRound, nextRound) {
  if (prevRound === null || nextRound === null || prevRound === undefined || nextRound === undefined) return null
  var out = []
  for (var a = 0; a < nextRound.assets.length; a += 1) {
    var next = nextRound.assets[a]
    var nextSnap = next.snapshot !== null && next.snapshot !== undefined && typeof next.snapshot === 'object' ? next.snapshot : {}
    var keys = Object.keys(nextSnap)
    if (keys.length === 0) continue
    var prev = null
    for (var p = 0; p < prevRound.assets.length; p += 1) {
      if (prevRound.assets[p].assetId === next.assetId) prev = prevRound.assets[p]
    }
    var prevSnap =
      prev !== null && prev.snapshot !== null && prev.snapshot !== undefined && typeof prev.snapshot === 'object'
        ? prev.snapshot
        : null
    if (prev === null || prevSnap === null || Object.keys(prevSnap).length === 0) {
      out.push({ assetId: next.assetId, key: '', kind: 'unknown', added: [], removed: [], from: '', to: '' })
      continue
    }
    for (var k = 0; k < keys.length; k += 1) {
      var key = keys[k]
      var nowValue = nextSnap[key]
      if (prevSnap[key] === undefined) {
        out.push({ assetId: next.assetId, key: key, kind: 'new-key', added: monitorStringList(nowValue), removed: [], from: '', to: cellText(nowValue) })
        continue
      }
      var wasValue = prevSnap[key]
      if (Array.isArray(nowValue) || Array.isArray(wasValue)) {
        var nowList = monitorStringList(Array.isArray(nowValue) ? nowValue : [nowValue])
        var wasList = monitorStringList(Array.isArray(wasValue) ? wasValue : [wasValue])
        var added = []
        var removed = []
        for (var n = 0; n < nowList.length; n += 1) {
          if (wasList.indexOf(nowList[n]) < 0) added.push(nowList[n])
        }
        for (var w = 0; w < wasList.length; w += 1) {
          if (nowList.indexOf(wasList[w]) < 0) removed.push(wasList[w])
        }
        if (added.length > 0 || removed.length > 0) {
          out.push({ assetId: next.assetId, key: key, kind: 'list', added: added, removed: removed, from: '', to: '' })
        }
        continue
      }
      var wasText = cellText(wasValue)
      var nowText = cellText(nowValue)
      if (wasText !== nowText) {
        out.push({ assetId: next.assetId, key: key, kind: 'scalar', added: [], removed: [], from: wasText, to: nowText })
      }
    }
  }
  return out
}

/** 一轮里有没有"高"以上的发现（轮次带的颜色用它） */
function monitorRoundLevelCounts(round) {
  var counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  if (round === null || round === undefined) return counts
  for (var i = 0; i < round.findings.length; i += 1) {
    var key = round.findings[i].levelKey
    if (key === '') counts.unknown += 1
    else counts[key] += 1
  }
  return counts
}

/* ── 已阅标记（**只存本机**：控制台不写员工的工作区文件）── */

/**
 * 为什么不做"写回 findings.json"：一份数据两个写者，必然出现并发覆盖与两份真相。
 * 代价是换设备就丢 —— 所以界面上必须写明这是本机标记（见 renderPanelMonitorFindings）。
 *
 * 存储形状是**扁平**的 {"员工id/发现id": 时刻}（与 LS.monitorRead 的注释一致）：
 * 写成嵌套对象时读写两边很容易一边记 data[id]、一边记 data[id + '/' + fid] ——
 * 真发生过：标记写进去了但永远读不回来，"已阅"点完就消失，而且不报错。
 */
function monitorReadSet(employeeId) {
  var raw = readLocal(LS.monitorRead)
  if (raw === null || raw === '') return {}
  var data = null
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return {}
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  var prefix = String(employeeId) + '/'
  var mine = {}
  var keys = Object.keys(data)
  for (var i = 0; i < keys.length; i += 1) {
    if (keys[i].indexOf(prefix) === 0) mine[keys[i]] = data[keys[i]]
  }
  return mine
}

function monitorReadKey(employeeId, findingId) {
  return String(employeeId) + '/' + String(findingId)
}

function markMonitorRead(employeeId, findingId, read) {
  var raw = readLocal(LS.monitorRead)
  var data = {}
  if (raw !== null && raw !== '') {
    try {
      var parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
    } catch (error) {
      data = {}
    }
  }
  var key = monitorReadKey(employeeId, findingId)
  if (read) data[key] = Date.now()
  else delete data[key]
  writeLocal(LS.monitorRead, JSON.stringify(data))
}

/* ── 共用小件 ── */

/** 一行「读不到」的原因（沿用 appendFileState 的四种分法，别让两个面板说法不一致） */
function monitorFileNote(box, result, hint) {
  if (result !== null && result !== undefined && result.ok === true) return false
  appendFileState(box, result, hint)
  return true
}

/** 面板标题行右侧的小字（asideBlock 的徽章位留给计数，这里放时间口径） */
function monitorTitleSub(box, text) {
  if (text === '' || box === null || box.firstChild === null) return
  box.firstChild.appendChild(el('span', 'quad-sub', text))
}

/** 状态点（四态 + 还没跑过） */
function monitorDotNode(state) {
  return el('span', 'quad-dot ' + String(state || 'none'))
}

/**
 * 给输入框填一句待发指令（**不代你发送**）。
 *
 * 为什么只填不发：「看证据」要花你的额度、要占一轮对话，还可能连着一串动作。
 * 页面的职责是把话说清楚，按发送键的必须是人。
 */
function quadPrefillPrompt(text) {
  var input = $('promptInput')
  if (input === null) return false
  input.value = String(text)
  if (typeof updateSendButton === 'function') updateSendButton()
  input.focus()
  return true
}

/* ── 面板：顶部「只读 · 无处置权限」徽章 ── */

/** 这个员工此刻的未决条数（徽章与右上格用的是同一份 state.approvals） */
function monitorPendingCount(employeeId) {
  var count = 0
  for (var i = 0; i < state.approvals.length; i += 1) {
    var item = state.approvals[i]
    if (item === null || typeof item !== 'object') continue
    if (String(item.status || '') !== 'pending') continue
    if (
      String(item.employeeId || '') === String(employeeId) ||
      String(item.fromEmployeeId || '') === String(employeeId) ||
      String(item.toEmployeeId || '') === String(employeeId)
    ) {
      count += 1
    }
  }
  return count
}

/**
 * 声明 ↔ 生效（**页面从"复述承诺"变成"校验承诺"的唯一一行**）。
 *
 * 能校验的只有 preset（employee.list 带出来的 agentPreset）；approval 的生效值控制台读不到，
 * 所以那一半只显示声明、**明确写"未校验"**，不假装校验过。
 */
function monitorPresetVerdict(view, employee) {
  var actual = employee !== null && employee !== undefined && typeof employee.agentPreset === 'string' ? employee.agentPreset.trim() : ''
  var expect = view !== null && view !== undefined ? view.expectPreset : ''
  var verdict = { actual: actual, expect: expect, kind: 'none', text: '' }
  if (actual === '') {
    verdict.kind = 'unknown'
    verdict.text = '生效 preset：节点默认（这个员工没有单独指定）—— 与声明的对照校验不了'
    return verdict
  }
  if (expect === '') {
    verdict.kind = 'none'
    verdict.text = '生效 preset：' + actual + '（' + MONITOR_PATH + ' 没写 capabilities.expectPreset，所以没有可对照的声明）'
    return verdict
  }
  if (expect === actual) {
    verdict.kind = 'ok'
    verdict.text = '生效 preset：' + actual + ' · 与声明一致'
    return verdict
  }
  verdict.kind = 'bad'
  verdict.text = '生效 preset：' + actual + ' · 与声明不符（' + MONITOR_PATH + ' 里声明的是 ' + expect + '）'
  return verdict
}

/** 钥匙：清单里出现过的只读账号（含授权约束原文），去重后列出 */
function monitorKeyLines(view) {
  var lines = []
  for (var i = 0; i < view.assets.length; i += 1) {
    var asset = view.assets[i]
    if (asset.account === '') continue
    var text = asset.name + ' · ' + asset.account + (asset.constraint === '' ? '' : ' · ' + asset.constraint)
    if (lines.indexOf(text) < 0) lines.push(text)
  }
  return lines
}

/**
 * 徽章的"声明"从哪个文件读。
 *
 * 两个岗位共用这一个面板，但文件不同：安全监测读 monitor.json（只读岗），
 * 应急响应读 incident.json（可处置岗）。**先看有没有事件登记** —— 而"哪个文件该读"
 * 在 68-quad 的 quadFileNeeds 里就定了（配了 incident-* 面板的岗位不会去读 monitor.json），
 * 所以这里只是把拿到的那一份转成同一种形状。
 */
function incidentCapabilityView(view) {
  var caps = view !== null && view.capabilities !== null && typeof view.capabilities === 'object' ? view.capabilities : null
  var out = { label: '', note: '', allow: [], deny: [], expectPreset: '', assets: [] }
  if (caps === null) return out
  out.label = cellText(caps.label)
  out.note = cellText(caps.note)
  out.allow = monitorStringList(caps.allow)
  out.deny = monitorStringList(caps.deny)
  out.expectPreset = cellText(caps.expectPreset)
  var account = cellText(caps.account)
  if (account !== '') {
    out.assets.push({
      name: cellText(caps.accountLabel) === '' ? '处置账号' : cellText(caps.accountLabel),
      account: account,
      constraint: cellText(caps.constraint),
    })
  }
  return out
}

/** 徽章的数据来源：{ view, result, path, hint }（view 为 null = 没读到，要用 path/hint 说清原因） */
function capabilitySourceOf(ctx) {
  var incidentResult = ctx.incidentResult
  if (incidentResult !== null && incidentResult !== undefined && incidentResult.ok === true) {
    return { view: incidentCapabilityView(incidentView(incidentResult.value)), result: incidentResult, path: INCIDENT_PATH, hint: INCIDENT_HINT }
  }
  var monitorResult = ctx.monitorResult
  var view = monitorResult !== null && monitorResult !== undefined && monitorResult.ok === true ? monitorView(monitorResult.value) : null
  return { view: view, result: monitorResult, path: MONITOR_PATH, hint: MONITOR_HINT }
}

/** 顶部徽章 + 弹层（点开才是完整的权限边界卡） */
function renderPanelCapabilityBadge(container, ctx) {
  var employee = ctx.employee
  var employeeId = employee === null || employee === undefined ? '' : String(employee.id || '')
  var source = capabilitySourceOf(ctx)
  var result = source.result
  var view = source.view
  var verdict = monitorPresetVerdict(view, employee)
  var tone = verdict.kind === 'bad' ? ' bad' : view === null ? ' plain' : ' ok'
  var fullLabel = view !== null && view.label !== '' ? view.label : MONITOR_BADGE_FALLBACK
  /**
   * 药丸上只放标签的第一段（"只读 · 无处置权限" → "只读"）。
   *
   * 为什么：顶部条是**稀缺位置**，实测 1280px 窗口里放完"只读 · 无处置权限"（114px）后
   * 整行横向溢出 67px —— 顶部条推出去的那部分会被裁掉（返回键、动作按钮都可能在裁掉的区域里）。
   * 完整标签在弹层标题与 title 里都在，所以这里短一点也不丢信息。
   * 不一致时药丸改成"声明不符"并变红：那才是它需要被看见的时刻。
   */
  var shortLabel = String(fullLabel).split('·')[0].trim()
  if (shortLabel === '') shortLabel = fullLabel
  var pending = monitorPendingCount(employeeId)

  var wrap = el('div', 'quad-badge-wrap')
  var button = el('button', 'quad-badge' + tone, verdict.kind === 'bad' ? '声明不符' : shortLabel)
  button.setAttribute('aria-expanded', state.quad.badgeOpen === true ? 'true' : 'false')
  button.title = fullLabel + ' —— ' + verdict.text
  button.onclick = function () {
    state.quad.badgeOpen = !(state.quad.badgeOpen === true)
    renderQuadCells()
  }
  wrap.appendChild(button)
  if (pending > 0) wrap.appendChild(el('span', 'badge warn', String(pending)))
  container.appendChild(wrap)

  if (state.quad.badgeOpen !== true) return
  var pop = el('div', 'quad-pop')
  var title = el('div', 'aside-title', fullLabel)
  title.appendChild(el('span', 'quad-sub', '声明（你写）↔ 生效（平台）'))
  pop.appendChild(title)

  if (view === null) {
    pop.appendChild(el('div', 'aside-bad', '读不到 ' + source.path + '，所以"声明"那一半拿不到。'))
    pop.appendChild(el('div', 'aside-note', source.hint))
    if (result !== null && result !== undefined && result.ok !== true) appendFileState(pop, result, source.hint)
  } else {
    var caps = el('div', 'quad-cap')
    var can = el('div', 'quad-cap-col can')
    can.appendChild(el('div', 'quad-cap-head', '能做'))
    if (view.allow.length === 0) can.appendChild(el('div', 'aside-note', '（' + source.path + ' 没写 capabilities.allow）'))
    for (var i = 0; i < view.allow.length; i += 1) can.appendChild(el('div', 'quad-cap-item', '✓ ' + view.allow[i]))
    var cannot = el('div', 'quad-cap-col cannot')
    cannot.appendChild(el('div', 'quad-cap-head', '不能做'))
    if (view.deny.length === 0) cannot.appendChild(el('div', 'aside-note', '（' + source.path + ' 没写 capabilities.deny）'))
    for (var d = 0; d < view.deny.length; d += 1) cannot.appendChild(el('div', 'quad-cap-item', '✗ ' + view.deny[d]))
    caps.appendChild(can)
    caps.appendChild(cannot)
    pop.appendChild(caps)
  }

  var verdictRow = el('div', 'quad-verdict' + (verdict.kind === 'bad' ? ' bad' : verdict.kind === 'ok' ? ' ok' : ''))
  verdictRow.textContent = verdict.text
  pop.appendChild(verdictRow)

  if (view !== null) {
    var keys = monitorKeyLines(view)
    if (keys.length === 0) {
      pop.appendChild(el('div', 'aside-note', '钥匙：' + source.path + ' 里没有登记账号'))
    } else {
      for (var k = 0; k < keys.length; k += 1) pop.appendChild(el('div', 'quad-key', '钥匙 ' + keys[k]))
    }
    if (view.note !== '') pop.appendChild(el('div', 'aside-note', view.note))
  }
  pop.appendChild(
    el(
      'div',
      'aside-note',
      '审批：只在真有未决项时才出现在右上格顶上 —— 本页平时不显示这一栏，因为常态是 0，' +
        '常驻一个永远不变的数字等于白占位置。',
    ),
  )
  wrap.appendChild(pop)
}

/* ── 面板：左上哨兵台 ── */

/** 空态里的「写入模板」：写一份带注释的起步文件（人写的东西，控制台只帮起个草） */
function monitorTemplateText() {
  var template = {
    _note: '监测范围由人写：盯谁、多久一次、钥匙是什么。把 assets 改成你自己的机器；' +
      'capabilities 是给页面看的声明（能不能动手）。员工不能自己决定监测范围。',
    updatedAtMs: Date.now(),
    defaultIntervalMinutes: 60,
    assets: [
      {
        id: 'local',
        kind: 'local',
        name: '本机',
        os: '',
        checks: [],
      },
      {
        id: 'srv-1',
        kind: 'ssh',
        name: '（改成服务器名）',
        host: '',
        readonlyAccount: '',
        readonlyConstraint: '',
        checks: [],
      },
    ],
    capabilities: {
      label: '只读 · 无处置权限',
      note: '本岗位只报不处置：发现了也只报给你，不能动手。',
      allow: ['读工作区', '跑只读命令', '用只读账号 SSH 到清单内的机器', '生成报告', '通知你'],
      deny: ['改配置', '杀进程', '删或隔离文件', '装软件', '重启服务', '改防火墙', '在服务器上写任何文件'],
      expectPreset: 'workspace-write',
    },
  }
  return JSON.stringify(template, null, 2) + '\n'
}

/**
 * 「写入 <文件> 模板」按钮（监测岗与应急岗共用这一条写入路径）。
 *
 * 为什么共用：写入是**唯一一处控制台往员工工作区写文件**的地方（其余一律只读）。
 * 两个岗位各写一份的话，权限检查、失败提示、写后重读这三件事迟早只有一份是对的。
 * 谁有权限：employee.manage（没有就不画按钮 —— 按了会失败的按钮等于骗人）。
 */
function workspaceTemplateButton(box, employeeId, filePath, content) {
  if (state.scopes.indexOf('employee.manage') < 0) {
    box.appendChild(el('div', 'aside-note', '（写入模板需要 employee.manage 权限）'))
    return
  }
  var label = '写入 ' + filePath + ' 模板'
  var button = el('button', 'ghost', label)
  button.onclick = function () {
    button.disabled = true
    button.textContent = '正在写入…'
    rpc('employee.files.set', { employeeId: employeeId, path: filePath, content: content }).then(
      function () {
        toast('已写入 ' + filePath + '：改完刷新这一页', 'ok')
        reloadQuadFiles()
      },
      function (error) {
        button.disabled = false
        button.textContent = label
        toast('写入失败：' + describeError(error), 'bad')
      },
    )
  }
  box.appendChild(button)
}

function monitorTemplateButton(box, employeeId) {
  workspaceTemplateButton(box, employeeId, MONITOR_PATH, monitorTemplateText())
}

/**
 * incident.json 的起步模板。
 *
 * **故意写成 status: "standby"（待命）而不是直接开一次事件**：写完模板就显示"正在处置"
 * 是这一页最容易犯的谎 —— 没有事件就是没有事件。准备开一次真实事件时，
 * 把 title/level/scope 改成真的，并把 status 改成 "open"。
 */
function incidentTemplateText() {
  var template = {
    _note: '这一份是常备层：允许处置什么、禁止什么、谁定的 —— 定一次、长期不变。' +
      '它不描述"这一次事件"（那是 actions.json 里的事件登记，由员工写），也不放预案（要干什么你当场告诉她）。',
    authorizedBy: '（谁定的）',
    authorizedAtMs: Date.now(),
    stages: ['发现', '遏制', '清除', '恢复', '复盘'],
    standing: {
      allow: ['跑只读命令', '改防火墙规则', '停用账号', '断开连接'],
      deny: ['重装系统', '删除数据', '重启数据库'],
    },
    capabilities: {
      label: '可处置 · 逐步审批',
      note: '每一步动手前都要提案并等我批准；只读排查不用批。',
      allow: ['读工作区', '跑只读命令', '以只读账号 SSH', '按批准执行单步处置', '生成报告'],
      deny: ['未经批准的任何写操作', '重装/删数据', '扩大处置范围'],
      expectPreset: 'workspace-write',
      account: '',
      constraint: '',
    },
  }
  return JSON.stringify(template, null, 2) + '\n'
}

function incidentTemplateButton(box, employeeId) {
  workspaceTemplateButton(box, employeeId, INCIDENT_PATH, incidentTemplateText())
}

/** 左上「监测面」：在岗状态 + 监测范围里每台机器的**新鲜度** */
function renderPanelMonitorPost(container, ctx) {
  var employee = ctx.employee
  var employeeId = employee === null || employee === undefined ? '' : String(employee.id || '')
  var nodeOnline = employee !== null && employee !== undefined && employee.nodeOnline !== false
  var monitorResult = ctx.monitorResult
  var findingsResult = ctx.findingsResult
  var view = monitorResult !== null && monitorResult !== undefined && monitorResult.ok === true ? monitorView(monitorResult.value) : null
  var fview = findingsResult !== null && findingsResult !== undefined && findingsResult.ok === true ? findingsView(findingsResult.value) : null
  var nowMs = Date.now()

  var latestAtMs = 0
  if (fview !== null) {
    for (var r = 0; r < fview.rounds.length; r += 1) {
      if (fview.rounds[r].atMs > latestAtMs) latestAtMs = fview.rounds[r].atMs
    }
  }

  var box = asideBlock(container, '监测面')
  monitorTitleSub(box, latestAtMs > 0 ? '最后一份报告 ' + monitorAgoText(nowMs - latestAtMs) : '还没有报告')

  /* ① 没读到 monitor.json：这一格的空态是产品的一部分（"盯谁由你定"） */
  if (view === null) {
    box.appendChild(
      el('div', 'quad-empty', '工作区里还没有 ' + MONITOR_PATH + ' —— 盯谁由你定，员工不能自己决定监测范围。'),
    )
    appendFileState(box, monitorResult, MONITOR_HINT)
    monitorTemplateButton(box, employeeId)
    return
  }
  if (view.assets.length === 0) {
    box.appendChild(el('div', 'quad-empty', MONITOR_PATH + ' 里一台机器都没有登记（assets 是空的）。'))
    box.appendChild(el('div', 'aside-note', MONITOR_HINT))
    box.appendChild(el('div', 'aside-note', '台数它自己不会变多：要盯什么，得你写进去。'))
    return
  }

  /* ② 在岗 / 中断 / 陈旧：监测岗唯一真正的灾难是静默失效，所以这一行永远在最上面 */
  var states = []
  var worst = 'ok'
  var rank = { ok: 0, none: 1, warn: 2, stale: 2, bad: 3, off: 4 }
  for (var i = 0; i < view.assets.length; i += 1) {
    var one = monitorAssetState(view.assets[i], fview, nowMs, nodeOnline)
    states.push(one)
    if (rank[one.state] > rank[worst]) worst = one.state
  }
  var totalFindings = 0
  var staleCount = 0
  var freshCount = 0
  for (var s = 0; s < states.length; s += 1) {
    totalFindings += states[s].total
    if (states[s].state === 'stale') staleCount += 1
    if (states[s].state === 'ok' || states[s].state === 'warn' || states[s].state === 'bad') freshCount += 1
  }
  var posture = el('div', 'quad-posture ' + (nodeOnline !== true ? 'off' : worst === 'ok' ? 'ok' : 'warn'))
  posture.appendChild(monitorDotNode(nodeOnline !== true ? 'off' : worst))
  if (nodeOnline !== true) {
    posture.appendChild(el('b', '', '监测中断'))
    posture.appendChild(
      el(
        'div',
        'aside-note',
        '节点离线 —— 这台机器上的员工没有说话' +
          (latestAtMs > 0 ? '，最后一份报告 ' + monitorAgoText(nowMs - latestAtMs) : '（还没有过报告）'),
      ),
    )
  } else if (staleCount > 0) {
    posture.appendChild(el('b', '', '有 ' + String(staleCount) + ' 台数据过期'))
    posture.appendChild(el('div', 'aside-note', '过期期间这一页不能替你判断：无数据 != 正常。'))
  } else {
    posture.appendChild(el('b', '', '在岗'))
    posture.appendChild(
      el(
        'div',
        'aside-note',
        '本机 ' + String(view.localCount) + ' · 服务器 ' + String(view.assets.length - view.localCount) +
          ' · 周期 ' + String(view.intervalMinutes) + ' 分钟' +
          (view.intervalFromFile ? '' : '（' + MONITOR_PATH + ' 没写周期，按 60 分钟算）') + ' · 未超期',
      ),
    )
  }
  box.appendChild(posture)

  /* ③ 每台一行：名字 + 新鲜度（现算）+ 本轮条数 + 证据可信度 */
  var assetsBox = el('div', 'quad-assets')
  for (var a = 0; a < view.assets.length; a += 1) {
    var asset = view.assets[a]
    var state = states[a]
    var row = el('div', 'quad-asset')
    row.appendChild(monitorDotNode(state.state))
    var main = el('div', 'quad-asset-main')
    var nameRow = el('div', 'quad-asset-name', asset.name)
    if (asset.detail !== '') nameRow.appendChild(el('span', 'quad-asset-detail', asset.detail))
    main.appendChild(nameRow)
    var freshText = ''
    if (state.state === 'off') freshText = '节点离线，读不到'
    else if (state.lastAtMs === 0) freshText = '从没巡检过（清单里有它，但没有记录）'
    else {
      freshText = '上次巡检 ' + monitorAgoText(nowMs - state.lastAtMs)
      if (state.state === 'stale') freshText += ' · 已超期 ' + monitorAgoText(state.lateMs - state.intervalMs)
      else freshText += ' · 周期 ' + String(asset.intervalMinutes) + ' 分钟'
    }
    main.appendChild(el('div', 'quad-asset-sub', freshText))
    row.appendChild(main)
    /* 有发现的那台挂红徽章（badge.bad 是平台既有语义色；别自造 hot 这种没样式的类名） */
    if (state.total > 0) row.appendChild(el('span', 'badge ' + (state.state === 'bad' ? 'bad' : 'warn'), String(state.total) + ' 项'))
    else row.appendChild(el('span', 'badge', state.label))
    row.appendChild(
      el(
        'span',
        'quad-prov ' + (state.provenance === MONITOR_PROV_SELF ? 'self' : 'ext'),
        state.provenance,
      ),
    )
    assetsBox.appendChild(row)
  }
  box.appendChild(assetsBox)

  /* ④ 汇总 + 图例（状态点的四种态必须解释一次，否则"黄点"没人知道是过期） */
  box.appendChild(el('div', 'aside-sep'))
  var line = el('div', 'quad-legend')
  line.appendChild(el('span', '', '状态'))
  var legend = [
    { state: 'ok', text: '正常' },
    { state: 'bad', text: '有异常' },
    { state: 'stale', text: '陈旧' },
    { state: 'off', text: '失联' },
    { state: 'none', text: '没跑过' },
  ]
  for (var l = 0; l < legend.length; l += 1) {
    line.appendChild(monitorDotNode(legend[l].state))
    line.appendChild(el('span', '', legend[l].text))
  }
  box.appendChild(line)
  box.appendChild(
    el(
      'div',
      'aside-note',
      '新鲜度由控制台现算（' + String(freshCount) + '/' + String(view.assets.length) + ' 台在周期内' +
        '，本轮共 ' + String(totalFindings) + ' 项待复核）—— 不采信员工自报"我巡检过了"。',
    ),
  )
  /* 读不到就必须说读不到 —— 绝不把它渲染成"一切正常" */
  monitorFileNote(box, findingsResult, '每轮巡检结果写在 ' + FINDINGS_PATH + '（员工写）：rounds[] 每轮带 atMs / assets / findings。')
  box.appendChild(el('div', 'aside-note', '自证 = 本机结论（只作线索）· 可核验 = 服务器侧留痕，可抽查'))
}

/* ── 面板：左下异常台账 ── */

/** 一条发现（含「看证据 / 生成处置申请 / 已阅」三个动作，**没有处置**） */
function monitorFindingNode(finding, ctx, stale, assetName) {
  var employeeId = ctx.employee === null || ctx.employee === undefined ? '' : String(ctx.employee.id || '')
  var levelKey = finding.levelKey
  var levelText = levelKey === '' ? (finding.levelRaw === '' ? '未分级' : finding.levelRaw) : MONITOR_LEVEL_LABELS[levelKey]
  var row = el('div', 'quad-find' + (levelKey === 'critical' || levelKey === 'high' ? ' high' : levelKey === 'medium' ? ' med' : '') + (stale ? ' stale' : ''))

  var head = el('div', 'quad-find-head')
  head.appendChild(el('span', 'quad-lv ' + (levelKey === '' ? 'unknown' : levelKey), levelText))
  head.appendChild(el('span', 'quad-find-title', finding.title))
  head.appendChild(el('span', 'quad-find-time', monitorClockText(finding.detectedAtMs, Date.now())))
  row.appendChild(head)

  var meta = []
  if (assetName !== '') meta.push(assetName)
  if (finding.detail !== '') meta.push(finding.detail)
  if (meta.length > 0) row.appendChild(el('div', 'quad-find-meta', meta.join(' · ')))
  if (finding.evidence !== '') {
    row.appendChild(
      el(
        'div',
        'quad-find-ev',
        '证据 ' + finding.evidence + (finding.sha === '' ? '' : ' · sha256 ' + finding.sha),
      ),
    )
  }
  if (finding.notifiedAtMs > 0) {
    row.appendChild(el('div', 'quad-find-ev', '已通知你 ' + monitorClockText(finding.notifiedAtMs, Date.now())))
  }
  /* 陈旧（或节点离线）时**不给任何动作**：这三条是上一轮的结论，"已阅"或"申请处置"
     都等于把过期结论当成现在的判断依据。等有新的一轮再说 —— 读一读可以，动手不行。 */
  if (stale) return row

  var readSet = monitorReadSet(employeeId)
  var isRead = readSet[monitorReadKey(employeeId, finding.id)] !== undefined
  var act = el('div', 'quad-find-act')
  var see = el('button', 'ghost', '看证据')
  see.onclick = function () {
    if (!quadPrefillPrompt('把 ' + (finding.evidence === '' ? '这条发现的证据' : finding.evidence) + ' 的原文贴出来，并说明你的判断依据。')) {
      toast('先在右侧选一个会话再下指令', 'warn')
    }
  }
  act.appendChild(see)
  if (!isRead) {
    var ask = el('button', 'ghost', '生成处置申请')
    ask.onclick = function () {
      if (
        !quadPrefillPrompt(
          '为「' + finding.title + '」写一份处置申请（你不要执行任何处置动作）：目标与动作原文 / 依据 / 影响面 / 回滚办法 / 预计耗时。',
        )
      ) {
        toast('先在右侧选一个会话再下指令', 'warn')
      }
    }
    act.appendChild(ask)
  }
  var mark = el('button', 'ghost', isRead ? '取消已阅' : '已阅')
  mark.onclick = function () {
    markMonitorRead(employeeId, finding.id, !isRead)
    renderQuadCells()
    if (!isRead) toast('已标记已阅（只存在这台设备上，没有写回工作区）', 'info')
  }
  act.appendChild(mark)
  act.appendChild(el('span', 'quad-find-note', '本岗位无处置权限'))
  row.appendChild(act)
  return row
}

/** 左下「异常台账」：本轮发现 + 「无数据 != 正常」两句话分清楚 */
function renderPanelMonitorFindings(container, ctx) {
  var employee = ctx.employee
  var monitorResult = ctx.monitorResult
  var findingsResult = ctx.findingsResult
  var view = monitorResult !== null && monitorResult !== undefined && monitorResult.ok === true ? monitorView(monitorResult.value) : null
  var fview = findingsResult !== null && findingsResult !== undefined && findingsResult.ok === true ? findingsView(findingsResult.value) : null
  var nowMs = Date.now()
  var nodeOnline = employee !== null && employee !== undefined && employee.nodeOnline !== false

  var latest = fview !== null && fview.rounds.length > 0 ? fview.rounds[fview.rounds.length - 1] : null
  var latestAtMs = latest === null ? 0 : latest.atMs
  var slotMs = view !== null && view.intervalMinutes > 0 ? view.intervalMinutes * 60000 : 3600000
  /* 过期口径与哨兵台一致：拿"最新一轮的时间"跟周期比（同一份数据，两个面板不能各算各的） */
  var stale = nodeOnline !== true || (latestAtMs > 0 && nowMs - latestAtMs > slotMs)
  var ageText = latestAtMs > 0 ? monitorAgoText(nowMs - latestAtMs) : ''

  var findings = latest === null ? [] : latest.findings
  var unread = 0
  if (employee !== null && employee !== undefined) {
    var readSet = monitorReadSet(String(employee.id || ''))
    for (var u = 0; u < findings.length; u += 1) {
      if (readSet[monitorReadKey(String(employee.id || ''), findings[u].id)] === undefined) unread += 1
    }
  }
  var box = asideBlock(
    container,
    '异常台账',
    findings.length === 0 ? '' : stale ? '上一轮 ' + String(findings.length) : String(unread) + ' 待复核',
    stale ? 'warn' : 'bad',
  )
  monitorTitleSub(box, latest === null ? '还没有一轮记录' : monitorClockText(latestAtMs, nowMs) + (stale ? ' · 上一轮' : ' · 本轮'))

  if (findingsResult === null || findingsResult === undefined) {
    box.appendChild(el('div', 'aside-note', '（正在载入…）'))
    return
  }
  if (findingsResult.ok !== true) {
    appendFileState(box, findingsResult, '每轮巡检结果写在 ' + FINDINGS_PATH + '（员工写）：rounds[] 每轮带 atMs/assets/findings。')
    return
  }

  if (stale && findings.length > 0) {
    var judge = el('div', 'quad-cannot')
    judge.appendChild(
      el(
        'div',
        '',
        nodeOnline !== true
          ? '无法判断：节点离线，读不到新数据（最后一份报告 ' + ageText + '）。'
          : '无法判断：数据已过期 ' + ageText + '（周期 ' + String(view === null ? 60 : view.intervalMinutes) + ' 分钟）。',
      ),
    )
    judge.appendChild(el('div', 'aside-note', '无数据 != 正常 —— 下面这些是上一轮的结果，不代表现在。'))
    box.appendChild(judge)
  }

  if (findings.length === 0) {
    if (stale) {
      box.appendChild(el('div', 'quad-empty', '本轮没有任何数据，所以"没有异常"这句话现在说不了。'))
    } else {
      box.appendChild(
        el('div', 'quad-empty', '本轮无新增异常（上次巡检 ' + (latestAtMs > 0 ? ageText : '（没有记录）') + '）。'),
      )
      box.appendChild(el('div', 'aside-note', '有数据才敢这么说 —— 没有数据时这一格会改成"无法判断"。'))
    }
    return
  }

  var nameOfAsset = function (assetId) {
    if (view === null) return assetId
    for (var i = 0; i < view.assets.length; i += 1) {
      if (view.assets[i].id === assetId) return view.assets[i].name
    }
    return assetId === '' ? '未指定资产' : assetId
  }
  for (var f = 0; f < findings.length && f < MONITOR_FINDINGS_MAX; f += 1) {
    box.appendChild(monitorFindingNode(findings[f], ctx, stale, nameOfAsset(findings[f].assetId)))
  }
  if (findings.length > MONITOR_FINDINGS_MAX) {
    box.appendChild(el('div', 'aside-note', '…本轮共 ' + String(findings.length) + ' 条（其余到对话里问）'))
  }
  box.appendChild(
    el('div', 'aside-note', '「已阅」只存在这台设备上，不写回工作区（一份数据两个写者 = 两份真相）。'),
  )
}

/* ── 面板：右上值守记录（轮次带 + 与上一轮的差异）── */

/** 与上一轮的差异（没有可比的两轮时如实说"比不了"） */
function monitorDiffBlock(rounds, nameOf) {
  var box = el('div', 'quad-diff')
  if (rounds.length < 2) {
    box.appendChild(
      el(
        'div',
        'aside-note',
        rounds.length === 0
          ? '还没有可比的两轮。'
          : '只有一轮记录，还比不了：差异要等下一轮才有（这也是"每轮都留 snapshot"的用处）。',
      ),
    )
    return box
  }
  var prev = rounds[rounds.length - 2]
  var next = rounds[rounds.length - 1]
  var diffs = monitorDiff(prev, next)
  if (diffs === null || diffs.length === 0) {
    box.appendChild(el('div', 'quad-same', '本轮与上一轮相比没有变化。'))
    box.appendChild(el('div', 'aside-note', '这句话有信息量：它说明真的比过了（快照现算，不读自报的变更列表）。'))
    return box
  }
  for (var i = 0; i < diffs.length; i += 1) {
    var one = diffs[i]
    var row = el('div', 'quad-chg ' + (one.kind === 'unknown' ? 'same' : one.added.length > 0 || one.kind === 'new-key' ? 'new' : 'up'))
    /* 资产名要写在行里：多台机器的同名键（比如都有 listening-ports）不写出来就分不清是谁的 */
    var assetName = typeof nameOf === 'function' ? String(nameOf(one.assetId)) : String(one.assetId)
    row.appendChild(el('span', 'quad-chg-k', one.key === '' ? assetName : assetName + ' · ' + one.key))
    var text = ''
    if (one.kind === 'unknown') text = '上一轮没有这一台的快照，比不了'
    else if (one.kind === 'list') {
      var bits = []
      if (one.added.length > 0) bits.push('+' + String(one.added.length) + ' ' + one.added.join('、'))
      if (one.removed.length > 0) bits.push('−' + String(one.removed.length) + ' ' + one.removed.join('、'))
      text = bits.join(' · ')
    } else if (one.kind === 'new-key') text = '上一轮没有这个键：' + (one.to === '' ? '（空）' : one.to)
    else text = (one.from === '' ? '（空）' : one.from) + ' → ' + (one.to === '' ? '（空）' : one.to)
    row.appendChild(el('span', 'quad-chg-v', text))
    box.appendChild(row)
  }
  return box
}

/** 右上「值守记录」：只放会变的东西 —— 轮次带、与上一轮的差异（审批/权限声明不常驻） */
function renderPanelMonitorWatch(container, ctx) {
  var view = ctx.monitorResult !== null && ctx.monitorResult !== undefined && ctx.monitorResult.ok === true ? monitorView(ctx.monitorResult.value) : null
  var fview = ctx.findingsResult !== null && ctx.findingsResult !== undefined && ctx.findingsResult.ok === true ? findingsView(ctx.findingsResult.value) : null
  var nowMs = Date.now()
  var intervalMs = view !== null && view.intervalMinutes > 0 ? view.intervalMinutes * 60000 : 3600000

  var box = asideBlock(container, '巡检轮次')
  monitorTitleSub(box, '最近 ' + String(MONITOR_WINDOW_ROUNDS) + ' 轮 · ' + String(Math.round(intervalMs / 60000)) + ' 分钟一轮')
  if (fview === null) {
    box.appendChild(el('div', 'aside-note', '（还没有可看的轮次记录）'))
  } else {
    var slots = monitorSlots(fview, intervalMs, nowMs, MONITOR_WINDOW_ROUNDS)
    var tally = { ok: 0, bad: 0, miss: 0, due: 0 }
    var track = el('div', 'quad-track')
    for (var i = 0; i < slots.length; i += 1) {
      tally[slots[i].state] += 1
      var cell = el('i', 'quad-slot ' + slots[i].state)
      var tips = [monitorClockText(slots[i].start, nowMs) + ' – ' + monitorClockText(slots[i].end, nowMs)]
      if (slots[i].state === 'ok') tips.push('有巡检')
      else if (slots[i].state === 'bad') tips.push('有"高"以上发现')
      else if (slots[i].state === 'miss') tips.push('没跑（缺口）')
      else tips.push('还没到点')
      cell.title = tips.join(' · ')
      track.appendChild(cell)
    }
    box.appendChild(track)
    var legend = el('div', 'quad-legend')
    legend.appendChild(monitorDotNode('ok'))
    legend.appendChild(el('span', '', '有巡检 ' + String(tally.ok)))
    legend.appendChild(monitorDotNode('bad'))
    legend.appendChild(el('span', '', '有异常 ' + String(tally.bad)))
    legend.appendChild(monitorDotNode('miss'))
    legend.appendChild(el('span', '', '缺轮 ' + String(tally.miss)))
    legend.appendChild(monitorDotNode('due'))
    legend.appendChild(el('span', '', '待执行 ' + String(tally.due)))
    box.appendChild(legend)
    box.appendChild(el('div', 'aside-note', '缺口由控制台按周期推 —— 员工漏跑时它当然不会自己报告。'))
  }

  var diffBox = asideBlock(container, '与上一轮的变化')
  var rounds = fview === null ? [] : fview.rounds
  monitorTitleSub(diffBox, rounds.length === 0 ? '' : '控制台现算的差异')
  var nameOf = function (assetId) {
    if (view !== null) {
      for (var i = 0; i < view.assets.length; i += 1) {
        if (view.assets[i].id === assetId) return view.assets[i].name
      }
    }
    return assetId === '' ? '未指定资产' : assetId
  }
  diffBox.appendChild(monitorDiffBlock(rounds, nameOf))
}

/* ═══════════ 9.10 安全监测面板的 id 清单（68-quad 据此决定要读哪些工作区文件）═══════════ */

/**
 * 配了这些面板中的任意一个 → 就需要 monitor.json（除 capability-badge 外还要 findings.json）。
 * 这份清单是"数据需求"的唯一出处：**别的岗位不为这几个文件花一次请求**。
 */
var MONITOR_PANEL_IDS = ['capability-badge', 'monitor-post', 'monitor-findings', 'monitor-watch']

/* ═══════════ 9.11 应急响应岗位面板（四宫格：左上事件台 / 左下处置队列 / 右上时间线）═══════════
 *
 * 这一页与安全监测**正好相反**：监测岗不能动手，应急岗**能动手、但每一步都要你批**。
 * 所以重心不是"新鲜度"，而是三件事：
 *
 *   1. **球在谁手里**：哪一步卡在我这里、卡了多久（这一页的瓶颈本来就该被看见）；
 *   2. **我批的是什么**：提案五要素（动作原文/依据/影响面/回滚/耗时），而不是一条光秃秃的命令；
 *   3. **她真正跑的是不是那一条**：提案 ↔ 平台审批单（dsh 执行时另发一条，带的是要跑的命令）。
 *
 * 六条边界：
 *   1. **不做批量批准**（页面上根本没有这个按钮）。批量拒绝可以做 —— 拒绝只会让事情变慢，
 *      批准会让事情发生。那个"全部拒绝并停手"是这一页唯一的紧急出口。
 *   2. **五要素缺失照样摆出来并标红**，但不给"通过"加强调（缺回滚的步骤不该被一键点过去）。
 *   3. **被拒的步骤不删**：拒绝也是决策，复盘时要看"当时为什么没做"。
 *   4. **不让员工宣布阶段**：阶段由人写进 incident.json；员工只能写事实与状态。
 *   5. **超出授权范围的动作红标**（拿 incident.json 的 scope.allow 原文比），不因为"看起来合理"就放行。
 *   6. **没有事件时不说假话**：只说三件真事（当前无事件 / 预案就绪 / 上次遗留），不摆健康度。
 */

/** 事件登记（**人写**：谁指挥、什么级别、能做什么、不能做什么） */
var INCIDENT_PATH = 'incident.json'
/** 处置步骤（**员工写**：这次事件的事件登记 + 每步五要素 + 状态 + 结果 + 证据） */
var ACTIONS_PATH = 'actions.json'
/** 事件档案（**员工写**：事件结束后把这一次归档，一行一次；事件台的历史列表读它） */
var INCIDENTS_PATH = 'incidents.json'
/** 展开卡的条数上限：再多的收成折叠行（"一次只摊开一条"这条规矩见 design §5.9） */
var INCIDENT_OPEN_MAX = 1
/**
 * 时间线日志最多列几条。
 *
 * 为什么是 3：每一步的经过本来就在**对话里**（她提案时会说、执行完会报），
 * 日志只是"我批过什么"的索引。列多了既占高度，又是对话的重复。
 * 更早的用一句话指路（"更早的 N 条在会话里"）。
 */
var INCIDENT_LOG_MAX = 3
/** 事件台的历史事件最多列几条（更早的在 incidents.json 里，格子里不放） */
var INCIDENT_HISTORY_MAX = 3
/** 五要素的显示名与判定顺序（缺哪一项就在折叠行与卡片里点名） */
var INCIDENT_FIELDS = [
  { key: 'action', label: '动作原文' },
  { key: 'why', label: '依据' },
  { key: 'impact', label: '影响面' },
  { key: 'rollback', label: '回滚办法' },
  { key: 'etaSec', label: '预计耗时' },
]
/** 步骤状态 → 显示名（认中英文：员工写中文更顺手） */
var INCIDENT_STATUS = {
  pending: { label: '待你批准', cls: 'pending' },
  approved: { label: '已批准', cls: 'running' },
  running: { label: '执行中', cls: 'running' },
  done: { label: '已完成', cls: 'done' },
  failed: { label: '失败', cls: 'rollback' },
  'rolled-back': { label: '已回滚', cls: 'rollback' },
  rejected: { label: '已拒绝', cls: 'rejected' },
  todo: { label: '待办', cls: '' },
}
/** 状态别名：员工写中文/近义词都认（不认识的如实显示原文） */
var INCIDENT_STATUS_ALIAS = {
  '待批准': 'pending', '待你批准': 'pending', '待批': 'pending', 待审批: 'pending',
  '已批准': 'approved', 批准: 'approved', '执行中': 'running', 进行中: 'running',
  '完成': 'done', '已完成': 'done', 成功: 'done',
  '失败': 'failed', '回滚': 'rolled-back', '已回滚': 'rolled-back',
  '拒绝': 'rejected', '已拒绝': 'rejected', '待办': 'todo',
}

/**
 * incident.json → 显示模型。
 *
 * 这份文件是**常备层**：人定一次、长期不变 —— 能处置什么、禁止什么、谁定的。
 * 它**不**描述"这一次事件"（那是 actions.json 里的事件登记，由员工写），
 * 也**不**放预案（要干什么由人当场告诉员工，不需要控制台替他记手册）。
 *
 * 授权字段认两种写法：standing.allow/deny（新）与 scope.allow/deny（旧，兼容）。
 */
function incidentView(incident) {
  var view = {
    incidentId: '', title: '', level: '', commander: '', openedAtMs: 0, closedAtMs: 0,
    /* status: standby（待命）/ open（进行中）/ closed（已关闭）。
       人写的显式字段优先；没写时按老规矩退化成"有 closedAtMs 就是关闭，否则进行中"。 */
    status: '', running: false,
    stages: [], stage: '', assets: [], allow: [], deny: [],
    authorizedBy: '', authorizedAtMs: 0,
    capabilities: null,
  }
  if (incident === null || typeof incident !== 'object') return view
  view.incidentId = cellText(incident.incidentId !== undefined ? incident.incidentId : incident.id)
  view.title = cellText(incident.title)
  view.level = cellText(incident.level !== undefined ? incident.level : incident.severity)
  view.commander = cellText(incident.commander !== undefined ? incident.commander : incident.owner)
  view.openedAtMs = monitorTimeMs(incident.openedAtMs !== undefined ? incident.openedAtMs : incident.openedAt)
  view.closedAtMs = monitorTimeMs(incident.closedAtMs !== undefined ? incident.closedAtMs : incident.closedAt)
  var statusText = cellText(incident.status).trim().toLowerCase()
  view.status = statusText
  view.running = statusText === 'open' || statusText === '进行中' || statusText === '处置中'
  if (statusText === 'standby' || statusText === '待命') view.running = false
  else if (statusText === 'closed' || statusText === '已关闭') view.running = false
  else if (statusText === '') view.running = view.closedAtMs === 0
  view.stages = monitorStringList(incident.stages)
  view.stage = cellText(incident.stage)
  view.authorizedBy = cellText(incident.authorizedBy !== undefined ? incident.authorizedBy : incident.by)
  view.authorizedAtMs = monitorTimeMs(incident.authorizedAtMs !== undefined ? incident.authorizedAtMs : incident.atMs)
  var standing = incident.standing !== null && incident.standing !== undefined && typeof incident.standing === 'object' ? incident.standing : incident.scope
  if (standing !== null && standing !== undefined && typeof standing === 'object') {
    view.assets = monitorStringList(standing.assets)
    view.allow = monitorStringList(standing.allow)
    view.deny = monitorStringList(standing.deny)
  }
  view.capabilities = incident.capabilities !== null && typeof incident.capabilities === 'object' ? incident.capabilities : null
  return view
}

/** actions.json 里的事件登记（**员工写**：这次事件的编号/标题/级别/影响面/发现时间/阶段） */
function incidentRegistration(actions) {
  var out = { incidentId: '', title: '', level: '', assets: [], openedAtMs: 0, closedAtMs: 0, stage: '' }
  if (actions === null || typeof actions !== 'object') return out
  var one = actions.incident !== null && actions.incident !== undefined && typeof actions.incident === 'object' ? actions.incident : actions
  out.incidentId = cellText(one.incidentId !== undefined ? one.incidentId : one.id)
  out.title = cellText(one.title)
  out.level = cellText(one.level !== undefined ? one.level : one.severity)
  out.assets = monitorStringList(one.assets)
  out.openedAtMs = monitorTimeMs(one.openedAtMs !== undefined ? one.openedAtMs : one.openedAt)
  out.closedAtMs = monitorTimeMs(one.closedAtMs !== undefined ? one.closedAtMs : one.closedAt)
  out.stage = cellText(one.stage !== undefined ? one.stage : actions.stage)
  return out
}

/** incidents.json → 历史事件（**员工写**：事件结束后归档，新的在前） */
function incidentsView(raw) {
  var list = []
  if (raw === null || typeof raw !== 'object') return list
  var source = Array.isArray(raw) ? raw : Array.isArray(raw.incidents) ? raw.incidents : []
  for (var i = 0; i < source.length; i += 1) {
    var one = source[i]
    if (one === null || typeof one !== 'object' || Array.isArray(one)) continue
    var steps = one.steps !== null && one.steps !== undefined && typeof one.steps === 'object' ? one.steps : null
    list.push({
      incidentId: cellText(one.incidentId !== undefined ? one.incidentId : one.id),
      title: cellText(one.title),
      level: cellText(one.level !== undefined ? one.level : one.severity),
      openedAtMs: monitorTimeMs(one.openedAtMs !== undefined ? one.openedAtMs : one.openedAt),
      closedAtMs: monitorTimeMs(one.closedAtMs !== undefined ? one.closedAtMs : one.closedAt),
      outcome: cellText(one.outcome !== undefined ? one.outcome : one.result),
      report: cellText(one.report !== undefined ? one.report : one.reportPath),
      total: steps === null ? 0 : Number(steps.total) || 0,
      rejected: steps === null ? 0 : Number(steps.rejected) || 0,
      rolledBack: steps === null ? 0 : Number(steps.rolledBack) || 0,
    })
  }
  list.sort(function (a, b) {
    return (b.closedAtMs || b.openedAtMs) - (a.closedAtMs || a.openedAtMs)
  })
  return list
}

/** 一个处置步骤 → 规整形状（状态认中英文别名；时间容忍秒/毫秒/ISO） */
function incidentParseSteps(raw) {
  var out = []
  if (!Array.isArray(raw)) return out
  for (var i = 0; i < raw.length; i += 1) {
    var one = raw[i]
    if (one === null || typeof one !== 'object' || Array.isArray(one)) continue
    var statusRaw = cellText(one.status)
    var status = INCIDENT_STATUS_ALIAS[statusRaw] !== undefined ? INCIDENT_STATUS_ALIAS[statusRaw] : statusRaw
    if (INCIDENT_STATUS[status] === undefined) status = statusRaw === '' ? 'pending' : 'unknown'
    out.push({
      id: cellText(one.id) === '' ? 's-' + String(i) : cellText(one.id),
      proposedAtMs: monitorTimeMs(one.proposedAtMs !== undefined ? one.proposedAtMs : one.atMs),
      action: cellText(one.action !== undefined ? one.action : one.command),
      assetId: cellText(one.assetId !== undefined ? one.assetId : one.asset),
      why: cellText(one.why !== undefined ? one.why : one.reason),
      /* 授权依据：这一步落在**人写的那一条授权**之下。控制台只做成员检查 ——
         不靠"从命令里猜意图"（猜错的代价是误报，而误报会让红标失去意义）。 */
      under: cellText(one.under !== undefined ? one.under : one.authorization),
      impact: cellText(one.impact !== undefined ? one.impact : one.scope),
      rollback: cellText(one.rollback !== undefined ? one.rollback : one.undo),
      etaSec: Number(one.etaSec !== undefined ? one.etaSec : one.eta),
      status: status === 'unknown' ? 'unknown' : status,
      statusRaw: statusRaw,
      approvalId: cellText(one.approvalId),
      approvedAtMs: monitorTimeMs(one.approvedAtMs),
      finishedAtMs: monitorTimeMs(one.finishedAtMs),
      result: cellText(one.result),
      evidence: cellText(one.evidence !== undefined ? one.evidence : one.evidencePath),
    })
  }
  return out
}

/**
 * actions.json → { registration, stage, steps }。
 *
 * 事件登记（这次事件的编号/标题/级别/影响面/发现时间）**一并解析进来**：
 * 它是员工写的，而事件台要显示它。分开解析会让"面板拿到的是别人重算过的对象"
 * （真实踩到：面板去读原始 payload，而它手上只有 actionsView 的结果 —— 于是标题空白）。
 */
function actionsView(actions) {
  var view = { registration: incidentRegistration(actions), incidentId: '', stage: '', steps: [] }
  if (actions === null || typeof actions !== 'object') return view
  view.incidentId = cellText(actions.incidentId)
  view.stage = cellText(actions.stage)
  view.steps = incidentParseSteps(actions.steps)
  return view
}

/** 五要素里缺了哪些（**控制台自己判**：不读员工写的"完整度"字段） */
function incidentMissingFields(step) {
  var missing = []
  for (var i = 0; i < INCIDENT_FIELDS.length; i += 1) {
    var field = INCIDENT_FIELDS[i]
    var value = step[field.key]
    if (field.key === 'etaSec') {
      if (!isFinite(value) || Number(value) <= 0) missing.push(field.label)
      continue
    }
    if (String(value === undefined || value === null ? '' : value).trim() === '') missing.push(field.label)
  }
  return missing
}

/** 状态显示名（不认识的如实显示原文，不塞进"待批"里） */
function incidentStatusLabel(step) {
  var known = INCIDENT_STATUS[step.status]
  if (known !== undefined) return known.label
  return step.statusRaw === '' ? '未标状态' : step.statusRaw
}

function incidentStatusClass(step) {
  var known = INCIDENT_STATUS[step.status]
  return known === undefined ? '' : known.cls
}

/** 这一步是否"等你决定"（待批）—— 计数徽章与"卡了多久"都只看它 */
function incidentStepWaiting(step) {
  return step.status === 'pending'
}

/** 这一步是否"正在跑"（展开优先给它） */
function incidentStepRunning(step) {
  return step.status === 'approved' || step.status === 'running'
}

/**
 * 处置时钟：从发现到现在，以及**最久的那条待批等了多久**（这一页的瓶颈就该被看见）。
 *
 * "卡在你这里"只算待批步骤里最早的提案时间 —— 不把"没人提案"的时间算成你的锅。
 */
function incidentClock(steps, nowMs) {
  var waiting = []
  for (var i = 0; i < steps.length; i += 1) {
    if (incidentStepWaiting(steps[i])) waiting.push(steps[i])
  }
  waiting.sort(function (a, b) {
    return a.proposedAtMs - b.proposedAtMs
  })
  var oldest = waiting.length > 0 ? waiting[0] : null
  return {
    waitingCount: waiting.length,
    oldestAtMs: oldest === null ? 0 : oldest.proposedAtMs,
    oldestWaitedMs: oldest === null || oldest.proposedAtMs <= 0 ? 0 : Number(nowMs) - oldest.proposedAtMs,
  }
}

/** 步骤计数（已批/待批/被拒/回滚/完成）—— 全部现算 */
function incidentCounts(steps) {
  var counts = { pending: 0, running: 0, done: 0, rejected: 0, rollback: 0, todo: 0, unknown: 0, total: steps.length }
  for (var i = 0; i < steps.length; i += 1) {
    var step = steps[i]
    if (incidentStepWaiting(step)) counts.pending += 1
    else if (incidentStepRunning(step)) counts.running += 1
    else if (step.status === 'done') counts.done += 1
    else if (step.status === 'rejected') counts.rejected += 1
    else if (step.status === 'rolled-back' || step.status === 'failed') counts.rollback += 1
    else if (step.status === 'todo') counts.todo += 1
    else counts.unknown += 1
  }
  return counts
}

/**
 * 授权检查：这一步声明的「授权依据」是否真的在你写下的 scope.allow 里。
 *
 * 为什么用"成员检查"而不是"从命令里猜意图"：rm -rf /data 与 deny 里的"删除数据"
 * 之间没有任何可靠的字符串关系 —— 靠关键词猜，猜错的代价是误报，而**红标一旦会误报就没人看了**。
 * 所以规则改成可验证的：员工必须写 under（依据哪一条授权），控制台只判：
 * 在你允许的清单里（ok）/ 不在（out，红标）/ 没写或你没写 allow（unknown，不下结论）。
 */
function incidentScopeCheck(step, view) {
  var under = String(step.under === undefined || step.under === null ? '' : step.under).trim()
  if (view === null || view.allow.length === 0) return { kind: 'unknown', text: '人写的授权清单是空的 —— 无从核对' }
  if (under === '') return { kind: 'unknown', text: '这一步没写「授权依据」' }
  for (var i = 0; i < view.allow.length; i += 1) {
    var allow = String(view.allow[i]).trim()
    if (allow === under || allow.indexOf(under) >= 0 || under.indexOf(allow) >= 0) return { kind: 'ok', text: '依据：' + allow }
  }
  return { kind: 'out', text: '依据「' + under + '」不在你允许的清单里' }
}

/** 平台审批的正文（认几种形状：dsh 审批把命令放在 detail/request/summary 里） */
function incidentApprovalText(item) {
  var parts = []
  var keys = ['summary', 'detail', 'request', 'command', 'text']
  for (var i = 0; i < keys.length; i += 1) {
    var text = cellText(item[keys[i]])
    if (text !== '') parts.push(text)
  }
  return parts.join(' ')
}

/** 命令归一：去多余空白、去引号 —— 只为比较（不改原文显示） */
function incidentNormalizeCommand(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[\u2018\u2019\u201c\u201d"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 把「提案」与「平台审批单」对上号（**这一页最值钱的一条判定**）。
 *
 * dsh 执行时另发一条审批，它带的是**要跑的命令**；而员工在 actions.json 里写的是**提案**。
 * 两者不一致时（真机上见过：提案封单个 IP、审批单封整个网段），人眼扫过去根本看不出来。
 * 返回：match（命令原文一致）/ differ（同类命令但不一样 → 红字）/ none（没有对应的审批单）。
 */
function incidentMatchApproval(step, pending) {
  var action = incidentNormalizeCommand(step.action)
  if (action === '') return { kind: 'none', item: null, text: '' }
  var sameHead = null
  for (var i = 0; i < pending.length; i += 1) {
    var item = pending[i]
    var text = incidentNormalizeCommand(incidentApprovalText(item))
    if (text === '') continue
    if (text.indexOf(action) >= 0 || action.indexOf(text) >= 0) return { kind: 'match', item: item, text: incidentApprovalText(item) }
    var head = action.split(' ')[0]
    if (head !== '' && text.indexOf(head) >= 0) sameHead = { item: item, text: incidentApprovalText(item) }
  }
  if (sameHead !== null) return { kind: 'differ', item: sameHead.item, text: sameHead.text }
  return { kind: 'none', item: null, text: '' }
}

/** 这个员工此刻未决的审批（现读 state.approvals，与审批页共用同一份） */
function incidentPendingApprovals(employeeId) {
  var out = []
  for (var i = 0; i < state.approvals.length; i += 1) {
    var item = state.approvals[i]
    if (item === null || typeof item !== 'object') continue
    if (String(item.status || '') !== 'pending') continue
    if (
      String(item.employeeId || '') === String(employeeId) ||
      String(item.fromEmployeeId || '') === String(employeeId) ||
      String(item.toEmployeeId || '') === String(employeeId)
    ) {
      out.push(item)
    }
  }
  return out
}

/** 一条时间线日志（提案 / 批准 / 完成 / 证据）—— 只追加不覆盖，倒序展示 */
function incidentLogRows(steps) {
  var rows = []
  for (var i = 0; i < steps.length; i += 1) {
    var step = steps[i]
    var title = step.action === '' ? step.id : step.action
    if (step.proposedAtMs > 0) rows.push({ atMs: step.proposedAtMs, text: '提案：' + title })
    if (step.approvedAtMs > 0) rows.push({ atMs: step.approvedAtMs, text: '你批准：' + title })
    if (step.status === 'rejected') rows.push({ atMs: step.finishedAtMs > 0 ? step.finishedAtMs : step.proposedAtMs, text: '你拒绝：' + title, bad: true })
    if (step.status === 'done' && step.finishedAtMs > 0) rows.push({ atMs: step.finishedAtMs, text: '完成：' + title + (step.evidence === '' ? '' : '（证据 ' + step.evidence + '）') })
    if ((step.status === 'rolled-back' || step.status === 'failed') && step.finishedAtMs > 0) {
      rows.push({ atMs: step.finishedAtMs, text: '回滚/失败：' + title + (step.result === '' ? '' : ' —— ' + step.result), bad: true })
    }
  }
  rows.sort(function (a, b) {
    return b.atMs - a.atMs
  })
  return rows
}

/* ── 面板：左上 事件台 ── */

/**
 * 事件台的"当前事件"一块。
 *
 * 事实来源分两处，页面**分别标出来**（这是这一格最容易被含糊过去的地方）：
 *   · 这次事件的登记（编号/标题/级别/影响面/发现时间）—— **她提的**（actions.json）
 *   · 处置授权（允许/禁止什么）—— **常备层，人定的**（incident.json），标在弹层与每张步骤卡上
 */
function incidentCurrentBox(box, view, actions, steps, nowMs) {
  var clock = incidentClock(steps, nowMs)
  var counts = incidentCounts(steps)
  monitorTitleSub(box, actions.incidentId === '' ? '' : actions.incidentId)
  if (actions.title !== '') {
    var title = el('div', 'quad-target')
    title.textContent = actions.title
    if (actions.level !== '') title.appendChild(el('span', 'badge warn', '级别：' + actions.level))
    box.appendChild(title)
  }
  var clockBox = el('div', 'quad-clock')
  clockBox.appendChild(el('b', '', actions.openedAtMs > 0 ? monitorAgoText(nowMs - actions.openedAtMs).replace(/前$/, '') : '未知'))
  clockBox.appendChild(
    el('span', '', actions.openedAtMs > 0 ? '从发现到现在 · ' + monitorClockText(actions.openedAtMs, nowMs) + ' 发现' : '（她还没报发现时间）'),
  )
  box.appendChild(clockBox)
  /* 来源标注：这一格里的"事实"是她报的；授权边界才是人定的。两者不许混着说。 */
  box.appendChild(el('div', 'aside-note', '事件登记：她提的（' + ACTIONS_PATH + '，可改）'))

  var wait = el('div', 'quad-wait' + (clock.waitingCount > 0 ? ' hot' : ''))
  if (clock.waitingCount > 0) {
    wait.appendChild(el('b', '', '等待你批准 · 最久一条等了 ' + monitorAgoText(clock.oldestWaitedMs).replace(/前$/, '')))
    wait.appendChild(
      el('div', 'aside-note', '共 ' + String(clock.waitingCount) + ' 步待批' + (counts.running > 0 ? ' · ' + String(counts.running) + ' 步正在跑' : '')),
    )
  } else if (counts.running > 0) {
    wait.appendChild(el('b', '', '执行中 · ' + String(counts.running) + ' 步'))
    wait.appendChild(el('div', 'aside-note', '没有待你批准的动作 —— 她正在做的是已批准的那些。'))
  } else {
    wait.appendChild(el('b', '', '没有待你批准的动作'))
    wait.appendChild(el('div', 'aside-note', '只读排查不需要批准；只有动手的步骤才进处置队列。'))
  }
  box.appendChild(wait)

  if (view.stages.length > 0) {
    var stageNow = actions.stage !== '' ? actions.stage : view.stage
    var bar = el('div', 'quad-stages')
    for (var i = 0; i < view.stages.length; i += 1) {
      var isNow = String(view.stages[i]) === String(stageNow)
      var done = stageNow !== '' && view.stages.indexOf(stageNow) > i
      bar.appendChild(el('i', done ? 'done' : isNow ? 'now' : 'todo'))
    }
    box.appendChild(bar)
    box.appendChild(el('div', 'aside-note', view.stages.join(' · ') + (stageNow === '' ? '（当前阶段没写）' : '　← 现在：' + stageNow)))
  }

  var facts = el('div', 'quad-legend')
  var factsList = [
    '待批 ' + String(counts.pending),
    '执行中 ' + String(counts.running),
    '已完成 ' + String(counts.done),
    '被拒 ' + String(counts.rejected),
    '回滚 ' + String(counts.rollback),
  ]
  for (var f = 0; f < factsList.length; f += 1) {
    facts.appendChild(el('span', 'badge' + (f === 0 && counts.pending > 0 ? ' warn' : ''), factsList[f]))
  }
  box.appendChild(facts)

  var meta = el('div', 'quad-kv')
  if (actions.assets.length > 0) meta.appendChild(el('span', '', '影响面 ' + actions.assets.join('·')))
  if (view.authorizedBy !== '') {
    meta.appendChild(
      el('span', '', '处置授权 ' + view.authorizedBy + (view.authorizedAtMs > 0 ? ' 于 ' + monitorClockText(view.authorizedAtMs, nowMs) + ' 定' : ' 定')),
    )
  }
  if (meta.children.length > 0) box.appendChild(meta)
  if (view.deny.length > 0) box.appendChild(el('div', 'quad-kv', '禁止 ' + view.deny.join('/') + '（常备层，任何一步都不许越过）'))
}

/** 事件台的"历史事件"一块（读 incidents.json；没有就如实说没有） */
function incidentHistoryBox(box, history, result) {
  box.appendChild(el('div', 'aside-sep'))
  box.appendChild(el('div', 'panel-title', '历史事件'))
  if (result === null || result === undefined || result.ok !== true) {
    box.appendChild(el('div', 'aside-note', '（还没有归档；事件结束后她把这一次写进 ' + INCIDENTS_PATH + '）'))
    return
  }
  if (history.length === 0) {
    box.appendChild(el('div', 'aside-note', '还没有历史事件。'))
    return
  }
  var list = el('div', 'quad-assets')
  var shown = Math.min(history.length, INCIDENT_HISTORY_MAX)
  for (var i = 0; i < shown; i += 1) {
    var one = history[i]
    var row = el('div', 'quad-asset')
    row.appendChild(el('span', 'quad-dot ' + (one.rolledBack > 0 || one.rejected > 0 ? 'warn' : 'ok')))
    var main = el('div', 'quad-asset-main')
    var nameRow = el('div', 'quad-asset-name', one.title === '' ? one.incidentId : one.title)
    if (one.level !== '') nameRow.appendChild(el('span', 'quad-asset-detail', '级别 ' + one.level))
    main.appendChild(nameRow)
    /* 元信息与结论压成**一行**：历史是"扫一眼"的东西，三次事件三行就够，
       细节在复盘报告里（那一行右侧的报告入口指向它）。 */
    var bits = []
    if (one.closedAtMs > 0) bits.push(monitorClockText(one.closedAtMs, Date.now()) + ' 关闭')
    else if (one.openedAtMs > 0) bits.push(monitorClockText(one.openedAtMs, Date.now()) + ' 起')
    if (one.total > 0) bits.push(String(one.total) + ' 步')
    if (one.rejected > 0) bits.push('被拒 ' + String(one.rejected))
    if (one.rolledBack > 0) bits.push('回滚 ' + String(one.rolledBack))
    if (one.outcome !== '') bits.push(one.outcome)
    main.appendChild(el('div', 'quad-asset-sub', bits.join(' · ')))
    row.appendChild(main)
    if (one.report !== '') {
      var report = el('span', 'quad-prov ext', '报告')
      report.title = one.report
      row.appendChild(report)
    }
    list.appendChild(row)
  }
  box.appendChild(list)
  if (history.length > shown) box.appendChild(el('div', 'aside-note', '…共 ' + String(history.length) + ' 次'))
}

/** 左上「事件台」：当前事件（她提的登记）+ 历史事件 */
function renderPanelIncidentPost(container, ctx) {
  var employee = ctx.employee
  var employeeId = employee === null || employee === undefined ? '' : String(employee.id || '')
  var result = ctx.incidentResult
  var view = result !== null && result !== undefined && result.ok === true ? incidentView(result.value) : null
  var actions = ctx.actionsResult !== null && ctx.actionsResult !== undefined && ctx.actionsResult.ok === true ? actionsView(ctx.actionsResult.value) : null
  var steps = actions === null ? [] : actions.steps
  var nowMs = Date.now()
  var box = asideBlock(container, '事件台')

  if (view === null) {
    monitorTitleSub(box, '')
    box.appendChild(
      el('div', 'quad-empty', '工作区里还没有 ' + INCIDENT_PATH + ' —— 允许处置什么、禁止什么，必须由人定一次（常备层，长期不变）。'),
    )
    appendFileState(box, result, '最小写法 {"standing":{"allow":["改防火墙规则","停用账号"],"deny":["重装系统","删除数据"]},"capabilities":{"label":"可处置 · 逐步审批"},"authorizedBy":"张总","stages":["发现","遏制","清除","恢复","复盘"]}')
    box.appendChild(el('div', 'aside-note', '没有授权清单时这一格不猜：宁可空着，也不显示一个编出来的"允许"。'))
    incidentTemplateButton(box, employeeId)
    return
  }

  if (actions !== null) {
    var registration = actions.registration
    var running = registration.incidentId !== '' || steps.length > 0
    if (running) {
      incidentCurrentBox(box, view, registration, steps, nowMs)
      incidentHistoryBox(box, incidentsView(ctx.incidentsResult !== null && ctx.incidentsResult !== undefined && ctx.incidentsResult.ok === true ? ctx.incidentsResult.value : null), ctx.incidentsResult)
      monitorFileNote(box, ctx.actionsResult, '这次事件的登记与每一步都写在 ' + ACTIONS_PATH + '（员工写）。')
      return
    }
  }

  monitorTitleSub(box, '当前无事件')
  var fresh = el('div', 'quad-posture ok')
  fresh.appendChild(el('span', 'quad-dot ok'))
  fresh.appendChild(el('b', '', '待命'))
  fresh.appendChild(el('div', 'aside-note', '当前无进行中的事件 —— 没有事件就是没有事件，这一格不摆仪表盘。'))
  box.appendChild(fresh)
  if (view.allow.length > 0) {
    box.appendChild(el('div', 'quad-kv', '常备授权：允许 ' + view.allow.join('/') + (view.deny.length > 0 ? ' · 禁止 ' + view.deny.join('/') : '')))
  }
  incidentHistoryBox(box, incidentsView(ctx.incidentsResult !== null && ctx.incidentsResult !== undefined && ctx.incidentsResult.ok === true ? ctx.incidentsResult.value : null), ctx.incidentsResult)
  if (actions === null) monitorFileNote(box, ctx.actionsResult, '这次事件的登记与每一步都写在 ' + ACTIONS_PATH + '（员工写）。')
}

/* ── 面板：左下 处置队列 ── */

/** 五要素行（缺的标红点名） */
function incidentFieldRows(box, step) {
  for (var i = 0; i < INCIDENT_FIELDS.length; i += 1) {
    var field = INCIDENT_FIELDS[i]
    var row = el('div', 'quad-kv')
    var label = el('b', '', field.label + '：')
    var missing = incidentMissingFields(step).indexOf(field.label) >= 0
    if (missing) label.className = 'bad'
    row.appendChild(label)
    var value = step[field.key]
    if (field.key === 'etaSec') {
      row.appendChild(el('span', missing ? 'bad' : '', missing ? '未提供' : String(value) + ' 秒'))
    } else {
      row.appendChild(el('span', missing ? 'bad' : '', missing ? '未提供' : String(value)))
    }
    box.appendChild(row)
  }
}

/** 折叠行（两行）：标题 + 依据，**风险标记留在折叠行上** */
function incidentMiniRow(step, view, pending) {
  var row = el('div', 'quad-step mini ' + incidentStatusClass(step))
  var head = el('div', 'quad-step-head')
  head.appendChild(el('span', 'quad-st ' + incidentStatusClass(step), incidentStatusLabel(step)))
  head.appendChild(el('b', '', step.action === '' ? step.id : step.action))
  var missing = incidentMissingFields(step)
  if (missing.length > 0) head.appendChild(el('span', 'quad-risky', '缺' + missing.join('/')))
  var scopeMini = incidentScopeCheck(step, view)
  if (scopeMini.kind === 'out') head.appendChild(el('span', 'quad-risky', '超授权'))
  else if (scopeMini.kind === 'unknown' && step.under === '') head.appendChild(el('span', 'quad-risky', '没写授权依据'))
  /* 审批单与提案对不上时**折叠行上也要看得见** —— 否则等于把问题藏在折叠里（与"缺回滚"同一条规矩） */
  if (incidentStepWaiting(step) && incidentMatchApproval(step, pending === undefined ? [] : pending).kind === 'differ') {
    head.appendChild(el('span', 'quad-risky', '不一致'))
  }
  head.appendChild(el('span', 'quad-when', step.proposedAtMs > 0 ? monitorClockText(step.proposedAtMs, Date.now()) : ''))
  head.appendChild(el('span', 'quad-chev-sm', '⌄'))
  row.appendChild(head)
  var why = []
  if (step.why !== '') why.push('依据：' + step.why)
  if (step.impact !== '') why.push('影响面：' + step.impact)
  row.appendChild(el('div', 'quad-step-why', why.join(' ｜ ')))
  return row
}

/** 展开卡：五要素 + 提案 ↔ 审批单对照 + 行内裁决 */
function incidentOpenCard(step, view, pending, employeeId) {
  var card = el('div', 'quad-step open ' + incidentStatusClass(step))
  var head = el('div', 'quad-step-head')
  head.appendChild(el('span', 'quad-st ' + incidentStatusClass(step), incidentStatusLabel(step)))
  head.appendChild(el('b', '', step.action === '' ? step.id : step.action))
  head.appendChild(el('span', 'quad-when', step.proposedAtMs > 0 ? monitorClockText(step.proposedAtMs, Date.now()) + ' 提案' : ''))
  card.appendChild(head)

  /* 授权依据：写在第 1.5 行（动作原文之后、五要素之前）—— 它是"能不能做"的前提 */
  var scopeState = incidentScopeCheck(step, view)
  var scopeRow = el('div', 'quad-kv' + (scopeState.kind === 'ok' ? '' : ' bad'))
  scopeRow.appendChild(el('b', scopeState.kind === 'ok' ? '' : 'bad', '授权依据：'))
  scopeRow.appendChild(el('span', scopeState.kind === 'ok' ? '' : 'bad', step.under === '' ? '未提供' : step.under))
  if (scopeState.kind !== 'ok') scopeRow.appendChild(el('span', 'aside-note', '（' + scopeState.text + '）'))
  card.appendChild(scopeRow)

  if (step.action !== '') card.appendChild(el('div', 'quad-step-code', step.action))
  incidentFieldRows(card, step)
  if (step.assetId !== '') card.appendChild(el('div', 'quad-kv', '目标：' + step.assetId))

  /* 提案 ↔ 审批单：不一致就红着说（网段 vs 单 IP 这种事人眼扫不出来） */
  var matched = incidentMatchApproval(step, pending)
  if (incidentStepWaiting(step) && matched.kind === 'differ') {
    var diff = el('div', 'quad-step-diff')
    diff.appendChild(el('b', '', '⚠ 她要跑的与你批的提案不一致'))
    diff.appendChild(el('div', '', '审批单：' + matched.text))
    diff.appendChild(el('div', '', '提案：' + step.action))
    diff.appendChild(el('div', 'aside-note', '先把这条问清楚再批 —— 不一致的命令不该直接放行。'))
    card.appendChild(diff)
  }

  var act = el('div', 'quad-step-act')
  if (incidentStepWaiting(step)) {
    var missing = incidentMissingFields(step)
    var matchedItem = matched.kind === 'none' || matched.item === null ? null : matched.item
    if (matchedItem === null) {
      act.appendChild(el('span', 'aside-note', matched.kind === 'differ' ? '先问清不一致，再决定' : '等待她的审批请求（她动手时 dsh 会发一条）'))
    } else if (state.canResolve !== true) {
      act.appendChild(el('span', 'aside-note', '需要 approval.resolve 权限才能裁决'))
    } else {
      var approvalId = String(matchedItem.approvalId || '')
      /* 缺回滚的步骤不给"通过"加强调：不该被一键点过去（但紧急时仍然批得动） */
      var approve = el('button', missing.length === 0 && matched.kind === 'match' ? 'primary' : '', '通过')
      var reject = el('button', 'danger', '拒绝')
      /* 不一致时**不能直接批**：先把这条问清楚（拒绝随时可用）。
         一个能一键放行"和你批的不一样"的按钮，等于把对照这件事做成装饰。 */
      if (matched.kind === 'differ') {
        approve.disabled = true
        approve.title = '审批单与提案不一致：先问清再决定'
      }
      /* 提交期间 resolveApproval 要按 id 找得到这两个按钮并锁住（防连点） */
      approve.setAttribute('data-approval-id', approvalId)
      reject.setAttribute('data-approval-id', approvalId)
      approve.onclick = function () {
        resolveApproval(approvalId, true)
      }
      reject.onclick = function () {
        resolveApproval(approvalId, false)
      }
      act.appendChild(approve)
      act.appendChild(reject)
    }
    if (missing.length > 0) act.appendChild(el('span', 'quad-step-note bad', '提案缺：' + missing.join('、') + ' —— 让她补完再批'))
    else if (scopeState.kind === 'out') {
      /* 超出常备授权的一步：仍然**允许你批**，但要说清这是一次记录在案的破例 ——
         真实的应急就是这样（break-glass 要有账），而不是要求你现场回去改配置。
         不给她自己批的余地：这一步永远不会变成"她觉得合理就做"。 */
      act.appendChild(el('span', 'quad-step-note bad', '超出常备授权 —— 通过即记录一次破例'))
    } else act.appendChild(el('span', 'quad-step-note', '批准只对这一步有效'))
  } else if (incidentStepRunning(step)) {
    act.appendChild(el('span', 'aside-note', step.approvedAtMs > 0 ? '你于 ' + monitorClockText(step.approvedAtMs, Date.now()) + ' 批准，正在执行' : '正在执行'))
  } else if (step.status === 'done') {
    act.appendChild(el('span', 'aside-note', '已完成' + (step.evidence === '' ? '' : ' · 证据 ' + step.evidence)))
  } else if (step.status === 'rejected') {
    act.appendChild(el('span', 'aside-note', '你拒绝了这一步' + (step.result === '' ? '' : ' —— ' + step.result)))
  } else if (step.status === 'rolled-back' || step.status === 'failed') {
    act.appendChild(el('span', 'quad-step-note bad', (step.status === 'failed' ? '失败' : '已回滚') + (step.result === '' ? '' : '：' + step.result)))
  }
  card.appendChild(act)
  return card
}

/**
 * 左下「处置队列」：一条 = 一步。
 *
 * 展开规则（实测逼出来的）：**一次只摊开一条** —— 优先"正在跑的"，否则"等得最久的待批"。
 * 全部摊开时 4 条就要 677px，而这一格只有约 382px，最后一条会被切掉；而"一次只看一条"
 * 也更接近真实：**人一次只能认真批一件事**，摊开两条只会鼓励扫一眼就点通过。
 */
function renderPanelIncidentSteps(container, ctx) {
  var employee = ctx.employee
  var employeeId = employee === null || employee === undefined ? '' : String(employee.id || '')
  var view = ctx.incidentResult !== null && ctx.incidentResult !== undefined && ctx.incidentResult.ok === true ? incidentView(ctx.incidentResult.value) : null
  var actions = ctx.actionsResult !== null && ctx.actionsResult !== undefined && ctx.actionsResult.ok === true ? actionsView(ctx.actionsResult.value) : null
  var steps = actions === null ? [] : actions.steps
  var counts = incidentCounts(steps)
  var pending = incidentPendingApprovals(employeeId)

  var box = asideBlock(
    container,
    '处置队列',
    counts.pending > 0 ? String(counts.pending) + ' 待你批准' : '',
    counts.pending > 0 ? 'warn' : '',
  )
  monitorTitleSub(box, steps.length === 0 ? '' : '一次只摊开一条 · 一次授权一步')

  if (ctx.incidentResult === null || ctx.incidentResult === undefined || ctx.actionsResult === null || ctx.actionsResult === undefined) {
    box.appendChild(el('div', 'aside-note', '（正在载入…）'))
    return
  }
  if (ctx.incidentResult.ok !== true) {
    box.appendChild(el('div', 'aside-note', '还没有事件登记（' + INCIDENT_PATH + '）—— 队列要挂在一次事件上才有意义。'))
    return
  }
  if (ctx.actionsResult.ok !== true) {
    appendFileState(box, ctx.actionsResult, '每步处置写进 ' + ACTIONS_PATH + '（员工写）。')
    return
  }
  if (view !== null && view.running !== true) {
    box.appendChild(
      el('div', 'quad-empty',
        view.closedAtMs > 0
          ? '事件已关闭（' + monitorClockText(view.closedAtMs, Date.now()) + '）—— 队列是空的。'
          : '当前是待命状态（' + INCIDENT_PATH + ' 里 status=standby）—— 队列是空的。'),
    )
    if (counts.done + counts.rejected + counts.rollback > 0) {
      box.appendChild(
        el('div', 'aside-note', '这次事件共 ' + String(counts.total) + ' 步：完成 ' + String(counts.done) + ' · 被拒 ' + String(counts.rejected) + ' · 回滚 ' + String(counts.rollback) + '。'),
      )
    }
    return
  }
  if (steps.length === 0) {
    box.appendChild(el('div', 'quad-empty', '队列是空的：没有待批的动作。'))
    box.appendChild(el('div', 'aside-note', '只读排查（看日志、看进程、看连接）不需要你批准 —— 只有动手的步骤才进这个队列。'))
    return
  }

  /* 紧急出口：批量拒绝（批量批准**没有**，也不会有） */
  var freeze = el('div', 'quad-freeze')
  freeze.appendChild(el('span', '', '拿不准就先停手'))
  var freezeBtn = el('button', '', '全部拒绝并停手')
  if (pending.length === 0) {
    freezeBtn.disabled = true
    freezeBtn.title = '现在没有待批的审批'
  } else {
    freezeBtn.onclick = function () {
      var ids = []
      for (var i = 0; i < pending.length; i += 1) ids.push(String(pending[i].approvalId || ''))
      for (var j = 0; j < ids.length; j += 1) {
        if (ids[j] !== '') resolveApproval(ids[j], false)
      }
      toast('已拒绝 ' + String(ids.length) + ' 条待批（批量拒绝是安全的；批量批准不存在）', 'info')
    }
  }
  freeze.appendChild(freezeBtn)
  box.appendChild(freeze)

  /* 展开谁：正在跑的优先，否则等得最久的待批 */
  var open = null
  for (var r = 0; r < steps.length; r += 1) {
    if (incidentStepRunning(steps[r])) {
      open = steps[r]
      break
    }
  }
  if (open === null) {
    var waiting = []
    for (var w = 0; w < steps.length; w += 1) if (incidentStepWaiting(steps[w])) waiting.push(steps[w])
    waiting.sort(function (a, b) {
      return a.proposedAtMs - b.proposedAtMs
    })
    open = waiting.length > 0 ? waiting[0] : null
  }

  if (open !== null) box.appendChild(incidentOpenCard(open, view, pending, employeeId))

  /* 其余待批/执行中：折叠两行（风险标记留在折叠行上） */
  var mini = []
  for (var m = 0; m < steps.length; m += 1) {
    var step = steps[m]
    if (step === open) continue
    if (incidentStepWaiting(step) || incidentStepRunning(step)) mini.push(step)
  }
  for (var i2 = 0; i2 < mini.length; i2 += 1) box.appendChild(incidentMiniRow(mini[i2], view, pending))

  /* 已结束的：一行计数 + 展开明细（拒绝也要留痕，所以计数里带着它） */
  if (counts.done + counts.rejected + counts.rollback + counts.unknown > 0) {
    var more = el('div', 'quad-step-more')
    if (counts.done > 0) more.appendChild(el('span', 'quad-st done', '✓ ' + String(counts.done)))
    if (counts.rejected > 0) more.appendChild(el('span', 'quad-st rejected', '✗ ' + String(counts.rejected)))
    if (counts.rollback > 0) more.appendChild(el('span', 'quad-st rollback', '↺ ' + String(counts.rollback)))
    var moreText = el('span', '', '已结束（含被拒的，拒绝也是决策）')
    more.appendChild(moreText)
    var moreChev = el('span', 'quad-chev-sm', state.quad.incidentDoneOpen === true ? '⌃' : '⌄')
    more.appendChild(moreChev)
    makeFoldToggle(more, state.quad.incidentDoneOpen === true, function () {
      state.quad.incidentDoneOpen = !(state.quad.incidentDoneOpen === true)
      renderQuadCells()
    })
    box.appendChild(more)
    if (state.quad.incidentDoneOpen === true) {
      for (var d = 0; d < steps.length; d += 1) {
        var one = steps[d]
        if (incidentStepWaiting(one) || incidentStepRunning(one)) continue
        var row = el('div', 'quad-step-row')
        row.appendChild(el('span', 'quad-st ' + incidentStatusClass(one), incidentStatusLabel(one)))
        row.appendChild(el('b', '', one.action === '' ? one.id : one.action))
        if (one.proposedAtMs > 0) row.appendChild(el('span', 'quad-when', monitorClockText(one.proposedAtMs, Date.now())))
        box.appendChild(row)
        if (one.result !== '' || one.evidence !== '') {
          box.appendChild(el('div', 'quad-step-why', (one.result === '' ? '' : one.result + ' ') + (one.evidence === '' ? '' : '证据 ' + one.evidence)))
        }
      }
    } else {
      box.appendChild(el('div', 'aside-note', '点开看每一步的依据与结果（不含被拒的原因 —— 那在会话里）。'))
    }
  }
}

/* ── 面板：右上 处置时间线 ── */

/** 右上「处置时间线」：一条 = 一步 + 逐条日志（只追加不覆盖） */
function renderPanelIncidentTimeline(container, ctx) {
  var actions = ctx.actionsResult !== null && ctx.actionsResult !== undefined && ctx.actionsResult.ok === true ? actionsView(ctx.actionsResult.value) : null
  var view = ctx.incidentResult !== null && ctx.incidentResult !== undefined && ctx.incidentResult.ok === true ? incidentView(ctx.incidentResult.value) : null
  var steps = actions === null ? [] : actions.steps
  var counts = incidentCounts(steps)
  var nowMs = Date.now()

  /* 工具条里只放"扫一眼"的部分：带子 + 计数。每一步的经过本来就在对话里，
     3 行日志在只有一行高的工具条里会把整条撑开（实测会把工具条从 29px 撑到 ~140px，
     而它下面就是对话 —— 那就违背了这一页"重对话"的初衷）。 */
  var compact = ctx !== null && ctx !== undefined && ctx.cell === 'tr'
  var box = asideBlock(container, '处置时间线')
  monitorTitleSub(box, steps.length === 0 ? '' : String(steps.length) + ' 步')
  if (steps.length === 0) {
    box.appendChild(el('div', 'aside-note', view !== null && view.running !== true ? '这次事件没有留下步骤记录。' : '还没有任何处置步骤。'))
    return
  }
  var band = el('div', compact ? 'quad-tl inc-tl-compact' : 'quad-tl')
  for (var i = 0; i < steps.length; i += 1) {
    var step = steps[i]
    var cls = incidentStatusClass(step)
    var cell = el('i', 'quad-tl-cell ' + (cls === '' ? 'todo' : cls))
    var tip = [incidentStatusLabel(step), step.action === '' ? step.id : step.action]
    if (step.proposedAtMs > 0) tip.push(monitorClockText(step.proposedAtMs, nowMs))
    cell.title = tip.join(' · ')
    band.appendChild(cell)
  }
  box.appendChild(band)
  if (compact) {
    /* 工具条里用一行文字代替圆点图例：图例本身会换行，把只有一行高的工具条撑成三行。
       "颜色 = 状态"这件事在带子的 hover 提示里仍然有（每格都带 title）。 */
    var countsLine = []
    if (counts.done > 0) countsLine.push('完成 ' + String(counts.done))
    if (counts.running > 0) countsLine.push('执行中 ' + String(counts.running))
    if (counts.pending > 0) countsLine.push('待批 ' + String(counts.pending))
    if (counts.rejected > 0) countsLine.push('被拒 ' + String(counts.rejected))
    if (counts.rollback > 0) countsLine.push('回滚 ' + String(counts.rollback))
    box.appendChild(el('span', 'inc-tl-counts', countsLine.length === 0 ? '没有步骤' : countsLine.join(' · ')))
    return
  }
  var legend = el('div', 'quad-legend')
  var items = [
    { cls: 'done', text: '完成 ' + String(counts.done) },
    { cls: 'running', text: '执行中 ' + String(counts.running) },
    { cls: 'pending', text: '待你批准 ' + String(counts.pending) },
    { cls: 'rejected', text: '被拒 ' + String(counts.rejected) },
    { cls: 'rollback', text: '回滚 ' + String(counts.rollback) },
  ]
  for (var l = 0; l < items.length; l += 1) {
    legend.appendChild(el('span', 'quad-tl-dot ' + items[l].cls))
    legend.appendChild(el('span', '', items[l].text))
  }
  box.appendChild(legend)

  if (compact) return
  var rows = incidentLogRows(steps)
  var logBox = el('div', 'quad-log')
  for (var r = 0; r < rows.length && r < INCIDENT_LOG_MAX; r += 1) {
    var row = el('div', rows[r].bad === true ? 'bad' : '')
    row.appendChild(el('span', 'quad-log-t', monitorClockText(rows[r].atMs, nowMs)))
    row.appendChild(el('span', 'quad-log-w', rows[r].text))
    logBox.appendChild(row)
  }
  box.appendChild(logBox)
  if (rows.length > INCIDENT_LOG_MAX) box.appendChild(el('div', 'aside-note', '…更早的 ' + String(rows.length - INCIDENT_LOG_MAX) + ' 条在会话里'))
  box.appendChild(el('div', 'aside-note', '时间线只追加不覆盖 —— 它是复盘材料，也是"我批过什么"的唯一真相。'))
}

/* ═══════════ 9.12 应急响应面板的 id 清单 ═══════════ */

/** 配了这些面板中的任意一个 → 就需要 incident.json + actions.json */
var INCIDENT_PANEL_IDS = ['incident-post', 'incident-steps', 'incident-timeline']
`
