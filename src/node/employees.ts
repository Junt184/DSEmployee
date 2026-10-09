/**
 * 员工 = 工作区。本模块是这条等式在终端节点上的唯一实现。
 *
 * 落盘布局（每个员工一个目录）：
 *   <employeeRoot>/<slug>/
 *     .dsemployee/employee.json   员工身份与元数据（名字、岗位说明、preset）
 *     AGENTS.md                   岗位说明书 + 知识库 —— dsh 每次会话自动注入
 *     AGENTS.local.md             本机私有补充（可选，不入版本库）
 *     .dsh/skills/<技能>/SKILL.md  该员工专属技能（dsh 扫描 rank 100，优先级最高）
 *
 * 关键设计：**员工身份随目录走**。`employee.json` 存在工作区里，而不是只存在 Hub 或
 * 某个数据库里 —— 这样把工作区目录整个拷到另一台机器，员工的身份不变（Hub 侧会因为
 * id 冲突而告警，正好提示"这是同一个员工的两份拷贝"）。
 */

import path from 'node:path'
import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat, rm } from 'node:fs/promises'

import {
  ensureDir,
  isDirectory,
  isPathInside,
  newId,
  pathExists,
  readJsonFile,
  safeSlug,
  writeFileAtomic,
  writeJsonFile,
} from '../util/fsx.ts'
import type { DshClient } from './dsh-client.ts'
import { activeModelOf, readLlmFile } from './employee-llm.ts'
import { ensureFileDeliveryInstructions } from './file-delivery.ts'

/** `<工作区>/.dsemployee/employee.json` 的内容。 */
export interface EmployeeManifest {
  id: string
  name: string
  /** 这个员工做什么 —— 会展示在员工目录里，也写进 AGENTS.md */
  role: string
  /**
   * 岗位 id（指向 Hub 侧岗位目录 `positions.json` 的条目；缺省 = 通用）。
   *
   * **存 id 不存名称**：显示名只在目录里存一份，于是"给岗位改个名"只动一处、
   * 已绑定的员工不会失联；若这里存名称，改一次名全部员工断链，而且「渗透测试」与
   * 「渗透」会变成两个互不相干的岗位。
   *
   * 它**只影响界面与 AGENTS.md 文本**，绝不参与鉴权（权限仍在方法表/scope）——
   * 见 docs/06 的红线。当前阶段控制台还用不到它来渲染面板（那部分先不做）。
   */
  position?: string
  /** 初始提示词/身份补充（trim 后 1–500 字符）；非空时写进 AGENTS.md 的「设定」行 */
  intro?: string
  createdAtMs: number
  /** 会话创建时使用的 agent preset（工具集模板）；省略则用 dsh 的部署默认 */
  agentPreset?: string
  /** 分组/部门名，用于控制台工位视图分组；省略则归入「未分组」 */
  group?: string
}

/**
 * 带校验信息的技能清单条目（`employee.skills.list` 的返回元素）。
 *
 * dsh 对 frontmatter 不合规的技能是「告警 + 忽略」（fail-closed，docs/02 §12.2），
 * 用户从界面上需要一个「写了但没生效」的明确信号 —— 这就是 valid/issues 的用途。
 */
export interface DescribedSkill {
  /** 技能名（目录名，或平铺文件名去掉 .md 后缀） */
  name: string
  /** frontmatter 是否通过校验；false 表示 dsh 会忽略这个技能 */
  valid: boolean
  /** 人话问题清单；为空表示无问题 */
  issues: string[]
}

/** 从目录名 slug 得到的、用于 wire 的扁平形状。 */
export interface DiscoveredEmployee extends EmployeeManifest {
  /** 工作区绝对路径 */
  workspacePath: string
  /** 目录名（不等于 id；重命名目录不影响身份） */
  slug: string
  status: 'ok' | 'missing-dir'
  /** dsh 侧注册的 workspace id（若已注册） */
  workspaceId?: string
  /** 该员工专属技能（`<工作区>/.dsh/skills` 下的技能名） */
  skills: string[]
  /** 是否有自定义头像（`<工作区>/.dsemployee/avatar.*`）—— 控制台据此免探测 */
  hasAvatar: boolean
  /**
   * 头像的"版本"（文件 mtime + 字节数）—— 控制台**本地缓存**的失效依据。
   *
   * 为什么需要它：头像是几百 KB 的图，而控制台每次都把所有人的头像经 Hub 拉一遍
   * （实测 9 个员工 ≈ 4.2 MB base64/次，且每次刷新都重来），于是"点进去先是线稿，
   * 等一下才变成照片"。有了版本号，客户端就能"版本没变就不下载"，
   * 只在真的换了头像时才走一次网络。
   */
  avatarUpdatedAtMs?: number
  avatarBytes?: number
  /**
   * 工作区**自己**是不是 git 仓库（含 worktree/submodule 的 `.git` 文件形态）。
   *
   * dsh 的 `projectRoot` 由 `findProjectRoot()` 决定，它从 cwd 往上找第一个含 `.git`
   * 的祖先。工作区没有自己的 `.git` 时，projectRoot 落到外层仓库 ⇒ 私有技能根变成
   * `<外层>/.dsh/skills` ⇒ **工作区里的私有技能被静默忽略**（不报错、不告警）。
   * 上报这个布尔值，是为了让"写了技能却看不见"这件事在控制台上可见。
   */
  hasGitAnchor: boolean
  /**
   * 模型配置摘要（给 Hub 与控制台看的一行）：当前模型的别名 + 用到的端点库 id。
   *
   * 为什么随注册上报而不是让控制台逐个去问：控制台的「模型配置」页要显示
   * 每个员工"现在用哪个模型"，而逐个 `employee.llm.get` 意味着 12 次跨公网往返；
   * Hub 侧另有一件事需要它 —— "这个端点库条目还有谁在用"（删端点时要能点名），
   * 没有这份摘要就只能挨个问节点，或者维护一份注定会漂移的索引。
   */
  llmActiveName?: string
  llmEndpointIds?: string[]
}

const MANIFEST_DIR = '.dsemployee'
const MANIFEST_FILE = 'employee.json'
const SKILLS_DIR = path.join('.dsh', 'skills')

/** 头像允许的 MIME ↔ 扩展名（双向表，写入与读取共用一份真源）。 */
const AVATAR_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
}
const AVATAR_MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(AVATAR_EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
)
/** 头像大小上限：2MB（控制台内存缓存 + dataURL 内联展示的合理上限）。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/**
 * 单次上传给员工的文件大小上限。
 *
 * 与头像同一个量级，原因也一样：Hub 协议单帧上限 4 MiB（`MAX_FRAME_BYTES`），
 * 而 base64 会把字节数放大 4/3 —— 2 MiB 原文编码后约 2.7 MB，留足 JSON 与其它
 * 字段的余量。要突破它必须改成分片上传（分片、续传、临时文件回收），
 * 那是另一件事，不该由一个"顺手把文件递进去"的功能顺带承担。
 */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024

/** intro 上限：trim 后 500 字符（契约：1–500；null/空串 = 删除）。 */
export const INTRO_MAX_CHARS = 500

/** 归一化 intro：trim；空 → undefined（不落盘/删除）；超长 → 抛错。 */
function normalizeIntro(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > INTRO_MAX_CHARS) {
    throw new Error(`intro 超长：trim 后 ${trimmed.length} 字符，上限 ${INTRO_MAX_CHARS}`)
  }
  return trimmed
}

export class EmployeeStore {
  readonly root: string
  readonly #dsh: DshClient

  constructor(root: string, dsh: DshClient) {
    this.root = path.resolve(root)
    this.#dsh = dsh
  }

  /** 确保员工根目录存在。 */
  async init(): Promise<void> {
    await ensureDir(this.root)
  }

  /* ────────────────────────── 发现 ────────────────────────── */

  /**
   * 扫描员工根目录。
   *
   * 只认"含 `.dsemployee/employee.json`"的目录 —— 这样用户往根目录里随手丢的其他文件夹
   * 不会被误当成员工。损坏的 manifest 会让该员工以 `status: 'missing-dir'` 之外的
   * 方式被跳过，并汇总到返回值里，避免"静默消失"。
   */
  async discover(): Promise<{ employees: DiscoveredEmployee[]; warnings: string[] }> {
    const warnings: string[] = []
    const employees: DiscoveredEmployee[] = []

    if (!(await isDirectory(this.root))) {
      return { employees, warnings: [`employee root ${this.root} does not exist`] }
    }

    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const workspacePath = path.join(this.root, entry.name)
      const manifestPath = path.join(workspacePath, MANIFEST_DIR, MANIFEST_FILE)
      if (!(await pathExists(manifestPath))) continue

      let manifest: EmployeeManifest
      try {
        manifest = await readJsonFile<EmployeeManifest>(manifestPath, undefined as never)
        if (typeof manifest?.id !== 'string' || typeof manifest.name !== 'string') {
          throw new Error('missing id/name')
        }
      } catch (error) {
        warnings.push(
          `skipping ${entry.name}: invalid ${MANIFEST_FILE} (${error instanceof Error ? error.message : String(error)})`,
        )
        continue
      }

      const skills = await this.#discoverSkills(workspacePath)
      const avatar = await this.#avatarInfo(workspacePath)
      const llm = await readLlmFile(workspacePath)
      const activeModel = activeModelOf(llm)
      const endpointIds = Array.from(
        new Set((llm?.models ?? []).map((entry) => entry.endpointId).filter((id) => id !== '')),
      )
      employees.push({
        ...manifest,
        workspacePath,
        slug: entry.name,
        status: (await isDirectory(workspacePath)) ? 'ok' : 'missing-dir',
        skills,
        hasAvatar: avatar.hasAvatar,
        /* 版本号只在真有头像时带出（客户端据此判断本地缓存还能不能用） */
        ...(avatar.avatarUpdatedAtMs === undefined
          ? {}
          : { avatarUpdatedAtMs: avatar.avatarUpdatedAtMs, avatarBytes: avatar.avatarBytes ?? 0 }),
        hasGitAnchor: await pathExists(path.join(workspacePath, '.git')),
        ...(activeModel === undefined ? {} : { llmActiveName: activeModel.name }),
        ...(endpointIds.length === 0 ? {} : { llmEndpointIds: endpointIds }),
      })
    }

    employees.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return { employees, warnings }
  }

  /** 读取 `<工作区>/.dsh/skills` 下的技能名（目录 bundle 与平铺 md 两种形态都认）。 */
  async #discoverSkills(workspacePath: string): Promise<string[]> {
    const skillsRoot = path.join(workspacePath, SKILLS_DIR)
    if (!(await isDirectory(skillsRoot))) return []
    const names: string[] = []
    try {
      const entries = await readdir(skillsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (await pathExists(path.join(skillsRoot, entry.name, 'SKILL.md'))) {
            names.push(entry.name)
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          names.push(entry.name.slice(0, -3))
        }
      }
    } catch {
      /* 技能目录读不了不算致命 */
    }
    return names.sort()
  }

  /**
   * 带校验的技能清单：除名字外，还给出每个技能的 frontmatter 是否会被 dsh 接受。
   *
   * 与 `#discoverSkills` 并列存在 —— 后者只回名字，喂给上报目录（DiscoveredEmployee.skills）；
   * 本方法逐个解析 SKILL.md，单个文件再坏也只落进自己的 issues，绝不上抛炸掉整个清单。
   */
  async describeSkills(workspacePath: string): Promise<DescribedSkill[]> {
    const skillsRoot = path.join(workspacePath, SKILLS_DIR)
    if (!(await isDirectory(skillsRoot))) return []
    const files: Array<{ name: string; file: string }> = []
    try {
      const entries = await readdir(skillsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const file = path.join(skillsRoot, entry.name, 'SKILL.md')
          if (await pathExists(file)) files.push({ name: entry.name, file })
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push({ name: entry.name.slice(0, -3), file: path.join(skillsRoot, entry.name) })
        }
      }
    } catch {
      return [] // 与 #discoverSkills 一致：技能目录读不了不算致命
    }
    const described: DescribedSkill[] = []
    for (const { name, file } of files) {
      described.push(await describeSkillFile(name, file))
    }
    return described.sort((a, b) => a.name.localeCompare(b.name))
  }

  /* ────────────────────────── 创建 ────────────────────────── */

  async create(input: {
    name: string
    role: string
    slug?: string
    agentPreset?: string
    group?: string
    intro?: string
    /** 岗位 id（Hub 侧目录里的条目）；缺省即通用 */
    position?: string
  }): Promise<DiscoveredEmployee> {
    const slug = safeSlug(input.slug ?? input.name, `employee-${Date.now().toString(36)}`)
    const workspacePath = path.join(this.root, slug)

    if (await pathExists(workspacePath)) {
      throw new Error(`workspace directory already exists: ${workspacePath}`)
    }
    await ensureDir(workspacePath)
    await ensureDir(path.join(workspacePath, MANIFEST_DIR))
    await ensureDir(path.join(workspacePath, SKILLS_DIR))
    await this.#ensureGitAnchor(workspacePath)

    const intro = input.intro === undefined ? undefined : normalizeIntro(input.intro)
    const manifest: EmployeeManifest = {
      id: newId('emp'),
      name: input.name,
      role: input.role,
      createdAtMs: Date.now(),
      ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
      ...(input.group === undefined ? {} : { group: input.group }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(intro === undefined ? {} : { intro }),
    }
    await writeJsonFile(path.join(workspacePath, MANIFEST_DIR, MANIFEST_FILE), manifest, 0o600)

    // 岗位说明书：dsh 会把 AGENTS.md 作为持久指令注入每一次会话。
    // 因此这里写的就是"这个员工的岗位职责"，是"知识库"的起点。
    await writeFileAtomic(
      path.join(workspacePath, 'AGENTS.md'),
      renderAgentsMd(manifest),
      0o600,
    )
    await ensureFileDeliveryInstructions(workspacePath)

    // 在 dsh 里注册这个工作区，这样它才会出现在 dsh Web 的工作区列表里
    let workspaceId: string | undefined
    try {
      const created = await this.#dsh.workspaceCreate(workspacePath, input.name)
      workspaceId = created.workspaceId
    } catch (error) {
      // 注册失败不阻断创建：目录与身份已经就位，下次发现时会重试注册
      process.emitWarning(
        `employee created but dsh workspace registration failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    return {
      ...manifest,
      workspacePath,
      slug,
      status: 'ok',
      skills: [],
      hasAvatar: false,
      hasGitAnchor: await pathExists(path.join(workspacePath, '.git')),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
  }

  /**
   * 让新工作区成为 dsh 认可的「项目根」——`git init`。
   *
   * 为什么必须做：私有技能根是 `<projectRoot>/.dsh/skills`，而 projectRoot 由 dsh 的
   * `findProjectRoot()` 决定 —— 它从 cwd 往上找第一个含 `.git` 的祖先。工作区没有
   * 自己的 `.git` 时，projectRoot 落到**外层仓库**（例如本产品自己的仓库），于是
   * `<工作区>/.dsh/skills` 里的技能**一个都扫不到，且不报错**：员工照常工作，只是
   * 悄悄少了技能。而 `create()` 又会预先建好 `.dsh/skills` 目录 —— 等于邀请人往里写
   * 一个永远不会生效的技能。这是实测发现的真缺陷（4 个存量工作区都有 `.git`，
   * 因为它们是真实项目目录；而新建的空工作区没有）。
   *
   * 失败**不阻断创建**：机器上可能没有 git。代价是那个工作区的私有技能不生效，
   * 而这一点会在控制台「体检」里以"缺 .git 锚点"告警出现 —— 可见的降级，
   * 好过静默的失效。
   */
  async #ensureGitAnchor(workspacePath: string): Promise<void> {
    await new Promise<void>((resolve) => {
      execFile('git', ['init', '--quiet'], { cwd: workspacePath, timeout: 10_000 }, (error) => {
        if (error !== null) {
          process.emitWarning(
            `workspace ${workspacePath} has no .git anchor (git init failed: ${error.message}); ` +
              'dsh will look for private skills in an outer project root — 该员工的私有技能不会生效',
          )
        }
        resolve()
      })
    })
  }

  /** 确保某个已存在的员工工作区在 dsh 里注册过。返回 workspaceId。 */
  async ensureRegistered(employee: DiscoveredEmployee): Promise<string | undefined> {
    try {
      const listed = await this.#dsh.workspaceList()
      for (const raw of listed.items) {
        const item = raw as { workspaceId?: string; path?: string; title?: string }
        if (item.path !== undefined && path.resolve(item.path) === employee.workspacePath) {
          return item.workspaceId
        }
      }
      const created = await this.#dsh.workspaceCreate(employee.workspacePath, employee.name)
      return created.workspaceId
    } catch {
      return undefined
    }
  }

  /* ────────────────────────── 更新 / 移除 ────────────────────────── */

  async update(
    employeeId: string,
    patch: {
      name?: string
      role?: string
      agentPreset?: string | null
      group?: string | null
      intro?: string | null
      /** 岗位 id；null 表示回到通用 */
      position?: string | null
    },
  ): Promise<DiscoveredEmployee> {
    const found = await this.#find(employeeId)
    const manifestPath = path.join(found.workspacePath, MANIFEST_DIR, MANIFEST_FILE)
    const manifest = await readJsonFile<EmployeeManifest>(manifestPath, undefined as never)

    if (patch.name !== undefined) manifest.name = patch.name
    if (patch.role !== undefined) manifest.role = patch.role
    // null 表示「回到通用岗位」，与 group 的清除语义一致
    if (patch.position === null) delete manifest.position
    else if (patch.position !== undefined) manifest.position = patch.position
    if (patch.agentPreset === null) delete manifest.agentPreset
    else if (patch.agentPreset !== undefined) manifest.agentPreset = patch.agentPreset
    // null 表示「清除分组」（回到未分组），与 agentPreset 的写法一致
    if (patch.group === null) delete manifest.group
    else if (patch.group !== undefined) manifest.group = patch.group
    // intro：null 或 trim 后为空都表示「删除」，与 group 的 null 清除语义一致
    if (patch.intro === null) delete manifest.intro
    else if (patch.intro !== undefined) {
      const intro = normalizeIntro(patch.intro)
      if (intro === undefined) delete manifest.intro
      else manifest.intro = intro
    }

    await writeJsonFile(manifestPath, manifest, 0o600)

    // AGENTS.md 只在"是我们生成的"情况下才同步更新，避免覆盖用户自己的知识库内容
    const agentsMdPath = path.join(found.workspacePath, 'AGENTS.md')
    if (await this.#isGeneratedAgentsMd(agentsMdPath)) {
      await writeFileAtomic(agentsMdPath, renderAgentsMd(manifest), 0o600)
    }

    // delete 语义无法经 spread 表达：manifest 里被删的键不会盖掉 found 里的旧值，
    // 被清除的可选字段要在合并结果上显式删掉
    const merged: DiscoveredEmployee = { ...found, ...manifest, skills: found.skills }
    if (manifest.agentPreset === undefined) delete merged.agentPreset
    if (manifest.group === undefined) delete merged.group
    if (manifest.intro === undefined) delete merged.intro
    return merged
  }

  async #isGeneratedAgentsMd(file: string): Promise<boolean> {
    try {
      const text = await readFile(file, 'utf8')
      // 前缀匹配：新模板的标记行在 `DSEmployee` 后直接接接管说明（`：… -->`），
      // 旧模板是 `<!-- generated by DSEmployee -->`，两者都命中
      return text.includes('<!-- generated by DSEmployee')
    } catch {
      return false
    }
  }

  /**
   * 移除员工注册。
   *
   * 默认**只删身份文件**，保留目录与用户数据 —— 删除一个人积累的知识库是不可逆操作，
   * 不该由一次 API 调用顺手做掉。真要删目录必须显式传 `deleteFiles: true`，
   * 且仍然拒绝删除员工根本身。
   */
  async remove(employeeId: string, options: { deleteFiles?: boolean } = {}): Promise<{ removed: boolean }> {
    const found = await this.#find(employeeId)
    if (options.deleteFiles === true) {
      if (path.resolve(found.workspacePath) === this.root) {
        throw new Error('refusing to delete the employee root itself')
      }
      await rm(found.workspacePath, { recursive: true, force: true })
      return { removed: true }
    }
    await rm(path.join(found.workspacePath, MANIFEST_DIR), { recursive: true, force: true })
    return { removed: true }
  }

  /* ────────────────────────── 自定义头像 ──────────────────────────
   *
   * 存 `<工作区>/.dsemployee/avatar.<ext>`（原格式直存，不转码 —— 用户会用
   * 图像模型生成图来指派，转码只会丢保真度）。同一员工只留一个文件：
   * 换格式时先删旧文件，避免 avatar.png 与 avatar.webp 并存时"哪个生效"成谜。
   */

  /** 读头像。没有 → undefined；有 → 内容 + 元信息。 */
  async avatarGet(
    employeeId: string,
  ): Promise<{ mimeType: string; data: Buffer; size: number; updatedAtMs: number } | undefined> {
    const found = await this.#find(employeeId)
    const file = await this.#avatarPath(found.workspacePath)
    if (file === undefined) return undefined
    const info = await stat(file)
    return {
      mimeType: AVATAR_MIME_BY_EXT[path.extname(file).slice(1)] ?? 'application/octet-stream',
      data: await readFile(file),
      size: info.size,
      updatedAtMs: Math.round(info.mtimeMs),
    }
  }

  /** 写头像。mimeType 白名单与 2MB 上限在这里强制（网络入口的硬边界）。 */
  async avatarSet(
    employeeId: string,
    input: { mimeType: string; data: Buffer },
  ): Promise<{ size: number }> {
    const ext = AVATAR_EXT_BY_MIME[input.mimeType]
    if (ext === undefined) {
      throw new Error(`不支持的图片类型 ${input.mimeType}（只接受 png/webp/gif/jpeg）`)
    }
    if (input.data.length === 0) throw new Error('图片内容为空')
    if (input.data.length > AVATAR_MAX_BYTES) {
      throw new Error(`图片超过 ${AVATAR_MAX_BYTES / 1024 / 1024}MB 上限（${input.data.length} 字节）`)
    }
    const found = await this.#find(employeeId)
    const old = await this.#avatarPath(found.workspacePath)
    if (old !== undefined) await rm(old, { force: true })
    await writeFileAtomic(
      path.join(found.workspacePath, MANIFEST_DIR, `avatar.${ext}`),
      input.data,
      0o600,
    )
    return { size: input.data.length }
  }

  /** 删头像（幂等：没有也算成功 —— 调用方语义是"回到程序生成头像"）。 */
  async avatarRemove(employeeId: string): Promise<{ removed: boolean }> {
    const found = await this.#find(employeeId)
    const file = await this.#avatarPath(found.workspacePath)
    if (file === undefined) return { removed: false }
    await rm(file, { force: true })
    return { removed: true }
  }

  /** 找工作区里现存的 avatar 文件；没有 → undefined。 */
  async #avatarPath(workspacePath: string): Promise<string | undefined> {
    return (await this.#avatarInfo(workspacePath)).file
  }

  /**
   * 头像文件的路径 + 版本（`mtime` 与字节数）。**一次 stat 同时喂饱两件事**：
   * 「有没有头像」与「这一份是不是客户端手上那份」—— 别为版本号再加一次系统调用。
   */
  async #avatarInfo(
    workspacePath: string,
  ): Promise<{ file: undefined; hasAvatar: false; avatarUpdatedAtMs?: undefined; avatarBytes?: undefined } | { file: string; hasAvatar: true; avatarUpdatedAtMs: number; avatarBytes: number }> {
    for (const ext of Object.keys(AVATAR_MIME_BY_EXT)) {
      const file = path.join(workspacePath, MANIFEST_DIR, `avatar.${ext}`)
      if (!(await pathExists(file))) continue
      try {
        const info = await stat(file)
        return { file, hasAvatar: true, avatarUpdatedAtMs: Math.round(info.mtimeMs), avatarBytes: info.size }
      } catch {
        /* 探测与 stat 之间被删了：当作"没有头像"，别让一个可选装饰把整次上报打挂 */
        return { file, hasAvatar: true, avatarUpdatedAtMs: 0, avatarBytes: 0 }
      }
    }
    return { file: undefined, hasAvatar: false }
  }

  /* ────────────────────────── 知识库文件 ────────────────────────── */

  /**
   * 列出工作区内的文件（限定在员工工作区内，且不跟随符号链接逃逸）。
   *
   * 这是"知识库"的可视化入口：用户能看到员工到底读了哪些资料。
   */
  async listFiles(
    employeeId: string,
    relative = '.',
    options: { maxEntries?: number } = {},
  ): Promise<{ path: string; type: 'file' | 'dir'; size?: number }[]> {
    const found = await this.#find(employeeId)
    const target = this.#resolveInside(found, relative)
    const maxEntries = options.maxEntries ?? 500
    const entries = await readdir(target, { withFileTypes: true })
    const out: Array<{ path: string; type: 'file' | 'dir'; size?: number }> = []
    for (const entry of entries.slice(0, maxEntries)) {
      const abs = path.join(target, entry.name)
      const rel = path.relative(found.workspacePath, abs).split(path.sep).join('/')
      if (entry.isDirectory()) {
        out.push({ path: rel, type: 'dir' })
      } else if (entry.isFile()) {
        const info = await stat(abs).catch(() => undefined)
        out.push(info === undefined ? { path: rel, type: 'file' } : { path: rel, type: 'file', size: info.size })
      }
    }
    out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1))
    return out
  }

  async readFile(employeeId: string, relative: string): Promise<{ path: string; content: string; size: number }> {
    const found = await this.#find(employeeId)
    const target = this.#resolveInside(found, relative)
    const info = await stat(target)
    if (!info.isFile()) throw new Error(`${relative} is not a regular file`)
    const content = await readFile(target, 'utf8')
    return { path: relative, content, size: info.size }
  }

  async downloadFile(
    employeeId: string,
    relative: string,
  ): Promise<{ path: string; data: Buffer; size: number; mimeType: string }> {
    const found = await this.#find(employeeId)
    const target = await realpath(this.#resolveInside(found, relative))
    if (!isPathInside(await realpath(found.workspacePath), target)) {
      throw new Error(`path escapes the employee workspace: ${relative}`)
    }
    const info = await stat(target)
    if (!info.isFile()) throw new Error(`${relative} is not a regular file`)
    if (info.size > UPLOAD_MAX_BYTES) {
      throw new Error(`file is too large to download: ${info.size} bytes > ${UPLOAD_MAX_BYTES} bytes`)
    }
    const data = await readFile(target)
    if (data.length > UPLOAD_MAX_BYTES) {
      throw new Error(`file is too large to download: ${data.length} bytes > ${UPLOAD_MAX_BYTES} bytes`)
    }
    return { path: relative, data, size: data.length, mimeType: mimeTypeOf(relative) }
  }

  async writeFile(
    employeeId: string,
    relative: string,
    content: string,
  ): Promise<{ path: string; size: number }> {
    const found = await this.#find(employeeId)
    const target = this.#resolveInside(found, relative)
    await ensureDir(path.dirname(target))
    await writeFileAtomic(target, content, 0o600)
    return { path: relative, size: Buffer.byteLength(content, 'utf8') }
  }

  /**
   * 把**二进制**文件写进员工工作区 —— 控制台给员工"递材料"的唯一入口。
   *
   * 为什么必须落在工作区里而不是当附件塞进对话：dsh 的附件通道明确只收图片
   * （`dsh-attachment`：v1 接受 PNG/JPEG/WebP/GIF，"Generic files, audio, video …
   * require separate lifecycle and provider contracts"）。而员工真正要处理的是
   * Excel / PDF / 压缩包这类文件 —— 它们只有**落在工作区里**才能被员工自己的
   * bash / fs 工具读到。所以：任意文件走这里，图片另外还能内联进 prompt 让模型
   * 直接看见（见 agent.ts 的 session.prompt content 直通）。
   *
   * 大小上限（`UPLOAD_MAX_BYTES`）不是产品口味，是**载体硬约束**：Hub 协议单帧
   * 上限 4 MiB，base64 膨胀 4/3，再算 JSON 与其它字段 —— 2 MiB 是安全水位
   * （与头像上传同一个先例：`AVATAR_MAX_BYTES`）。
   */
  async uploadFile(
    employeeId: string,
    relative: string,
    data: Buffer,
  ): Promise<{ path: string; size: number }> {
    if (data.length === 0) throw new Error('refusing to write an empty file')
    if (data.length > UPLOAD_MAX_BYTES) {
      throw new Error(
        `file is too large: ${data.length} bytes > ${UPLOAD_MAX_BYTES} bytes ` +
          '(the hub relays uploads inside a single 4 MiB frame; larger files need another route)',
      )
    }
    const found = await this.#find(employeeId)
    const target = this.#resolveInside(found, relative)
    // 目录不存在就建（"递材料"不该因为少了 收件箱/ 而失败）
    await ensureDir(path.dirname(target))
    await writeFileAtomic(target, data, 0o600)
    return { path: relative, size: data.length }
  }

  /* ────────────────────────── 内部 ────────────────────────── */

  async #find(employeeId: string): Promise<DiscoveredEmployee> {
    const { employees } = await this.discover()
    const hit = employees.find((employee) => employee.id === employeeId)
    if (hit === undefined) throw new Error(`unknown employee "${employeeId}" on this node`)
    return hit
  }

  /**
   * 把相对路径解析到员工工作区内，越界即抛错。
   *
   * 这是**路径穿越的硬边界**：`../../etc/passwd`、绝对路径、`..` 段都会在这里被拒。
   * 注意 `isPathInside` 会先 `path.resolve` 再做带分隔符的前缀比较，因此
   * `/root/employee-evil` 不会被误判成在 `/root/employee` 之内。
   */
  #resolveInside(employee: DiscoveredEmployee, relative: string): string {
    if (path.isAbsolute(relative)) {
      throw new Error('absolute paths are not allowed')
    }
    const target = path.resolve(employee.workspacePath, relative)
    if (!isPathInside(employee.workspacePath, target)) {
      throw new Error(`path escapes the employee workspace: ${relative}`)
    }
    return target
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
}

function mimeTypeOf(relative: string): string {
  return MIME_BY_EXTENSION[path.extname(relative).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 生成岗位说明书 —— **刻意紧凑**：dsh 每轮会话都注入它，啰嗦就是白烧 token。
 * 标记行兼任「如何接管编辑」的说明（旧模板的页脚并入注释行，不占模型可见正文）。
 *
 * `<!-- generated by DSEmployee` 这个标记是刻意留下的：只要文件里还有它，
 * 我们就认为文件由本工具生成、可以安全地随元数据更新而重写；
 * 一旦用户手工编辑掉这个标记（或大幅改写），我们就再也不动它。
 */
function renderAgentsMd(manifest: EmployeeManifest): string {
  const intro = manifest.intro?.trim()
  const lines = [
    '<!-- generated by DSEmployee：手工编辑请删掉本行，工具将不再重写此文件 -->',
    `你是 **${manifest.name}**，数字员工。${manifest.role}`,
    ...(intro === undefined || intro === '' ? [] : [`设定：${intro}`]),
    '约定：产出放本目录；长期记忆写 memory/；专属技能在 .dsh/skills/（只对你生效）；不确定先问，不要猜。',
    '别用 heredoc（<<EOF），会卡死；多行脚本用 python3 -c 一行，或先写 .py 再跑。',
  ]
  return `${lines.join('\n')}\n`
}

/* ────────────────────── SKILL.md frontmatter 校验 ──────────────────────
 *
 * 规则对齐 dsh（docs/02 §12.2）：必填 name（kebab-case）与 description；
 * 旧驼峰键被 dsh 显式拒绝；布尔字段取值非法同样被拒。
 *
 * **刻意的简化**：不引 YAML 依赖 —— frontmatter 就是 `---` 包裹的扁平 `key: value`，
 * 本项目技能用到的字段（name/description/disable-model-invocation/user-invocable）
 * 都是标量，逐行正则解析足够。嵌套结构（如 metadata 的对象值）只认键、不解析值；
 * 真 YAML 的高级写法（锚点、多行串）会被当成普通行略过 —— 复杂的 frontmatter
 * 本就不该出现在技能文件里，这个清单的定位是「人话问题提示」，不是完整 YAML 校验器。
 */

/** dsh 显式拒绝的旧驼峰键 → 提示中给出的替代写法（docs/02 §12.2）。 */
const LEGACY_CAMEL_KEYS: Record<string, string> = {
  disableModelInvocation: 'disable-model-invocation',
  userInvocable: 'user-invocable',
  modelInvocable: 'disable-model-invocation（注意语义相反）',
}

/** 布尔字段（dsh 接受 true/false、1/0、yes/no、on/off，不区分大小写）。 */
const SKILL_BOOLEAN_KEYS = ['disable-model-invocation', 'user-invocable'] as const
const BOOLEAN_LITERAL = /^(?:true|false|1|0|yes|no|on|off)$/i

/** kebab-case：小写字母/数字，段间单短横线。 */
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/

type FrontmatterParse = { ok: true; fields: Record<string, string> } | { ok: false; error: string }

/** 逐行解析 `---` 包裹的扁平键值 frontmatter（简化规则见上方注释）。 */
function parseFlatFrontmatter(text: string): FrontmatterParse {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { ok: false, error: '缺少 frontmatter：文件须以 --- 开头' }
  }
  const fields: Record<string, string> = {}
  let closed = false
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim() === '---') {
      closed = true
      break
    }
    // 跳过空行、注释与缩进行（嵌套值/续行不属于扁平层）
    if (line.trim() === '' || line.trimStart().startsWith('#') || /^\s/.test(line)) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1] as string
    let value = (match[2] as string).trim()
    // 去掉成对引号（YAML 对标量就是这么解析的）
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  if (!closed) return { ok: false, error: 'frontmatter 未闭合：缺结束的 --- 行' }
  return { ok: true, fields }
}

/**
 * UTF-8 BOM 的成因说明。
 *
 * 为什么必须单独认它（真机事故 2026-09-24，员工「小满」）：
 *   · 本文件下面的 `parseFlatFrontmatter` 会**剥掉** BOM（`replace(/^\uFEFF/, '')`），
 *     所以平台自己的校验说"✅ 合规"；
 *   · 而 **dsh 的 provider 不剥 BOM** —— 它看到 `\uFEFF---`，判定"没有 frontmatter"，
 *     整个技能被忽略（`skill file … ignored: missing YAML frontmatter`）。
 *   两边判定不一致的后果最难受：控制台显示合规、dsh 一声不响地不用它，
 *   表现为"员工莫名其妙变笨"，而且查不出原因。
 *
 * 解决方式是把平台这边**对齐到更严的那一边**：BOM 也算不合格并点名原因
 * （不是"帮它剥掉"—— 剥掉只会让控制台继续撒谎，dsh 仍然忽略）。正文不用动，去掉
 * 开头那 3 个字节即可。
 */
export const SKILL_BOM_ISSUE =
  '文件开头有 UTF-8 BOM（\\uFEFF）：dsh 的解析器不剥 BOM，会把这个技能整个忽略；' +
  '去掉开头 3 个字节（EF BB BF）即可，frontmatter 与正文都不用改'

/** 按 dsh 规则校验扁平 frontmatter，返回人话问题清单（空 = 合规）。 */
function validateSkillFields(fields: Record<string, string>): string[] {
  const issues: string[] = []
  for (const [legacy, replacement] of Object.entries(LEGACY_CAMEL_KEYS)) {
    if (legacy in fields) {
      issues.push(`字段 "${legacy}" 是旧驼峰写法，dsh 会拒绝整个技能；请改用 "${replacement}"`)
    }
  }
  const name = fields['name']?.trim()
  if (name === undefined || name === '') {
    issues.push('缺少必填字段 name')
  } else if (!KEBAB_CASE.test(name)) {
    issues.push(`name "${name}" 不是 kebab-case（dsh 只接受小写字母/数字/短横线）`)
  }
  const description = fields['description']?.trim()
  if (description === undefined || description === '') {
    issues.push('缺少必填字段 description')
  }
  for (const key of SKILL_BOOLEAN_KEYS) {
    const value = fields[key]?.trim()
    if (value !== undefined && !BOOLEAN_LITERAL.test(value)) {
      issues.push(
        `字段 "${key}" 的值 "${value}" 不是合法布尔（dsh 接受 true/false、1/0、yes/no、on/off）`,
      )
    }
  }
  return issues
}

/**
 * 解析并校验单个技能文件。读文件失败（乱码/无权限/不是常规文件）也落进 issues，
 * 绝不上抛 —— 一个坏文件不该炸掉整个技能清单。
 */
async function describeSkillFile(name: string, file: string): Promise<DescribedSkill> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return {
      name,
      valid: false,
      issues: [
        `无法读取技能文件：${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
  /* BOM 先判：它会同时骗过下面的解析器（那个会剥 BOM）与用户（控制台显示合规）。
     判完继续往下解析，好让"除了 BOM 还有别的问题"也一次说全。 */
  const bomIssues = text.startsWith('\uFEFF') ? [SKILL_BOM_ISSUE] : []
  const parsed = parseFlatFrontmatter(text)
  if (!parsed.ok) return { name, valid: false, issues: [...bomIssues, parsed.error] }
  const issues = [...bomIssues, ...validateSkillFields(parsed.fields)]
  return { name, valid: issues.length === 0, issues }
}
