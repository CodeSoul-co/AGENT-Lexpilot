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
        'LexPilot 将事实澄清、隐私脱敏、法规检索与专业数据分析组织为同一个受治理工作流，让每一步都有依据、状态与边界。',
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
      lead: 'LexPilot 是面向法律与合规场景的智能工作平台。',
      supporting: '它把专业知识、执行边界与安全治理放在同一条路径中，帮助用户专注于真正需要判断的工作。',
      highlight: '更少重复，更清楚地抵达结果。'
    },
    capabilities: [
      {
        index: '01',
        title: '法律自检',
        status: '当前可用',
        tone: 'active',
        description: '用自然语言描述遭遇，系统先脱敏，再通过有限追问补齐事实并返回可核验的候选法条。',
        action: { label: '开始法律自检', mode: 'v0' }
      },
      {
        index: '02',
        title: '合同分析',
        status: '规划能力 · 待接入',
        tone: 'planned',
        description: '预留合同上传、条款识别、风险标记与审阅协作入口；当前版本尚未开放，不展示虚构能力。'
      },
      {
        index: '03',
        title: '专业数据分析',
        status: '当前可用',
        tone: 'active',
        description: '把自然语言需求转换为受约束查询计划，经确认后返回表格、图表与可下载分析文档。',
        action: { label: '进入数据分析', mode: 'v1' }
      },
      {
        index: '04',
        title: '法规检索',
        status: '限定语料范围',
        tone: 'limited',
        description: '只从本地已核验法规语料生成候选依据，并保留来源、版本与匹配条件；未匹配不代表不存在相关法律。'
      },
      {
        index: '05',
        title: '复杂工作流',
        status: '受治理执行',
        tone: 'limited',
        description: '通过计划确认、Schema 校验、Human Review、隔离执行与审计回执约束高风险操作。'
      }
    ],
    scenarios: [
      {
        label: '个人法律信息辅助',
        title: '从把事情说清楚开始',
        description: '适合劳动用工、婚姻家庭、民间借贷、税务与知识产权首轮信息自检。',
        status: '当前可体验'
      },
      {
        label: '法务与专业服务',
        title: '让数据任务先经过审阅',
        description: '查询计划、数据边界和执行状态在操作前后保持可见，降低黑箱执行风险。',
        status: '当前可体验'
      },
      {
        label: '合同与组织协作',
        title: '为后续能力保留正式入口',
        description: '合同审阅、团队协作和组织知识能力将在需求与安全边界明确后接入。',
        status: PLACEHOLDER_STATUS
      }
    ],
    security: {
      eyebrow: 'SECURITY & PRIVACY',
      title: '专业可信，不应以牺牲数据边界为代价。',
      description:
        '当前 Demo 仅绑定本机回环地址，输入先经过确定性脱敏，会话加密保存并支持受控物理删除。',
      items: [
        { title: '输入先脱敏', detail: '个人信息在进入后续处理前按固定规则替换。' },
        { title: '结果可追溯', detail: '法规候选项保留版本、来源与核验状态。' },
        { title: '执行需确认', detail: '专业查询和高风险动作进入计划与审核边界。' },
        { title: '本地数据可删除', detail: '会话与关联私有产物通过受控流程物理删除。' }
      ]
    },
    resources: {
      heading: '案例、指标与资源将在验证后公开',
      description: '以下组件已经预留数据位置，但不会在缺少正式材料时填入推测内容。',
      items: [
        { type: '合作案例', title: '经授权的应用案例', status: PLACEHOLDER_STATUS },
        { type: '数据指标', title: '可公开的产品与服务指标', status: PLACEHOLDER_STATUS },
        { type: '资质材料', title: '测评、备案、软著或安全资质', status: PLACEHOLDER_STATUS }
      ]
    },
    about: {
      eyebrow: 'ABOUT LEXPILOT',
      title: '关于团队与项目',
      description: '正式主体、团队介绍、联系方式和媒体资料将在确认公开口径后统一补充。',
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
      description: '先完成信息自检，或进入专业数据工作台审阅一个受约束的分析计划。',
      primaryAction: { label: '进入 LexPilot 工作台', mode: 'v0' },
      secondaryAction: { label: '专业数据分析', mode: 'v1' }
    },
    footer: {
      productLine: '法律合规智能助手 · 本地 Demo',
      boundary: '非法律意见 · 正式主体、备案及联系信息待补充'
    }
  });
})(globalThis);
