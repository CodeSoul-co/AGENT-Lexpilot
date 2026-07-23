# 法律合规审查智能助手

基于 [Hypha](https://github.com/CodeSoul-co/Hypha) 框架构建的法律合规业务 Agent，提供两项核心能力：

- **法律自检**：面向普通人的免费法律信息自检工具。用户用自然语言描述遭遇（被辞退、借钱不还、离婚财产分割、侵权盗版、税务纠纷等），智能助手主动追问关键事实，匹配经官方来源核验的法条，输出结构化风险卡片；
- **专业数据分析**：面向法务、律师等专业人员的自然语言数据分析工作台。用户用一句话描述统计需求，智能助手展示只读查询计划，经用户确认后执行，输出表格、图表和可下载的分析文档。

> **产品边界**：本产品不是律师——不提供行动建议、不判断案件胜负、不代写法律文书、不推荐任何律师或律所。输出仅用于信息自检，每张结果卡片附固定免责声明。

## 核心设计

### 隐私优先

- 用户输入先经确定性 PII 脱敏（手机号、身份证号、邮箱、地址、银行卡号及其常见分隔符变体）才允许进入推理；脱敏失败时流程直接关闭，原文不会交给后续处理；
- 会话仅保存脱敏后的消息，本地 AES-256-GCM 加密持久化，磁盘不暴露用户 ID、会话 ID 或明文；
- 删除需显式确认并执行物理删除；90 天未活跃会话自动清理。

### 法规依据可核验

- 结果卡片只引用本地法规语料，每条法条录入时经官方来源核验并记录正文 SHA-256；
- 提供 `npm run audit:law-corpus`（新鲜度）、`audit:law-coverage`（覆盖度）、`audit:law-sources`（官方来源只读核对）三个审计命令；
- 当前语料为最小演示集，`audit:law-coverage` 在语料达到 100 个唯一法条前按设计以退出码 1 "诚实失败"；未匹配不代表不存在相关法律。

### 真实模型、受控智能

- 默认 `demo` 确定性推理可离线运行；`deepseek` / `openai-compatible` 模式接入真实模型；
- 模型只负责领域识别、事实抽取与追问生成，且输出必须通过结构化边界校验（禁止法律结论、行动建议检测、PII 复检）；校验失败自动回退到确定性管线并在页面如实标注；
- 模型提取的事实须经字段/枚举白名单校验后才会合入会话；确定性提取优先，模型只补缺。

### 专业分析须确认后执行

- 查询计划（SQL + 注释）先展示，用户确认后才执行；写操作一律拒绝；
- 每步操作写入只增不改的执行日志；产物（表格/图表/Markdown 分析文档）可下载，并可一键导出 PDF；
- 当前专业数据分析功能使用匿名合成的固定演示数据结构与本地受控求值器，不接真实数据库；Hypha 通用 Text2SQL / SQL Execution 能力到位后再替换。

## 运行

要求：Node.js ≥ 18，以及按 `hypha.lock.json` 基线克隆的 Hypha 仓库。Hypha 默认位于本项目的同级目录 `../Hypha`；如目录不同，应更新 `hypha.lock.json` 中的 `localPath`，不得在业务代码中复制 Hypha 实现。

```bash
# 1. 配置本地环境（模板见 .env.example；.env 已被 git 忽略）
cp .env.example .env
# 生成会话加密密钥并写入 .env：
echo "LEGAL_SESSION_KEY_BASE64=$(npm run --silent demo:key)" >> .env

# 2. 启动本地网页 Demo（只绑定 127.0.0.1，默认端口 4173）
npm run demo:web
```

浏览器打开 `http://127.0.0.1:4173`。

默认 `LEGAL_AGENT_PROVIDER=demo`，无需外部模型即可运行。接入 DeepSeek：在 `.env` 中设置 `LEGAL_AGENT_PROVIDER=deepseek` 与 `LEGAL_AGENT_API_KEY`；或使用 `npm run demo:web:deepseek`，脚本隐藏读取 API Key，不落盘、不进命令历史。本地演示开启诚实回退：仅在网络、超时、限流或服务端故障等可重试错误时使用演示推理并如实标注；鉴权或请求错误不会回退。接入其他 OpenAI-compatible 模型：

```bash
LEGAL_AGENT_PROVIDER=openai-compatible
LEGAL_AGENT_BASE_URL=http://127.0.0.1:11434/v1
LEGAL_AGENT_MODEL=your-model-id
LEGAL_AGENT_API_KEY=optional-for-local-provider
```

密钥不要写入仓库。真实 Provider 只替换法律自检中的结构化事实推理，隐私门、输出校验、法规检索和禁止生成法律结论等边界仍然生效。

## 验证

```bash
npm run verify   # verify:baseline + verify:domain + Package Test
npm test         # 仅 Package Test
```

完整 `verify` 依次检查：本地 Hypha 仓库是否等于锁定 commit（或仅在业务锁定依赖范围外继续前进）；所需 Hypha 构建产物是否存在；Legal DomainPack 能否通过 Hypha 校验并编译为 FSM；Package Test 是否通过。若 Domain、Inference、Kernel 等依赖范围发生变化，验证会主动停止，必须先重新只读审计兼容性，不能放宽门禁。

法规语料可单独审计：

```bash
npm run audit:law-corpus    # 新鲜度
npm run audit:law-coverage  # 覆盖度（语料不足 100 条时按设计失败）
npm run audit:law-sources   # 官方来源只读核对（需联网）
```

## 目录结构

```text
configs/domain-packs/  Legal DomainPack（FSM 工作流契约）
resources/law-corpus/  经官方来源核验的本地法规语料
scripts/               启动、密钥生成、语料审计与基线验证脚本
src/agent/             Hypha ReAct Agent 业务适配层（推理 Provider、输出边界校验）
src/                   法律自检、专业数据分析、隐私网关与本地网页服务
src/web/               本地网页 Demo 服务（仅 127.0.0.1）
tests/                 Package Test
web/                   网页前端（原生 HTML/CSS/JS，零构建）
hypha.lock.json        Hypha 可复现基线
```

## 安全说明

- 网页 Demo 仅绑定 `127.0.0.1`，校验 Host 头防 DNS 重绑定，API 写入强制 `application/json`；
- API Key 只经环境变量传入，不写日志、不进错误消息、不下发前端；
- 本项目是本地单用户演示形态，不含生产级账号体系、权限系统与 HTTPS 部署。

## 尚未实现

账号删除、每日法规同步、生产数据库连接、Hypha 通用 Text2SQL / SQL Execution、生产级权限系统与生产级网页部署。
