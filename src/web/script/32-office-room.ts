/* 32-office-room：「全景」页 —— 左侧是可扩展的小办公室，右侧是本地虚构小剧场。
 *
 * 每间工作室保留六个插画工位，增加员工时自动扩展工作室分页。
 * 点击头像会弹出轻松台词，双击或点「聊两句」进入真实会话。
 *
 * 几条边界：
 *   1. 谁在线、谁在忙、谁有未读都来自 state 与办公区同一套判定（roomStatusOf 复用 availabilityBadge），
 *      绝不为好看编造真实状态。
 *   2. 不生图。头像使用员工自己的头像（avatarNode），场景装饰由 DOM + CSS 绘制。
 *   3. 小剧场是独立的本地脚本，不读取工作内容，也不触发员工任务。
 *   4. 员工节点只在人员集合变化时增删；忙闲与未读更新只改状态和文字。
 *
 * 台词气泡由 ROOM_TALK_MS 控时，ROOM_LINES 控制内容。
 */

export const CHUNK_32_OFFICE_ROOM = String.raw`
/** 一句话在气泡里停多久（毫秒）。 */
var ROOM_TALK_MS = 3600

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

/** 稳定哈希：同一个 id 保持服装配色、动效相位与台词起点一致。 */
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
  page: 0,
  selectedId: '',
  selectedAvatarKey: '',
  daypart: '',
  paused: false,
  eventCount: { coffee: 0, plane: 0, plant: 0 },
  eventTimer: null,
  order: '',
  nodes: {},
  talkTimers: {},
  said: 0,
  lastLine: -1,
  storyKey: '',
  storyChoice: -1,
  storybookOpen: false,
  storyRenderKey: '',
  storybookRenderKey: '',
  timer: null
}

/** 每日小剧场：纯本地的轻剧情，不读取员工工作内容，也不调用员工会话。 */
var ROOM_STORIES = [
  {
    id: 'plant',
    title: '绿萝今天有点不对劲',
    setup: '早上刚到办公室，大家发现绿萝头上多了一顶纸帽。它看起来像是准备参加什么重要活动。',
    choices: [
      { label: '给它办一场正式发布会', ending: '发布会准时开始。绿萝在掌声中宣布：今天也要好好晒太阳。它凭借稳定发挥，当选本周最冷静的同事。' },
      { label: '沿着纸屑线索破案', ending: '纸屑一路指向打印机。案件最终定名为《帽子的来源》，绿萝获得一件由便利贴改造的小披风。' }
    ]
  },
  {
    id: 'snack',
    title: '最后一块饼干去哪了',
    setup: '茶水间只剩最后一块饼干，旁边还摆着一张神秘纸条：「请把它交给最需要快乐的人。」',
    choices: [
      { label: '掰成两半，快乐共享', ending: '两个人都拿到了半块饼干，还认真给它起名叫「公平」。纸条的作者获得了下一包饼干的优先命名权。' },
      { label: '把饼干送去失物招领', ending: '饼干被郑重登记，失主很快出现：是下午茶时间。全办公室一致决定，明天多准备一包。' }
    ]
  },
  {
    id: 'elevator',
    title: '电梯里的神秘按钮',
    setup: '电梯面板上多了一个画着小星星的按钮。没人知道它会去几楼，但按钮看起来很期待被按下。',
    choices: [
      { label: '按下按钮，看看会怎样', ending: '电梯没有移动，顶灯却变成了星星形状。大家把这一层命名为「心情不错层」，并给按钮放了个小假。' },
      { label: '先给按钮做个访谈', ending: '经过一番认真采访，按钮承认自己只是贴纸。它被授予「最有存在感贴纸奖」，继续负责点亮大家的想象力。' }
    ]
  }
]

var ROOM_STORYBOOK_KEY = 'dse.roomStorybook'
var ROOM_STORY_PROGRESS_KEY = 'dse.roomStoryProgress'

function roomStoryDate() {
  var now = new Date()
  var month = now.getMonth() + 1
  var day = now.getDate()
  return {
    key: String(now.getFullYear()) + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
    label: String(month) + '月' + String(day) + '日'
  }
}

function roomStoryEpisodeOf(employees) {
  var list = Array.isArray(employees) ? employees.slice() : []
  list.sort(function (left, right) {
    return String(left.id || '').localeCompare(String(right.id || ''), 'zh-CN')
  })
  var date = roomStoryDate()
  var story = ROOM_STORIES[roomPick(roomHash('story:' + date.key), ROOM_STORIES.length)]
  if (story === undefined) story = ROOM_STORIES[0]
  var cast = []
  if (list.length > 0) {
    var leadIndex = roomPick(roomHash('lead:' + date.key), list.length)
    var lead = list[leadIndex]
    if (lead !== undefined) cast.push(lead)
    if (list.length > 1) {
      var guestOffset = 1 + roomPick(roomHash('guest:' + date.key), list.length - 1)
      var guest = list[(leadIndex + guestOffset) % list.length]
      if (guest !== undefined) cast.push(guest)
    }
  }
  var castKey = cast.map(function (employee) { return String(employee.id || '') }).join(',')
  return {
    key: date.key + '|' + String(story.id || '') + '|' + castKey,
    date: date,
    story: story,
    cast: cast
  }
}

function roomStorybookRead() {
  try {
    var raw = readLocal(ROOM_STORYBOOK_KEY)
    var parsed = raw === null ? [] : JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(function (item) {
      return item !== null && typeof item === 'object' && typeof item.key === 'string' &&
        typeof item.title === 'string' && typeof item.ending === 'string'
    }).slice(0, 40)
  } catch (error) {
    return []
  }
}

function roomStoryProgressRead(key) {
  try {
    var raw = readLocal(ROOM_STORY_PROGRESS_KEY)
    var parsed = raw === null ? null : JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || parsed.key !== key) return -1
    var choice = Number(parsed.choice)
    return Number.isInteger(choice) && choice >= 0 && choice < 2 ? choice : -1
  } catch (error) {
    return -1
  }
}

function roomStorybookRender(records) {
  var toggle = $('roomStorybookToggle')
  var count = $('roomStorybookCount')
  var book = $('roomStorybook')
  var list = $('roomStorybookList')
  if (count !== null) count.textContent = String(records.length)
  if (toggle !== null) toggle.setAttribute('aria-expanded', roomView.storybookOpen ? 'true' : 'false')
  if (book !== null) {
    if (roomView.storybookOpen) book.classList.remove('hidden')
    else book.classList.add('hidden')
  }
  if (list === null) return
  clear(list)
  if (records.length === 0) {
    list.appendChild(el('p', 'room-storybook-empty', '还没有收藏。选一个结局，把今天的小故事收进来吧。'))
    return
  }
  records.forEach(function (record) {
    var item = el('article', 'room-storybook-entry')
    var title = el('strong', '', record.title)
    var date = el('span', 'room-storybook-date', record.date || '')
    var ending = el('p', '', record.ending)
    item.appendChild(title)
    item.appendChild(date)
    if (typeof record.cast === 'string' && record.cast !== '') item.appendChild(el('span', 'room-storybook-cast', '主演：' + record.cast))
    item.appendChild(ending)
    list.appendChild(item)
  })
}

function roomStoryRender(focusAfter) {
  var content = $('roomStoryContent')
  if (content === null) return
  var episode = roomStoryEpisodeOf(state.employees)
  var poster = $('roomStoryPoster')
  if (poster !== null) poster.setAttribute('data-story', String(episode.story.id || 'plant'))
  var castNames = episode.cast.map(function (employee) { return String(employee.name || employee.id || '同事') })
  if (roomView.storyKey !== episode.key) {
    roomView.storyKey = episode.key
    roomView.storyChoice = roomStoryProgressRead(episode.key)
  }
  var records = roomStorybookRead()
  var collected = {}
  records.forEach(function (record) { collected[record.key] = true })
  var choice = roomView.storyChoice
  var selected = episode.story.choices[choice]
  var selectedRecordKey = episode.key + ':' + String(choice)
  var signature = [episode.key, castNames.join(','), String(choice), collected[selectedRecordKey] === true ? 'saved' : 'new'].join('|')
  var bookSignature = [roomView.storybookOpen ? 'open' : 'closed', records.map(function (record) { return record.key }).join(',')].join('|')
  if (roomView.storybookRenderKey !== bookSignature) {
    roomView.storybookRenderKey = bookSignature
    roomStorybookRender(records)
  }

  if (roomView.storyRenderKey !== signature) {
    roomView.storyRenderKey = signature
    clear(content)

    var meta = el('div', 'room-story-meta')
    meta.appendChild(el('span', 'room-story-date', episode.date.label))
    meta.appendChild(el('span', 'room-story-fiction', '纯属虚构'))
    content.appendChild(meta)
    content.appendChild(el('h4', 'room-story-title', episode.story.title))
    content.appendChild(el('p', 'room-story-setup', episode.story.setup))

    if (episode.cast.length > 0) {
      var cast = el('div', 'room-story-cast')
      cast.appendChild(el('span', 'room-story-cast-label', '本集主演'))
      episode.cast.forEach(function (employee, index) {
        var actor = el('div', 'room-story-actor')
        actor.appendChild(avatarNode(employee, 28))
        actor.appendChild(el('span', '', castNames[index] || '同事'))
        cast.appendChild(actor)
      })
      content.appendChild(cast)
    }

    var prompt = el('p', 'room-story-prompt', episode.cast.length > 0 ? '如果是你，会怎么收场？' : '接入员工后，这集就能开演。')
    content.appendChild(prompt)
    var choices = el('div', 'room-story-choices')
    episode.story.choices.forEach(function (option, index) {
      var button = el('button', 'room-story-choice' + (choice === index ? ' is-selected' : ''), option.label)
      button.setAttribute('type', 'button')
      button.setAttribute('aria-pressed', choice === index ? 'true' : 'false')
      if (episode.cast.length === 0) button.disabled = true
      button.onclick = function () {
        roomView.storyChoice = index
        writeLocal(ROOM_STORY_PROGRESS_KEY, JSON.stringify({ key: episode.key, choice: index }))
        roomStoryRender('choice')
      }
      choices.appendChild(button)
    })
    content.appendChild(choices)

    if (selected !== undefined && episode.cast.length > 0) {
      var ending = el('div', 'room-story-ending')
      ending.appendChild(el('span', 'room-story-ending-label', choice === 0 ? '结局 A' : '结局 B'))
      ending.appendChild(el('p', '', selected.ending))
      content.appendChild(ending)
      var save = el('button', 'room-story-save', collected[selectedRecordKey] === true ? '已收进趣事簿 ✓' : '把这个结局收进趣事簿 ＋')
      save.setAttribute('type', 'button')
      save.disabled = collected[selectedRecordKey] === true
      save.onclick = function () {
        var current = roomStorybookRead()
        var key = episode.key + ':' + String(choice)
        var alreadySaved = current.some(function (record) { return record.key === key })
        if (!alreadySaved) {
          current.unshift({
            key: key,
            title: episode.story.title + ' · ' + (choice === 0 ? '结局 A' : '结局 B'),
            ending: selected.ending,
            date: episode.date.label,
            cast: castNames.join('、')
          })
          writeLocal(ROOM_STORYBOOK_KEY, JSON.stringify(current.slice(0, 40)))
        }
        roomStoryRender('save')
      }
      content.appendChild(save)
    }
  }

  if (focusAfter === 'choice') {
    var selectedButton = content.querySelector('.room-story-choice.is-selected')
    if (selectedButton !== null && typeof selectedButton.focus === 'function') selectedButton.focus()
  } else if (focusAfter === 'save') {
    var saveButton = content.querySelector('.room-story-save')
    if (saveButton !== null && typeof saveButton.focus === 'function') saveButton.focus()
  }
}

var roomStorybookToggle = $('roomStorybookToggle')
if (roomStorybookToggle !== null) {
  roomStorybookToggle.onclick = function () {
    roomView.storybookOpen = !roomView.storybookOpen
    roomView.storybookRenderKey = ''
    roomStoryRender()
  }
}

/* ═══ 微缩办公室：固定舞台、真实名册、本地小互动 ═══ */

var ROOM_PAGE_SIZE = 6
var ROOM_SEATS = [
  { x: 444, y: 335 }, { x: 568, y: 395 }, { x: 692, y: 455 },
  { x: 306, y: 405 }, { x: 430, y: 465 }, { x: 554, y: 525 }
]
var ROOM_DESK_COLORS = ['#708f8b', '#bb826b', '#8e8da8', '#c29b53', '#758dad', '#a1848c']

/** 页码只有视图状态，所有人依照办公区顺序完整分到六人工位中。 */
function roomPageCount(count) {
  return Math.max(1, Math.ceil(Math.max(0, Number(count) || 0) / ROOM_PAGE_SIZE))
}

function roomPageOf(ordered, page) {
  var list = Array.isArray(ordered) ? ordered : []
  var index = Math.floor(roomClamp(Number(page) || 0, 0, roomPageCount(list.length) - 1))
  return list.slice(index * ROOM_PAGE_SIZE, (index + 1) * ROOM_PAGE_SIZE)
}

function roomOrderedEmployees() {
  var ordered = []
  var seen = {}
  officeSections().forEach(function (section) {
    section.members.forEach(function (employee) {
      var id = String(employee.id || '')
      if (seen[id] === true) return
      seen[id] = true
      ordered.push(employee)
    })
  })
  /* 员工刚刚接入、分组尚未刷新时，也不能把新人漏掉。 */
  state.employees.forEach(function (employee) {
    var id = String(employee.id || '')
    if (seen[id] === true) return
    seen[id] = true
    ordered.push(employee)
  })
  return ordered
}

function roomSvgElement(tag, attrs) {
  var node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]) })
  return node
}

/** 纯静态的桌椅道具，与整间屋子的等距轴线一致。 */
function roomDeskObject() {
  var object = el('span', 'room-desk-object')
  object.setAttribute('aria-hidden', 'true')
  var svg = roomSvgElement('svg', { viewBox: '0 0 170 130', width: '170', height: '130', fill: 'none' })
  var shapes = [
    ['path', { 'class': 'room-desk-leg', d: 'M22 72V108L29 112V76M146 74V109L139 113V78M88 107V127L94 124V105', fill: '#858678' }],
    ['path', { 'class': 'room-desk-front', d: 'M8 65L87 111L163 65V73L87 119L8 73Z', fill: '#bf956e' }],
    ['path', { 'class': 'room-desk-top', d: 'M8 65L84 22L163 65L87 111Z', fill: '#e8c8a3', stroke: '#b78f69', 'stroke-width': '1.2', 'stroke-linejoin': 'round' }],
    ['path', { 'class': 'room-monitor-stand', d: 'M78 62L65 70L85 81L98 73Z', fill: '#b4b6a8' }],
    ['path', { 'class': 'room-monitor', d: 'M70 38L110 61V87L70 64Z', fill: '#677f7a', stroke: '#405f5b', 'stroke-width': '2', 'stroke-linejoin': 'round' }],
    ['path', { 'class': 'room-monitor-screen', d: 'M75 45L105 63V78L75 60Z', fill: '#c8e4db' }],
    ['path', { 'class': 'room-monitor-code', d: 'M80 51L95 60M80 56L100 68M80 61L91 67', stroke: '#79a69b', 'stroke-width': '1.8', 'stroke-linecap': 'round' }],
    ['path', { 'class': 'room-desk-paper', d: 'M35 65L51 56L64 64L48 73Z', fill: '#fff7e8', stroke: '#cfba99' }],
    ['path', { 'class': 'room-desk-pencil', d: 'M40 69L55 60', stroke: '#d38557', 'stroke-width': '2', 'stroke-linecap': 'round' }],
    ['path', { 'class': 'room-desk-cup', d: 'M128 62V71C128 76 138 76 138 71V62Z', fill: '#f7eed8', stroke: '#b6a083' }],
    ['ellipse', { cx: '133', cy: '62', rx: '5', ry: '2.5', fill: '#a78361' }],
    ['path', { d: 'M138 64C146 63 145 72 138 70', stroke: '#d2bba0', 'stroke-width': '2' }]
  ]
  shapes.forEach(function (shape) { svg.appendChild(roomSvgElement(shape[0], shape[1])) })
  object.appendChild(svg)
  return object
}

function roomPositionWalker(walker, index) {
  var spot = ROOM_SEATS[index]
  if (spot === undefined) return
  walker.style.setProperty('left', String(spot.x / 10) + '%')
  walker.style.setProperty('top', String(spot.y / 7.2) + '%')
  walker.style.setProperty('--seat-index', String(index))
  walker.style.setProperty('z-index', String(Math.round(spot.y)))
}

function buildRoomWalker(employee) {
  var id = String(employee.id || '')
  var name = String(employee.name || id)
  var walker = el('div', 'walker')
  walker.setAttribute('role', 'button')
  walker.setAttribute('tabindex', '0')
  walker.setAttribute('data-emp', id)
  walker.style.setProperty('--walker-av', '44px')
  walker.style.setProperty('--desk-color', ROOM_DESK_COLORS[roomPick(roomHash(id), ROOM_DESK_COLORS.length)])
  walker.style.setProperty('--walk-delay', String(-roomPick(roomHash(id), 50) / 10) + 's')
  walker.appendChild(roomDeskObject())
  walker.appendChild(el('span', 'walker-shadow'))
  walker.appendChild(el('span', 'walker-chair'))
  var body = el('span', 'walker-body')
  body.appendChild(el('span', 'walker-torso'))
  var face = el('span', 'walker-face')
  face.appendChild(avatarNode(employee, 44))
  body.appendChild(face)
  body.appendChild(el('span', 'walker-dot'))
  body.appendChild(el('span', 'walker-prop'))
  body.appendChild(el('span', 'walker-badge'))
  walker.appendChild(body)
  walker.appendChild(el('span', 'walker-name', name))
  walker.appendChild(el('span', 'walker-role', String(employee.role || '数字同事')))
  var bubble = el('span', 'walker-bubble')
  bubble.appendChild(el('span', 'walker-bubble-head', name))
  bubble.appendChild(el('span', 'walker-line', ''))
  bubble.appendChild(el('span', 'walker-fiction', '即兴台词'))
  var talk = el('button', 'walker-talk', '聊两句')
  talk.setAttribute('type', 'button')
  talk.setAttribute('tabindex', '-1')
  talk.setAttribute('aria-label', '和「' + name + '」开始对话')
  bubble.appendChild(talk)
  walker.appendChild(bubble)
  walker.title = '点一下认识「' + name + '」（双击进入对话）'
  ensureAvatar(employee)
  return walker
}

/** 状态轮询只改属性，人物和家具节点保持原位。 */
function patchRoomWalker(walker, employee) {
  var id = String(employee.id || '')
  var name = String(employee.name || id)
  var status = roomStatusOf(employee)
  walker.setAttribute('data-pose', status.pose)
  walker.setAttribute('data-lamp', status.lamp)
  walker.setAttribute('data-unread', status.unread > 0 ? '1' : '0')
  walker.setAttribute('aria-label', name + '：' + status.text + '。点一下打个招呼，双击开始对话')
  walker.setAttribute('aria-pressed', id === roomView.selectedId ? 'true' : 'false')
  var badge = walker.querySelector('.walker-badge')
  if (badge !== null) badge.textContent = status.unread > 0 ? (status.unread > 99 ? '99+' : String(status.unread)) : ''
  var prop = walker.querySelector('.walker-prop')
  if (prop !== null) {
    prop.setAttribute('data-kind', status.prop)
    prop.textContent = status.prop === 'zzz' ? 'Zzz' : status.prop === 'bang' ? '!' : status.prop === 'dust' ? '×' : ''
  }
  var head = walker.querySelector('.walker-bubble-head')
  if (head !== null) head.textContent = name + ' · ' + status.text
  var label = walker.querySelector('.walker-name')
  if (label !== null) label.textContent = name
  var role = walker.querySelector('.walker-role')
  if (role !== null) role.textContent = String(employee.role || '数字同事')
  if (id === roomView.selectedId) walker.classList.add('active')
  else walker.classList.remove('active')
}

function roomSetText(id, text) {
  var node = $(id)
  if (node !== null) node.textContent = text
}

function roomSelectedRender(employee) {
  var talk = $('roomSelectedTalk')
  if (employee === null || employee === undefined) {
    roomSetText('roomSelectedName', '等待同事入座')
    roomSetText('roomSelectedRole', '接入员工后，点工位认识大家')
    roomSetText('roomSelectedStatus', '暂无员工')
    roomSetText('roomSelectedQuote', '等待同事入座，一起创造办公室里的小故事。')
    if (talk !== null) {
      talk.disabled = true
      talk.onclick = null
    }
    var emptyAvatar = $('roomSelectedAvatar')
    if (emptyAvatar !== null) clear(emptyAvatar)
    roomView.selectedAvatarKey = ''
    return
  }
  var id = String(employee.id || '')
  var status = roomStatusOf(employee)
  roomSetText('roomSelectedName', String(employee.name || id))
  roomSetText('roomSelectedRole', String(employee.role || '数字同事'))
  roomSetText('roomSelectedStatus', status.text + (status.unread > 0 ? ' · ' + String(status.unread) + ' 条未读' : ''))
  var statusNode = $('roomSelectedStatus')
  if (statusNode !== null) statusNode.setAttribute('data-kind', status.kind)
  var avatar = $('roomSelectedAvatar')
  var cached = state.avatars === undefined ? undefined : state.avatars[id]
  var avatarKey = id + '|' + String(cached === undefined ? '' : cached)
  if (avatar !== null && roomView.selectedAvatarKey !== avatarKey) {
    clear(avatar)
    avatar.appendChild(avatarNode(employee, 48))
    roomView.selectedAvatarKey = avatarKey
  }
  if (talk !== null) {
    talk.disabled = false
    talk.onclick = function () { selectEmployee(id) }
  }
}

function roomSelectLocal(employee) {
  roomView.selectedId = String(employee.id || '')
  Object.keys(roomView.nodes).forEach(function (id) {
    var walker = roomView.nodes[id]
    var selected = id === roomView.selectedId
    walker.setAttribute('aria-pressed', selected ? 'true' : 'false')
    if (selected) walker.classList.add('active')
    else walker.classList.remove('active')
  })
  roomSelectedRender(employee)
}

/** 台词属于本地小剧场，不向员工发送消息。 */
function roomSay(walker, employee, scriptedLine) {
  if (walker === null || walker === undefined) return
  /* 一次只留一句小心声，避免相邻工位的气泡互相遮挡。 */
  Object.keys(roomView.nodes).forEach(function (id) {
    var other = roomView.nodes[id]
    if (other === walker) return
    other.setAttribute('data-talk', '0')
    var otherTalk = other.querySelector('.walker-talk')
    if (otherTalk !== null) otherTalk.setAttribute('tabindex', '-1')
    if (roomView.talkTimers[id] !== undefined && typeof clearTimeout === 'function') clearTimeout(roomView.talkTimers[id])
    delete roomView.talkTimers[id]
  })
  var text = typeof scriptedLine === 'string' ? scriptedLine : roomNextLine(employee)
  var line = walker.querySelector('.walker-line')
  if (line !== null) line.textContent = text
  if (String(employee.id || '') === roomView.selectedId) roomSetText('roomSelectedQuote', '「' + text + '」 · 即兴台词')
  walker.setAttribute('data-talk', '1')
  var talk = walker.querySelector('.walker-talk')
  if (talk !== null) talk.setAttribute('tabindex', '0')
  var id = String(employee.id || '')
  if (typeof setTimeout !== 'function') return
  if (roomView.talkTimers[id] !== undefined && typeof clearTimeout === 'function') clearTimeout(roomView.talkTimers[id])
  roomView.talkTimers[id] = setTimeout(function () {
    walker.setAttribute('data-talk', '0')
    if (talk !== null) talk.setAttribute('tabindex', '-1')
  }, ROOM_TALK_MS)
}

function roomWalkersBind(root) {
  if (root === null || root === undefined) return
  var walkers = root.querySelectorAll('.walker')
  for (var index = 0; index < walkers.length; index += 1) {
    var walker = walkers[index]
    if (walker !== undefined) roomWalkerBind(walker, walker.getAttribute('data-emp') || '')
  }
}

function roomWalkerBind(walker, id) {
  var employeeOf = function () {
    var found = null
    state.employees.forEach(function (item) { if (String(item.id || '') === String(id)) found = item })
    return found
  }
  var inspect = function () {
    var employee = employeeOf()
    if (employee === null) return
    roomSelectLocal(employee)
    roomSay(walker, employee)
  }
  walker.onclick = inspect
  walker.ondblclick = function () { selectEmployee(String(id)) }
  walker.onkeydown = function (event) {
    if (event !== undefined && event !== null && event.target !== undefined && event.target !== null && event.target !== walker) return
    var key = event === undefined || event === null ? '' : String(event.key || '')
    if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    inspect()
  }
  var talk = walker.querySelector('.walker-talk')
  if (talk !== null) talk.onclick = function (event) {
    if (event !== undefined && event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
    selectEmployee(String(id))
  }
}

var ROOM_LOCAL_EVENTS = {
  coffee: [
    { title: '咖啡暂停键', text: '一朵咖啡香云飘过工位。今天的杯子，装的是好心情。', lines: ['这杯叫快乐续杯', '给咖啡画了一颗心'] },
    { title: '第七杯给想象力', text: '咖啡机认真打出一颗爱心，泡沫宣布自己才是今日主角。', lines: ['拉花有自己的想法', '闻到了周末的味道'] },
    { title: '杯子也要碰个杯', text: '叮！六只杯子隔空碰杯，为这个普通的小瞬间干杯。', lines: ['为小事开心一下', '今天这杯特别香'] }
  ],
  plane: [
    { title: '一封没有截止日期的信', text: '纸飞机绕办公室兜了一圈，带着「祝你开心」轻轻降落。', lines: ['给风捎个小口信', '收到一张晴天明信片'] },
    { title: '纸飞机航空首航', text: '本次航班目的地：窗边的太阳。机上供应无限想象力。', lines: ['请收好你的小愿望', '这架飞机自带好心情'] },
    { title: '风替你跑个腿', text: '一张便签折成小飞机，暂时忘记文字，练习自由飞行。', lines: ['拐弯技术相当不错', '它在和云打招呼'] }
  ],
  plant: [
    { title: '绿萝的微型演讲', text: '你碰了碰叶子，绿萝轻轻摇头：别急，快乐可以慢慢长。', lines: ['它说要再晒五分钟', '今天也是一片好叶子'] },
    { title: '植物语翻译时间', text: '绿萝抖了抖叶子。翻译结果：请把烦恼寄存在花盆旁。', lines: ['绿萝今天很会安慰人', '叶子鼓掌也很小声'] },
    { title: '一厘米的冒险', text: '绿萝向阳光挪了想象中的一厘米，并宣布今天的探险圆满结束。', lines: ['小小一步也值得庆祝', '它的目标是整个窗台'] }
  ]
}

function roomLocalAction(action) {
  var options = ROOM_LOCAL_EVENTS[action]
  if (!Array.isArray(options)) return
  var count = Number(roomView.eventCount[action] || 0)
  var event = options[roomPick(count, options.length)]
  roomView.eventCount[action] = count + 1
  if (event === undefined) return
  var stage = $('roomRoom')
  if (stage !== null) {
    /* 重播同一个动作也能从头开始；只触碰装饰状态。 */
    stage.setAttribute('data-event', '')
    if (typeof stage.getBoundingClientRect === 'function') stage.getBoundingClientRect()
    stage.setAttribute('data-event', action)
    stage.setAttribute('data-event-step', String(count % 2))
  }
  roomSetText('roomEventTitle', event.title)
  roomSetText('roomSceneMessage', event.text)
  roomSetText('roomEventText', '场景彩蛋 · 一段办公室里的即兴小插曲。')
  var visible = roomPageOf(roomOrderedEmployees(), roomView.page)
  var speaker = visible[roomPick(count, visible.length)]
  if (speaker !== undefined) {
    roomSelectLocal(speaker)
    roomSay(roomView.nodes[String(speaker.id || '')], speaker, event.lines[roomPick(count, event.lines.length)])
  }
  if (roomView.eventTimer !== null && typeof clearTimeout === 'function') clearTimeout(roomView.eventTimer)
  if (typeof setTimeout === 'function') roomView.eventTimer = setTimeout(function () {
    if (stage !== null) stage.setAttribute('data-event', '')
    roomView.eventTimer = null
  }, 6500)
}

function roomQueryAll(selector) {
  return typeof document.querySelectorAll === 'function' ? document.querySelectorAll(selector) : []
}

function roomLightRender() {
  var stage = $('roomRoom')
  var part = roomView.daypart || roomDaypartOf(new Date().getHours())
  if (stage !== null) stage.setAttribute('data-daypart', part)
  var controls = roomQueryAll('[data-room-light]')
  for (var index = 0; index < controls.length; index += 1) {
    var button = controls[index]
    if (button === undefined) continue
    button.setAttribute('aria-pressed', button.getAttribute('data-room-light') === (part === 'dawn' ? 'day' : part) ? 'true' : 'false')
  }
}

function roomDateRender() {
  var now = new Date()
  if (typeof now.getMonth !== 'function') return
  var weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  roomSetText('roomDayLabel', String(now.getMonth() + 1) + ' 月 ' + String(now.getDate()) + ' 日 · ' + weekdays[now.getDay()] + ' · ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'))
}

function roomChangePage(delta) {
  var count = roomPageCount(roomOrderedEmployees().length)
  roomView.page = Math.floor(roomClamp(roomView.page + Number(delta || 0), 0, count - 1))
  renderOfficeRoom()
}

function roomControlsBind() {
  var prev = $('roomPrevPage')
  var next = $('roomNextPage')
  if (prev !== null) prev.onclick = function () { roomChangePage(-1) }
  if (next !== null) next.onclick = function () { roomChangePage(1) }
  var lights = roomQueryAll('[data-room-light]')
  for (var index = 0; index < lights.length; index += 1) {
    var light = lights[index]
    if (light === undefined) continue
    light.onclick = function () {
      roomView.daypart = this.getAttribute('data-room-light') || 'day'
      roomLightRender()
    }
  }
  var actions = roomQueryAll('[data-room-action]')
  for (var actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    var button = actions[actionIndex]
    if (button === undefined) continue
    button.onclick = function () { roomLocalAction(this.getAttribute('data-room-action') || '') }
  }
  var toggles = roomQueryAll('[data-room-ambience]')
  for (var toggleIndex = 0; toggleIndex < toggles.length; toggleIndex += 1) {
    var toggle = toggles[toggleIndex]
    if (toggle === undefined) continue
    toggle.setAttribute('aria-pressed', roomView.paused ? 'true' : 'false')
    toggle.onclick = function () {
      roomView.paused = !roomView.paused
      var stage = $('roomRoom')
      if (stage !== null) stage.setAttribute('data-paused', roomView.paused ? 'true' : 'false')
      this.setAttribute('aria-pressed', roomView.paused ? 'true' : 'false')
      roomSetText('roomMotionLabel', roomView.paused ? '继续小动作' : '暂停小动作')
    }
  }
}

function roomClearTalkTimers() {
  Object.keys(roomView.talkTimers).forEach(function (id) {
    if (typeof clearTimeout === 'function') clearTimeout(roomView.talkTimers[id])
  })
  roomView.talkTimers = {}
}

function renderOfficeRoom() {
  var stage = $('roomRoom')
  var scene = $('roomFloor')
  if (stage === null || scene === null) return
  var ordered = roomOrderedEmployees()
  var pages = roomPageCount(ordered.length)
  roomView.page = Math.floor(roomClamp(roomView.page, 0, pages - 1))
  var visible = roomPageOf(ordered, roomView.page)
  stage.setAttribute('data-count', String(ordered.length))
  stage.setAttribute('data-paused', roomView.paused ? 'true' : 'false')
  var scale = Math.max(0.1, (Number(stage.clientWidth) || 1000) / 1000)
  stage.style.setProperty('--office-scale', String(scale))
  stage.style.setProperty('--office-label-scale', String(Math.max(1, 0.72 / scale)))
  stage.style.setProperty('--office-bubble-scale', String(Math.max(1, 0.85 / scale)))
  stage.style.setProperty('--walker-av', '44px')
  roomLightRender()
  roomDateRender()
  roomControlsBind()
  roomSetText('roomSummary', ordered.length === 0 ? '' : roomSummary(ordered))
  roomSetText('roomPageLabel', String(roomView.page + 1).padStart(2, '0') + ' / ' + String(pages).padStart(2, '0'))
  roomSetText('roomStudioName', String(roomView.page + 1).padStart(2, '0') + ' 号工作室')
  var prev = $('roomPrevPage')
  var next = $('roomNextPage')
  if (prev !== null) prev.disabled = roomView.page === 0
  if (next !== null) next.disabled = roomView.page >= pages - 1
  roomStoryRender()

  var orderKey = visible.map(function (employee) { return String(employee.id || '') }).join(',')
  if (roomView.order !== orderKey || (visible.length === 0 && scene.querySelector('.walker-empty') === null)) {
    roomClearTalkTimers()
    clear(scene)
    roomView.nodes = {}
    roomView.order = orderKey
    visible.forEach(function (employee, index) {
      var walker = buildRoomWalker(employee)
      roomPositionWalker(walker, index)
      roomView.nodes[String(employee.id || '')] = walker
      scene.appendChild(walker)
    })
  }
  if (visible.length === 0) {
    roomView.selectedId = ''
    roomSelectedRender(null)
    var emptyState = scene.querySelector('.walker-empty')
    if (emptyState === null) {
      emptyState = el('div', 'empty walker-empty')
      scene.appendChild(emptyState)
    }
    emptyState.textContent = state.phase === 'ready' ? '工位已经准备好，等待第一位同事入座。暂无员工，请确认节点已上报目录。' : '未连接，连接后就能迎接同事入座。'
    roomClockStart()
    return
  }
  var selected = null
  visible.forEach(function (employee) { if (String(employee.id || '') === roomView.selectedId) selected = employee })
  if (selected === null && roomView.selectedId === '') {
    visible.forEach(function (employee) { if (String(employee.id || '') === String(state.selectedEmployeeId || '')) selected = employee })
  }
  if (selected === null) {
    selected = visible[0]
    roomView.selectedId = String(selected.id || '')
    roomSetText('roomSelectedQuote', '点一下工位，听一句小心声。')
  } else roomView.selectedId = String(selected.id || '')
  visible.forEach(function (employee) { patchRoomWalker(roomView.nodes[String(employee.id || '')], employee) })
  roomSelectedRender(selected)
  roomWalkersBind(scene)
  roomClockStart()
}

function maybeRenderOfficeRoom() {
  if (state.view !== 'officeRoom') return
  renderOfficeRoom()
}

/** 自动天色每十分钟跟随一次本地时钟；手动选定天色后保留用户的观景选择。 */
function roomClockStart() {
  if (roomView.timer !== null || typeof setInterval !== 'function') return
  roomView.timer = setInterval(function () {
    if (state.view !== 'officeRoom') return
    roomLightRender()
    roomDateRender()
    roomStoryRender()
  }, 600000)
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', function () {
    if (state.view === 'officeRoom') renderOfficeRoom()
  })
}
`
