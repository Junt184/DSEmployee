/**
 * 控制台脚本片段：新建员工辅助（随机昵称、节点选择）
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
export const CHUNK_40_PAGES = String.raw`
/* ─────────────────── 9.5 新建员工：随机昵称 ───────────────────
 *
 * 单人自用场景里"给新员工起名"是高频低价值的决策点 —— 表单展开时自动填一个
 * 可爱的女性昵称，不满意点「换一个」，用户自己填的永远优先。
 * 抽取用 Math.random（无安全需求），但避开现有员工名（重名会让办公区混淆）。
 */
var EMPLOYEE_NAME_POOL = [
  /* 叠字 */
  '桃桃', '朵朵', '念念', '糖糖', '果果', '米米', '豆豆', '萌萌', '甜甜', '暖暖',
  '安安', '宁宁', '悠悠', '然然', '夏夏', '晴晴', '溪溪', '沐沐', '橙橙', '柚柚',
  '梨梨', '杏杏', '荔荔', '莓莓', '椰椰', '麦麦', '苗苗', '芽芽', '棉棉', '糯糯',
  '圆圆', '团团', '柔柔', '蜜蜜', '泡泡', '叮叮', '当当', '可可', '乐乐', '笑笑',
  /* 小字辈 */
  '小满', '小葵', '小桃', '小杏', '小梨', '小柚', '小橙', '小橘', '小荔', '小莓',
  '小椰', '小柠', '小檬', '小棠', '小栀', '小荷', '小芦', '小蒲', '小苔', '小芙',
  '小樱', '小棉', '小糯', '小粟', '小麦', '小豆', '小米', '小甜', '小暖', '小安',
  '小宁', '小悠', '小然', '小夏', '小晴', '小溪', '小沐', '小云', '小月', '小星',
  /* 自然系 */
  '知夏', '晚晴', '初夏', '半夏', '立夏', '白露', '谷雨', '小雪', '青禾', '白桃',
  '青提', '红柚', '青梅', '紫苏', '薄荷', '茉莉', '栀子', '海棠', '丁香', '木棉',
  '风信', '雨眠', '云舒', '溪云', '汀兰', '汀白', '浅夏', '沐晴', '暖阳', '微风',
  '晨露', '朝颜', '晚霞', '春水', '秋梨', '冬枣', '山桃', '野樱', '溪桃', '望舒',
  /* 食物系 */
  '桃酥', '杏子', '栗子', '柚子', '橙子', '布丁', '糯米', '芋圆', '奶盖', '西米',
  '可颂', '麻薯', '青团', '豆花', '花卷', '糖霜', '奶冻', '泡芙', '曲奇', '蛋挞',
  '松饼', '雪媚', '绵绵', '冰糖', '蜜豆', '椰果', '桂圆', '莲雾', '杨桃', '石榴',
  '樱桃', '蓝莓', '草莓', '树莓', '蜜桃', '甜橙', '香梨', '脆柿', '蜜柚', '金桔',
  /* 叠字与其他 */
  '一一', '七七', '九九', '元元', '岁岁', '年年', '朝朝', '暮暮', '多多', '满满',
  '盈盈', '灿灿', '星星', '啾啾', '嘟嘟', '滚滚', '阿梨', '阿桃', '阿杏', '阿柚',
  '阿棠', '阿柠', '阿樱', '阿禾', '阿恬', '阿暖', '囡囡', '妞妞', '丫丫', '妙妙',
  '灵灵', '俏俏', '婉婉', '楚楚', '陶陶', '莞莞', '茸茸', '软软', '晶晶', '栗栗'
]

/** 可用池 = 名字池 − 现有员工名，从可用池里均匀随机；抽空时退回「昵称+两位序号」。 */
function randomEmployeeName() {
  var existing = {}
  state.employees.forEach(function (employee) {
    existing[String(employee.name || '')] = true
  })
  var available = EMPLOYEE_NAME_POOL.filter(function (name) {
    return existing[name] !== true
  })
  if (available.length === 0) {
    return EMPLOYEE_NAME_POOL[Math.floor(Math.random() * EMPLOYEE_NAME_POOL.length)] + String(Math.floor(Math.random() * 90) + 10)
  }
  return available[Math.floor(Math.random() * available.length)]
}

/** 表单展开时的自动填充：用户手动改过名字就不冲掉（手动输入永远优先）。 */
function autofillCreateName() {
  var input = $('createName')
  if (input === null) return
  if (state.createNameTouched === true && String(input.value || '').trim() !== '') return
  input.value = randomEmployeeName()
  state.createNameTouched = false
}

/** 新建员工表单里的节点下拉：node.list 只需 employee.read，失败时留提示不阻塞页面。 */
function loadNodeOptions() {
  var select = $('createNode')
  if (select === null || state.phase !== 'ready') return
  rpc('node.list', {})
    .then(function (payload) {
      var nodes = pickArray(payload, ['nodes', 'items', 'list'])
      clear(select)
      if (nodes.length === 0) {
        select.appendChild(el('option', '', '（暂无在线节点）'))
        renderCreatePreview()
        return
      }
      nodes.forEach(function (node) {
        var option = el('option', '', String(node.name || node.nodeId || '?') + (node.online === false ? '（离线）' : ''))
        option.value = String(node.nodeId || '')
        select.appendChild(option)
      })
      renderCreatePreview()
    })
    .catch(function (error) {
      reportRpcError('node.list', error)
    })
}

/* ─────────────────── 体检 ─────────────────── */

/**
 * 体检：把三类「不报错的分叉」摆到台面上。
 *
 *   1. 控制台脚本指纹 vs 服务端印在页面上的指纹 —— 不一致 = 本页跑的是被缓存冻住的
 *      旧脚本（手机上"和电脑不一样"的经典成因，见 docs/05 §13.5）；
 *   2. Hub 与各节点的**代码指纹** —— 不一致 = 那台机器跑的是旧代码。节点是手动升级的，
 *      跑旧代码时界面上一模一样（照常在线、照常列员工），只有这个字段能戳破它；
 *   3. 员工工作区缺 .git 锚点 —— dsh 的 projectRoot 会落到外层仓库，该员工写在
 *      .dsh/skills 里的私有技能**被静默忽略**（写了也不生效）。
 *
 * 数据来源：node.list（Hub 现算的版本比对）+ 本地已缓存的员工目录（employee.list）。
 * 只在卡片展开时拉取，不给后端添常态负担。
 *
 * 注意：本段是 CONTROL_UI_SCRIPT 模板的一部分，**注释里也不能出现反引号或美元花括号**
 * —— 它们会提前终止 String.raw 模板（这里真踩过：tsc 报的是 "',' expected" +
 * 一大段源码，很难一眼看出是注释里的反引号干的）。
 */
/* ─────────────────── 定时任务 ───────────────────
 *
 * 语义与 Hub 侧严格对齐（见 src/hub/scheduler.ts）：
 *   · 只显示**派发结果**（已送出 / 排队中 / 失败），不冒充"任务成功"—— Hub 不解析
 *     会话事件，员工的回复在被调员工的会话里，这里不编造。
 *   · 停用如实显示原因（自动停用会说"连续失败 N 次"），不做静默停用。
 *   · 「立即运行」不动时间表：否则"点一下试试"会把节奏整体推后，用户以为改了间隔。
 */

/** 间隔的人话：优先"分钟"，够整就升到小时/天。 */`
