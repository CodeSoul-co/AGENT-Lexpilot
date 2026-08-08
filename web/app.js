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
  factsList: $('#facts-list'), needsList: $('#needs-list'), sourceList: $('#source-list'), historyList: $('#history-list'), historySearch: $('#history-search'), input: $('#message-input'),
  newSession: $('#new-session'), pageTitle: $('#page-title'), privacyAccept: $('#privacy-accept'),
  privacyModal: $('#privacy-modal'), policyVersion: $('#policy-version'), refreshHistory: $('#refresh-history'),
  runtime: $('.runtime-status'), runtimeText: $('#runtime-text'), scroll: $('#chat-scroll'),
  send: $('#send-button'), sessionOrb: $('#session-orb'), sessionRound: $('#session-round'),
  sessionStatus: $('#session-status'), toast: $('#toast'), welcome: $('#welcome'),
  welcomeEyebrow: $('#welcome-eyebrow'), welcomeTitle: $('#welcome-title'),
  welcomeCopy: $('#welcome-copy'), scopeBanner: $('#scope-banner'),
  taskPanel: $('#task-panel'), taskPanelToggle: $('#task-panel-toggle'), taskPanelClose: $('#task-panel-close'),
  historyToggle: $('#history-toggle'), historyClose: $('#history-close'), privacyPolicyDetails: $('#privacy-full-policy'),
  confirmModal: $('#confirm-modal'), confirmExplanation: $('#confirm-explanation'),
  confirmSql: $('#confirm-sql'), confirmAccept: $('#confirm-accept'), confirmCancel: $('#confirm-cancel'),
  confirmQuery: $('#confirm-query'), confirmRange: $('#confirm-range'), confirmMetrics: $('#confirm-metrics'),
  confirmSource: $('#confirm-source'), confirmAccess: $('#confirm-access'), confirmOutput: $('#confirm-output'),
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

const state = {
  activeSessionId: null,
  activeStatus: null,
  config: null,
  consentGranted: false,
  busy: false,
  mode: 'v0',
  artifacts: [],
  lastExecutionMs: null,
  pendingSandboxPlanId: null,
  historyQuery: '',
  lastSubmittedText: ''
};
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
  mentioned: '已说明', unknown: '尚不清楚',
  signed: '已签订', not_signed: '未签订',
  dismissal: '辞退', unpaid_wages: '拖欠工资', social_insurance: '社会保险', overtime: '加班',
  medical_or_non_work_injury: '患病或非因工受伤', performance: '不能胜任工作',
  objective_change: '客观情况发生变化', other: '其他原因',
  written_notice_30_days: '已提前三十天书面通知', extra_month_salary: '已额外支付一个月工资',
  neither: '均未提供', ended: '已经结束', not_ended: '尚未结束',
  cannot_original_or_alternative: '无法从事原工作，也未安排合适的新工作',
  can_original_or_alternative: '仍可从事原工作或合适的新工作',
  training_or_adjustment_still_unqualified: '培训或调岗后仍不能胜任',
  no_training_or_adjustment: '未进行培训或调岗', became_qualified: '已经能够胜任',
  contract_cannot_continue: '劳动合同无法继续履行', contract_can_continue: '劳动合同仍可继续履行',
  discussed_no_agreement: '协商后未达成一致', not_discussed: '尚未协商', agreement_reached: '已达成一致',
  married: '已婚', divorced: '已离婚', cohabiting: '共同生活',
  domestic_violence: '家庭暴力', bigamy: '重婚', marriage_freedom: '婚姻自由',
  children: '子女事项', property: '财产事项', debt: '债务事项', marriage_status: '婚姻关系',
  available: '已有证据', none_stated: '尚未说明证据',
  agreed: '已有约定', not_agreed: '没有约定', unpaid: '尚未归还', partial: '部分归还', paid: '已经归还',
  individual: '个人', company: '公司', self_employed: '个体经营者',
  filing: '税务申报', withholding: '代扣代缴', additional_tax: '补缴税款', invoice: '发票事项', general: '一般税务事项',
  written_work: '文字作品', image: '图片作品', software: '软件', trademark: '商标', patent: '专利',
  copy: '复制', repost: '转载', sale: '销售', use: '使用', authorized: '已获授权', not_authorized: '未经授权'
};

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

const HISTORY_TITLE_STORAGE_KEY = 'lexpilot.historyTitles.v1';

function historyTitles() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_TITLE_STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveHistoryTitle(sessionId, title) {
  try {
    const titles = historyTitles();
    if (title) titles[sessionId] = title;
    else delete titles[sessionId];
    window.localStorage.setItem(HISTORY_TITLE_STORAGE_KEY, JSON.stringify(titles));
  } catch {
    // Renaming is a local convenience and must never block the legal workflow.
  }
}

function customerSafeMessage(message, fallback = '当前任务未能完成，请稍后重试。') {
  if (typeof message !== 'string' || !message.trim()) return fallback;
  const technicalPattern = /(agent|provider|runtime|schema|sql|sqlite|postgres|mysql|database|artifact|workspace|docker|\/api\/|[a-z]:\\|\/users\/|error[_ -]?code|stack|exception)/i;
  return technicalPattern.test(message) ? fallback : message;
}

function customerFactValue(value) {
  if (Object.hasOwn(valueLabels, value)) return valueLabels[value];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return '已确认';
}

function setTaskPanelExpanded(expanded) {
  elements.workspaceApp.classList.toggle('task-panel-collapsed', !expanded);
  elements.workspaceApp.classList.toggle('task-panel-open', expanded);
  elements.taskPanelToggle.setAttribute('aria-expanded', String(expanded));
}

function markTaskPanelContent(hasContent) {
  elements.taskPanelToggle.classList.toggle('has-content', hasContent);
}

function closeMobileHistory() {
  elements.workspaceApp.classList.remove('history-open');
}

function customerDataSourceLabel(data) {
  const value = data?.schema?.displayName ?? data?.schema?.dataSource;
  if (typeof value !== 'string' || /(demo|演示|schema|sqlite|postgres|mysql)/i.test(value)) return '已授权数据源';
  return value;
}

function formatPlanRange(data) {
  const range = data?.plan?.semanticQuery?.yearRange;
  if (!Array.isArray(range) || range.length !== 2) return '按当前查询条件';
  return range[0] === range[1] ? `${range[0]} 年` : `${range[0]}—${range[1]} 年`;
}

function formatPlanMetrics(data) {
  const labels = {
    year: '年份',
    case_count: '案件数量',
    employee_win_rate: '胜诉率',
    median_compensation: '赔偿中位数'
  };
  const columns = data?.plan?.expectedOutput?.columns;
  return Array.isArray(columns) && columns.length
    ? columns.map((column) => labels[column]).filter(Boolean).join('、') || '按已确认指标分析'
    : '按已确认指标分析';
}

function planSummary(data) {
  const writePlan = data?.plan?.readOnly === false;
  let title = '按当前条件完成数据分析';
  if (!writePlan) {
    try { title = v1Presentation.buildPresentation(data).title; } catch { /* keep customer-safe fallback */ }
  }
  return {
    query: title,
    range: formatPlanRange(data),
    metrics: formatPlanMetrics(data),
    source: customerDataSourceLabel(data),
    access: writePlan ? '受控变更，需要再次批准' : '只读，不修改原始数据',
    output: writePlan ? '操作结果与确认记录' : '表格、图表与分析文档'
  };
}

function createPlanSummary(data) {
  const summary = planSummary(data);
  const list = node('dl', 'plan-summary');
  for (const [label, value] of [
    ['查询内容', summary.query],
    ['数据范围', summary.range],
    ['分析指标', summary.metrics],
    ['数据来源', summary.source],
    ['访问方式', summary.access],
    ['预期输出', summary.output]
  ]) {
    const row = node('div');
    row.append(node('dt', '', label), node('dd', '', value));
    list.append(row);
  }
  return list;
}

function createTechnicalDetails(sql, label = '高级技术详情') {
  const details = node('details', 'technical-details');
  details.append(node('summary', '', label));
  const panel = node('div', 'sql-panel');
  panel.append(node('div', 'sql-toolbar', '技术查询详情'), node('pre', '', sql ?? ''));
  details.append(panel);
  return details;
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
  setLandingText('#value-section-number', content.value.sectionNumber);
  setLandingText('#value-side-title', content.value.sideTitle);
  setLandingText('#value-lead', content.value.lead);
  setLandingText('#value-supporting', content.value.supporting);
  setLandingText('#value-highlight', content.value.highlight);
  setLandingText('#value-description', content.value.description);
  const valueProofGrid = $('#value-proof-grid');
  valueProofGrid.replaceChildren();
  for (const proofPoint of content.value.proofPoints) {
    const item = node('article', 'value-proof-card');
    item.append(
      node('span', '', proofPoint.label),
      node('strong', '', proofPoint.value),
      node('small', '', proofPoint.detail)
    );
    valueProofGrid.append(item);
  }

  const capabilityList = $('#capability-list');
  capabilityList.replaceChildren();
  for (const capability of content.capabilities) {
    const article = node('article', `capability-card ${capability.tone}`);
    article.dataset.reveal = '';
    const meta = node('header', 'capability-card-meta');
    meta.append(node('span', '', capability.index), node('small', '', capability.status));
    const body = node('div', 'capability-card-body');
    body.append(node('h3', '', capability.title), node('p', '', capability.description));
    const tags = node('ul', 'capability-tags');
    for (const label of capability.supportingCapabilities) tags.append(node('li', '', label));
    const footer = node('footer', 'capability-card-footer');
    footer.append(landingAction(capability.action, 'capability-action'), node('span', 'capability-arrow', '↗'));
    article.append(meta, body, tags, footer);
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
  if (!response.ok) {
    const fallback = response.status === 403
      ? '当前操作没有权限。'
      : response.status === 404
        ? '当前任务不存在或已经结束。'
        : response.status === 409
          ? '任务状态已变化，请刷新后重试。'
          : response.status === 413
            ? '提交内容过大，请精简后重试。'
            : response.status >= 500
              ? '服务暂时不可用，请稍后重试。'
              : '请求内容无法处理，请检查后重试。';
    throw new Error(customerSafeMessage(body.error?.message, fallback));
  }
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
  elements.send.firstChild.textContent = value ? '正在分析 ' : '发送 ';
  elements.composer.classList.toggle('is-busy', value);
}

function scrollBottom() {
  window.requestAnimationFrame(() => { elements.scroll.scrollTop = elements.scroll.scrollHeight; });
}

function enterWorkspace(mode = 'v0') {
  closeLandingMenu();
  elements.landingPage.classList.add('hidden');
  elements.workspaceApp.classList.remove('hidden');
  setTaskPanelExpanded(false);
  closeMobileHistory();
  resetConversation(mode);
  if (!state.consentGranted) elements.privacyModal.classList.remove('hidden');
  else elements.input.focus();
}

function returnToLanding() {
  if (state.busy) return;
  closeConfirmModal();
  setTaskPanelExpanded(false);
  closeMobileHistory();
  elements.privacyModal.classList.add('hidden');
  elements.workspaceApp.classList.add('hidden');
  elements.landingPage.classList.remove('hidden');
  elements.landingPage.scrollTo({ top: 0, behavior: 'smooth' });
}

function addMessage(role, text, label) {
  const row = node('div', `message ${role}`);
  if (role === 'assistant') row.append(node('div', 'avatar', 'L'));
  const bubble = node('div', 'bubble');
  if (label || role === 'assistant') {
    bubble.append(node('span', 'message-label', label ?? 'LexPilot 法律助手'));
  }
  bubble.append(document.createTextNode(text));
  row.append(bubble);
  elements.conversation.append(row);
  scrollBottom();
}

function addLoading() {
  const row = node('div', 'message assistant');
  row.dataset.loading = 'true';
  row.append(node('div', 'avatar', 'L'));
  const bubble = node('div', 'bubble loading-bubble');
  bubble.append(node('strong', 'loading-text', '正在分析'), node('span'), node('span'), node('span'));
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
  elements.openSchema.classList.add('hidden');
  elements.input.maxLength = sandbox ? 65536 : 5000;
  if (sandbox) {
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
  elements.welcomeEyebrow.textContent = v1 ? '专业数据分析' : '法律自检';
  elements.welcomeTitle.textContent = v1 ? '从一个清楚的数据问题开始' : '把事情说清楚，先完成一次法律自检';
  elements.welcomeCopy.textContent = v1
    ? '描述希望分析的范围和指标。开始前可以核对查询内容、数据来源、只读说明和预期输出。'
    : '描述需要核对的情况。信息会先脱敏；如有必要，我们会继续询问关键事实并展示已经核验的引用来源。';
  elements.artifactsSection.classList.toggle('hidden', !v1);
  elements.logsSection.classList.add('hidden');
  if (v1 && hasAccess(accessActions.executionLogRead)) refreshV1Panels();
  elements.scopeBanner.classList.add('hidden');
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
  elements.sessionRound.textContent = mode === 'v1' ? '请描述分析范围和指标' : '请描述需要处理的问题';
  elements.sessionOrb.className = 'status-orb';
  elements.domainLabel.textContent = '尚无';
  elements.factsList.replaceChildren();
  const row = node('div', 'task-empty');
  row.append(node('dt', '', '尚无有效信息'), node('dd', '', '开始对话后自动整理'));
  elements.factsList.append(row);
  elements.needsList.replaceChildren(node('li', 'task-empty', '当前无需补充'));
  elements.sourceList.replaceChildren(node('li', 'task-empty', '尚无引用来源'));
  markTaskPanelContent(false);
  setTaskPanelExpanded(false);
  document.querySelectorAll('.history-item').forEach((item) => item.classList.remove('active'));
  showMode(mode);
  elements.input.focus();
}

function renderFacts(result) {
  elements.factsList.replaceChildren();
  if (result.taskType === 'professional_data_query' && result.v1) {
    const writePlan = result.v1.plan?.readOnly === false;
    const presentation = writePlan ? null : v1Presentation.buildPresentation(result.v1);
    const matchedCount = Number.isSafeInteger(presentation?.counts.matchedCount)
      ? String(presentation.counts.matchedCount)
      : result.status === 'cancelled' ? '已取消' : '待执行';
    elements.domainLabel.textContent = '专业数据分析';
    const entries = writePlan
      ? [
          ['数据来源', customerDataSourceLabel(result.v1)],
          ['访问方式', '受控变更'],
          ['确认状态', result.status === 'completed' ? '已批准' : '等待批准'],
          ['影响行数', String(result.v1.result?.affectedRows ?? '待执行')]
        ]
      : [
          ['数据来源', customerDataSourceLabel(result.v1)],
          ['数据范围', formatPlanRange(result.v1)],
          ['分析指标', formatPlanMetrics(result.v1)],
          ['访问方式', result.v1.safety?.readOnly ? '只读' : '未执行'],
          ['本次匹配', matchedCount]
        ];
    for (const [key, value] of entries) {
      const row = node('div');
      row.append(node('dt', '', key), node('dd', '', value));
      elements.factsList.append(row);
    }
    return;
  }
  elements.domainLabel.textContent = result.legalDomainLabel ?? '法律自检';
  const facts = Object.entries(result.knownFacts ?? {}).filter(([key]) => factLabels[key]);
  const entries = facts.length
    ? facts.map(([key, value]) => [factLabels[key], customerFactValue(value)])
    : [['关键信息', '等待更多信息']];
  for (const [key, value] of entries) {
    const row = node('div');
    row.append(node('dt', '', key), node('dd', '', value));
    elements.factsList.append(row);
  }
}

function renderTaskNeeds(result) {
  elements.needsList.replaceChildren();
  const questions = Array.isArray(result.questions) ? result.questions : [];
  const missing = Array.isArray(result.missingFields)
    ? result.missingFields.map((field) => factLabels[field]).filter(Boolean)
    : [];
  const items = questions.length ? questions : missing.map((field) => `请补充：${field}`);
  if (!items.length) {
    elements.needsList.append(node('li', 'task-confirmed', '✓ 信息已确认'));
    return false;
  }
  for (const item of items) elements.needsList.append(node('li', '', item));
  return true;
}

function renderTaskSources(result) {
  elements.sourceList.replaceChildren();
  let count = 0;
  for (const card of result.resultCards ?? []) {
    const item = node('li');
    const link = node('a', '', `${card.lawName} ${card.articleNumber}`);
    link.href = card.officialSource.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    item.append(link, node('span', '', '引用来源已核验'));
    elements.sourceList.append(item);
    count += 1;
  }
  if (result.taskType === 'professional_data_query' && result.v1?.plan) {
    const item = node('li');
    item.append(node('strong', '', customerDataSourceLabel(result.v1)), node('span', '', '数据范围已确认'));
    elements.sourceList.append(item);
    count += 1;
  }
  if (!count) elements.sourceList.append(node('li', 'task-empty', '尚无引用来源'));
  return count > 0;
}

function renderStatus(result) {
  const labels = {
    needs_clarification: '需要补充信息', needs_domain_clarification: '需要确认领域', completed: '任务已完成',
    information_ready: '信息已整理', rejected: '操作未执行', unsupported_domain: '暂不支持该领域',
    clarification_limit_reached: '需要重新补充', failed: '处理未完成',
    awaiting_confirmation: '等待你的确认', cancelled: '已取消', archived: '历史任务'
  };
  elements.sessionStatus.textContent = labels[result.status] ?? '处理中';
  const progressDetails = {
    needs_clarification: '请回答对话中的补充问题',
    needs_domain_clarification: '请确认问题所属领域',
    completed: '结果与来源已经准备完成',
    information_ready: '关键信息已经整理完成',
    awaiting_confirmation: '请核对分析内容后确认执行',
    cancelled: '本次任务未执行',
    archived: '历史结果仅供查看',
    failed: '可以重新尝试本次任务',
    rejected: '操作未执行',
    unsupported_domain: '可以补充更具体的问题描述',
    clarification_limit_reached: '请在新对话中一次性补充材料'
  };
  elements.sessionRound.textContent = progressDetails[result.status] ?? '正在整理任务信息';
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

function questionQuickOptions(question) {
  if (/签过.*合同|书面合同/.test(question)) return ['已签订', '未签订', '不清楚'];
  if (/提前三十天|多给一个月工资|代通知金/.test(question)) return ['已书面通知', '已多付一个月工资', '均未提供', '不清楚'];
  if (/原来的工作|原工作|另行安排|安排的工作/.test(question)) {
    return ['无法从事原工作，也没有合适的新工作', '仍可从事原工作或合适的新工作', '不清楚'];
  }
  if (/培训|调岗|胜任/.test(question)) return ['培训或调岗后仍不能胜任', '没有培训或调岗', '已经能够胜任', '不清楚'];
  if (/医疗期|休养时间是否/.test(question)) return ['已经结束', '尚未结束', '不清楚'];
  if (/证据|借条|转账记录/.test(question)) return ['有相关证据', '暂时没有', '不清楚'];
  if (/是否|有没有|能否|可否/.test(question)) return ['是', '否', '不清楚'];
  return [];
}

function useQuickAnswer(answer) {
  const current = elements.input.value.trim();
  elements.input.value = current ? `${current}；${answer}` : answer;
  elements.characterCount.textContent = String(elements.input.value.length);
  elements.input.focus();
}

function addQuestions(questions) {
  const row = node('div', 'message assistant question-message');
  row.append(node('div', 'avatar', 'L'));
  const bubble = node('div', 'bubble question-bubble');
  bubble.append(
    node('span', 'message-label', '需要确认的信息'),
    node('p', 'question-intro', '为了继续核对，请补充以下内容。')
  );
  const list = node('div', 'question-list');
  questions.forEach((question, index) => {
    const item = node('section', 'question-item');
    item.append(node('span', 'question-number', `问题 ${index + 1}/${questions.length}`), node('p', '', question));
    const options = questionQuickOptions(question);
    if (options.length) {
      const actions = node('div', 'quick-answer-list');
      for (const answer of options) {
        const button = node('button', 'quick-answer', answer);
        button.type = 'button';
        button.addEventListener('click', () => useQuickAnswer(answer));
        actions.append(button);
      }
      item.append(actions);
    }
    list.append(item);
  });
  bubble.append(list);
  row.append(bubble);
  elements.conversation.append(row);
  scrollBottom();
}

function addSelfCheckResult(result) {
  const cards = result.resultCards ?? [];
  const panel = node('section', 'self-check-result');
  const header = node('header', 'self-check-result-header');
  header.append(
    node('span', 'result-index', 'SELF-CHECK RESULT'),
    node('h2', '', '初步自检结果'),
    node('p', '', cards.length
      ? '根据已经确认的事实与固定法规语料，整理出以下可能相关的核对依据。'
      : '本次没有生成未经核验的法规判断。')
  );
  panel.append(header);

  const overview = node('div', 'result-overview-grid');
  const summarySection = node('section', 'result-summary-section');
  summarySection.append(node('span', 'result-section-label', '01 · 初步自检摘要'));
  const title = cards.length
    ? `找到 ${cards.length} 条可能相关的法规核对项`
    : result.lawRetrievalStatus === 'no_match'
      ? '当前法规语料暂未找到安全匹配'
      : '当前未能生成可核验的结果卡片';
  summarySection.append(node('h3', '', title));
  const summary = cards.length
    ? '以下内容根据你提供的脱敏事实与固定法规语料生成，用于识别可能相关的规则和仍需确认的条件。'
    : result.lawRetrievalStatus === 'failed'
      ? '法规检索环节暂时不可用。本次不会用模型常识补写法条，请稍后重新核对。'
      : result.lawComparisonStatus === 'failed' || result.resultCardStatus === 'failed'
        ? '候选法规的核对环节未能完成。本次没有输出未经验证的判断。'
        : '这不代表不存在相关法律，只表示当前首版语料和事实条件不足以安全展示匹配结果。';
  summarySection.append(node('p', 'summary-copy', summary));

  const factsSection = node('section', 'result-facts-section');
  factsSection.append(node('span', 'result-section-label', '02 · 已确认的关键事实'));
  const factGrid = node('dl', 'result-fact-grid');
  const facts = Object.entries(result.knownFacts ?? {}).filter(([key]) => factLabels[key]);
  if (!facts.length) {
    const row = node('div', 'result-fact-empty');
    row.append(node('dt', '', '关键信息'), node('dd', '', '尚不足以形成可靠核对'));
    factGrid.append(row);
  } else {
    for (const [key, value] of facts) {
      const row = node('div');
      row.append(node('dt', '', factLabels[key]), node('dd', '', customerFactValue(value)));
      factGrid.append(row);
    }
  }
  factsSection.append(factGrid);
  overview.append(summarySection, factsSection);
  panel.append(overview);

  const lawsSection = node('section', 'result-laws-section');
  lawsSection.append(node('span', 'result-section-label', '03 · 可能相关的法规依据'));
  if (!cards.length) {
    lawsSection.append(node('p', 'result-law-empty', '当前没有可以安全展示的法规依据。你可以补充争议主体、时间、现有材料和具体事项后重新核对。'));
  }
  for (const card of cards) {
    const law = node('article', 'law-result-card');
    const lawHeader = node('header', 'law-result-header');
    const lawTitle = node('div');
    lawTitle.append(node('span', '', card.findingLabel ?? '可能相关'), node('h3', '', `${card.lawName} ${card.articleNumber}`));
    const source = node('a', 'source-link', '查看官方来源 ↗');
    source.href = card.officialSource.url;
    source.target = '_blank';
    source.rel = 'noreferrer';
    lawHeader.append(lawTitle, source);
    const excerpt = card.articleText.length > 128 ? `${card.articleText.slice(0, 128)}……` : card.articleText;
    law.append(
      lawHeader,
      node('p', 'law-key-excerpt', excerpt),
      node('div', 'law-match-reason', `匹配原因：你已确认的事实与该条款涉及的适用条件存在对应，因此将其列为可能相关依据；这不是案件结论。`)
    );
    const details = node('details', 'law-full-text');
    details.append(node('summary', '', '查看法条全文'), node('p', '', card.articleText));
    const copy = node('button', 'copy-button', '复制法规引用');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(`${card.lawName}${card.articleNumber}\n${card.articleText}\n${card.officialSource.url}`);
        toast('法规引用已复制');
      } catch {
        toast('请手动选择法规文本');
      }
    });
    const footer = node('footer', 'law-result-footer');
    footer.append(node('span', '', `版本日期：${card.lawVersionDate} · 来源已经核验`), copy);
    law.append(details, footer);
    lawsSection.append(law);
  }
  panel.append(lawsSection);

  const boundary = node('footer', 'result-boundary');
  boundary.append(
    node('strong', '', '产品边界说明'),
    node('p', '', result.disclaimer ?? '本结果仅用于法律信息辅助，不构成违法认定、案件结论或正式法律意见。')
  );
  panel.append(boundary);
  elements.conversation.append(panel);
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
    node('p', 'summary-copy', customerSafeMessage(result.error?.message, '请检查输入内容，或稍后重新尝试。'))
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
  } else {
    const retry = node('button', 'retry-button', '重新尝试');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      if (state.lastSubmittedText) {
        elements.input.value = state.lastSubmittedText;
        elements.characterCount.textContent = String(state.lastSubmittedText.length);
      }
      elements.input.focus();
    });
    body.append(retry);
  }
  article.append(header, body);
  stack.append(article);
  elements.conversation.append(stack);
}

function addRequestFailure() {
  const result = {
    status: 'failed',
    error: { message: '服务暂时未能完成本次任务，请稍后重新尝试。' }
  };
  addTerminalError(result);
}

function addIncompleteSummary(result) {
  const stack = node('div', 'result-stack');
  const article = node('article', 'result-card incomplete-card');
  const header = node('div', 'result-card-header');
  header.append(node('span', '', '本次核对未完成'));
  const body = node('div', 'result-card-body');
  body.append(
    node('h3', '', '仍缺少完成可靠核对所需的信息'),
    node('p', 'law-meta', '关键信息仍不完整，本次没有生成判断')
  );
  const list = node('ul', 'missing-list');
  for (const field of result.missingFields ?? []) {
    list.append(node('li', '', factLabels[field] ?? '其他必要信息'));
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
    addMessage('assistant', customerSafeMessage(data.reason, '该数据任务未执行。'), '安全边界');
    return;
  }
  if (data.plan?.readOnly === false) {
    const board = node('section', 'v1-board');
    const heading = node('div', 'v1-heading');
    const titleWrap = node('div');
    titleWrap.append(node('span', 'message-label', '受控操作'), node('h3', '', '数据变更已完成'));
    heading.append(titleWrap, node('span', 'verified-badge', '✓ 已确认'));
    const resultCard = node(
      'div',
      'demo-boundary',
      `操作已完成 · 影响 ${data.result.affectedRows} 行数据`
    );
    board.append(heading, createPlanSummary(data), resultCard, createTechnicalDetails(data.plan.sql));
    elements.conversation.append(board);
    return;
  }
  const presentation = v1Presentation.buildPresentation(data);
  const board = node('section', 'v1-board');
  const heading = node('div', 'v1-heading');
  const titleWrap = node('div'); titleWrap.append(node('span', 'message-label', '查询计划'), node('h3', '', presentation.title));
  heading.append(titleWrap, node('span', 'verified-badge', '✓ 来源已核验'));
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
  const boundary = node('div', 'demo-boundary', '本次分析已按确认的数据范围完成，结果不构成法律意见。');
  board.append(heading, tableWrap, chart, footer, boundary, createTechnicalDetails(data.plan.sql)); elements.conversation.append(board);
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
    node('span', 'message-label', writePlan ? '受控操作' : '分析内容'),
    node('h3', '', planTitle)
  );
  heading.append(titleWrap, node('span', 'verified-badge', '等待确认'));
  const boundary = node(
    'div',
    'demo-boundary',
    writePlan
      ? '该操作会修改一条授权数据。批准后才会执行；未通过校验时不会提交。'
      : '该分析仅读取已授权的数据范围，确认后才会执行，不会修改原始数据。'
  );
  board.append(heading, createPlanSummary(data), boundary, createTechnicalDetails(data.plan.sql)); elements.conversation.append(board);
}

function addSchemaDriftCard(result) {
  const drift = result.v1?.schemaDrift;
  if (!drift?.detected) return;
  const board = node('section', 'v1-board');
  const heading = node('div', 'v1-heading');
  const titleWrap = node('div');
  titleWrap.append(node('span', 'message-label', '数据更新通知'), node('h3', '', '原分析计划已安全停止'));
  heading.append(titleWrap, node('span', 'verified-badge', '需要重新确认'));
  const detail = node('div', 'demo-boundary', '数据结构已更新，原计划没有执行。请基于当前数据重新生成分析内容。');
  board.append(heading, detail);
  if (result.v1?.replanRequired === true) {
    const button = node('button', 'primary-button', '基于当前数据重新生成');
    button.type = 'button';
    button.addEventListener('click', replanExecution);
    board.append(button);
  }
  elements.conversation.append(board);
}

function openConfirmModal(result) {
  const data = result?.v1;
  const writePlan = data?.plan?.readOnly === false;
  const summary = planSummary(data);
  elements.confirmExplanation.textContent = writePlan
    ? '这项操作会改变一条授权数据，请确认内容无误。'
    : '开始分析前，请确认查询范围与预期输出符合你的需求。';
  elements.confirmSql.textContent = data?.plan?.sql ?? '';
  const toolbar = elements.confirmModal.querySelector('.sql-toolbar');
  if (toolbar) toolbar.textContent = '技术查询详情';
  const title = $('#confirm-title');
  if (title) title.textContent = writePlan ? '确认执行这项数据变更？' : '请核对本次分析内容';
  elements.confirmQuery.textContent = summary.query;
  elements.confirmRange.textContent = summary.range;
  elements.confirmMetrics.textContent = summary.metrics;
  elements.confirmSource.textContent = summary.source;
  elements.confirmAccess.textContent = summary.access;
  elements.confirmOutput.textContent = summary.output;
  const note = elements.confirmModal.querySelector('.confirm-note');
  if (note) note.textContent = writePlan
    ? '批准后才会执行；未通过安全校验时不会提交。'
    : '确认后才会开始分析。只读任务不会修改原始数据。';
  elements.confirmModal.querySelector('.technical-details').open = false;
  elements.confirmAccept.textContent = writePlan ? '批准并执行' : '确认并开始分析';
  elements.confirmAccept.disabled = false;
  elements.confirmCancel.disabled = false;
  elements.confirmModal.classList.remove('hidden');
}

function closeConfirmModal() {
  elements.confirmModal.classList.add('hidden');
  elements.confirmExplanation.textContent = '';
  elements.confirmSql.textContent = '';
  elements.confirmModal.querySelector('.technical-details').open = false;
}

async function confirmExecution(confirmed) {
  if (!state.activeSessionId || state.busy) return;
  elements.confirmAccept.disabled = true;
  elements.confirmCancel.disabled = true;
  addMessage('user', confirmed ? '确认开始分析。' : '取消本次分析。');
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
    if (result.error) addMessage('assistant', customerSafeMessage(result.error.message), '任务已停止');
    else if (result.status === 'completed' && result.v1?.status === 'completed') {
      addMessage('assistant', customerSafeMessage(result.assistantMessage, '专业数据分析已完成。'), '智能助手');
      addV1Result(result);
    } else if (result.v1?.schemaDrift?.detected) {
      addMessage('assistant', '数据已更新，原分析计划没有执行。', '需要重新确认');
      addSchemaDriftCard(result);
    } else {
      addMessage('assistant', result.assistantMessage ?? '已按你的选择取消本次专业数据分析，查询未执行。', '安全边界');
    }
    await loadHistory(); refreshV1Panels();
  } catch (error) {
    elements.confirmAccept.disabled = false;
    elements.confirmCancel.disabled = false;
    addRequestFailure();
  } finally { scrollBottom(); }
}

async function replanExecution() {
  if (!state.activeSessionId || state.busy) return;
  setBusy(true);
  addMessage('user', '基于当前数据重新生成分析内容。');
  try {
    const result = await api(`/api/sessions/${state.activeSessionId}/schema-replan`, {
      method: 'POST',
      body: JSON.stringify({ requested: true })
    });
    state.activeStatus = result.status;
    renderStatus(result); renderFacts(result);
    if (result.status === 'awaiting_confirmation') {
      addMessage('assistant', '已基于当前数据生成新的分析内容，请重新确认。', '已更新');
      addV1PlanCard(result);
      openConfirmModal(result);
    } else {
      addMessage('assistant', '暂时无法重新生成分析内容，请稍后再试。', '任务已停止');
      addSchemaDriftCard(result);
    }
    await loadHistory(); refreshV1Panels();
  } catch (error) {
    addRequestFailure();
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
  const rowHeight = 44;
  const tableRows = presentation.table.rows.length + 1;
  const chartHeight = 300;
  measure.font = font(15);
  const disclaimerLines = wrapLines(measure, presentation.disclaimer, contentWidth);
  const height =
    pad + 44 + 30 + 26 * 3 + 24 + // 标题与元信息
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
    `生成时间：${new Date().toLocaleString('zh-CN')} · 分析耗时：${Number.isFinite(executionMs) ? `${executionMs} ms` : '未记录'}`,
    `${presentation.summary} · 分析范围已经确认`
  ];
  for (const line of meta) { ctx.fillText(line, pad, y); y += 26; }
  y += 24;
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

function renderResult(result, options = {}) {
  state.activeSessionId = result.sessionId ?? state.activeSessionId;
  state.activeStatus = result.status;
  elements.deleteSession.classList.add('hidden');
  const v1 = result.taskType === 'professional_data_query';
  showMode(v1 ? 'v1' : 'v0');
  elements.pageTitle.textContent = v1 ? '专业数据分析' : (result.legalDomainLabel ? `${result.legalDomainLabel}自检` : '法律自检会话');
  renderStatus(result);
  renderFacts(result);
  const hasNeeds = renderTaskNeeds(result);
  const hasSources = renderTaskSources(result);
  const hasFacts = Object.keys(result.knownFacts ?? {}).length > 0 || Boolean(result.v1?.plan);
  markTaskPanelContent(Boolean(state.activeSessionId || hasNeeds || hasSources || hasFacts));
  const finalSelfCheck =
    !v1 && ['completed', 'information_ready'].includes(result.status);
  const hasQuestions = (result.questions ?? []).length > 0;
  if (result.agentExecution && !result.error && !finalSelfCheck && !hasQuestions && !options.skipAssistantTurn) {
    addMessage(
      'assistant',
      customerSafeMessage(result.assistantMessage, '已完成本轮信息整理。'),
      '智能助手'
    );
  }
  if (result.status === 'clarification_limit_reached') addIncompleteSummary(result);
  else if (result.error) addTerminalError(result);
  else if (v1) {
    if (result.status === 'awaiting_confirmation') {
      if (result.assistantMessage) addMessage('assistant', customerSafeMessage(result.assistantMessage), '分析内容');
      addV1PlanCard(result);
      openConfirmModal(result);
    } else if (result.status === 'cancelled') {
      addV1PlanCard(result);
      addMessage('assistant', result.assistantMessage ?? '已取消本次专业数据分析，任务未执行。', '任务已取消');
    } else if (result.status === 'archived') {
      addMessage('assistant', '该任务因长期未使用已归档。现有结果仍可查看；继续分析请新建任务。', '历史任务');
      if (result.v1?.result && result.v1?.artifact) {
        addV1Result({ ...result, v1: { ...result.v1, status: 'completed' } });
      }
    } else if (result.v1?.schemaDrift?.detected) {
      addMessage('assistant', '数据已更新，原分析计划未执行。请重新确认分析内容。', '需要重新确认');
      addSchemaDriftCard(result);
    } else addV1Result(result);
  }
  else if (hasQuestions && !options.skipAssistantTurn) addQuestions(result.questions);
  else if (finalSelfCheck) {
    addSelfCheckResult(result);
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
    addRequestFailure();
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
    addRequestFailure();
  } finally {
    setBusy(false);
    scrollBottom();
  }
}

async function submitText(text) {
  if (!state.consentGranted) { elements.privacyModal.classList.remove('hidden'); return; }
  state.lastSubmittedText = text;
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
    elements.conversation.querySelector('[data-loading="true"]')?.remove(); addRequestFailure();
  } finally { setBusy(false); }
}

async function loadHistory() {
  const result = await api('/api/sessions');
  const titles = historyTitles();
  const query = state.historyQuery.trim().toLocaleLowerCase('zh-CN');
  const sessions = result.sessions.filter((session) => {
    const defaultTitle = session.legalDomainLabel
      ? `${session.legalDomainLabel}自检`
      : taskLabels[session.taskType] ?? '新任务';
    return !query || `${titles[session.sessionId] ?? defaultTitle} ${taskLabels[session.taskType] ?? ''}`
      .toLocaleLowerCase('zh-CN')
      .includes(query);
  });
  elements.historyList.replaceChildren();
  if (!sessions.length) {
    elements.historyList.append(node('p', 'history-empty', query ? '未找到匹配会话' : '还没有会话记录'));
    return;
  }
  for (const session of sessions) {
    const defaultTitle = session.legalDomainLabel
      ? `${session.legalDomainLabel}自检`
      : taskLabels[session.taskType] ?? '新任务';
    const title = titles[session.sessionId] ?? defaultTitle;
    const item = node('article', 'history-item');
    item.dataset.sessionId = session.sessionId;
    if (session.sessionId === state.activeSessionId) item.classList.add('active');
    const open = node('button', 'history-open');
    open.type = 'button';
    open.append(
      node('strong', '', title),
      node('span', '', `${taskLabels[session.taskType] ?? '法律自检'} · ${new Date(session.updatedAt).toLocaleDateString('zh-CN')}`)
    );
    open.addEventListener('click', () => openHistory(session.sessionId));
    const actions = node('div', 'history-item-actions');
    const rename = node('button', '', '重命名');
    rename.type = 'button';
    rename.setAttribute('aria-label', `重命名${title}`);
    rename.addEventListener('click', () => renameHistorySession(session.sessionId, title));
    const remove = node('button', 'danger-text', '删除');
    remove.type = 'button';
    remove.setAttribute('aria-label', `删除${title}`);
    remove.addEventListener('click', () => deleteHistorySession(session.sessionId));
    actions.append(rename, remove);
    item.append(open, actions);
    elements.historyList.append(item);
  }
}

async function renameHistorySession(sessionId, currentTitle) {
  const nextTitle = window.prompt('输入新的会话名称：', currentTitle);
  if (nextTitle === null) return;
  const normalized = nextTitle.trim().slice(0, 60);
  if (!normalized) {
    toast('会话名称不能为空');
    return;
  }
  saveHistoryTitle(sessionId, normalized);
  await loadHistory();
}

async function deleteHistorySession(sessionId) {
  if (!window.confirm('确认删除这条本地会话？删除后无法恢复。')) return;
  try {
    await api(`/api/sessions/${sessionId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmed: true })
    });
    saveHistoryTitle(sessionId, '');
    if (sessionId === state.activeSessionId) resetConversation(state.mode);
    toast('会话已删除');
    await loadHistory();
  } catch {
    toast('暂时无法删除，请稍后重试');
  }
}

async function openHistory(sessionId) {
  setBusy(true);
  try {
    const { session } = await api(`/api/sessions/${sessionId}`); elements.welcome.classList.add('hidden'); elements.conversation.replaceChildren(); state.activeSessionId = session.sessionId; state.activeStatus = session.status;
    state.artifacts = []; renderArtifacts(); closeConfirmModal();
    for (const message of session.messages ?? []) {
      addMessage(
        message.role === 'user' ? 'user' : 'assistant',
        message.redactedText,
        message.role === 'assistant' ? '需要确认的信息' : undefined
      );
    }
    const latestTurnAlreadyStored = session.messages?.at(-1)?.role === 'assistant';
    renderResult(session, { skipAssistantTurn: latestTurnAlreadyStored }); closeMobileHistory(); await loadHistory();
  } catch { toast('暂时无法打开该会话，请稍后重试'); } finally { setBusy(false); }
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
elements.newSession.addEventListener('click', () => { resetConversation(state.mode); closeMobileHistory(); });
elements.refreshHistory.addEventListener('click', () => loadHistory().catch(() => toast('暂时无法刷新会话，请稍后重试')));
elements.historySearch.addEventListener('input', () => {
  state.historyQuery = elements.historySearch.value;
  loadHistory().catch(() => toast('暂时无法搜索会话'));
});
elements.taskPanelToggle.addEventListener('click', () => {
  setTaskPanelExpanded(elements.taskPanelToggle.getAttribute('aria-expanded') !== 'true');
});
elements.taskPanelClose.addEventListener('click', () => setTaskPanelExpanded(false));
elements.historyToggle.addEventListener('click', () => elements.workspaceApp.classList.toggle('history-open'));
elements.historyClose.addEventListener('click', closeMobileHistory);
elements.policyVersion.addEventListener('click', (event) => {
  event.preventDefault();
  elements.privacyPolicyDetails.classList.toggle('hidden');
});
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
  } catch {
    toast('暂时无法清除历史，请稍后重试');
  }
});
document.querySelectorAll('.mode-switch .mode-tab').forEach((tab) => tab.addEventListener('click', () => resetConversation(tab.dataset.mode)));
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
    const [, config] = await Promise.all([api('/api/health'), api('/api/config')]);
    state.config = config;
    elements.openDataSourceAdmin.classList.add('hidden');
    document.querySelector('.sandbox-mode-tab')?.classList.add('hidden');
    elements.privacyAccept.disabled = !elements.consent.checked;
    elements.runtime.classList.add('online');
    elements.runtimeText.textContent = '服务正常';
    await loadHistory();
  } catch {
    elements.runtime.classList.add('offline');
    elements.runtimeText.textContent = '服务暂时不可用';
  }
}

showMode('v0');
initialize();
