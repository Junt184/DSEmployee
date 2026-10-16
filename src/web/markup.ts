/**
 * 控制台的页面标记（`<body>` 到 `</body>`，含视图容器与右栏）。
 *
 * 为什么单独一个文件：它原来是 ui.ts 那个大模板字面量的一部分（329 行），
 * 而 ui.ts 同时装着组装、标记与样式。改标记（加一个视图、改一处文案）与
 * 改脚本片段、改样式现在各占一个文件。
 *
 * 为什么是函数而不是常量：它**需要 5 处插值**（引导配置的 hubId/hubName、界面指纹、
 * 脚本标签）—— 这些值由服务端在渲染时决定。参数用对象传，就是为了让"这个页面依赖
 * 哪几个注入值"一眼可见，而不是散在模板里。
 *
 * 注意：**不是** `String.raw`，是普通模板字面量（要的就是插值）。
 */
export interface ControlUiMarkupParts {
  /** 引导配置：Hub id（写进 [data-hub-id]，由脚本读走） */
  bootHubId: string
  /** 引导配置：Hub 名 */
  bootHubName: string
  /** 服务端算出的界面指纹（印在页面上，用来发现"你跑的是旧脚本"） */
  uiVersion: string
  /** `<script>` 标签（外链带版本号）/ 或内联脚本 */
  scriptTag: string
  /**
   * 新设备的进门方式（`store.ts` 的 `pairingApproval`，缺省 `code-only`）。
   *
   * 为什么页面上要这份：授权页给未配对设备看，而**未配对设备读不到任何需要权限的
   * 接口**（`pairing.approval` 要 `device.pair`）。所以只能由服务端在交付页面时就写进
   * boot 里 —— 否则页面会继续宣传一条服务端已经拒绝的路（"去另一台设备批准"）。
   */
  pairingApproval?: 'code-only' | 'operator'
}

export function renderControlBody(parts: ControlUiMarkupParts): string {
  return `<body>
<!-- 进门方式也由服务端注入：授权页要据此决定"人工批准"那条路能不能走
     （只认配对码时它是**被服务端拒绝**的，画出来就是骗人点）。 -->
<div id="dse-boot" class="hidden" data-hub-id="${parts.bootHubId}" data-hub-name="${parts.bootHubName}" data-pairing-approval="${parts.pairingApproval ?? ''}"></div>

<div id="banner" class="banner hidden"></div>

<!-- 全屏授权页：未配对（或认证类致命错误）时盖住主区域，是本产品的「登录页」 -->
<div id="authGate" class="auth-gate hidden">
  <div class="auth-card">
    <h1>这是 Hub「<span id="authHubName"></span>」</h1>
    <div class="muted">地址 <span id="authHubAddr"></span> · 本设备尚未授权
      <span class="ui-version" data-ui-version data-server-version="${parts.uiVersion}">脚本版本未知（多半缓存了旧脚本）</span>
    </div>

    <div id="authNoCrypto" class="warn auth-note hidden">
      当前页面不是安全上下文（非 https / localhost），浏览器不提供 WebCrypto，
      无法生成设备密钥。请改用 https://（TLS 反代）或 Tailscale 等隧道访问。
    </div>

    <div id="authPairArea">
      <div class="auth-step">方式一：输入配对码</div>
      <div class="muted">配对码显示在 Hub 服务器或任一终端节点的屏幕上（在终端执行 <code>dse pair-code --hub &lt;Hub地址&gt;</code> 生成，10 分钟内有效）。</div>
      <div class="row auth-code-row">
        <input id="pairCodeInput" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位配对码">
        <button id="btnRedeem" class="primary">使用配对码授权</button>
      </div>
      <div class="auth-error" id="authError"></div>

      <div id="authApprovePath">
        <div class="auth-step">方式二：在另一台已授权设备上批准</div>
        <div class="muted">
          本设备的配对请求 ID：<code id="authRequestId">…</code><br>
          在已授权控制台的「设备」卡片里批准它即可 —— 本页每 3 秒自动重试，批准后自动进入。
        </div>
      </div>
      <!-- 只认配对码时用它换掉方式二：那条路服务端会拒，留着就是让人白点一次。 -->
      <div id="authCodeOnlyNote" class="muted hidden">
        这台 Hub 现在是「只认配对码」：人工批准已关闭。请让已授权的设备在控制台
        「设备」页打开「允许新设备注册」，然后用上面的配对码授权。
      </div>
      <div class="row">
        <button id="btnRepair" class="ghost">清除本地令牌并重新配对</button>
      </div>
    </div>
  </div>
</div>

<main class="grid">
  <!-- 一级视图标签。顺序按"多久看一次"排：办公区（天天看）→ 审批 / 设备 / 体检（遇事才看）
       → 模型配置（配一次）。每个 data-view 必须在脚本的 VIEW_IDS 里有容器，
       反过来 VIEW_IDS 里的非 chat 视图也都得在这里有个按钮 —— 两边都会静默失效
       （点了没反应 / 页面切过去了但永远空白），所以有测试逐项对。 -->
  <div class="tabs" id="viewTabs">
    <button class="tab" data-view="projects">项目与任务</button>
    <button class="tab active" data-view="office">办公区</button>
    <!-- 办公室：观赏性的一页（谁在、谁在忙、点一下去找谁）。它排在办公区后面而不是取代它 ——
         办公区是每天要用的工作台，办公室是看的那一页，两者共用同一份员工与状态数据。
         对外叫「全景」而不是「办公室」：两个"办公×"的标签挨在一起，用户点之前分不清
         哪个是干活的、哪个是看的；「全景」说的是这页唯一的价值 —— 一眼看全。 -->
    <button class="tab" data-view="officeRoom">全景</button>
    <button class="tab" data-view="approvals">审批 <span class="chip" id="approvalCount"></span></button>
    <button class="tab" data-view="jobs">定时 <span class="chip" id="jobChip"></span></button>
    <button class="tab hidden" data-view="devices" id="tabDevices">设备</button>
    <button class="tab" data-view="health">体检 <span class="chip" id="healthChip"></span></button>
    <button class="tab" data-view="llm">员工配置</button>
  </div>

  <section class="col project-workspace hidden" id="viewProjects">
    <div class="project-heading"><div><h2>项目与任务</h2><p class="muted">打开电脑上的已有目录，直接开始工作。</p></div><button id="btnProjectRefresh" class="ghost">刷新</button></div>
    <details class="card project-open" id="projectOpenPanel" open>
      <summary>打开已有目录</summary>
      <form id="projectOpenForm" class="project-open-form">
        <label>执行节点<select id="projectNode" required aria-label="执行节点"></select></label>
        <div class="project-path-field"><span class="muted">节点上的目录</span><span id="projectChosenDirectory" class="project-chosen-directory">点击“打开目录”选择文件夹</span></div>
        <button id="btnProjectOpen" type="submit" class="primary">打开目录…</button>
      </form>
      <p class="muted">目录必须已经存在于所选节点上；不会搬动文件或覆盖项目规则。</p>
    </details>
    <p id="projectNotice" class="project-notice muted" role="status" aria-live="polite"></p>
    <div class="project-grid">
      <aside class="card project-navigation">
        <details open><summary>最近项目</summary><div id="projectList" class="project-list"></div></details>
        <div class="project-task-heading"><strong>项目会话</strong><button id="btnProjectNewTask" class="ghost">新任务</button></div>
        <label class="project-archive-filter"><input id="projectShowArchived" type="checkbox">显示已归档</label>
        <div id="projectSessions" class="project-list"></div>
      </aside>
      <section class="card project-conversation" aria-label="项目对话">
        <div class="project-conversation-heading"><div><h3 id="projectTaskTitle">选择项目开始工作</h3><div id="projectEnvironment" class="muted project-environment"></div><div id="projectTurnState" class="muted" role="status"></div></div><div class="project-actions"><button id="btnProjectRename" class="ghost">改名</button><button id="btnProjectArchive" class="ghost">归档</button><button id="btnProjectCancel" class="ghost hidden">停止</button></div></div>
        <div id="projectMessages" class="project-messages" aria-label="项目消息"></div>
        <button id="btnProjectLatest" class="ghost hidden">回到最新</button>
        <div class="project-composer">
          <div class="project-task-options"><label>新任务执行者<select id="projectEmployee" aria-label="新任务执行者" aria-describedby="projectEmployeeHint"><option value="">通用助手（节点默认模型）</option></select></label><label>新任务名称<input id="projectTaskName" maxlength="200" placeholder="可选，留空也能直接开始"></label></div>
          <p id="projectEmployeeHint" class="muted" role="status">先打开项目，执行者将按项目所在节点显示。</p>
          <label for="projectPrompt">任务指令</label><textarea id="projectPrompt" rows="3" placeholder="描述要做的事；提到的相对文件路径以当前项目为准。"></textarea>
          <div class="project-composer-actions"><span class="muted">执行者用于新任务；已有会话保留原来的目录和执行者。</span><button id="btnProjectSend" class="primary">发送</button></div>
        </div>
      </section>
    </div>
  </section>

  <section class="col" id="viewOffice">
    <section class="card">
      <h2>办公区
        <span class="h2-actions">
          <button id="btnReloadEmployees" class="ghost">刷新</button>
          <button id="btnOrderMode" class="ghost">排序</button>
          <button id="btnDensity" class="ghost">紧凑</button>
          <button id="btnDisconnect" class="ghost" disabled>断开</button>
          <button id="btnNotify" class="ghost">桌面通知</button>
          <button id="btnPushOn" class="ghost" title="手机通知：添加到主屏幕后即使应用关着也能收到（Web Push）">手机通知</button>
          <button id="btnPushTest" class="ghost" title="发一条测试通知，确认手机到底响不响">测试推送</button>
          <button id="btnTheme" class="ghost">🌙 夜间</button>
        </span>
      </h2>
      <div class="muted">每个分组是一个办公区；点工位上的同事即可开始对话。
        <span class="ui-version" data-ui-version data-server-version="${parts.uiVersion}">脚本版本未知（多半缓存了旧脚本）</span>
      </div>
      <div id="officeFloor"></div>
    </section>

    <details class="card create-card" id="cardCreate">
      <summary>
        <span class="create-summary-title">新建一个数字员工</span>
        <span class="create-summary-note">把一位新同事放进办公区</span>
      </summary>
      <div class="create-workspace">
        <section class="create-preview-panel" aria-label="新工位预览">
          <div class="create-kicker">新工位预览</div>
          <div id="createPreview"></div>
          <div class="create-preview-help">创建后可以在工位上换头像、编辑分组和职责。</div>
        </section>
        <div class="create-form">
          <section class="create-section">
            <h3>① 基本资料</h3>
            <div class="create-field-grid">
              <label class="create-field create-field-name" for="createName">
                <span class="create-label">员工名字</span>
                <span class="create-control-line">
                  <input id="createName" type="text" placeholder="例如：小艾" autocomplete="off">
                  <button id="btnAnotherName" class="ghost" type="button" title="随机换个名字">换一个</button>
                </span>
                <span class="create-help">这个名字会显示在办公区的工位上。</span>
              </label>
              <label class="create-field" for="createRole">
                <span class="create-label">岗位说明</span>
                <input id="createRole" type="text" placeholder="例如：负责周报整理、数据核对" autocomplete="off">
                <span class="create-help">一句话描述他主要负责什么。</span>
              </label>
            </div>
          </section>

          <section class="create-section">
            <h3>② 办公位置</h3>
            <div class="create-field-grid create-location-grid">
              <label class="create-field">
                <span class="create-label">办公区</span>
                <span id="createGroupSlot"></span>
                <span class="create-help">决定他出现在办公区的哪个分组。</span>
              </label>
              <label class="create-field">
                <span class="create-label">岗位</span>
                <span id="createPositionSlot"></span>
                <span class="create-help">决定他的工作面板；可在下拉中新增。</span>
              </label>
              <label class="create-field create-field-node">
                <span class="create-label">运行节点</span>
                <select id="createNode"></select>
                <span class="create-help">员工会在这台设备上运行。</span>
              </label>
            </div>
          </section>

          <section class="create-section">
            <h3>③ 同事设定</h3>
            <label class="create-field" for="createIntro">
              <span class="create-label">初始提示词</span>
              <textarea id="createIntro" rows="3" maxlength="500" placeholder="例如：你是小艾，负责整理周报与数据核对。说话简洁，发现异常时主动提醒我。"></textarea>
              <span class="create-help">每次开始新会话时，都会把这段设定告诉员工。</span>
            </label>
          </section>

          <div class="create-actions">
            <span class="muted">需要 employee.manage scope</span>
            <span class="create-action-buttons">
              <button id="btnCancelCreateEmployee" class="ghost" type="button">取消</button>
              <button id="btnCreateEmployee" class="primary" type="button">创建员工</button>
            </span>
          </div>
        </div>
      </div>
    </details>

    <!-- 岗位管理：目录是共享数据，管它的入口也该是一个地方（而不是散在每次新建里）。
         默认收起；点开时自动拉最新目录。 -->
    <details class="card" id="cardPositions">
      <summary>岗位 <span class="chip" id="positionCount"></span></summary>
      <div class="muted">
        岗位决定员工的界面（当前只影响工位徽章与下一步的面板）。员工身份里存的是岗位 <b>id</b>，
        所以改名不会断开绑定；删除会把仍绑着它的员工改回「通用」。
      </div>
      <div class="row">
        <input id="newPositionName" type="text" maxlength="32" placeholder="新岗位名（如：DSC平台运营）">
        <button id="btnAddPosition" class="primary">新增</button>
        <button id="btnReloadPositions" class="ghost">刷新</button>
      </div>
      <div id="positionAdminList"></div>
    </details>

    <section class="card token-card hidden" id="cardToken"></section>

    <details class="card debug hidden" id="cardDebug">
      <summary>原始事件（调试）</summary>
      <div class="muted">
        本面板只在 URL 带 <code>?debug=1</code> 时出现。
        节点侧的会话事件形状尚未定稿，这里保留全部原始帧以便对照。
      </div>
      <div class="raw-log" id="rawLog"></div>
    </details>
  </section>

  <!-- 微缩办公室：矢量布景与真实员工共用同一套坐标，每间六个工位，增加员工时扩展工作室。
       场景彩蛋与每日剧场只在浏览器里演出；员工状态、未读与真实对话入口仍来自办公区。 -->
  <section class="col hidden" id="viewOfficeRoom">
    <section class="room-card">
      <header class="room-page-heading">
        <div>
          <span class="room-eyebrow"><span></span> LITTLE OFFICE, BIG IDEAS</span>
          <h2>小办公室<span>把日常，过得有趣一点。</span></h2>
          <p>来逛一圈，和同事打个招呼，或者给今天加一点小插曲。</p>
        </div>
        <div class="room-calendar"><span class="room-calendar-icon" aria-hidden="true">☀</span><div><strong id="roomDayLabel">今天，也一起上班</strong><span>一个属于你们的小世界</span></div></div>
      </header>
      <div class="room-layout">
        <div class="room-stage-column">
          <div class="room-scene-card">
            <div class="room-toolbar">
              <div class="room-studio-title"><span class="room-studio-dot"></span><h3 id="roomStudioName">01 号工作室</h3><span>微缩日常</span></div>
              <div class="room-pagination"><button id="roomPrevPage" type="button" aria-label="上一间工作室">←</button><span id="roomPageLabel">01 / 01</span><button id="roomNextPage" type="button" aria-label="下一间工作室">→</button></div>
              <div class="room-light-switch" role="group" aria-label="办公室光线">
                <button type="button" data-room-light="day" aria-pressed="true" title="切换日光">日光</button>
                <button type="button" data-room-light="dusk" aria-pressed="false" title="切换落日">落日</button>
                <button type="button" data-room-light="night" aria-pressed="false" title="切换夜晚">夜晚</button>
              </div>
            </div>
          <div class="room-playbar"><div><strong>给日常加点戏</strong><span>随手点点，会有小惊喜</span></div><div class="room-play-actions"><button type="button" data-room-action="coffee"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 8h10v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8Zm10 1h2a2 2 0 0 1 0 4h-2M3 18h13M7 5c-2-2 2-2 0-4m4 4c-2-2 2-2 0-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>送杯咖啡</button><button type="button" data-room-action="plane"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m2 8 16-6-6 16-3-7-7-3Zm7 3 9-9m-9 9v5l3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>纸飞机</button><button type="button" data-room-action="plant"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 14V8m0 3C3 12 2 6 3 4c5-1 7 3 7 7Zm0-3c0-6 5-7 7-6 1 5-2 7-7 6ZM6 14h8l-1 5H7l-1-5Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>碰碰绿植</button><button class="room-motion-toggle" type="button" data-room-ambience aria-pressed="false" title="暂停场景里的装饰动画"><span id="roomMotionLabel">暂停小动作</span></button></div></div>
            <div class="room room-diorama" id="roomRoom" data-daypart="day" role="group" aria-label="微缩办公室：点同事听一句话，双击进入对话；增加员工时可切换工作室">
              <span class="room-scene-caption" aria-hidden="true">a good day<br><i>starts here.</i></span>
              <svg class="room-office-art" viewBox="0 0 1000 720" fill="none" aria-hidden="true">
                <defs>
                  <linearGradient id="roomArtWindow" x1="0" y1="0" x2="0.7" y2="1"><stop class="office-sky-top" stop-color="#b8dedd"/><stop class="office-sky-bottom" offset="1" stop-color="#f3ead6"/></linearGradient>
                  <linearGradient id="roomArtFloor" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#eee0c4"/><stop offset="1" stop-color="#d9c6a2"/></linearGradient>
                  <linearGradient id="roomArtWall" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#e4e9d9"/><stop offset="1" stop-color="#f9f5e7"/></linearGradient>
                  <linearGradient id="roomArtSunbeam" x1="0" y1="0" x2="0.7" y2="1"><stop stop-color="#fff8d3" stop-opacity=".62"/><stop offset="1" stop-color="#fff8d3" stop-opacity="0"/></linearGradient>
                  <filter id="roomArtSoftShadow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="13"/></filter>
                  <g id="roomArtLeaf"><path d="M0 0C-32-1-41-27-33-36C-17-43 2-21 0 0Z" fill="#71947c"/><path d="M-1-1C4-35 30-49 40-38C50-20 24-3-1-1Z" fill="#90ae8a"/><path d="M0 0C-6-43 7-64 19-58C33-48 18-16 0 0Z" fill="#4f7c63"/></g>
                </defs>
                <ellipse cx="505" cy="606" rx="390" ry="55" fill="#63756a" opacity=".14" filter="url(#roomArtSoftShadow)"/>
                <path d="M50 422 500 207 950 422 500 668Z" fill="#b7bda8"/>
                <path d="M50 402 500 187 950 402 500 648Z" fill="url(#roomArtFloor)"/>
                <path d="M50 402 500 648V668L50 422Z" fill="#c5b592"/><path d="m500 648 450-246v20L500 668Z" fill="#a99f82"/>
                <g stroke="#bca984" stroke-opacity=".26" stroke-width="1.6">
                  <path d="m125 366 450 241m-375-277 450 236m-375-272 450 232m-375-268 450 226m-375-262 450 223"/>
                  <path d="M125 443 575 223M200 484 650 259M275 525 725 295M350 566 800 331M425 607 875 367"/>
                </g>
                <path d="M50 402V227L500 12v175Z" fill="url(#roomArtWall)"/><path d="M500 12 950 227v175L500 187Z" fill="#d9e1cc"/>
                <path d="M50 227 500 12 950 227" stroke="#fdfbf2" stroke-width="12" stroke-linejoin="round"/>
                <path d="M50 395 500 180 950 395" stroke="#b9c5ad" stroke-width="9"/>
                <!-- 左侧连续落地窗与窗外剪影 -->
                <g transform="matrix(1 -.478 0 1 95 233)">
                  <rect width="325" height="128" rx="4" fill="#9eafa4"/><rect x="6" y="5" width="313" height="116" rx="2" fill="url(#roomArtWindow)"/>
                  <circle class="office-window-sun" cx="241" cy="38" r="22" fill="#fff6cd"/>
                  <path d="M6 109V82h32V69h35v25h26V77h39v32h26V87h34v22h33V71h36v38h52v12H6Z" fill="#9cbdb1" opacity=".45"/>
                  <path d="M82 5v116M162 5v116M242 5v116M6 76h313" stroke="#f8f9ea" stroke-width="7"/>
                  <path d="M-7 127h339v9H-7Z" fill="#bac7b1"/>
                  <path d="M12 10h29L13 114H6V32Z" fill="#fff" opacity=".18"/>
                </g>
                <path class="office-sunbeam" d="m105 368 305-146 307 236-259 148Z" fill="url(#roomArtSunbeam)"/>
                <!-- 墙上的时钟、海报和软木留言板 -->
                <g transform="matrix(1 .478 0 1 557 91)">
                  <rect x="0" y="0" width="88" height="94" rx="3" fill="#98ab91" opacity=".25"/><rect x="-3" y="-4" width="88" height="94" rx="3" fill="#fbf5df" stroke="#b8baa0" stroke-width="4"/>
                  <circle cx="41" cy="27" r="16" fill="#dea26d"/><path d="M19 31c7-9 16-15 28-10 12 5 14 13 22 10v19H19Z" fill="#72988a"/>
                  <text x="13" y="67" fill="#4a675a" font-size="12" font-family="Georgia,serif" font-weight="bold">MAKE GOOD</text><text x="13" y="80" fill="#4a675a" font-size="12" font-family="Georgia,serif" font-weight="bold">THINGS.</text>
                </g>
                <g transform="matrix(1 .478 0 1 725 156)">
                  <rect width="110" height="72" rx="4" fill="#b79e75" stroke="#dfd1aa" stroke-width="5"/><path d="m12 14 26-3 2 26-26 3Z" fill="#f8dfa1"/><path d="m48 23 25 2-2 29-25-2Z" fill="#d3e4cd"/><path d="m80 10 20 1-2 23-20-1Z" fill="#e8b9a4"/><path d="m19 22 13-1m21 11 13 1m-14 7 13 1" stroke="#a18a60" stroke-width="2"/>
                </g>
                <g transform="matrix(1 .478 0 1 874 234)"><circle r="23" fill="#faf7e8" stroke="#9cab92" stroke-width="4"/><path d="M0-14V0L10 5" stroke="#647767" stroke-width="3" stroke-linecap="round"/><circle r="2" fill="#647767"/></g>
                <!-- 窗边咖啡柜 -->
                <g class="office-coffee-corner" transform="translate(128 367)">
                  <path d="m0 0 85-40 62 29-85 43Z" fill="#d5b486"/><path d="m0 0 62 32v66L0 67Z" fill="#b68e60"/><path d="m62 32 85-43v67L62 98Z" fill="#cba373"/><path d="m71 44 65-33v22L71 66Zm0 31 65-33v11L71 86Z" fill="#9c7c53"/>
                  <path d="m14-10 28-13 26 12-28 14Z" fill="#f2e2bd"/><path d="M19-43 49-57 70-47v35L40 3 19-8Z" fill="#526c62"/><path d="m25-38 19-9 18 8v18l-19 9-18-8Z" fill="#314f46"/><path d="m31-25 12-6 11 5v9l-12 6-11-5Z" fill="#ddc79f"/><path d="m37-10 8-4 7 3v8l-8 4-7-3Z" fill="#faf2d8"/>
                  <g class="office-coffee-steam" stroke="#fffaf0" stroke-width="2.8" stroke-linecap="round"><path d="M42-18c-8-6 7-9 0-15M49-21c-8-6 7-9 0-15"/></g>
                  <path d="m86-14 15-7 11 5v15l-15 7-11-5Z" fill="#f6e5c3"/><path d="m111-8 9-4v9l-9 5" stroke="#f6e5c3" stroke-width="4"/>
                </g>
                <!-- 小会客区：地毯、沙发、圆桌和一本没合上的杂志 -->
                <path d="m695 365 112-54 126 62-114 63Z" fill="#aaa98d" opacity=".2"/><path d="m685 351 112-54 126 62-114 63Z" fill="#d7b594"/>
                <g transform="translate(767 313)">
                  <path d="m0 0 39-19 94 45-39 20Z" fill="#82a995"/><path d="m0 0 94 46v43L0 42Z" fill="#6d9582"/><path d="m94 46 39-20v43L94 89Z" fill="#4f7e69"/>
                  <path d="M0-15 12-21 106 24v42L94 72 0 27Z" fill="#9cbca5"/><path d="m12-21 94 45v42L12 21Z" fill="#89ae98"/>
                  <path d="m-5 17 18-9 9 5v34L4 56-5 51Zm89 43 18-9 9 5v34l-18 9-9-5Z" fill="#a9c6ad"/>
                  <path d="m31 16 19 9v21l-19-9Zm33 16 19 9v21l-19-9Z" fill="#d3c9a6"/>
                  <path d="M5 55v11m91 27v10m34-33v10" stroke="#536a56" stroke-width="5"/>
                </g>
                <g transform="translate(740 385)"><path d="M0-5v32m36-32v32" stroke="#9b8466" stroke-width="5"/><ellipse cy="-8" rx="43" ry="22" fill="#ad9676"/><ellipse cy="-13" rx="43" ry="22" fill="#f4e7c9"/><path d="m-22-14 19-9 25 12-19 9Z" fill="#cb8b6c"/><path d="m-19-14 16-7 21 10-16 7Z" fill="#fff3d8"/><ellipse cx="18" cy="-18" rx="7" ry="4" fill="#7e9d80"/></g>
                <!-- 角落里的绿植 -->
                <g class="office-plant-leaves" transform="translate(492 223)"><path d="M0-4v-52m0 33-24-26m24 18 23-25" stroke="#4f765a" stroke-width="4"/><use href="#roomArtLeaf" transform="translate(0 -35) scale(.8)"/><use href="#roomArtLeaf" transform="translate(0 -62) scale(.62)"/></g>
                <path d="m470 217 44-1-7 35c-9 8-23 7-30 0Z" fill="#ba8b68"/><ellipse cx="492" cy="217" rx="22" ry="10" fill="#d9ab81"/><ellipse cx="492" cy="215" rx="16" ry="6" fill="#766b4b"/>
                <g transform="translate(872 433)"><path d="M-21 0h42l-7 36c-9 7-19 7-28 0Z" fill="#ece5cf"/><ellipse rx="21" ry="9" fill="#c8ccb3"/><path d="M0-1v-40m0 15-20-25m20 16 18-27" stroke="#537f60" stroke-width="4"/><use href="#roomArtLeaf" transform="translate(0 -21) scale(.78)"/><use href="#roomArtLeaf" transform="translate(0 -49) scale(.65)"/></g>
                <g transform="matrix(1 .48 -1 .52 365 575)" opacity=".5"><text fill="#9e8d69" font-size="15" font-family="system-ui,sans-serif" letter-spacing="5">LITTLE OFFICE</text><path d="M0 10h132" stroke="#b39f75"/></g>
                <g class="office-pendant"><path d="M675 0v92" stroke="#9da38c" stroke-width="3"/><path d="m642 104 33-24 33 24c-16 17-50 17-66 0Z" fill="#bd9f6c"/><ellipse cx="675" cy="106" rx="33" ry="11" fill="#f3d89f"/><ellipse class="office-lamp-glow" cx="675" cy="108" rx="23" ry="5" fill="#fff6d4"/></g>
              </svg>
              <div class="room-scene" id="roomFloor" role="group" aria-label="工作室里的员工工位"></div>
              <svg class="room-paper-plane" viewBox="0 0 64 50" fill="none" aria-hidden="true"><path d="m2 21 59-18-21 43-12-16Z" fill="#fffdf3" stroke="#739087" stroke-width="2"/><path d="m2 21 26 9L61 3 21 24l7 6-1 14 10-9" stroke="#739087" stroke-width="2"/></svg>
              <span class="room-event-spark room-event-spark-one" aria-hidden="true">✦</span><span class="room-event-spark room-event-spark-two" aria-hidden="true">✧</span>
              <span class="room-corner-label" aria-hidden="true"><span></span> LIVE LITTLE MOMENTS</span>
            </div>
            <div class="room-scene-bottom"><p><span aria-hidden="true">↖</span> 点一位同事，听一句小心声</p><span class="room-scene-tips">双击工位 · 进入对话</span></div>
          </div>
          <div class="room-moment"><span class="room-moment-icon" aria-hidden="true">✦</span><div><strong id="roomEventTitle">办公室里的小确幸</strong><p id="roomSceneMessage" aria-live="polite">阳光刚好，咖啡温热。今天会有什么好玩的事？</p><span id="roomEventText">场景彩蛋 · 只负责让心情变好一点</span></div></div>
          <div class="room-colleague"><div class="room-colleague-avatar" id="roomSelectedAvatar"></div><div class="room-colleague-copy"><div class="room-colleague-heading"><strong id="roomSelectedName">等一位新同事</strong><span id="roomSelectedStatus">尚无员工</span></div><span id="roomSelectedRole">每位同事都有自己的小工位</span><p id="roomSelectedQuote">点一下工位，和他打个招呼。</p></div><button type="button" id="roomSelectedTalk">聊两句 <span aria-hidden="true">↗</span></button></div>
        </div>
        <aside class="room-story-card" aria-labelledby="roomStoryTitle">
          <div class="room-story-header">
            <div><span class="room-story-eyebrow">THE OFFICE THEATER</span><h3 id="roomStoryTitle">今日小剧场 <span>虚构放映中</span></h3></div>
            <button id="roomStorybookToggle" class="room-storybook-toggle" type="button" aria-expanded="false" aria-controls="roomStorybook">
              趣事簿 <span id="roomStorybookCount">0</span>
            </button>
          </div>
          <div class="room-story-poster" id="roomStoryPoster" aria-hidden="true"><span class="room-poster-episode">TODAY’S EPISODE</span><svg viewBox="0 0 320 165" fill="none"><ellipse cx="162" cy="143" rx="93" ry="13" fill="#b2b799" opacity=".27"/><path d="m33 153 21-86m234 86-21-86" stroke="#c5c5aa" stroke-width="2"/><path d="M34 49c27 24 58 26 79 11m96 0c25 14 51 13 79-11" stroke="#b8be9c" stroke-width="2" stroke-dasharray="3 5"/><g class="room-poster-prop room-poster-prop-plant"><path d="M143 102h39l-6 36c-8 7-19 7-27 0Z" fill="#c28f6e"/><ellipse cx="162" cy="103" rx="20" ry="8" fill="#e0b48b"/><path d="M162 103V62m0 25-23-18m23 7 20-23" stroke="#507658" stroke-width="3"/><path d="M162 88c-38 4-51-27-33-32 18-3 29 12 33 32Z" fill="#7e9f75"/><path d="M162 75c-11-34 7-50 19-40 13 11-2 33-19 40Z" fill="#587c5d"/><path d="M162 90c16-32 49-32 46-16-3 18-25 18-46 16Z" fill="#9ab18a"/><path d="m128 45 42-24 27 31-42 4Z" fill="#fff8e4" stroke="#c7bea5" stroke-width="1.5"/><path d="m155 56 15-35-42 24Z" fill="#eee4c9"/><path d="m155 56 20-11 22 7" stroke="#c7bea5" stroke-width="1.5"/></g><g class="room-poster-prop room-poster-prop-snack"><ellipse cx="162" cy="126" rx="61" ry="19" fill="#faf6e6" stroke="#d7d7bb" stroke-width="2"/><path d="M193 88c-7 1-12-4-11-11-7 2-14-3-14-11-32-5-60 22-50 49 11 29 59 33 76 6 7-12 6-24-1-33Z" fill="#d3a66e" stroke="#b98d59" stroke-width="2"/><path d="M128 105c8 20 31 28 51 12" stroke="#dfbb89" stroke-width="3" stroke-linecap="round"/><g fill="#8a6349"><circle cx="137" cy="88" r="4"/><circle cx="155" cy="108" r="5"/><circle cx="173" cy="93" r="3"/><circle cx="179" cy="118" r="3"/><circle cx="135" cy="115" r="3"/><circle cx="154" cy="79" r="3"/></g><path d="m208 69 38 7-5 36-38-7Z" fill="#fffae7"/><path d="m215 80 20 4m-21 4 16 3m-17 5 19 3" stroke="#bdc2a1" stroke-width="2"/><circle cx="201" cy="126" r="3" fill="#b98d59"/></g><g class="room-poster-prop room-poster-prop-elevator"><path d="M123 138V38h76v100" fill="#b7c5aa" stroke="#8b9e80" stroke-width="3"/><path d="M133 138V63h56v75" fill="#e4e8d2" stroke="#8b9e80" stroke-width="2"/><path d="M161 64v74" stroke="#a7b797" stroke-width="2"/><path d="m146 51 6-7 6 7m9-7 6 7 6-7" stroke="#6d8665" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="207" y="77" width="17" height="35" rx="4" fill="#f7f2dd"/><path d="m215 84 2 5 5 1-4 4 1 5-4-3-4 3 1-5-4-4 5-1Z" fill="#d7ad5b"/><path d="M117 139h89" stroke="#7d9472" stroke-width="3" stroke-linecap="round"/></g><path d="M62 34h49a11 11 0 0 1 11 11v9a11 11 0 0 1-11 11H91L80 76V65H62a11 11 0 0 1-11-11v-9a11 11 0 0 1 11-11Z" fill="#fffbed"/><path d="M77 46h20m-20 8h13" stroke="#99a087" stroke-width="2" stroke-linecap="round"/><path d="M219 82h38a10 10 0 0 1 10 10v5a10 10 0 0 1-10 10h-9l-9 10v-10h-20a10 10 0 0 1-10-10v-5a10 10 0 0 1 10-10Z" fill="#e3e9d0"/><circle cx="226" cy="95" r="2" fill="#7b8c6d"/><circle cx="237" cy="95" r="2" fill="#7b8c6d"/><circle cx="248" cy="95" r="2" fill="#7b8c6d"/></svg><span class="room-poster-caption">生活偶尔需要一点无厘头。</span></div>
          <div id="roomStoryContent" class="room-story-content"></div>
          <section id="roomStorybook" class="room-storybook hidden" aria-label="收藏的趣事">
            <h4>我的趣事簿</h4>
            <div id="roomStorybookList"></div>
          </section>
          <p class="room-story-footnote">小剧场与场景彩蛋是虚构演出，不读取工作内容，也不会触发员工任务。</p>
        </aside>
      </div>
      <footer class="room-page-footer"><div class="room-state-legend"><span><i class="is-online"></i>在线</span><span><i class="is-busy"></i>忙碌</span><span><i class="is-offline"></i>离线</span><span><i class="is-attention"></i>需处理</span><span class="room-state-note">状态来自真实工作</span></div><span id="roomSummary"></span></footer>
    </section>
  </section>

  <!-- 审批中心：待处理是员工来找你，已处理是可回看的请求记录。列表负责扫一眼，右侧详情负责做决定。 -->
  <section class="col hidden" id="viewApprovals">
    <section class="card approval-card">
      <h2 class="approval-heading">
        <span>审批</span>
        <button id="btnReloadApprovals" class="ghost">刷新</button>
      </h2>
      <div class="approval-intro">
        <span>员工工作中需要你确认的事情，处理后会继续执行。</span>
        <strong id="approvalPendingSummary"></strong>
      </div>
      <div class="approval-filters" role="tablist" aria-label="审批记录">
        <button id="approvalTabPending" class="approval-filter active" data-approval-view="pending" role="tab" aria-controls="approvalPendingPanel" aria-selected="true">待处理 <span id="approvalPendingCount"></span></button>
        <button id="approvalTabHistory" class="approval-filter" data-approval-view="history" role="tab" aria-controls="approvalHistoryPanel" aria-selected="false">已处理 <span id="approvalHistoryCount"></span></button>
      </div>

      <section class="approval-panel" id="approvalPendingPanel" role="tabpanel" aria-labelledby="approvalTabPending">
        <div class="approval-workspace">
          <section class="approval-queue" aria-label="等待处理的员工请求">
            <div class="approval-queue-heading"><strong>员工来找你</strong><span>最新请求</span></div>
            <ul class="approval-list" id="approvalList"></ul>
          </section>
          <article class="approval-detail" id="approvalDetail" aria-live="polite" aria-label="所选审批详情"></article>
        </div>
        <div class="approval-footnote">这里只放还需要你决定的请求；完成记录收在「已处理」里。</div>
      </section>

      <section class="approval-panel hidden" id="approvalHistoryPanel" role="tabpanel" aria-labelledby="approvalTabHistory">
        <div class="approval-workspace">
          <section class="approval-queue" aria-label="已处理的员工请求">
            <div class="approval-queue-heading"><strong>最近处理</strong><span>已完成的请求</span></div>
            <ul class="approval-list" id="approvalHistoryList"></ul>
          </section>
          <article class="approval-detail" id="approvalHistoryDetail" aria-live="polite" aria-label="所选已处理记录"></article>
        </div>
      </section>
    </section>
  </section>

  <!-- 设备页要 device.pair scope：没这个 scope 时**连标签一起藏掉**（syncControls），
       否则会留下一个点开全是报错的入口。 -->
  <section class="col hidden" id="viewDevices">
    <section class="card">
      <h2>新设备注册</h2>
      <div class="muted">开关「是否允许新设备注册」：关掉之后，未授权的访问只会看到 404（与 nginx 一致）；
        已配对的浏览器不受影响。要加设备时点开（默认 15 分钟自动关）。</div>
      <div id="pairingWindowBox"></div>
    </section>
    <section class="card">
      <h2>设备 <button id="btnReloadDevices" class="ghost">刷新</button></h2>
      <div class="muted">待审批</div>
      <ul class="list" id="devicePendingList"></ul>
      <div class="muted">已配对</div>
      <ul class="list" id="devicePairedList"></ul>
      <div class="row">
        <button id="btnResetKey" class="ghost">重置本机设备密钥</button>
        <button id="btnClearToken" class="ghost">清除本地令牌</button>
      </div>
    </section>
  </section>

  <!-- 体检：把"沉默的分叉"变成看得见的一行字。
       代码版本（Hub vs 各节点）、工作区 git 锚点（私有技能可见性的前提）、
       控制台脚本指纹（PWA 缓存是否把人冻在旧版）—— 三类问题都不报错，
       只是让系统悄悄变差，所以需要一个地方主动把它们摆出来。
       结论同时写在标签上的 chip 里，不用点进来就能看见（见 renderHealth）。 -->
  <!-- 定时任务：周期性把一件事交给数字员工。页面采用「任务列表 + 详情工作区」——
       左侧负责扫一眼，右侧负责编辑与执行；不改变 job.* 协议和 Hub 侧调度语义。 -->
  <section class="col hidden" id="viewJobs">
    <section class="card jobs-card">
      <h2 class="jobs-heading">
        <span>定时</span>
        <button id="btnReloadJobs" class="ghost">刷新</button>
      </h2>
      <div class="jobs-intro">
        <span>让数字员工按间隔自动工作。</span>
        <span class="jobs-policy">错过的时间点不会补跑</span>
      </div>
      <div class="jobs-summary" aria-label="定时任务概览">
        <div class="jobs-stat">
          <span class="jobs-stat-label">启用中</span>
          <strong id="jobEnabledSummary">0</strong>
        </div>
        <div class="jobs-stat">
          <span class="jobs-stat-label">下一次运行</span>
          <strong id="jobNextSummary">暂无</strong>
        </div>
        <div class="jobs-stat">
          <span class="jobs-stat-label">机器离线</span>
          <strong id="jobOfflineSummary">0</strong>
        </div>
      </div>
      <div class="jobs-workspace">
        <section class="jobs-queue" aria-label="定时任务列表">
          <div class="jobs-queue-heading">
            <div>
              <strong>任务列表</strong>
              <span id="jobListHint">先选一项查看详情</span>
            </div>
            <button id="btnNewJob" class="ghost">＋ 新建任务</button>
          </div>
          <div id="jobList"></div>
        </section>
        <article class="job-detail" id="jobDetail" aria-live="polite" aria-label="定时任务详情">
          <div class="job-detail-empty hidden" id="jobDetailEmpty">
            <strong>选择一个任务</strong>
            <span>查看下一次运行、修改指令或立即执行。</span>
          </div>
          <div id="jobForm" class="job-form">
            <div class="job-detail-heading">
              <div>
                <span class="job-kicker">任务设置</span>
                <h3 id="jobFormTitle">新建任务</h3>
              </div>
              <span id="jobFormState" class="job-form-state"></span>
            </div>
            <div class="job-form-grid">
              <label class="job-field">
                <span>任务名称</span>
                <input id="jobName" type="text" maxlength="60" placeholder="例如：每小时汇报">
              </label>
              <label class="job-field">
                <span>执行员工</span>
                <select id="jobEmployee"></select>
              </label>
              <label class="job-field job-field-interval">
                <span>执行间隔</span>
                <span class="job-interval-line"><input id="jobInterval" type="number" min="1" max="43200" step="1" value="30"><span>分钟</span></span>
              </label>
            </div>
            <label class="job-field job-field-prompt">
              <span>要交给员工的指令</span>
              <textarea id="jobPrompt" rows="4" placeholder="到时发给这位员工的话"></textarea>
              <small>节点离线时会先排进队列，等它上线后再送出。</small>
            </label>
            <div class="job-form-actions">
              <button id="btnSaveJob" class="primary">创建任务</button>
              <button id="btnResetJob" class="ghost">清空</button>
              <span id="jobFormHint" class="muted"></span>
            </div>
          </div>
        </article>
      </div>
    </section>
  </section>

  <section class="col hidden" id="viewHealth">
    <section class="card health-card" id="cardHealth">
      <h2 class="health-heading">
        <span>体检</span>
        <button id="btnReloadHealth" class="ghost">刷新</button>
      </h2>
      <div class="health-intro">
        <span>把不会主动报错的系统分叉摆出来：版本、节点、员工工作区。</span>
        <span id="healthLastChecked">尚未检查</span>
      </div>
      <div class="health-overview" id="healthOverview">
        <div class="health-state" id="healthState">
          <span class="health-state-dot" aria-hidden="true"></span>
          <div>
            <strong id="healthStateTitle">尚未检查</strong>
            <span id="healthStateText">切入本页后会自动检查。</span>
          </div>
        </div>
        <div class="health-counters" aria-label="体检摘要">
          <div><span>阻断</span><strong id="healthBadCount">0</strong></div>
          <div><span>需处理</span><strong id="healthWarnCount">0</strong></div>
          <div><span>信息</span><strong id="healthInfoCount">0</strong></div>
        </div>
      </div>
      <div class="health-filters" role="tablist" aria-label="体检项目筛选">
        <button id="healthFilterAll" class="health-filter active" role="tab" aria-selected="true">全部 <span id="healthAllCount"></span></button>
        <button id="healthFilterOpen" class="health-filter" role="tab" aria-selected="false">需处理 <span id="healthOpenCount"></span></button>
        <button id="healthFilterOk" class="health-filter" role="tab" aria-selected="false">正常 / 信息 <span id="healthOkCount"></span></button>
      </div>
      <div class="health-workspace">
        <section class="health-queue" aria-label="体检项目列表">
          <div class="health-queue-heading">
            <strong>检查项目</strong>
            <span id="healthQueueHint">等待检查</span>
          </div>
          <div id="healthBody"></div>
        </section>
        <article class="health-detail" id="healthDetail" aria-live="polite" aria-label="体检详情">
          <div class="health-detail-empty" id="healthDetailEmpty">
            <strong>选择一个检查项目</strong>
            <span>这里会说明事实、影响和下一步。</span>
          </div>
        </article>
      </div>
    </section>
  </section>

  <section class="col hidden" id="viewLlm">
    <div class="config-heading"><div><h2>员工配置</h2><p class="muted">设置员工使用的模型、基本信息与审批方式。</p></div></div>
    <nav class="config-pages" id="configPages" aria-label="配置范围">
      <button class="ghost" data-config-page="employees" aria-pressed="true">员工设置</button>
      <button class="ghost" data-config-page="services" aria-pressed="false">模型服务</button>
      <button class="ghost" data-config-page="nodes" aria-pressed="false">节点设置</button>
    </nav>
    <section id="configEmployees">
      <div class="config-toolbar"><span class="muted">选择员工后，在右侧修改配置</span><button id="btnBatchModels" class="primary">批量设置模型</button></div>
      <section id="configBatchPanel" class="card hidden" aria-label="批量设置模型"></section>
      <div class="config-workspace">
        <aside class="config-directory" aria-label="员工列表">
          <label class="config-field config-search">查找员工<input id="configSearch" type="search" placeholder="搜索姓名、岗位、分组"></label>
          <label class="config-field config-mobile-picker">选择员工<select id="configMobileEmployee"></select></label>
          <div id="configEmployeeList"></div>
        </aside>
        <section class="config-detail" aria-label="当前员工配置">
          <div id="configEmployeeHeading"></div>
          <nav class="config-tabs" id="configTabs" aria-label="员工设置分区">
            <button class="ghost" data-config-tab="models" aria-pressed="true">模型</button>
            <button class="ghost" data-config-tab="identity" aria-pressed="false">基本信息</button>
            <button class="ghost" data-config-tab="approval" aria-pressed="false">审批与权限</button>
          </nav>
          <div id="configEmployeeMessage" class="config-message hidden" role="status" aria-live="polite"></div>
          <div id="llmConfigList"></div>
        </section>
      </div>
    </section>
    <section id="configServices" class="card hidden">
      <h2>共享模型服务 <button id="btnNewEndpoint" class="ghost">新增服务</button></h2>
      <p class="muted">接口与密钥配置一次，供多位员工选择使用。修改共享服务时会同步到使用它的员工。</p>
      <div id="endpointList"></div>
      <div id="endpointEditor"></div>
      <div id="endpointStatus" role="status" aria-live="polite"></div>
    </section>
    <section id="configNodes" class="card hidden">
      <h2>节点默认权限</h2>
      <p class="muted">影响该节点所有员工之后新建的会话，已有会话保持原来的权限。</p>
      <div id="nodePermissionList"></div>
    </section>
  </section>

  <section class="chat-shell hidden" id="viewChatShell">
    <nav class="chat-nav-rail" id="employeeNavRail" aria-label="员工导航">
      <button id="btnChatSessions" class="ghost chat-nav-open" type="button" aria-expanded="false" aria-controls="sessionPanel" title="展开员工与会话">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M9 4v16M13 9h4M13 13h4"></path></svg>
        <span>员工</span>
      </button>
      <div class="chat-nav-people" id="employeeNavQuickList" role="group" aria-label="快捷切换员工"></div>
    </nav>
    <div class="chat-nav-backdrop hidden" id="employeeNavBackdrop" aria-hidden="true"></div>
    <aside class="chat-sessions hidden" id="sessionPanel" aria-label="员工与会话">
      <div class="cs-nav-header">
        <div class="cs-tree-label" id="sessionPanelTitle">员工与会话<span class="muted">点击名字切换员工，箭头展开会话</span></div>
        <button id="btnPanel" class="ghost cs-nav-close" type="button" aria-expanded="true" aria-controls="sessionPanel" aria-label="收起员工与会话" title="收起员工与会话">‹</button>
      </div>
      <ul class="list" id="sessionList"></ul>
      <div class="cs-nav-footer">
        <input id="newSessionTitle" class="cs-create-input" type="text" placeholder="会话名称（可选）" maxlength="80" autocomplete="off" aria-label="新会话名称">
        <details class="chat-advanced">
          <summary>高级</summary>
          <div class="muted cs-effective">生效 preset：<code id="effectivePreset"></code></div>
          <!-- autocomplete/spellcheck 都关掉：这是给 dsh 的 preset **id**，
               不是人名地名。实测踩过——浏览器把它当普通文本框自动填充，
               把设备显示名串了进来，于是每次新建会话都失败（见 60-sessions 的注释）。 -->
          <input id="presetInput" type="text" placeholder="agentPreset（可选，新建会话时使用）" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button id="btnReloadSessions" class="ghost">刷新会话列表</button>
        </details>
        <div class="chat-session-tools" id="sessionTools"></div>
      </div>
    </aside>
    <section id="viewChat">
    <!-- ── 秘书页外壳（岗位 layout="secretary" 时才显示；其余岗位这一页原样不动）──
         左立绘 / 右对话（气泡区独立滚动 + galgame 对话框），顶部一个下拉箭头拉出全屏看板。
         立绘现在是**占位剪影**：真素材（部件式帧图）到位后由 script/67-secretary.ts 换上，
         见 design/秘书页-设计稿.md §6。 -->
    <div class="secretary-stage hidden" id="secretaryStage" aria-hidden="true">
      <div class="stage-art" id="stageArt"></div>
      <div class="stage-plate"><span id="stageName">秘书</span><span class="stage-state" id="stageState">空闲</span></div>
    </div>
    <!-- 下拉箭头：常驻（她没写过结论时拉下来是空的，如实说明）。有点 = 有新结论没看过 -->
    <button id="btnBoard" class="board-pull hidden" aria-expanded="false" aria-controls="boardSheet" title="拉下看板：她上次写给你的结论">
      <span class="board-arrow" aria-hidden="true">▽</span>
      <span class="board-label" id="boardLabel">上次结论</span>
      <span class="board-dot hidden" id="boardDot" aria-label="有新结论"></span>
    </button>
    <div class="chat-top">
      <button id="btnBackOffice" class="ghost chat-back" aria-label="返回办公区" title="返回办公区">‹</button>
      <div class="chat-peer">
        <!-- 对方的头像（名字左边）。里面那颗由 script/65-chat.ts 的 updateChatPeerAvatar()
             填成 avatarNode()，与工位卡片同一套（自定义头像 / 线稿脸、版本没变就不下载）。
             没选员工时这里是空的，CSS 用 :empty 把整列收成 0。 -->
        <span class="chat-peer-avatar" id="chatPeerAvatar"></span>
        <span class="chat-peer-name" id="employeeTitle">对话</span>
        <span class="chat-peer-status"><span class="chat-peer-position" id="chatPeerPosition"></span><span class="chat-dot online" id="chatDot"></span><span id="streamState"></span><span class="chat-sync-status" id="chatSyncStatus" role="status" aria-live="polite"></span><!--
          上下文占用小圈：数字来自 dsh 的 session/projection 帧（解析见 script/65-chat.ts）。
          没有数据时整块隐藏 —— **绝不显示 0%**（那是在编数字）。点一下展开构成。
        --><button class="ctx-ring hidden" id="ctxRing" type="button" aria-label="上下文占用" title=""></button><span class="ctx-pop hidden" id="ctxPop"></span></span>
      </div>
      <div class="chat-top-cell" id="quadTop"></div>
      <div class="chat-top-actions">
        <button id="btnNewSession" class="ghost">新会话</button>
        <!-- 本页皮肤（日间 / 作业室）：**只属于四宫格那一页**，其余页面这一页与从前一样 -->
        <button id="btnQuadSkin" class="ghost quad-skin-btn" aria-pressed="false">🖥️ 作业室</button>
        <button id="btnAside" class="ghost" aria-pressed="false" title="收起右侧的上下文栏">上下文栏折叠</button>
      </div>
    </div>
    <!-- ── 四宫格外壳（岗位 layout="quad" 时才显示）──
         左上 当前目标（工作区文件：人写的授权范围 + 员工写的进度）
         左下 下一步（dsh 的 todos 投影，实时）
         右上 指挥栏（未决审批 / 专属技能，由脚本渲染）
         右下 对话（就是上面那几个原有元素，一格都不复制）
         窄屏不摆四格（四个都看不清），改成一次摊开一格的抽屉：下面那排按钮。 -->
    <section class="quad-cell quad-tl" id="quadTl" aria-label="左上 · 当前目标"></section>
    <section class="quad-cell quad-bl" id="quadBl" aria-label="左下 · 下一步"></section>
    <section class="quad-cell quad-tr" id="quadTr" aria-label="右上 · 指挥栏"></section>
    <div class="quad-drawer" role="group" aria-label="四宫格抽屉">
      <button id="quadDrawer_tl" class="ghost" aria-pressed="false">目标</button>
      <button id="quadDrawer_bl" class="ghost" aria-pressed="false">计划</button>
      <button id="quadDrawer_tr" class="ghost" aria-pressed="false">指挥</button>
    </div>
    <div class="messages" id="messages"></div>
    <div class="composer">
      <button id="btnChatLatest" class="ghost chat-latest hidden" type="button">有新消息 · 回到最新</button>
      <div class="attach-strip" id="attachStrip"></div>
      <div class="composer-inner">
        <button id="btnAttach" class="ghost chat-attach" aria-label="发文件" title="发文件给员工（图片还会直接让员工看见）">📎</button>
        <input id="fileInput" class="hidden" type="file" multiple>
        <textarea id="promptInput" rows="1" placeholder="输入指令…"></textarea>
        <button id="btnCompact" class="ghost chat-compact" aria-label="压缩上下文" title="压缩上下文" disabled>压缩上下文</button>
        <button id="btnDistill" class="ghost chat-compact" aria-label="沉淀为技能" title="把本会话演示过的工作流程沉淀成 .dsh/skills 里的可复用技能（新会话生效）" disabled>沉淀为技能</button>
        <button id="btnSend" class="chat-send" aria-label="发送" title="发送">↑</button>
        <button id="btnCancel" class="chat-send chat-stop hidden" aria-label="停止" title="停止">■</button>
      </div>
    </div>
    <!-- 宽屏右栏：员工上下文（岗位/技能/工作区交付物/未决审批）。
         窄屏一律隐藏（.hidden），只在 ≥1200px 由 CSS 放开 —— 手机上它会把对话挤没。 -->
    <aside class="chat-aside hidden" id="employeeAside" aria-label="员工上下文"></aside>
    <!-- 「上次结论」：桌面端只覆盖右侧对话列，保留浅夏立绘；手机端全屏阅读。 -->
    <div class="board-sheet hidden" id="boardSheet" role="dialog" aria-modal="true" aria-labelledby="boardTitle">
      <div class="board-head">
        <div class="board-heading">
          <span class="board-kicker"><span id="boardAuthor">秘书</span>递交 · 最近一份结论</span>
          <span class="board-title" id="boardTitle">上次结论</span>
        </div>
        <span class="board-meta" id="boardMeta"></span>
        <button id="btnBoardClose" class="ghost" aria-label="收起看板" title="收起（Esc）">✕</button>
      </div>
      <div class="board-scroll">
        <article class="board-paper" aria-label="最近一份结论正文">
          <div class="board-paper-top" aria-hidden="true"><span>最近整理</span><span>案头简报</span></div>
          <div class="board-body" id="boardBody"></div>
          <div class="board-signature"><span>整理</span><strong id="boardSignature">秘书</strong></div>
        </article>
      </div>
      <div class="board-actions">
        <button id="btnBoardResume" class="ghost">收起，继续聊</button>
        <button id="btnBoardFollowup" class="primary">围绕结论继续追问</button>
      </div>
    </div>
    </section>
  </section>
</main>

<dialog id="projectDirectoryPicker" class="project-directory-picker" aria-labelledby="projectDirectoryTitle">
  <div class="project-directory-heading"><div><h2 id="projectDirectoryTitle">选择文件夹</h2><p id="projectDirectoryNode" class="muted"></p></div><button id="btnProjectDirectoryClose" type="button" class="ghost" aria-label="关闭目录选择器">✕</button></div>
  <div class="project-directory-toolbar"><button id="btnProjectDirectoryBack" type="button" class="ghost" title="返回上一个位置">返回</button><button id="btnProjectDirectoryUp" type="button" class="ghost">上一级</button><button id="btnProjectDirectoryHome" type="button" class="ghost">主目录</button><button id="btnProjectDirectoryRefresh" type="button" class="ghost">刷新</button><label><input id="projectDirectoryHidden" type="checkbox">显示隐藏文件夹</label></div>
  <nav id="projectDirectoryBreadcrumbs" class="project-directory-breadcrumbs" aria-label="当前位置"></nav>
  <div class="project-directory-body"><nav id="projectDirectoryLocations" class="project-directory-locations" aria-label="常用位置和磁盘"></nav><div class="project-directory-content"><p id="projectDirectoryStatus" class="muted" role="status" aria-live="polite"></p><div id="projectDirectoryList" class="project-directory-list" aria-label="子文件夹"></div><button id="btnProjectDirectoryMore" type="button" class="ghost hidden">加载更多文件夹</button></div></div>
  <div class="project-directory-footer"><div class="project-directory-selection"><button id="btnProjectDirectoryCurrent" type="button" class="ghost">选择当前文件夹</button><span id="projectDirectorySelection" class="muted"></span></div><div class="project-directory-actions"><button id="btnProjectDirectoryCancel" type="button" class="ghost">取消</button><button id="btnProjectDirectoryConfirm" type="button" class="primary">打开此文件夹</button></div></div>
</dialog>

<div class="toasts" id="toasts"></div>

${parts.scriptTag}
</body>`
}
