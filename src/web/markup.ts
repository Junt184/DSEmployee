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
}

export function renderControlBody(parts: ControlUiMarkupParts): string {
  return `<body>
<div id="dse-boot" class="hidden" data-hub-id="${parts.bootHubId}" data-hub-name="${parts.bootHubName}"></div>

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

      <div class="auth-step">方式二：在另一台已授权设备上批准</div>
      <div class="muted">
        本设备的配对请求 ID：<code id="authRequestId">…</code><br>
        在已授权控制台的「设备」卡片里批准它即可 —— 本页每 3 秒自动重试，批准后自动进入。
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

  <!-- 办公室（全景）：一间会自己动的屋子 —— 同事们的头像在屋里到处走，点一下他就说句话。
       为什么不用背景图：背景图要生图（本仓库没有出图产线），位图还要进指纹、进 PWA 预缓存、
       为深色主题再出一张；而头像、影子、气泡全是几何图形，CSS 画得出来、零新增素材。
       这里只有三个容器：
         #roomSummary 门牌（一句话汇总）、#roomRoom 场地（天色与档位变量在它身上）、
         #roomFloor 场景层（地面与一个个头像，由脚本 32-office-room 按人数排布与绑定）。
       头像点一下 = 他说一句（气泡），双击或气泡里的"聊两句" = 走办公区那条现成的入口
       （selectEmployee → 对话视图）。 -->
  <section class="col hidden" id="viewOfficeRoom">
    <section class="card room-card">
      <h2>全景
        <span class="h2-actions">
          <span class="chip" id="roomSummary"></span>
        </span>
      </h2>
      <!-- 说明里必须写出"怎么看"：走位与台词是玩的部分，但状态是正事，看不懂就等于没有。
           灯的四色与姿态一一对应，读一遍就能认出"忙的、闲的、睡的、出事的"。
           姓名为什么只说"指到就有"：它默认隐身（人多了常显会糊成一团）。 -->
      <div class="muted">同事们在屋里随便走走，<b>点一下谁，他就跟你说句话</b>（会换着说，不会老是一句）；
        <b>双击</b>头像、或点气泡里的「聊两句」就进对话。动作就是状态：<b>打字</b>=忙碌、<b>走路</b>=在线空闲、
        <b>Zzz</b>=离线、<b>「!」发抖</b>=回合卡住需处理、<b>角标带数字</b>=有未读等你回话；头像上那颗小灯是同样的四色。
        指到头像上会显示姓名与状态。天色跟着你电脑上的钟走，深夜会暗下来。</div>
      <div class="room" id="roomRoom" data-tier="t10" data-daypart="day" role="group"
        aria-label="办公室全景：同事们的头像在屋里走动，点一下他会说句话，双击开始对话">
        <!-- 地面：一片椭圆。头像的影子落在它上面，"站在地上"这件事才成立 -->
        <span class="room-ground"></span>
        <!-- 场景层：一个个头像由脚本按人数撒在这一层里 -->
        <div class="room-scene" id="roomFloor"></div>
      </div>
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
    <section class="card">
      <h2>端点库 <button id="btnNewEndpoint" class="ghost">新增端点</button></h2>
      <div class="muted">
        BaseURL + Key 在这里输一次，多个员工复用。Key 存在 Hub 与节点上，界面只回掩码；
        改了 BaseURL 或 Key 会**自动同步**到所有用到它的员工。别名由你自己拼（如 gpt5.6-noelle）。
      </div>
      <div id="endpointList"></div>
    </section>
    <section class="card">
      <h2>节点权限档位</h2>
      <div class="muted">
        这是**整机**的默认档位（dsh 只有这一个写入口，做不到按员工）：只影响这台机器上
        **所有员工新建的会话**，已有会话不受影响。按员工的"别老是问我"请用下面的「审批自动放行」。
      </div>
      <div id="nodePermissionList"></div>
    </section>
    <section class="card">
      <h2>员工的模型</h2>
      <div class="muted">
        每个员工可以挂多条「别名 → 端点 + 模型」。设为当前后：新会话用它，
        **并且把当前打开的那个会话一起切过去**（正在跑回合的会话会等它跑完）。
      </div>
      <div id="llmConfigList"></div>
    </section>
  </section>

  <section class="hidden" id="viewChat">
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
        <span class="chat-peer-status"><span class="chat-dot online" id="chatDot"></span><span id="streamState"></span><!--
          上下文占用小圈：数字来自 dsh 的 session/projection 帧（解析见 script/65-chat.ts）。
          没有数据时整块隐藏 —— **绝不显示 0%**（那是在编数字）。点一下展开构成。
        --><button class="ctx-ring hidden" id="ctxRing" type="button" aria-label="上下文占用" title=""></button><span class="ctx-pop hidden" id="ctxPop"></span></span>
      </div>
      <div class="chat-top-cell" id="quadTop"></div>
      <div class="chat-top-actions">
        <button id="btnChatSessions" class="ghost" aria-haspopup="true" aria-expanded="false" aria-controls="sessionPanel">会话</button>
        <button id="btnNewSession" class="ghost">新会话</button>
        <!-- 本页皮肤（日间 / 作业室）：**只属于四宫格那一页**，其余页面这一页与从前一样 -->
        <button id="btnQuadSkin" class="ghost quad-skin-btn" aria-pressed="false">🖥️ 作业室</button>
        <!-- 左右两栏的折叠开关成对出现，各管各的、各记各的。
             左栏只在 ≥1200px 常驻（中档与窄屏的左栏是上面那个「会话」抽屉），
             所以 #btnPanel 也只在那一档出现；右栏窄屏根本摆不下。两个按钮都由 CSS
             控可见性 —— 宁可不给，也不给一个按了没反应的死键。

             ⚠️ 文案必须**说清它是个折叠开关**。原来只写「会话」「上下文」，与上面的
             「会话」抽屉、与"切到某某页"长得一样，真实反馈是"找不到收侧栏的按钮"。
             所以写成「…栏折叠」；收起后由 JS 改成「…栏展开」—— 动作变了还喊"折叠"就是假话。 -->
        <button id="btnPanel" class="ghost" aria-pressed="false" title="收起左侧的会话栏">会话栏折叠</button>
        <button id="btnAside" class="ghost" aria-pressed="false" title="收起右侧的上下文栏">上下文栏折叠</button>
      </div>
    </div>
    <div class="chat-sessions hidden" id="sessionPanel">
      <div class="cs-tree-label">员工与会话<span class="muted">点击名字切换员工</span></div>
      <ul class="list" id="sessionList"></ul>
      <input id="newSessionTitle" class="cs-create-input" type="text" placeholder="会话名称（可选）" maxlength="80" autocomplete="off">
      <details class="chat-advanced">
        <summary>高级</summary>
        <div class="muted cs-effective">生效 preset：<code id="effectivePreset"></code></div>
        <input id="presetInput" type="text" placeholder="agentPreset（可选，新建会话时使用）">
        <button id="btnReloadSessions" class="ghost">刷新会话列表</button>
      </details>
      <!-- 窄屏工具槽：手机上「压缩上下文 / 沉淀为技能」会被搬到这里（见 placeChatTools）。
           桌面端这个槽是空的，靠 :empty 隐藏 —— 那两个按钮留在输入区。 -->
      <div class="chat-session-tools" id="sessionTools"></div>
    </div>
    <!-- ── 四宫格外壳（岗位 layout="quad" 时才显示）──
         左上 当前目标（工作区文件：人写的授权范围 + 员工写的进度）
         左下 下一步（dsh 的 todos 投影，实时）
         右上 指挥栏（未决审批 / 会话折叠栏 / 专属技能，由脚本渲染）
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
</main>

<div class="toasts" id="toasts"></div>

${parts.scriptTag}
</body>`
}
