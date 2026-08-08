(function exposeLandingContent(globalObject) {
  const PLACEHOLDER_STATUS = '待补充';

  globalObject.LexPilotLandingContent = Object.freeze({
    announcement: {
      enabled: true,
      text: 'LexPilot 本地安全工作台现已开放体验',
      linkLabel: '了解产品能力',
      href: '#value'
    },
    hero: {
      eyebrow: 'LEGAL INTELLIGENCE, GOVERNED BY DESIGN',
      title: '让复杂法律工作，变得清晰、可信、可核验。',
      description:
        'LexPilot 将事实澄清、隐私脱敏、限定法规检索与专业数据分析组织为受治理的工作路径，让每一步都有依据、状态与边界。',
      primaryAction: { label: '进入法律自检', mode: 'v0' },
      secondaryAction: { label: '探索专业数据分析', mode: 'v1' },
      boundary: '当前为本地 Demo，不构成法律意见；法规范围与专业数据能力将持续完善。',
      media: {
        type: 'placeholder',
        imageUrl: '',
        videoUrl: '',
        posterUrl: '',
        alt: 'LexPilot 法律科技工作场景',
        label: '首页主视觉图片 / 视频',
        status: PLACEHOLDER_STATUS
      }
    },
    partners: {
      heading: '服务与合作信息',
      note: '正式名单和 Logo 将在取得公开授权后展示',
      items: [
        { label: '合作机构 01', status: PLACEHOLDER_STATUS, logoUrl: '' },
        { label: '合作机构 02', status: PLACEHOLDER_STATUS, logoUrl: '' },
        { label: '合作机构 03', status: PLACEHOLDER_STATUS, logoUrl: '' },
        { label: '合作机构 04', status: PLACEHOLDER_STATUS, logoUrl: '' },
        { label: '合作机构 05', status: PLACEHOLDER_STATUS, logoUrl: '' }
      ]
    },
    value: {
      eyebrow: 'WHY LEXPILOT',
      sectionNumber: '01',
      sideTitle: '把专业判断放回清楚的工作路径。',
      lead: '面向法律与合规场景，',
      supporting: '让知识、边界与结果可见。',
      highlight: '更少重复，更清楚地抵达结果。',
      description:
        'LexPilot 不用未经验证的概念替代真实能力。当前产品围绕法律自检与专业数据分析两个入口，将事实、依据、执行状态和安全边界组织在同一个可核验界面中。',
      proofPoints: [
        { label: '公开验证指标', value: PLACEHOLDER_STATUS, detail: '经验证并批准公开后展示' },
        { label: '代表性使用案例', value: PLACEHOLDER_STATUS, detail: '取得公开授权后展示' }
      ]
    },
    capabilities: [
      {
        index: '01',
        title: '法律自检',
        status: '当前可用',
        tone: 'light',
        description:
          '用自然语言描述遭遇，系统先进行隐私脱敏，再通过有限追问澄清事实，并从限定的已核验语料中返回候选依据。',
        supportingCapabilities: ['事实澄清', '隐私脱敏', '限定法规检索'],
        action: { label: '进入法律自检', mode: 'v0' }
      },
      {
        index: '02',
        title: '专业数据分析',
        status: '当前可用',
        tone: 'dark',
        description:
          '把自然语言需求转换为受约束的数据查询计划，经过确认与安全校验后，返回表格、图表和可下载的分析文档。',
        supportingCapabilities: ['受约束查询', '计划确认', '治理工作流'],
        action: { label: '进入专业数据分析', mode: 'v1' }
      }
    ],
    scenarios: [
      {
        label: '法律自检',
        title: '从把事情说清楚开始',
        description: '适合劳动用工、婚姻家庭、民间借贷、税务与知识产权首轮信息自检。',
        status: '当前可体验'
      },
      {
        label: '专业数据分析',
        title: '让数据任务先经过审阅',
        description: '查询计划、数据边界和执行状态在操作前后保持可见，降低黑箱执行风险。',
        status: '当前可体验'
      }
    ],
    security: {
      eyebrow: 'SECURITY & PRIVACY',
      title: '专业可信，不应以牺牲数据边界为代价。',
      description:
        '当前 Demo 仅绑定本机回环地址，输入先经过确定性脱敏，会话加密保存并支持受控物理删除。',
      items: [
        { title: '输入先脱敏', detail: '个人信息在进入后续处理前按固定规则替换。' },
        { title: '结果可追溯', detail: '候选依据保留版本、来源与核验状态。' },
        { title: '执行需确认', detail: '专业查询进入计划、校验与人工确认边界。' },
        { title: '本地数据可删除', detail: '会话与关联私有产物通过受控流程物理删除。' }
      ]
    },
    resources: {
      heading: '案例、指标与资源将在验证后公开',
      description: '以下组件已预留数据位置，但不会在缺少正式材料时填入推测内容。',
      items: [
        { type: '合作案例', title: '经授权的应用案例', status: PLACEHOLDER_STATUS },
        { type: '数据指标', title: '可公开的产品与服务指标', status: PLACEHOLDER_STATUS },
        { type: '资质材料', title: '测评、备案、软著或安全资质', status: PLACEHOLDER_STATUS }
      ]
    },
    about: {
      eyebrow: 'ABOUT LEXPILOT',
      title: '关于团队与项目',
      description: '正式主体、团队介绍、联系方式和媒体材料将在确认公开口径后统一补充。',
      fields: [
        { label: '项目主体', value: PLACEHOLDER_STATUS },
        { label: '核心团队', value: PLACEHOLDER_STATUS },
        { label: '联系与合作', value: PLACEHOLDER_STATUS },
        { label: '品牌媒体包', value: PLACEHOLDER_STATUS }
      ]
    },
    finalCallToAction: {
      eyebrow: 'START WITH A CLEAR QUESTION',
      title: '从一个具体问题开始。',
      description: '进入法律自检，或在专业数据工作台审阅一个受约束的分析计划。',
      primaryAction: { label: '进入法律自检', mode: 'v0' },
      secondaryAction: { label: '专业数据分析', mode: 'v1' }
    },
    footer: {
      productLine: '法律合规智能助手 · 本地 Demo',
      boundary: '非法律意见 · 正式主体、备案及联系信息待补充'
    }
  });
})(globalThis);
