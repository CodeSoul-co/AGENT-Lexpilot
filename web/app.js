const $ = (selector) => document.querySelector(selector);
const landingContent = globalThis.LexPilotLandingContent;
const v1Presentation = globalThis.LexPilotV1Presentation;
if (!landingContent) throw new Error('Landing content configuration failed to load.');
if (!v1Presentation) throw new Error('V1 presentation module failed to load.');
const elements = {
  landingPage: $('#landing-page'), workspaceApp: $('#workspace-app'), backHome: $('#back-home'),
  landingNav: $('#landing-nav'), landingMenuToggle: $('#landing-menu-toggle'),
  landingMobileMenu: $('#landing-mobile-menu'), announcementBar: $('#announcement-bar'),
  characterCount: $('#character-count'), composer: $('#composer'), consent: $('#privacy-consent'),
  conversation: $('#conversation'), deleteSession: $('#delete-session'), eraseHistory: $('#erase-history'), domainLabel: $('#domain-label'),
  factsList: $('#facts-list'), historyList: $('#history-list'), input: $('#message-input'),
  newSession: $('#new-session'), pageTitle: $('#page-title'), privacyAccept: $('#privacy-accept'),
  privacyModal: $('#privacy-modal'), policyVersion: $('#policy-version'), refreshHistory: $('#refresh-history'),
  runtime: $('.runtime-status'), runtimeText: $('#runtime-text'), scroll: $('#chat-scroll'),
  send: $('#send-button'), sessionOrb: $('#session-orb'), sessionRound: $('#session-round'),
  sessionStatus: $('#session-status'), toast: $('#toast'), welcome: $('#welcome'),
  welcomeIcon: $('#welcome-icon'), welcomeEyebrow: $('#welcome-eyebrow'), welcomeTitle: $('#welcome-title'),
  welcomeCopy: $('#welcome-copy'), scopeBanner: $('#scope-banner'), agentName: $('#agent-name'),
  agentProvider: $('#agent-provider'), agentRoute: $('#agent-route'),
  confirmModal: $('#confirm-modal'), confirmExplanation: $('#confirm-explanation'),
  confirmSql: $('#confirm-sql'), confirmAccept: $('#confirm-accept'), confirmCancel: $('#confirm-cancel'),
  schemaModal: $('#schema-modal'), schemaDescription: $('#schema-description'),
  schemaTableBody: $('#schema-table-body'), openSchema: $('#open-schema'), schemaClose: $('#schema-close'),
  dataSourceAdminModal: $('#data-source-admin-modal'),
  dataSourceProfileList: $('#data-source-profile-list'),
  openDataSourceAdmin: $('#open-data-source-admin'),
  dataSourceAdminClose: $('#data-source-admin-close'),
  artifactsSection: $('#artifacts-section'), artifactList: $('#artifact-list'),
  logsSection: $('#logs-section'), logFilter: $('#log-filter'), logList: $('#log-list'),
  sandboxControls: $('#sandbox-controls'), sandboxLanguage: $('#sandbox-language'),
  sandboxFiles: $('#sandbox-files'), sandboxFileSummary: $('#sandbox-file-summary')
};

const state = { activeSessionId: null, activeStatus: null, config: null, consentGranted: false, busy: false, mode: 'v0', artifacts: [], lastExecutionMs: null, pendingSandboxPlanId: null };
const accessActions = {
  dataSourceManage: 'data-source:manage',
  executionLogRead: 'execution-log:read',
  humanReviewApprove: 'human-review:approve'
};

function hasAccess(action) {
  return state.config?.access?.grants?.includes(action) === true;
}
const taskLabels = { legal_self_check: '法律自检', professional_data_query: '专业数据分析' };
const factLabels = {
  employmentDuration: '工作时长', writtenContractStatus: '书面合同', issueType: '事项类型',
  dismissalGround: '辞退原因', noticeOrPayStatus: '通知或代通知金', medicalPeriodStatus: '医疗期',
  workArrangementOutcome: '工作安排', performanceRemediationOutcome: '培训或调岗',
  objectiveChangeImpact: '客观变化影响', contractChangeNegotiationOutcome: '合同协商',
  relationshipStatus: '关系状态', disputeType: '争议类型', evidenceStatus: '证据情况',
  repaymentTermStatus: '还款约定', repaymentStatus: '还款状态', taxpayerType: '涉税主体',
  taxIssueType: '税务事项', taxPeriod: '税务期间', rightType: '权利类型',
  allegedAct: '相关行为', authorizationStatus: '授权情况'
};
const valueLabels = {
  mentioned: '已说明', not_signed: '未签订', signed: '已签订', dismissal: '辞退', unknown: '尚不清楚',
  available: '有证据', unavailable: '暂无证据', agreed: '有约定', unpaid: '未归还', neither: '两者均无',
  written_notice: '已书面通知', extra_month_pay: '已额外支付一个月工资'
};

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function setLandingText(selector, value) {
  const target = $(selector);
  if (target) target.textContent = value ?? '';
}

function isLocalMediaUrl(value, allowDataImage = false) {
  return (
    typeof value === 'string' &&
    (value.startsWith('/') || (allowDataImage && value.startsWith('data:image/')))
  );
}

function landingAction(action, className) {
  const button = node('button', className, action.label);
  button.type = 'button';
  button.dataset.enterWorkspace = action.mode;
  button.append(node('span', '', '→'));
  return button;
}

function renderLandingMedia(media) {
  const container = $('#hero-media');
  container.replaceChildren();
  if (media.type === 'video' && isLocalMediaUrl(media.videoUrl)) {
    const video = node('video', 'hero-media-asset');
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.src = media.videoUrl;
    if (isLocalMediaUrl(media.posterUrl, true)) video.poster = media.posterUrl;
    video.setAttribute('aria-label', media.alt);
    container.append(video);
    return;
  }
  if (media.type === 'image' && isLocalMediaUrl(media.imageUrl, true)) {
    const image = node('img', 'hero-media-asset');
    image.src = media.imageUrl;
    image.alt = media.alt;
    container.append(image);
    return;
  }
  const placeholder = node('div', 'hero-media-placeholder');
  const mark = node('div', 'media-placeholder-mark', 'L');
  const label = node('div', 'media-placeholder-copy');
  label.append(node('span', '', media.label), node('strong', '', media.status));
  placeholder.append(mark, label);
  container.append(placeholder);
}

function renderLandingContent() {
  const content = landingContent;
  elements.announcementBar.classList.toggle('hidden', content.announcement.enabled !== true);
  setLandingText('#announcement-text', content.announcement.text);
  setLandingText('#announcement-label', content.announcement.linkLabel);
  $('#announcement-link').href = content.announcement.href;

  setLandingText('#hero-eyebrow', content.hero.eyebrow);
  setLandingText('#hero-title', content.hero.title);
  setLandingText('#hero-description', content.hero.description);
  setLandingText('#hero-boundary', content.hero.boundary);
  const heroActions = $('#hero-actions');
  heroActions.replaceChildren(
    landingAction(content.hero.primaryAction, 'landing-primary'),
    landingAction(content.hero.secondaryAction, 'landing-secondary')
  );
  renderLandingMedia(content.hero.media);

  setLandingText('#partner-heading', content.partners.heading);
  setLandingText('#partner-note', content.partners.note);
  const partnerTrack = $('#partner-track');
  partnerTrack.replaceChildren();
  for (const partner of content.partners.items) {
    const item = node('article', 'partner-placeholder');
    if (isLocalMediaUrl(partner.logoUrl, true)) {
      const logo = node('img');
      logo.src = partner.logoUrl;
      logo.alt = partner.label;
      item.append(logo);
    } else {
      item.append(node('strong', '', partner.label), node('span', '', partner.status));
    }
    partnerTrack.append(item);
  }

  setLandingText('#value-eyebrow', content.value.eyebrow);
  setLandingText('#value-lead', content.value.lead);
  setLandingText('#value-supporting', content.value.supporting);
  setLandingText('#value-highlight', content.value.highlight);

  const capabilityList = $('#capability-list');
  capabilityList.replaceChildren();
  for (const capability of content.capabilities) {
    const article = node('article', `capability-row ${capability.tone}`);
    article.dataset.reveal = '';
    article.tabIndex = 0;
    const meta = node('div', 'capability-meta');
    meta.append(node('span', '', capability.index), node('small', '', capability.status));
    const body = node('div', 'capability-body');
    body.append(node('h3', '', capability.title), node('p', '', capability.description));
    if (capability.action) body.append(landingAction(capability.action, 'capability-action'));
    article.append(meta, body, node('span', 'capability-arrow', '↗'));
    capabilityList.append(article);
  }

  const scenarioGrid = $('#scenario-grid');
  scenarioGrid.replaceChildren();
  for (const [index, scenario] of content.scenarios.entries()) {
    const article = node('article', 'scenario-card');
    article.dataset.reveal = '';
    article.append(
      node('span', 'scenario-index', String(index + 1).padStart(2, '0')),
      node('small', '', scenario.label),
      node('h3', '', scenario.title),
      node('p', '', scenario.description),
      node('strong', '', scenario.status)
    );
    scenarioGrid.append(article);
  }

  setLandingText('#security-eyebrow', content.security.eyebrow);
  setLandingText('#security-title', content.security.title);
  setLandingText('#security-description', content.security.description);
  const securityList = $('#security-list');
  securityList.replaceChildren();
  for (const [index, item] of content.security.items.entries()) {
    const article = node('article');
    article.append(
      node('span', '', String(index + 1).padStart(2, '0')),
      node('strong', '', item.title),
      node('small', '', item.detail)
    );
    securityList.append(article);
  }

  setLandingText('#resource-heading', content.resources.heading);
  setLandingText('#resource-description', content.resources.description);
  const resourceGrid = $('#resource-grid');
  resourceGrid.replaceChildren();
  for (const resource of content.resources.items) {
    const article = node('article', 'resource-card');
    article.dataset.reveal = '';
    article.append(
      node('span', '', resource.type),
      node('h3', '', resource.title),
      node('strong', '', resource.status),
      node('i', '', '↗')
    );
    resourceGrid.append(article);
  }

  setLandingText('#about-eyebrow', content.about.eyebrow);
  setLandingText('#about-title', content.about.title);
  setLandingText('#about-description', content.about.description);
  const aboutFields = $('#about-fields');
  aboutFields.replaceChildren();
  for (const field of content.about.fields) {
    const row = node('div');
    row.append(node('dt', '', field.label), node('dd', '', field.value));
    aboutFields.append(row);
  }

  setLandingText('#cta-eyebrow', content.finalCallToAction.eyebrow);
  setLandingText('#cta-title', content.finalCallToAction.title);
  setLandingText('#cta-description', content.finalCallToAction.description);
  const ctaActions = $('#cta-actions');
  ctaActions.replaceChildren(
    landingAction(content.finalCallToAction.primaryAction, 'landing-primary light-action'),
    landingAction(content.finalCallToAction.secondaryAction, 'landing-secondary light-action')
  );
  setLandingText('#footer-product-line', content.footer.productLine);
  setLandingText('#footer-boundary', content.footer.boundary);
}

function closeLandingMenu() {
  elements.landingMenuToggle.setAttribute('aria-expanded', 'false');
  elements.landingMenuToggle.setAttribute('aria-label', '打开导航菜单');
  elements.landingMobileMenu.hidden = true;
}

function initLandingInteractions() {
  elements.landingMenuToggle.addEventListener('click', () => {
    const open = elements.landingMenuToggle.getAttribute('aria-expanded') === 'true';
    elements.landingMenuToggle.setAttribute('aria-expanded', String(!open));
    elements.landingMenuToggle.setAttribute('aria-label', open ? '打开导航菜单' : '关闭导航菜单');
    elements.landingMobileMenu.hidden = open;
  });
  elements.landingMobileMenu.querySelectorAll('a').forEach((link) =>
    link.addEventListener('click', closeLandingMenu)
  );
  $('#announcement-close').addEventListener('click', () =>
    elements.announcementBar.classList.add('hidden')
  );

  const revealTargets = document.querySelectorAll('[data-reveal]');
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    revealTargets.forEach((target) => target.classList.add('is-visible'));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      },
      { root: elements.landingPage, threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );
    revealTargets.forEach((target) => revealObserver.observe(target));
  }

  let frameRequested = false;
  const syncNavTone = () => {
    frameRequested = false;
    const navLine = elements.landingNav.getBoundingClientRect().bottom + 2;
    let tone = 'light';
    for (const section of document.querySelectorAll('[data-nav-section]')) {
      const bounds = section.getBoundingClientRect();
      if (bounds.top <= navLine && bounds.bottom > navLine) {
        tone = section.dataset.navSection;
        break;
      }
    }
    elements.landingNav.dataset.tone = tone;
  };
  elements.landingPage.addEventListener('scroll', () => {
    if (frameRequested) return;
    frameRequested = true;
    window.requestAnimationFrame(syncNavTone);
  }, { passive: true });
  syncNavTone();
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? '本地服务请求失败。');
  return body;
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.setTimeout(() => elements.toast.classList.remove('show'), 2400);
}

function setBusy(value) {
  state.busy = value;
  elements.send.disabled = value;
  elements.input.disabled = value;
  elements.send.firstChild.textContent = value ? 'Agent 处理中 ' : '发送 ';
}

function scrollBottom() {
  window.requestAnimationFrame(() => { elements.scroll.scrollTop = elements.scroll.scrollHeight; });
}

function enterWorkspace(mode = 'v0') {
  closeLandingMenu();
  elements.landingPage.classList.add('hidden');
  elements.workspaceApp.classList.remove('hidden');
  resetConversation(mode);
  if (!state.consentGranted) elements.privacyModal.classList.remove('hidden');
  else elements.input.focus();
}

function returnToLanding() {
  if (state.busy) return;
  closeConfirmModal();
  elements.privacyModal.classList.add('hidden');
  elements.workspaceApp.classList.add('hidden');
  elements.landingPage.classList.remove('hidden');
  elements.landingPage.scrollTo({ top: 0, behavior: 'smooth' });
}

function addMessage(role, text, label) {
  const row = node('div', `message ${role}`);
  if (role === 'assistant') row.append(node('div', 'avatar', 'AI'));
  const bubble = node('div', 'bubble');
  if (label) bubble.append(node('span', 'message-label', label));
  bubble.append(document.createTextNode(text));
  row.append(bubble);
  elements.conversation.append(row);
  scrollBottom();
}

function addLoading() {
  const row = node('div', 'message assistant');
  row.dataset.loading = 'true';
  row.append(node('div', 'avatar', 'AI'));
  const bubble = node('div', 'bubble loading-bubble');
  bubble.append(node('span'), node('span'), node('span'));
  row.append(bubble);
  elements.conversation.append(row);
  scrollBottom();
}

function showMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  document.querySelectorAll('.sample-card').forEach((card) => card.classList.toggle('hidden', card.dataset.mode !== mode));
  const v1 = mode === 'v1';
  const sandbox = mode === 'sandbox';
  elements.sandboxControls.classList.toggle('hidden', !sandbox);
  elements.openSchema.classList.toggle('hidden', !v1);
  elements.input.maxLength = sandbox ? 65536 : 5000;
  if (sandbox) {
    elements.welcomeIcon.textContent = '>_';
    elements.welcomeEyebrow.textContent = '受治理的脚本执行';
    elements.welcomeTitle.textContent = '先审阅计划，再在隔离环境中执行';
    elements.welcomeCopy.textContent = '支持 Python 与 Shell。脚本和所选文件只进入一次性工作区；网络关闭，限制 1 核 CPU、512 MiB 内存和 30 秒执行时间。';
    elements.artifactsSection.classList.add('hidden');
    elements.logsSection.classList.add('hidden');
    elements.scopeBanner.textContent = state.config?.sandbox?.available
      ? 'Docker Sandbox 已接入；确认前不会执行，结束后销毁容器与临时工作区。'
      : 'Docker Sandbox 当前未配置。请先按 README 设置固定镜像摘要并启用。';
    elements.input.placeholder = '输入需要隔离执行的 Python 或 Shell 脚本…';
    elements.pageTitle.textContent = '脚本沙箱';
    return;
  }
  elements.welcomeIcon.textContent = v1 ? '∑' : '§';
  elements.welcomeEyebrow.textContent = v1 ? '专业结构化数据查询' : '法律信息辅助';
  elements.welcomeTitle.textContent = v1 ? '从自然语言到可核验的数据结果' : '把事情说清楚，先完成一次法律自检';
  elements.welcomeCopy.textContent = v1
    ? '同一个 Agent 会识别数据任务，加载固定演示 Schema，生成只读查询计划，确认执行后返回表格、图表与可下载分析文档。'
    : '统一 Agent 会先脱敏，再判断所属领域；信息不足时每轮最多追问两个问题。结果只引用本地已核验法条，不构成法律意见。';
  elements.artifactsSection.classList.toggle('hidden', !v1);
  const mayReadLogs = hasAccess(accessActions.executionLogRead);
  elements.logsSection.classList.toggle('hidden', !v1 || !mayReadLogs);
  if (v1 && mayReadLogs) refreshV1Panels();
  elements.scopeBanner.textContent = v1
    ? '当前使用匿名合成演示案例库，查询计划、汇总表、图表和分析文档均可完整演示。'
    : '当前法规库为 Demo 最小样本；未匹配不代表不存在相关法律。';
  elements.input.placeholder = v1
    ? '例如：统计近三年案例库中未签劳动合同案件的胜诉率……'
    : '请描述发生了什么，避免粘贴不必要的敏感信息……';
  elements.pageTitle.textContent = v1 ? '开始一次数据分析' : '开始一次新的自检';
}

function resetConversation(mode = state.mode) {
  state.activeSessionId = null;
  state.activeStatus = null;
  state.artifacts = [];
  state.pendingSandboxPlanId = null;
  closeConfirmModal();
  renderArtifacts();
  elements.conversation.replaceChildren();
  elements.welcome.classList.remove('hidden');
  elements.deleteSession.classList.add('hidden');
  elements.sessionStatus.textContent = '等待任务';
  elements.sessionRound.textContent = mode === 'v1' ? '只读演示数据' : '最多追问 5 轮';
  elements.sessionOrb.className = 'status-orb';
  elements.domainLabel.textContent = '未识别';
  elements.agentRoute.textContent = '待识别';
  elements.factsList.replaceChildren();
  const row = node('div');
  row.append(node('dt', '', '状态'), node('dd', '', '等待输入'));
  elements.factsList.append(row);
  document.querySelectorAll('.history-item').forEach((item) => item.classList.remove('active'));
  showMode(mode);
  elements.input.focus();
}

function renderFacts(result) {
  elements.factsList.replaceChildren();
  if (result.taskType === 'professional_data_query' && result.v1) {
    const writePlan = result.v1.plan?.readOnly === false;
    const presentation = writePlan ? null : v1Presentation.buildPresentation(result.v1);
    elements.domainLabel.textContent = writePlan || !presentation?.isDemo
      ? '业务案例库'
      : '演示案例库';
    const pendingValue = result.status === 'cancelled' ? '已取消' : '待执行';
    const sourceCount = Number.isSafeInteger(presentation?.counts.sourceCount)
      ? String(presentation.counts.sourceCount)
      : pendingValue;
    const matchedCount = Number.isSafeInteger(presentation?.counts.matchedCount)
      ? String(presentation.counts.matchedCount)
      : pendingValue;
    const groupCount = Number.isSafeInteger(presentation?.counts.groupCount)
      ? String(presentation.counts.groupCount)
      : pendingValue;
    const entries = writePlan
      ? [
          ['数据源', result.v1.schema?.dataSource ?? '已配置'],
          ['Schema', result.v1.plan?.schemaVerified ? '已校验' : '未校验'],
          ['权限', 'Human Review 写入'],
          ['事务', result.v1.result?.transactionStatus ?? '待审批'],
          ['影响行数', String(result.v1.result?.affectedRows ?? '待执行')]
        ]
      : [
          ['数据源', presentation.dataSourceName],
          ['Schema', result.v1.plan?.schemaVerified ? '已校验' : '未校验'],
          ['权限', result.v1.safety?.readOnly ? '只读' : '已拒绝'],
          ...(presentation.isDemo
            ? [['案例总量', sourceCount], ['本次匹配', matchedCount]]
            : [['本次匹配', matchedCount], ['汇总年度', groupCount]])
        ];
    for (const [key, value] of entries) {
      const row = node('div'); row.append(node('dt', '', key), node('dd', '', value)); elements.factsList.append(row);
    }
    return;
  }
  elements.domainLabel.textContent = result.legalDomainLabel ?? '未识别';
  const facts = Object.entries(result.knownFacts ?? {});
  const entries = facts.length ? facts.map(([key, value]) => [factLabels[key] ?? key, valueLabels[value] ?? String(value)]) : [['状态', '等待更多信息']];
  for (const [key, value] of entries) {
    const row = node('div'); row.append(node('dt', '', key), node('dd', '', value)); elements.factsList.append(row);
  }
}

function renderStatus(result) {
  const labels = {
    needs_clarification: '需要补充信息', needs_domain_clarification: '需要确认领域', completed: '任务已完成',
    information_ready: '信息已收集', rejected: '已安全拒绝', unsupported_domain: '暂不支持该领域',
    clarification_limit_reached: '已到追问上限', failed: '处理失败',
    awaiting_confirmation: '等待执行确认', cancelled: '已取消执行', archived: '已归档'
  };
  elements.sessionStatus.textContent = labels[result.status] ?? '处理中';
  elements.sessionRound.textContent = result.taskType === 'professional_data_query'
    ? (result.status === 'awaiting_confirmation'
        ? (result.v1?.plan?.readOnly === false ? '写入计划 · 等待 Human Review' : '只读计划 · 等待确认')
        : result.status === 'cancelled'
          ? '已取消 · 未执行'
          : (result.v1?.plan?.readOnly === false
              ? '单行事务 · 受治理写入'
              : (result.v1?.safety?.readOnly ? '固定 Schema · 只读执行' : '未执行')))
    : `追问轮次 ${result.clarificationRound ?? 0} / 5`;
  elements.sessionOrb.className = 'status-orb';
  const orbClass = result.status === 'completed'
    ? 'done'
    : ['failed', 'rejected'].includes(result.status)
      ? 'error'
      : result.status === 'cancelled'
        ? null
        : 'active';
  if (orbClass) elements.sessionOrb.classList.add(orbClass);
}

function addQuestions(questions) {
  const row = node('div', 'message assistant'); row.append(node('div', 'avatar', 'AI'));
  const bubble = node('div', 'bubble'); bubble.append(node('span', 'message-label', 'AGENT 追问'), document.createTextNode('为了继续核对，请回答：'));
  const list = node('ol', 'question-list'); questions.forEach((question) => list.append(node('li', '', question))); bubble.append(list); row.append(bubble); elements.conversation.append(row);
}

function addResultCards(result) {
  const stack = node('div', 'result-stack');
  for (const card of result.resultCards ?? []) {
    const article = node('article', 'result-card');
    const header = node('div', 'result-card-header'); header.append(node('span', '', card.findingLabel ?? '可能存在不合规风险'));
    const copy = node('button', 'copy-button', '复制法条'); copy.type = 'button';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(`${card.lawName}${card.articleNumber}\n${card.articleText}`); toast('法条已复制'); } catch { toast('请手动选择法条文本'); } });
    header.append(copy);
    const body = node('div', 'result-card-body'); body.append(node('h3', '', `${card.lawName} ${card.articleNumber}`));
    body.append(node('p', 'law-meta', `版本日期：${card.lawVersionDate} · 正文完整性已校验`), node('p', 'law-text', card.articleText));
    if (card.userExcerpt) body.append(node('p', 'user-excerpt', `脱敏事实片段：${card.userExcerpt}`));
    const source = node('a', 'source-link', `官方来源：${card.officialSource.authority}`); source.href = card.officialSource.url; source.target = '_blank'; source.rel = 'noreferrer'; body.append(source);
    article.append(header, body); stack.append(article);
  }
  elements.conversation.append(stack);
  if (result.disclaimer) elements.conversation.append(node('div', 'disclaimer', result.disclaimer));
}

function addSelfCheckSummary(result) {
  const cards = result.resultCards ?? [];
  const stack = node('div', 'result-stack');
  const article = node('article', 'result-card self-check-summary');
  const header = node('div', 'result-card-header');
  header.append(node('span', '', cards.length ? '初步法律自检结果' : '本次法律自检结果'));
  const body = node('div', 'result-card-body');
  const title = cards.length
    ? `找到 ${cards.length} 条可能相关的法规核对项`
    : result.lawRetrievalStatus === 'no_match'
      ? '当前法规语料暂未找到安全匹配'
      : '当前未能生成可核验的结果卡片';
  body.append(node('h3', '', title));
  const summary = cards.length
    ? '以下内容根据你提供的脱敏事实与固定法规语料生成，用于识别可能相关的规则和仍需确认的条件。'
    : result.lawRetrievalStatus === 'failed'
      ? '法规检索环节暂时不可用。本次不会用模型常识补写法条，请稍后重新核对。'
      : result.lawComparisonStatus === 'failed' || result.resultCardStatus === 'failed'
        ? '候选法规的核对环节未能完成。本次没有输出未经验证的判断。'
        : '这不代表不存在相关法律，只表示当前首版语料和事实条件不足以安全展示匹配结果。';
  body.append(node('p', 'summary-copy', summary));
  if (cards.length) {
    const list = node('ul', 'summary-list');
    for (const card of cards) {
      list.append(node('li', '', `${card.lawName} ${card.articleNumber} · ${card.findingLabel}`));
    }
    body.append(list);
  }
  const next = node('div', 'result-next-step');
  next.append(
    node('strong', '', '建议下一步'),
    node(
      'p',
      '',
      cards.length
        ? '保存合同、通知、工资记录等原始证据；涉及期限、金额或争议处理时，携带完整材料咨询专业人士。'
        : '可以新建核对并在首次描述中写明争议主体、发生事项、时间和现有证据。'
    )
  );
  body.append(next);
  article.append(header, body);
  stack.append(article);
  elements.conversation.append(stack);
}

function addTerminalError(result) {
  const stack = node('div', 'result-stack');
  const article = node('article', 'result-card incomplete-card terminal-error-card');
  const header = node('div', 'result-card-header');
  const unsupported = result.status === 'unsupported_domain';
  header.append(node('span', '', unsupported ? '暂未识别法律领域' : '本次处理已安全停止'));
  const body = node('div', 'result-card-body');
  body.append(
    node('h3', '', unsupported ? '请补充争议主体和具体事项' : '当前请求未能继续处理'),
    node('p', 'summary-copy', result.error?.message ?? '请新建任务后重试。')
  );
  if (unsupported) {
    body.append(node('p', 'law-meta', '可直接选择一个首版支持领域并继续描述：'));
    const choices = node('div', 'domain-choice-list');
    for (const label of ['劳动用工', '婚姻家庭', '民间借贷', '税务', '知识产权']) {
      const button = node('button', 'domain-choice', label);
      button.type = 'button';
      button.addEventListener('click', () => {
        resetConversation('v0');
        elements.input.value = `我想咨询${label}问题：`;
        elements.characterCount.textContent = String(elements.input.value.length);
        elements.input.focus();
      });
      choices.append(button);
    }
    body.append(choices);
  }
  article.append(header, body);
  stack.append(article);
  elements.conversation.append(stack);
}

function addIncompleteSummary(result) {
  const stack = node('div', 'result-stack');
  const article = node('article', 'result-card incomplete-card');
  const header = node('div', 'result-card-header');
  header.append(node('span', '', '本次核对未完成'));
  const body = node('div', 'result-card-body');
  body.append(
    node('h3', '', '仍缺少完成可靠核对所需的信息'),
    node('p', 'law-meta', `已完成 ${result.clarificationRound ?? 5} 轮信息确认`)
  );
  const list = node('ul', 'missing-list');
  for (const field of result.missingFields ?? []) {
    list.append(node('li', '', factLabels[field] ?? field));
  }
  if (list.children.length) body.append(list);
  body.append(
    node(
      'p',
      'law-text',
      '为避免给出未经验证的判断，本次没有生成法律风险卡片。新建核对时可在首次描述中一并补充上述信息。'
    )
  );
  article.append(header, body); stack.append(article); elements.conversation.append(stack);
  if (result.disclaimer) elements.conversation.append(node('div', 'disclaimer', result.disclaimer));
}

function addV1Result(result) {
  const data = result.v1;
  if (data.status !== 'completed') {
    addMessage('assistant', data.reason ?? '该数据任务未执行。', '安全边界');
    return;
  }
  if (data.plan?.readOnly === false) {
    const board = node('section', 'v1-board');
    const heading = node('div', 'v1-heading');
    const titleWrap = node('div');
    titleWrap.append(node('span', 'message-label', '受治理写入'), node('h3', '', '数据库写操作已完成'));
    heading.append(titleWrap, node('span', 'verified-badge', '✓ Human Review 已完成'));
    const plan = node('div', 'sql-panel');
    plan.append(node('div', 'sql-toolbar', '写入 SQL · 已审批并提交'), node('pre', '', data.plan.sql));
    const resultCard = node(
      'div',
      'demo-boundary',
      `事务状态：${data.result.transactionStatus} · 影响行数：${data.result.affectedRows}`
    );
    const receipt = node(
      'p',
      'plan-explanation',
      `治理状态：${data.governanceReceipt?.status ?? 'resolved'} · 事件数：${data.governanceReceipt?.eventCount ?? 0}`
    );
    board.append(heading, plan, resultCard, receipt);
    elements.conversation.append(board);
    return;
  }
  const presentation = v1Presentation.buildPresentation(data);
  const board = node('section', 'v1-board');
  const heading = node('div', 'v1-heading');
  const titleWrap = node('div'); titleWrap.append(node('span', 'message-label', '查询计划'), node('h3', '', presentation.title));
  heading.append(titleWrap, node('span', 'verified-badge', '✓ Schema 已校验'));
  const plan = node('div', 'sql-panel'); plan.append(node('div', 'sql-toolbar', '只读 SQL 计划 · 已确认执行'), node('pre', '', data.plan.sql));
  const tableWrap = node('div', 'table-wrap');
  const table = node('table', 'data-table');
  const thead = node('thead'); const header = node('tr'); presentation.table.columns.forEach((column) => header.append(node('th', '', column.label))); thead.append(header);
  const tbody = node('tbody');
  for (const values of presentation.table.rows) {
    const tr = node('tr');
    values.forEach((value) => tr.append(node('td', '', value)));
    tbody.append(tr);
  }
  table.append(thead, tbody); tableWrap.append(table);
  const chart = node('div', 'chart-panel'); chart.append(node('h4', '', data.chart.title));
  const bars = node('div', 'bars');
  data.chart.labels.forEach((label, index) => {
    const item = node('div', 'bar-item');
    const value = data.chart.series[0].values[index];
    const bar = node('div', 'bar'); bar.style.setProperty('--bar-value', `${value}%`); bar.append(node('span', '', `${value}%`));
    item.append(bar, node('small', '', label)); bars.append(item);
  });
  chart.append(bars);
  const footer = node('div', 'artifact-row');
  const note = node('div'); note.append(node('strong', '', data.artifact.fileName), node('span', '', '分析文档 · 本地生成'));
  const actions = node('div', 'artifact-actions');
  const download = node('button', 'artifact-button', '下载分析文档'); download.type = 'button';
  download.addEventListener('click', () =>
    downloadArtifact(data.artifact).catch((error) => toast(error.message))
  );
  const pdf = node('button', 'artifact-button', '导出 PDF'); pdf.type = 'button';
  pdf.addEventListener('click', () => exportV1Pdf(data));
  actions.append(download, pdf);
  footer.append(note, actions);
  const boundary = node('div', 'demo-boundary', presentation.summary);
  board.append(heading, plan, tableWrap, chart, footer, boundary); elements.conversation.append(board);
  registerArtifact(data.artifact);
}

function addV1PlanCard(result) {
  const data = result.v1;
  if (!data?.plan) return;
  const board = node('section', 'v1-board');
  const heading = node('div', 'v1-heading');
  const writePlan = data.plan.readOnly === false;
  const planTitle = writePlan
    ? '单案例数据库变更'
    : v1Presentation.buildPresentation(data).title;
  const titleWrap = node('div');
  titleWrap.append(
    node('span', 'message-label', writePlan ? '写入计划' : '查询计划'),
    node('h3', '', planTitle)
  );
  heading.append(titleWrap, node('span', 'verified-badge', '✓ Schema 已校验'));
  const toolbarText = writePlan
    ? '写入 SQL 计划 · 等待 Human Review'
    : (data.status === 'awaiting_confirmation' ? '只读 SQL 计划 · 等待确认执行' : '只读 SQL 计划 · 未执行');
  const plan = node('div', 'sql-panel'); plan.append(node('div', 'sql-toolbar', toolbarText), node('pre', '', data.plan.sql));
  const explanation = node('p', 'plan-explanation', data.plan.explanation ?? '固定演示 Schema 的只读查询计划。');
  const badges = node('div', 'plan-badges');
  badges.append(
    node('span', 'verified-badge', writePlan ? '单行写入' : '只读'),
    node('span', 'verified-badge', writePlan ? 'Hypha Human Review' : '需人工确认')
  );
  const boundary = node(
    'div',
    'demo-boundary',
    writePlan
      ? '该计划会修改一条业务数据。批准后使用单个事务执行；失败、超行或超时均不提交，并且不会自动重试。'
      : '该计划仅读取固定演示 Schema 的匿名合成数据，确认后才会执行，不会产生任何写操作。'
  );
  board.append(heading, plan, explanation, badges, boundary); elements.conversation.append(board);
}

function addSchemaDriftCard(result) {
  const drift = result.v1?.schemaDrift;
  if (!drift?.detected) return;
  const board = node('section', 'v1-board');
  const heading = node('div', 'v1-heading');
  const titleWrap = node('div');
  titleWrap.append(node('span', 'message-label', 'Schema 变化通知'), node('h3', '', '旧查询计划已安全停止'));
  heading.append(titleWrap, node('span', 'verified-badge', '需重新规划'));
  const summary = drift.summary ?? {};
  const detail = node('div', 'demo-boundary', drift.notification ?? '检测到 Schema 变化，旧计划未执行。');
  const fields = node(
    'p',
    'plan-explanation',
    drift.affectedFields?.length
      ? `受影响字段：${drift.affectedFields.join('、')}`
      : `差异摘要：新增字段 ${summary.addedColumns ?? 0}，移除字段 ${summary.removedColumns ?? 0}，变更字段 ${summary.changedColumns ?? 0}`
  );
  board.append(heading, detail, fields);
  if (result.v1?.replanRequired === true) {
    const button = node('button', 'primary-button', '基于当前 Schema 重新生成计划');
    button.type = 'button';
    button.addEventListener('click', replanExecution);
    board.append(button);
  }
  elements.conversation.append(board);
}

function openConfirmModal(result) {
  const data = result?.v1;
  const writePlan = data?.plan?.readOnly === false;
  elements.confirmExplanation.textContent = data?.plan?.explanation ?? 'Agent 已生成固定演示 Schema 的只读查询计划，确认后才会执行。';
  elements.confirmSql.textContent = data?.plan?.sql ?? '';
  const toolbar = elements.confirmModal.querySelector('.sql-toolbar');
  if (toolbar) toolbar.textContent = writePlan ? '写入 SQL 计划 · 等待 Human Review' : '只读 SQL 计划 · 等待确认';
  const title = $('#confirm-title');
  if (title) title.textContent = writePlan ? '确认批准该数据库写操作？' : '确认执行该查询计划？';
  const note = elements.confirmModal.querySelector('.confirm-note');
  if (note) note.textContent = writePlan
    ? '这是数据库写操作。批准后将通过 Hypha Human Review 恢复执行；事务失败或影响超过 1 行时不会提交。'
    : '查询仅读取授权 Schema，确认后才会执行，不会产生任何写操作。';
  elements.confirmAccept.textContent = writePlan ? '批准并执行写入' : '确认执行';
  elements.confirmAccept.disabled = false;
  elements.confirmCancel.disabled = false;
  elements.confirmModal.classList.remove('hidden');
}

function closeConfirmModal() {
  elements.confirmModal.classList.add('hidden');
  elements.confirmExplanation.textContent = '';
  elements.confirmSql.textContent = '';
}

async function confirmExecution(confirmed) {
  if (!state.activeSessionId || state.busy) return;
  elements.confirmAccept.disabled = true;
  elements.confirmCancel.disabled = true;
  addMessage('user', confirmed ? '确认执行查询计划。' : '取消本次查询。');
  const startedAt = performance.now();
  try {
    const result = await api(`/api/sessions/${state.activeSessionId}/execution-confirmation`, {
      method: 'POST',
      body: JSON.stringify({ confirmed })
    });
    if (confirmed && result.status === 'completed') {
      state.lastExecutionMs = Math.round(performance.now() - startedAt);
    }
    closeConfirmModal();
    state.activeStatus = result.status;
    renderStatus(result); renderFacts(result);
    if (result.error) addMessage('assistant', result.error.message, '安全停止');
    else if (result.status === 'completed' && result.v1?.status === 'completed') {
      addMessage('assistant', result.assistantMessage ?? '专业数据分析已完成。', '智能助手');
      addV1Result(result);
    } else if (result.v1?.schemaDrift?.detected) {
      addMessage('assistant', result.assistantMessage ?? result.v1.schemaDrift.notification, 'Schema 变化');
      addSchemaDriftCard(result);
    } else {
      addMessage('assistant', result.assistantMessage ?? '已按你的选择取消本次专业数据分析，查询未执行。', '安全边界');
    }
    await loadHistory(); refreshV1Panels();
  } catch (error) {
    elements.confirmAccept.disabled = false;
    elements.confirmCancel.disabled = false;
    addMessage('assistant', error.message, '请求失败');
  } finally { scrollBottom(); }
}

async function replanExecution() {
  if (!state.activeSessionId || state.busy) return;
  setBusy(true);
  addMessage('user', '基于当前 Schema 重新生成查询计划。');
  try {
    const result = await api(`/api/sessions/${state.activeSessionId}/schema-replan`, {
      method: 'POST',
      body: JSON.stringify({ requested: true })
    });
    state.activeStatus = result.status;
    renderStatus(result); renderFacts(result);
    if (result.status === 'awaiting_confirmation') {
      addMessage('assistant', result.assistantMessage ?? '已基于当前 Schema 生成新计划，请重新确认。', '重新规划完成');
      addV1PlanCard(result);
      openConfirmModal(result);
    } else {
      addMessage('assistant', result.assistantMessage ?? result.v1?.reason ?? '重新规划未完成。', '安全停止');
      addSchemaDriftCard(result);
    }
    await loadHistory(); refreshV1Panels();
  } catch (error) {
    addMessage('assistant', error.message, '请求失败');
  } finally {
    setBusy(false); scrollBottom();
  }
}

async function downloadArtifact(artifact) {
  const downloadable =
    typeof artifact?.content === 'string'
      ? artifact
      : artifact?.downloadPath
        ? (await api(artifact.downloadPath)).artifact
        : null;
  if (!downloadable || typeof downloadable.content !== 'string') {
    throw new Error('分析产物正文不可下载。');
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(
    new Blob([downloadable.content], { type: downloadable.mimeType })
  );
  link.download = downloadable.fileName; link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// PDF 导出：把分析文档绘制到 Canvas，导出 JPEG 后嵌入极简 PDF（零依赖，纯前端）。
function buildPdfFromJpeg(jpegBytes, imgWidth, imgHeight) {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 24;
  const scale = Math.min((pageWidth - margin * 2) / imgWidth, (pageHeight - margin * 2) / imgHeight);
  const drawWidth = imgWidth * scale;
  const drawHeight = imgHeight * scale;
  const offsetX = (pageWidth - drawWidth) / 2;
  const offsetY = pageHeight - drawHeight - margin;
  const encoder = new TextEncoder();
  const chunks = [];
  let length = 0;
  const push = (data) => { chunks.push(data); length += data.length; };
  const pushText = (text) => push(encoder.encode(text));
  const offsets = [0];
  pushText('%PDF-1.4\n');
  const beginObject = (id) => { offsets[id] = length; pushText(`${id} 0 obj\n`); };
  beginObject(1); pushText('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObject(2); pushText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  beginObject(3);
  pushText(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>\nendobj\n`);
  beginObject(4);
  pushText(`<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${imgHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes); pushText('\nendstream\nendobj\n');
  const content = `q ${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${offsetX.toFixed(2)} ${offsetY.toFixed(2)} cm /Im0 Do Q`;
  beginObject(5);
  pushText(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  const xrefStart = length;
  pushText('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id += 1) pushText(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  pushText(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  const pdf = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { pdf.set(chunk, position); position += chunk.length; }
  return pdf;
}

function renderV1ReportCanvas(data, executionMs) {
  const presentation = v1Presentation.buildPresentation(data);
  const width = 1240;
  const pad = 64;
  const contentWidth = width - pad * 2;
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d');
  const font = (size, weight = 'normal', family = '"Microsoft YaHei", "PingFang SC", sans-serif') =>
    `${weight} ${size}px ${family}`;
  const wrapLines = (ctx, text, maxWidth) => {
    const lines = [];
    for (const rawLine of String(text).split('\n')) {
      let line = '';
      for (const char of rawLine) {
        if (ctx.measureText(line + char).width > maxWidth && line) { lines.push(line); line = char; }
        else line += char;
      }
      lines.push(line);
    }
    return lines;
  };
  measure.font = font(15, 'normal', 'Consolas, monospace');
  const sqlLines = (data.plan?.sql ?? '').split('\n');
  const rowHeight = 44;
  const tableRows = presentation.table.rows.length + 1;
  const chartHeight = 300;
  measure.font = font(15);
  const disclaimerLines = wrapLines(measure, presentation.disclaimer, contentWidth);
  const height =
    pad + 44 + 30 + 26 * 3 + 24 + // 标题与元信息
    40 + sqlLines.length * 24 + 48 + // SQL 区块
    40 + tableRows * rowHeight + 32 + // 表格
    40 + chartHeight + 32 + // 图表
    disclaimerLines.length * 24 + pad; // 免责
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
  let y = pad;
  // 标题
  ctx.fillStyle = '#123f31'; ctx.font = font(30, 'bold');
  ctx.fillText(presentation.title, pad, y + 8);
  y += 52;
  // 元信息
  ctx.fillStyle = '#4a5d55'; ctx.font = font(15);
  const meta = [
    `数据源：${presentation.sourceDescription}`,
    `生成时间：${new Date().toLocaleString('zh-CN')} · 执行耗时：${Number.isFinite(executionMs) ? `${executionMs} ms` : '演示执行'}`,
    `${presentation.summary} · 只读计划已经人工确认`
  ];
  for (const line of meta) { ctx.fillText(line, pad, y); y += 26; }
  y += 24;
  // SQL 区块
  ctx.fillStyle = '#123f31'; ctx.font = font(18, 'bold');
  ctx.fillText('只读 SQL 计划（Schema 已校验）', pad, y); y += 16;
  const sqlBoxHeight = sqlLines.length * 24 + 32;
  ctx.fillStyle = '#0f2c22';
  ctx.beginPath(); ctx.roundRect(pad, y, contentWidth, sqlBoxHeight, 12); ctx.fill();
  ctx.fillStyle = '#cde8dc'; ctx.font = font(15, 'normal', 'Consolas, "Courier New", monospace');
  let sqlY = y + 34;
  for (const line of sqlLines) { ctx.fillText(line, pad + 24, sqlY); sqlY += 24; }
  y += sqlBoxHeight + 32;
  // 表格
  ctx.fillStyle = '#123f31'; ctx.font = font(18, 'bold');
  ctx.fillText('查询结果', pad, y); y += 12;
  const columns = presentation.table.columns.map((column) => column.label);
  const colWidth = contentWidth / columns.length;
  const drawRow = (values, header) => {
    ctx.fillStyle = header ? '#e4f0ea' : '#ffffff';
    ctx.fillRect(pad, y, contentWidth, rowHeight);
    ctx.strokeStyle = '#c3d5cd'; ctx.strokeRect(pad, y, contentWidth, rowHeight);
    ctx.fillStyle = '#123f31'; ctx.font = font(15, header ? 'bold' : 'normal');
    values.forEach((value, index) => ctx.fillText(String(value), pad + index * colWidth + 16, y + 29));
    y += rowHeight;
  };
  drawRow(columns, true);
  for (const values of presentation.table.rows) {
    drawRow(values, false);
  }
  y += 32;
  // 图表
  ctx.fillStyle = '#123f31'; ctx.font = font(18, 'bold');
  ctx.fillText(data.chart?.title ?? '统计图表', pad, y); y += 24;
  const labels = data.chart?.labels ?? [];
  const values = data.chart?.series?.[0]?.values ?? [];
  const barAreaWidth = contentWidth - 80;
  const barSlot = labels.length ? barAreaWidth / labels.length : barAreaWidth;
  const barWidth = Math.min(120, barSlot * 0.5);
  const maxBarHeight = chartHeight - 80;
  labels.forEach((label, index) => {
    const value = values[index] ?? 0;
    const barHeight = Math.max(4, (value / 100) * maxBarHeight);
    const x = pad + 40 + index * barSlot + (barSlot - barWidth) / 2;
    const top = y + maxBarHeight - barHeight;
    ctx.fillStyle = '#1d7a5b';
    ctx.beginPath(); ctx.roundRect(x, top, barWidth, barHeight, [8, 8, 0, 0]); ctx.fill();
    ctx.fillStyle = '#123f31'; ctx.font = font(15, 'bold');
    const valueText = `${value}%`;
    ctx.fillText(valueText, x + (barWidth - ctx.measureText(valueText).width) / 2, top - 10);
    ctx.font = font(14);
    ctx.fillText(label, x + (barWidth - ctx.measureText(label).width) / 2, y + maxBarHeight + 26);
  });
  y += chartHeight + 32;
  // 免责
  ctx.fillStyle = '#4a5d55'; ctx.font = font(15);
  for (const line of disclaimerLines) { ctx.fillText(line, pad, y); y += 24; }
  return canvas;
}

async function exportV1Pdf(data) {
  try {
    const executionTimeMs = data.providerReceipt?.durationMs ?? data.artifact?.executionTimeMs ?? state.lastExecutionMs;
    const canvas = renderV1ReportCanvas(data, executionTimeMs);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('canvas export failed');
    const jpegBytes = new Uint8Array(await blob.arrayBuffer());
    const pdf = buildPdfFromJpeg(jpegBytes, canvas.width, canvas.height);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    link.download = (data.artifact?.fileName ?? '案例统计分析.md').replace(/\.md$/i, '.pdf');
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('PDF 已导出');
  } catch {
    toast('PDF 导出失败，请使用分析文档下载');
  }
}

function registerArtifact(artifact) {
  if (!artifact?.fileName) return;
  if (state.artifacts.some((item) => item.fileName === artifact.fileName && item.content === artifact.content)) return;
  state.artifacts.push(artifact);
  renderArtifacts();
}

function renderArtifacts() {
  elements.artifactList.replaceChildren();
  if (!state.artifacts.length) { elements.artifactList.append(node('p', 'muted compact', '本次会话暂无产物')); return; }
  for (const artifact of state.artifacts) {
    const row = node('div', 'artifact-row');
    const note = node('div'); note.append(node('strong', '', artifact.fileName), node('span', '', `${artifact.type ?? '分析文档'} · 本地生成`));
    const download = node('button', 'artifact-button', '下载'); download.type = 'button';
    download.addEventListener('click', () =>
      downloadArtifact(artifact).catch((error) => toast(error.message))
    );
    row.append(note, download);
    elements.artifactList.append(row);
  }
}

async function loadLogs() {
  const status = elements.logFilter.value;
  const query = status ? `?status=${encodeURIComponent(status)}&limit=50` : '?limit=50';
  const result = await api(`/api/v1/logs${query}`);
  renderLogs(result.logs ?? [], result.integrity);
}

function renderLogs(logs, integrity) {
  elements.logList.replaceChildren();
  if (integrity) {
    const integrityLabels = {
      empty: '审计链为空',
      verified: '审计链已校验',
      legacy_unverified: '旧版日志尚未建立校验锚点',
      verified_with_legacy_anchor: '审计链已校验（含旧版记录锚点）',
      unavailable: '审计链校验不可用'
    };
    const label = integrityLabels[integrity.status] ?? `审计链：${integrity.status}`;
    elements.logList.append(
      node('p', 'muted compact', `${label} · ${integrity.recordCount ?? 0} 条记录`)
    );
  }
  if (!logs.length) { elements.logList.append(node('p', 'muted compact', '暂无执行日志')); return; }
  const operationLabels = {
    plan: '计划',
    replan: '重新规划',
    execute: '执行',
    cancel: '取消',
    sandbox_plan: 'Sandbox 计划',
    sandbox_execute: 'Sandbox 执行',
    sandbox_reject: 'Sandbox 拒绝',
    sandbox_expire: 'Sandbox 过期',
    workspace_archive: 'Workspace 归档'
  };
  for (const log of logs) {
    const item = node('div', 'log-item');
    const top = node('div', 'log-item-top');
    top.append(
      node('span', 'log-operation', operationLabels[log.operationType] ?? log.operationType ?? '操作'),
      node('span', `log-badge ${log.status ?? ''}`, log.status ?? '未知')
    );
    const meta = [log.loggedAt ? new Date(log.loggedAt).toLocaleString('zh-CN') : ''];
    if (typeof log.durationMs === 'number') meta.push(`${log.durationMs}ms`);
    if (typeof log.rowCount === 'number') meta.push(`${log.rowCount} 行`);
    if (typeof log.generatedArtifactCount === 'number') {
      meta.push(`${log.generatedArtifactCount} 个产物`);
    }
    if (log.entryId) meta.push(`记录 ${log.entryId.slice(0, 8)}`);
    item.append(top, node('div', 'log-meta', meta.filter(Boolean).join(' · ')));
    if (log.error || log.errorCode) {
      item.append(node('div', 'log-error', log.errorCode ?? log.error));
    }
    elements.logList.append(item);
  }
}

function refreshV1Panels() {
  if (!hasAccess(accessActions.executionLogRead)) return;
  loadLogs().catch((error) => toast(error.message));
}

function openSchemaModal() {
  const schema = state.config?.v1DemoSchema;
  elements.schemaDescription.textContent = schema
    ? `${schema.displayName}（${schema.dataSource}）：${schema.description}`
    : '本地服务未提供演示数据源说明。';
  elements.schemaTableBody.replaceChildren();
  for (const column of schema?.columns ?? []) {
    const tr = node('tr');
    tr.append(node('td', '', column.name), node('td', '', column.type), node('td', '', column.description));
    elements.schemaTableBody.append(tr);
  }
  elements.schemaModal.classList.remove('hidden');
}

function dataSourceStatusLabel(status) {
  if (status === 'ready' || status === 'verified') return '已就绪';
  if (status === 'missing_environment' || status === 'not_configured') return '待配置';
  if (status === 'failed') return '验证失败';
  return status;
}

function renderInitialSchemaSnapshot(snapshot) {
  const browser = node('div', 'initial-schema-browser');
  browser.append(node('strong', 'initial-schema-title', '初始 Schema 快照'));
  for (const table of snapshot?.tables ?? []) {
    const section = node('section', 'initial-schema-table');
    section.append(node('span', 'initial-schema-table-name', `表：${table.name}`));
    const wrap = node('div', 'table-wrap initial-schema-table-wrap');
    const tableElement = node('table', 'data-table');
    const head = node('thead');
    const heading = node('tr');
    for (const label of ['字段', '类型', '可空', '主键序号']) {
      heading.append(node('th', '', label));
    }
    head.append(heading);
    const body = node('tbody');
    for (const column of table.columns ?? []) {
      const row = node('tr');
      row.append(
        node('td', '', column.name),
        node('td', '', column.type),
        node('td', '', column.nullable ? '是' : '否'),
        node('td', '', column.primaryKeyPosition > 0 ? String(column.primaryKeyPosition) : '—')
      );
      body.append(row);
    }
    tableElement.append(head, body);
    wrap.append(tableElement);
    section.append(wrap);
    browser.append(section);
  }
  return browser;
}

function renderDataSourceValidation(container, result) {
  container.replaceChildren();
  container.className = `data-source-validation ${result.status}`;
  if (result.status === 'verified') {
    container.append(
      node('strong', '', '连接与白名单 Schema 已验证'),
      node('span', '', `字段 ${result.columnCount} 个 · 指纹 ${result.schemaFingerprint.slice(0, 12)}…`),
      renderInitialSchemaSnapshot(result.initialSchemaSnapshot)
    );
    return;
  }
  if (result.status === 'not_configured') {
    container.append(
      node('strong', '', '尚未发起连接'),
      node('span', '', `缺少环境变量：${result.missingEnvironmentNames.join('、')}`)
    );
    return;
  }
  container.append(
    node('strong', '', '连接或 Schema 验证失败'),
    node('span', '', '响应已隐藏 Provider 错误和所有连接值，请检查服务端私有配置。')
  );
}

async function validateDataSourceProfile(profileId, button, validation) {
  button.disabled = true;
  button.textContent = '验证中…';
  try {
    const result = await api('/api/v1/admin/data-sources/validation', {
      method: 'POST',
      body: JSON.stringify({ profileId })
    });
    renderDataSourceValidation(validation, result);
  } catch (error) {
    validation.replaceChildren(node('strong', '', '验证请求失败'), node('span', '', error.message));
    validation.className = 'data-source-validation failed';
  } finally {
    button.disabled = false;
    button.textContent = '验证连接与 Schema';
  }
}

function renderDataSourceProfiles(result) {
  elements.dataSourceProfileList.replaceChildren();
  for (const profile of result.profiles) {
    const card = node('article', 'data-source-profile');
    const heading = node('div', 'data-source-profile-heading');
    const title = node('div');
    title.append(
      node('strong', '', profile.engine.toUpperCase()),
      node('span', '', `${profile.profileId}${profile.active ? ' · 当前运行模式' : ''}`)
    );
    heading.append(
      title,
      node(
        'span',
        `data-source-state ${profile.configurationStatus}`,
        dataSourceStatusLabel(profile.configurationStatus)
      )
    );
    const environment = node('dl', 'data-source-environment');
    for (const item of profile.environment) {
      const row = node('div');
      row.append(
        node('dt', '', item.name),
        node('dd', item.configured ? 'configured' : 'missing', item.configured ? '已配置' : '缺失')
      );
      environment.append(row);
    }
    const policy = node(
      'p',
      'data-source-policy',
      `只读 · ${profile.allowedTables.length} 个授权表 · ${profile.allowedColumns.length} 个授权字段 · 最多 ${profile.limits.maxRows} 行`
    );
    const validation = node('div', 'data-source-validation idle');
    validation.append(node('span', '', '尚未执行本次连接验证。'));
    const button = node('button', 'ghost-button data-source-validate', '验证连接与 Schema');
    button.type = 'button';
    button.addEventListener('click', () =>
      validateDataSourceProfile(profile.profileId, button, validation)
    );
    card.append(heading, environment, policy, validation, button);
    elements.dataSourceProfileList.append(card);
  }
}

async function openDataSourceAdmin() {
  elements.dataSourceAdminModal.classList.remove('hidden');
  elements.dataSourceProfileList.replaceChildren(node('p', 'muted compact', '正在读取数据源清单……'));
  try {
    renderDataSourceProfiles(await api('/api/v1/admin/data-sources'));
  } catch (error) {
    elements.dataSourceProfileList.replaceChildren(node('p', 'data-source-load-error', error.message));
  }
}

function renderResult(result) {
  state.activeSessionId = result.sessionId ?? state.activeSessionId;
  state.activeStatus = result.status;
  elements.deleteSession.classList.toggle('hidden', !state.activeSessionId);
  const v1 = result.taskType === 'professional_data_query';
  showMode(v1 ? 'v1' : 'v0');
  elements.pageTitle.textContent = v1 ? '专业数据分析' : (result.legalDomainLabel ? `${result.legalDomainLabel}自检` : '法律自检会话');
  elements.agentRoute.textContent = taskLabels[result.taskType] ?? '待识别';
  renderStatus(result); renderFacts(result);
  const finalSelfCheck =
    !v1 && ['completed', 'information_ready'].includes(result.status);
  if (result.agentExecution && !result.error && !finalSelfCheck) {
    const executionLabel = result.agentExecution.fallbackUsed
      ? '智能分析暂不可用 · 使用本地安全规则'
      : result.agentExecution.providerMode === 'demo'
        ? '本地演示分析'
        : '智能分析';
    addMessage('assistant', result.assistantMessage ?? '智能助手已完成本轮处理。', `智能助手 · ${executionLabel}`);
  }
  if (result.status === 'clarification_limit_reached') addIncompleteSummary(result);
  else if (result.error) addTerminalError(result);
  else if (v1) {
    if (result.status === 'awaiting_confirmation') {
      if (result.assistantMessage) addMessage('assistant', result.assistantMessage, '查询计划');
      addV1PlanCard(result);
      openConfirmModal(result);
    } else if (result.status === 'cancelled') {
      addV1PlanCard(result);
      addMessage('assistant', result.assistantMessage ?? '已按你的选择取消本次专业数据分析，查询未执行。', '安全边界');
    } else if (result.status === 'archived') {
      addMessage('assistant', '该逻辑查询 Workspace 已因超过 30 天未活动而归档。结果与 Artifact 引用保持只读，继续查询请新建任务。', 'Workspace 归档');
      if (result.v1?.result && result.v1?.artifact) {
        addV1Result({ ...result, v1: { ...result.v1, status: 'completed' } });
      }
    } else if (result.v1?.schemaDrift?.detected) {
      addMessage('assistant', result.assistantMessage ?? result.v1.schemaDrift.notification, 'Schema 变化');
      addSchemaDriftCard(result);
    } else addV1Result(result);
  }
  else if ((result.questions ?? []).length) addQuestions(result.questions);
  else if (finalSelfCheck) {
    addSelfCheckSummary(result);
    if ((result.resultCards ?? []).length) addResultCards(result);
  }
  scrollBottom();
}

function canContinue(status) { return ['needs_clarification', 'needs_domain_clarification', 'active'].includes(status); }

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function sandboxInputFiles() {
  const files = [...elements.sandboxFiles.files];
  const limits = state.config?.sandboxLimits ?? { maxInputFiles: 32, maxInputBytes: 16 * 1024 * 1024 };
  if (files.length > limits.maxInputFiles) throw new Error(`最多选择 ${limits.maxInputFiles} 个输入文件。`);
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > limits.maxInputBytes) throw new Error('输入文件总大小不能超过 16 MiB。');
  return Promise.all(files.map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const contentSha256 = `sha256:${[...digest].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    return {
      path: (file.webkitRelativePath || file.name).replaceAll('\\', '/'),
      contentBase64: bytesToBase64(bytes),
      contentSha256
    };
  }));
}

function addSandboxPlanCard(planned) {
  const plan = planned.plan;
  const board = node('section', 'v1-board sandbox-board');
  const heading = node('div', 'v1-heading');
  const title = node('div');
  title.append(node('span', 'message-label', '隔离执行计划'), node('h3', '', plan.language === 'python' ? 'Python 脚本' : 'Shell 脚本'));
  heading.append(title, node('span', 'verified-badge', '等待人工确认'));
  const details = node('dl', 'sandbox-plan-details');
  for (const [label, value] of [
    ['脚本 SHA-256', plan.scriptSha256],
    ['输入文件', `${plan.inputFileCount} 个 / ${plan.inputBytes} 字节`],
    ['资源限制', `${plan.policy.cpuCores} 核 / ${plan.policy.memoryMb} MiB / ${plan.policy.timeoutMs / 1000} 秒`],
    ['网络', plan.policy.network === 'disabled' ? '关闭' : plan.policy.network],
    ['计划哈希', plan.planHash]
  ]) {
    const row = node('div');
    row.append(node('dt', '', label), node('dd', '', String(value)));
    details.append(row);
  }
  board.append(heading, details, node('div', 'demo-boundary', '确认前不会创建 Provider 或执行脚本。服务端响应不回显脚本正文或文件内容。'));
  elements.conversation.append(board);
}

function openSandboxConfirmModal(planned, script) {
  state.pendingSandboxPlanId = planned.planId;
  $('#confirm-title').textContent = '确认在隔离环境中执行该脚本？';
  elements.confirmExplanation.textContent = `计划 ${planned.plan.planHash}；${planned.plan.inputFileCount} 个输入文件。`;
  elements.confirmSql.textContent = script;
  const toolbar = elements.confirmModal.querySelector('.sql-toolbar');
  if (toolbar) toolbar.textContent = '待确认脚本 · 本地预览';
  const note = elements.confirmModal.querySelector('.confirm-note');
  if (note) note.textContent = '确认后才会启动一次性 Docker Sandbox；网络关闭，执行完成或失败后均清理容器和临时工作区。';
  elements.confirmAccept.textContent = '确认隔离执行';
  elements.confirmAccept.disabled = false;
  elements.confirmCancel.disabled = false;
  elements.confirmModal.classList.remove('hidden');
}

function addSandboxResult(result) {
  if (result.status === 'rejected') {
    addMessage('assistant', '已取消本次脚本执行；Provider 未启动。', '安全边界');
    return;
  }
  const board = node('section', 'v1-board sandbox-board');
  const heading = node('div', 'v1-heading');
  const title = node('div');
  title.append(node('span', 'message-label', '沙箱执行结果'), node('h3', '', result.status === 'completed' ? '执行完成' : '执行失败'));
  heading.append(title, node('span', 'verified-badge', result.status));
  const output = result.result ?? {};
  const artifacts = [output.stdoutArtifactRef, output.stderrArtifactRef, ...(output.generatedArtifactRefs ?? [])].filter(Boolean);
  const summary = node('div', 'demo-boundary', `退出码：${output.exitCode ?? '—'}；产物：${artifacts.length} 个；治理事件：${result.governanceReceipt?.eventCount ?? 0} 个。`);
  board.append(heading, summary);
  for (const ref of artifacts) board.append(node('p', 'artifact-reference', ref));
  elements.conversation.append(board);
}

async function submitSandboxScript(script) {
  if (!state.consentGranted) { elements.privacyModal.classList.remove('hidden'); return; }
  if (!state.config?.sandbox?.available) {
    addMessage('assistant', 'Docker Sandbox 尚未配置，当前不会执行脚本。请先按 README 启用并固定镜像摘要。', '能力未启用');
    return;
  }
  elements.welcome.classList.add('hidden');
  addMessage('user', script, elements.sandboxLanguage.value === 'python' ? 'Python 脚本' : 'Shell 脚本');
  addLoading();
  setBusy(true);
  try {
    const inputFiles = await sandboxInputFiles();
    const planned = await api('/api/v1/sandbox/plans', {
      method: 'POST',
      body: JSON.stringify({ language: elements.sandboxLanguage.value, script, inputFiles })
    });
    elements.conversation.querySelector('[data-loading="true"]')?.remove();
    addSandboxPlanCard(planned);
    openSandboxConfirmModal(planned, script);
  } catch (error) {
    elements.conversation.querySelector('[data-loading="true"]')?.remove();
    addMessage('assistant', error.message, '计划创建失败');
  } finally {
    setBusy(false);
    scrollBottom();
  }
}

async function confirmSandboxExecution(confirmed) {
  if (!state.pendingSandboxPlanId || state.busy) return;
  const planId = state.pendingSandboxPlanId;
  elements.confirmAccept.disabled = true;
  elements.confirmCancel.disabled = true;
  setBusy(true);
  try {
    const result = await api(`/api/v1/sandbox/plans/${planId}/confirmation`, {
      method: 'POST',
      body: JSON.stringify({ confirmed })
    });
    closeConfirmModal();
    state.pendingSandboxPlanId = null;
    addSandboxResult(result);
  } catch (error) {
    elements.confirmAccept.disabled = false;
    elements.confirmCancel.disabled = false;
    addMessage('assistant', error.message, '执行失败');
  } finally {
    setBusy(false);
    scrollBottom();
  }
}

async function submitText(text) {
  if (!state.consentGranted) { elements.privacyModal.classList.remove('hidden'); return; }
  const continuing = state.activeSessionId && canContinue(state.activeStatus);
  if (state.activeSessionId && !continuing) resetConversation(state.mode);
  elements.welcome.classList.add('hidden'); addMessage('user', text); addLoading(); setBusy(true);
  try {
    const result = continuing
      ? await api(`/api/sessions/${state.activeSessionId}/answers`, { method: 'POST', body: JSON.stringify({ userText: text }) })
      : await api('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({
            userText: text,
            privacyConsent: true,
            privacyPolicyVersion: state.config.privacyPolicyVersion,
            ...(state.mode === 'v1'
              ? { requestedOutputFormats: state.config.v1TaskInput.defaultOutputFormats }
              : {})
          })
        });
    elements.conversation.querySelector('[data-loading="true"]')?.remove(); renderResult(result); await loadHistory();
  } catch (error) {
    elements.conversation.querySelector('[data-loading="true"]')?.remove(); addMessage('assistant', error.message, '请求失败');
  } finally { setBusy(false); }
}

async function loadHistory() {
  const result = await api('/api/sessions'); elements.historyList.replaceChildren();
  if (!result.sessions.length) { elements.historyList.append(node('p', 'muted compact', '暂无历史会话')); return; }
  const v1StatusLabels = { awaiting_confirmation: '等待确认', replanning: '重新规划中', cancelled: '已取消', rejected: '已拒绝', archived: '已归档' };
  for (const session of result.sessions) {
    const button = node('button', 'history-item'); button.type = 'button'; button.dataset.sessionId = session.sessionId;
    if (session.sessionId === state.activeSessionId) button.classList.add('active');
    const statusLabel = session.taskType === 'professional_data_query' ? v1StatusLabels[session.status] : undefined;
    button.append(node('strong', '', session.legalDomainLabel ?? taskLabels[session.taskType] ?? '智能任务'), node('span', '', `${session.agentConnected ? '智能分析已运行 · ' : ''}${statusLabel ? `${statusLabel} · ` : ''}${new Date(session.updatedAt).toLocaleString('zh-CN')}`));
    button.addEventListener('click', () => openHistory(session.sessionId)); elements.historyList.append(button);
  }
}

async function openHistory(sessionId) {
  setBusy(true);
  try {
    const { session } = await api(`/api/sessions/${sessionId}`); elements.welcome.classList.add('hidden'); elements.conversation.replaceChildren(); state.activeSessionId = session.sessionId; state.activeStatus = session.status;
    state.artifacts = []; renderArtifacts(); closeConfirmModal();
    for (const message of session.messages ?? []) addMessage(message.role === 'user' ? 'user' : 'assistant', message.redactedText);
    renderResult(session); await loadHistory();
  } catch (error) { toast(error.message); } finally { setBusy(false); }
}

elements.composer.addEventListener('submit', async (event) => { event.preventDefault(); const text = elements.input.value.trim(); if (!text || state.busy) return; elements.input.value = ''; elements.characterCount.textContent = '0'; if (state.mode === 'sandbox') await submitSandboxScript(text); else await submitText(text); });
elements.input.addEventListener('input', () => { elements.characterCount.textContent = String(elements.input.value.length); });
elements.input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); elements.composer.requestSubmit(); } });
elements.consent.addEventListener('change', () => { elements.privacyAccept.disabled = !elements.consent.checked || !state.config; });
elements.privacyAccept.addEventListener('click', () => { if (!elements.consent.checked) return; state.consentGranted = true; elements.privacyModal.classList.add('hidden'); elements.input.focus(); });
renderLandingContent();
initLandingInteractions();
document.querySelectorAll('[data-enter-workspace]').forEach((button) =>
  button.addEventListener('click', () => enterWorkspace(button.dataset.enterWorkspace))
);
elements.backHome.addEventListener('click', returnToLanding);
elements.newSession.addEventListener('click', () => resetConversation(state.mode));
elements.refreshHistory.addEventListener('click', () => loadHistory().catch((error) => toast(error.message)));
elements.deleteSession.addEventListener('click', async () => { if (!state.activeSessionId || !window.confirm('确认物理删除当前本地会话？此操作无法撤销。')) return; try { await api(`/api/sessions/${state.activeSessionId}`, { method: 'DELETE', body: JSON.stringify({ confirmed: true }) }); toast('会话已删除'); resetConversation(state.mode); await loadHistory(); } catch (error) { toast(error.message); } });
elements.eraseHistory.addEventListener('click', async () => {
  const confirmationPhrase = window.prompt('此操作会物理删除当前账号的全部本地会话和关联分析产物，且无法撤销。请输入 DELETE MY HISTORY 继续：');
  if (confirmationPhrase !== 'DELETE MY HISTORY') {
    if (confirmationPhrase !== null) toast('确认短语不匹配，未清除任何历史');
    return;
  }
  try {
    const result = await api('/api/account/history', {
      method: 'DELETE',
      body: JSON.stringify({ confirmed: true, confirmationPhrase })
    });
    toast(`已清除 ${result.erasedSessionCount} 个会话和 ${result.erasedArtifactCount} 个分析产物`);
    resetConversation(state.mode);
    await loadHistory();
  } catch (error) {
    toast(error.message);
  }
});
document.querySelectorAll('.mode-tab').forEach((tab) => tab.addEventListener('click', () => resetConversation(tab.dataset.mode)));
document.querySelectorAll('[data-sample]').forEach((button) => button.addEventListener('click', () => { showMode(button.dataset.mode); if (button.dataset.language) elements.sandboxLanguage.value = button.dataset.language; elements.input.value = button.dataset.sample; elements.characterCount.textContent = String(elements.input.value.length); elements.input.focus(); }));
elements.confirmAccept.addEventListener('click', () => state.pendingSandboxPlanId ? confirmSandboxExecution(true) : confirmExecution(true));
elements.confirmCancel.addEventListener('click', () => state.pendingSandboxPlanId ? confirmSandboxExecution(false) : confirmExecution(false));
elements.sandboxFiles.addEventListener('change', () => {
  const files = [...elements.sandboxFiles.files];
  const total = files.reduce((sum, file) => sum + file.size, 0);
  elements.sandboxFileSummary.textContent = files.length ? `${files.length} 个文件 / ${total} 字节` : '未选择文件';
});
elements.openSchema.addEventListener('click', openSchemaModal);
elements.schemaClose.addEventListener('click', () => elements.schemaModal.classList.add('hidden'));
elements.openDataSourceAdmin.addEventListener('click', () => openDataSourceAdmin());
elements.dataSourceAdminClose.addEventListener('click', () => elements.dataSourceAdminModal.classList.add('hidden'));
elements.logFilter.addEventListener('change', () => loadLogs().catch((error) => toast(error.message)));

async function initialize() {
  try {
    const [health, config] = await Promise.all([api('/api/health'), api('/api/config')]); state.config = config;
    elements.openDataSourceAdmin.classList.toggle(
      'hidden',
      !hasAccess(accessActions.dataSourceManage)
    );
    document.querySelector('.sandbox-mode-tab')?.classList.toggle(
      'hidden',
      !hasAccess(accessActions.humanReviewApprove)
    );
    elements.privacyAccept.disabled = !elements.consent.checked; elements.policyVersion.textContent = `隐私政策版本：${config.privacyPolicyVersion}`;
    elements.runtime.classList.add('online');
    const provider = health.agent?.inference?.mode === 'demo'
      ? '演示推理'
      : health.agent?.inference?.model ?? 'Provider 未识别';
    const fallbackNotice = health.agent?.inference?.fallbackMode === 'demo' ? ' · 自动回退' : '';
    elements.runtimeText.textContent = `Agent 在线 · ${provider}${fallbackNotice} · ${config.access?.role ?? 'user'}`; elements.agentName.textContent = health.agent?.agentId ?? 'Agent 未连接'; elements.agentProvider.textContent = `${provider}${fallbackNotice}`;
    await loadHistory();
  } catch (error) { elements.runtime.classList.add('offline'); elements.runtimeText.textContent = '本地服务不可用'; elements.policyVersion.textContent = error.message; }
}

document.querySelector('.mode-switch')?.append(document.querySelector('.sandbox-mode-tab'));
showMode('v0');
initialize();
