# AGENT-lexpilot

**中文名：LexPilot 法律智能体**

基于 [Hypha](https://github.com/CodeSoul-co/Hypha) 框架构建的法律合规业务 Agent，提供两项核心能力：

- **法律自检**：面向普通人的免费法律信息自检工具。用户用自然语言描述遭遇（被辞退、借钱不还、离婚财产分割、侵权盗版、税务纠纷等），智能助手主动追问关键事实，匹配经官方来源核验的法条，输出结构化风险卡片；
- **专业数据分析**：面向法务、律师等专业人员的自然语言数据分析工作台。用户用一句话描述统计需求，智能助手展示只读查询计划，经用户确认后执行，输出表格、图表和可下载的分析文档。

> **产品边界**：本产品不是律师——不提供行动建议、不判断案件胜负、不代写法律文书、不推荐任何律师或律所。输出仅用于信息自检，每张结果卡片附固定免责声明。

## 核心设计

### 隐私优先

- 用户输入先经确定性 PII 脱敏（手机号、身份证号、邮箱、地址、银行卡号及其常见分隔符变体）才允许进入推理；脱敏失败时流程直接关闭，原文不会交给后续处理；
- 会话仅保存脱敏后的消息，本地 AES-256-GCM 加密持久化，磁盘不暴露用户 ID、会话 ID 或明文；
- 单会话删除需显式确认并执行物理删除；侧边栏“清除全部本地历史”还要求输入固定确认短语，并按当前服务器绑定 owner 先校验、再删除关联 Hypha Analysis Artifact、全部加密 Session 与进程内 Agent 缓存。接口不接受 owner/session 列表，响应只返回汇总数量；既有不可变审计日志按合规保留策略保留，并追加不含 owner、会话 ID 或 Artifact 对象键的请求/完成汇总回执。90 天未活跃会话自动清理。

### 法规依据可核验

- 结果卡片只引用本地法规语料，每条法条录入时经官方来源核验并记录正文 SHA-256；
- 提供 `npm run audit:law-corpus`（新鲜度）、`audit:law-coverage`（覆盖度）、`audit:law-sources`（官方来源只读核对）三个审计命令；
- 当前语料版本为 `0.10.1`，Batch 001-008 已覆盖 46/100 个唯一法条；其中 7 条已完成检索与结果卡回归并启用，其余 39 条保持不可检索。当前阶段不再扩充条目，优先闭环既有语料；`audit:law-coverage` 仍会诚实报告 46/100，未匹配不代表不存在相关法律。

### 真实模型、受控智能

- 默认 `demo` 确定性推理可离线运行；`deepseek` / `openai-compatible` 模式接入真实模型；
- 模型只负责领域识别、事实抽取与追问生成，且输出必须通过结构化边界校验（禁止法律结论、行动建议检测、PII 复检）；校验失败自动回退到确定性管线并在页面如实标注；
- 模型提取的事实须经字段/枚举白名单校验后才会合入会话；确定性提取优先，模型只补缺。

### 专业分析须确认后执行

- 查询计划（参数化 SQL + 注释）先展示；SQLite/网络只读模式先用真实白名单 Schema 将受支持的脱敏自然语言映射为固定形状的参数化 `SELECT`，再由策略门校验单条语句、数据表、字段和绑定参数，用户确认后才执行。原始 SQL、未知模板和写入意图均关闭失败。SQLite 写入专用配置仅允许固定单行 `INSERT` / `UPDATE` / `DELETE` 模板，并强制进入 Hypha Human Review；多语句和 DDL 一律在数据库前拒绝；
- 计划同时保存白名单范围内的 Schema 快照、Schema 指纹与计划哈希；确认时重新读取真实 Schema，发生漂移即在到达数据库前停止旧计划，并返回新增、移除或属性变化的表/字段清单；
- DataSource/Schema Profile 由 `configs/capability-bindings/legal-v1-data-sources.json` 统一版本化：清单显式引用当前 DomainPack、SQLite 只读/受治理写入、PostgreSQL 只读和 MySQL 只读四份 manifest，并以规范化 JSON SHA-256 固定各自的引擎、权限、白名单和限制；初始 Schema 快照也携带 `schema-snapshot.allowlisted.v1@1.0.0` 契约引用。应用在读取数据库环境值或连接 Provider 前验证全部引用，并按当前 V1 runtime 只选择已登记的 manifest；缺失、未登记或任一内容漂移均关闭失败；
- V1 专业查询输入通过项目侧 `task-input.legal-professional-query@1.0.0` 适配为需求中的 `query`、`data_source_id`、`workspace_id` 和可选 `requested_output_formats`：查询必须先脱敏，数据源 ID 只能取管理员绑定的活动 runtime，网页和 API 均不能提交任意数据源或 Workspace ID；Workspace ID 是不含会话原值与路径的稳定逻辑标识，供同一会话的计划、确认与重规划关联，绝不映射或暴露 Sandbox/宿主机目录；公开回执不保存查询文本，缺失、扩展字段或任一标识漂移会在 Provider 执行前停止；
- 逻辑查询 Workspace 使用 `workspace-lifecycle.legal-query@1.0.0` 管理，并在严格超过 30 天未活动后自动生成 `workspace-archive.legal-query@1.0.0` 归档回执：应用启动和长运行进程每日首次会话入口执行扫描，归档回执以 SHA-256 固定 TaskSchema 回执与安全 Artifact 引用，不复制查询、Artifact 内容或路径；归档状态与回执写入加密 Session，并追加到既有哈希链执行日志。归档后旧计划不能确认或重规划，历史结果仍可只读查看，继续查询必须新建任务；归档历史响应不再携带 Markdown 正文，当前 owner 只能通过 `GET /api/sessions/:sessionId/artifacts/:artifactId/download` 经角色门禁、归档回执校验和私有 Store 回读校验后下载。归档不会修改 `session.updatedAt`，因此不会延后现有 90 天会话物理清理；
- Workflow State 能力映射由 `configs/capability-bindings/legal-workflow-state-capabilities.json` 作为项目侧 companion manifest 统一版本化，不修改 Hypha：它逐一覆盖当前 DomainPack 的 13 个状态，并把专业查询的 12 个实际阶段编译为独立、不可变的项目侧 FSM；`EXECUTE_SCRIPT` 显式绑定 Workspace、Execution 和 Artifact，Schema/计划/SQL 状态绑定活动 DataSource，产物与终态绑定 Artifact 和 OutputContract。Domain workflow、依赖清单、状态覆盖、转移或任一引用发生缺失/错配/漂移时，应用会在读取会话密钥、打开数据 Provider 和写入运行数据前关闭失败；编译回执仅保留版本引用、计数与 SHA-256，不包含路径、连接值或用户内容；
- Session/Agent 能力快照同样在项目侧实现，不修改 Hypha：应用启动时从已经验证的 Workflow State 绑定生成不可变、版本化的 capability reference snapshot，并把同一份快照写入每个加密 Session、绑定到 Agent patch 与 Session/Agent 组合边界。快照固定当前 runtime、Workspace、Execution、DataSource、Artifact、OutputContract 和 FSM SHA-256；会话恢复时缺失快照、内容或哈希漂移、切换 runtime 后继续使用旧会话、后续 patch 替换能力以及 Session/Agent 快照不一致均关闭失败。应用和 Agent 对外只暴露快照/补丁的版本引用与 SHA-256，不暴露路径、凭据、环境变量名或用户内容；升级前创建且没有快照的旧会话不会被静默继承，需要新建会话；
- Artifact 输出绑定由 `configs/capability-bindings/legal-v1-artifact-outputs.json` 在项目侧独立版本化：清单以 canonical SHA-256 固定当前 Workflow State binding，并绑定 `artifact-profile.lexpilot.v1-output@1.0.0`、`output.legal-professional-query@1.0.0` 以及分析/Sandbox 两个私有 Hypha Store。应用会把实际 Repository 的 store ID、后端、可见性和大小上限与清单逐项比较；分析结果发布前验证成功执行状态、Markdown 类型、文件名、MIME、大小和内容 SHA-256，写入后再验证对象键、ETag、大小、后端与绑定引用。声明、运行实例、产物或回执任一漂移时停止发布结果；安全回执只含版本、哈希和非敏感 Store 标识，不含根路径、连接值、凭据或用户原文；
- Schema 变化会在会话和网页中主动通知用户，并提供显式重新规划入口；重新规划只基于当前白名单 Schema 生成新计划，仍须再次人工确认，绝不会因重新规划而自动执行；漂移检测与重新规划同样适用于 SQLite、PostgreSQL 和 MySQL；
- 计划、取消和执行操作写入只增不改的 SHA-256 哈希链日志；日志损坏或篡改时停止读取与追加，日志写入失败时不发布执行结果；旧版 Demo 日志可读，并由首条新版记录建立兼容锚点；
- 本地网页使用 `access-control.local-demo@1.0.0` 服务器绑定角色：默认 `user` 只能使用 owner 隔离的会话及下载其分析产物；`administrator` 才能管理数据源、查看执行日志以及批准数据库写入或 Sandbox Human Review。角色只从服务器启动配置读取，浏览器请求头和请求体均不能切换角色；该本地策略显式声明不具备生产认证和职责分离，不能替代组织账号、SSO、租户 RBAC、审批人独立性与远程 Store 下载授权验收；
- 产物（表格/图表/Markdown 分析文档）包含内容 SHA-256，可下载并可一键导出 PDF；Markdown 分析文档在发布前写入 Hypha 本地 Artifact Store 并回读校验，持久化失败时停止发布结果；执行日志关联计划、Schema、执行 Provider 与产物存储回执；
- 当前网页专业数据分析流程默认使用匿名合成的固定演示数据结构与本地受控求值器；显式启用 `sqlite` 模式后，使用 Hypha 已构建的公开 `loadSqlite()` 驱动入口连接真实 SQLite 文件，支持连接测试、白名单表 Schema 快照、确认前 Schema 指纹复验、参数化 `SELECT`、15 秒硬超时、500 行与 1 MiB 输出上限。所有组合与治理均位于本项目，不会通过修改 Hypha 绕过治理门。
- SQLite 写入专用配置通过 Hypha `GovernedToolRunner` 创建真实待审批 invocation；拒绝时 handler 不执行，批准后只执行一次。Worker 使用单个事务，失败、超时或影响超过 1 行时不提交，写操作不自动重试。审计日志仅记录 invocation ID、审批状态、事件数量、事务状态和影响行数，不记录参数、数据库路径或凭证。PostgreSQL/MySQL 在取得专用写账号和独立验收环境前继续保持只读。
- Python / Shell 脚本执行同样强制进入 Hypha Human Review。批准后才把已校验路径、数量、总大小与 SHA-256 的输入文件写入独立的一次性 Workspace，并调用锁定 Hypha 基线公开导出的 `DockerSandboxProviderFactory`：网络与 DNS 默认关闭，根文件系统只读，只挂载当前 Workspace，固定非 root 用户、丢弃全部 capability，最多 1 核 CPU、512 MiB 内存和 30 秒命令执行时间。标准输出、标准错误和生成文件通过 Hypha Artifact Store 接口持久化；成功、失败和超时都必须验证执行容器已删除，再清理逻辑 Sandbox 与临时 Workspace。
- Workspace 与 Execution Profile 由 `configs/execution-profiles/legal-v1-sandbox.json` 统一版本化：清单固定引用当前 DomainPack、一次性 Workspace、Docker 执行环境及镜像环境变量名。应用组合根在任何运行模式下都先用锁定 Hypha 的 `ExecutionEnvironmentSpec` 校验该清单；启用真实 Sandbox 时还会把解析后的清单与运行时代码生成的安全策略逐字段比较。清单缺失、引用版本不一致、网络/挂载/非 root/资源/清理策略漂移或镜像 digest 未固定时均在执行和运行数据写入前关闭失败。该绑定回执只含版本引用与清单 SHA-256，不含 Workspace 路径、镜像值或凭证。

Schema 差异只包含数据源清单授权的表和字段，不扫描或输出其他客户 Schema。漂移事件、旧/新指纹、受影响表/字段数量和重新规划状态会写入哈希链审计日志；数据库路径、主机、账号、密码和字段数据不会进入通知或日志。对应接口为 `POST /api/sessions/:sessionId/schema-replan`，请求体固定为 `{ "requested": true }`。

### 执行日志归档与恢复

执行日志维护必须在应用停止写入的维护窗口内进行。`archive` 先验证完整哈希链，再原子写入日志快照和不含本机路径的 SHA-256 清单；归档不会自动删除在线日志。只有归档再次验证通过、在线日志与归档逐字节一致且操作员输入固定确认短语时，才允许删除在线副本。恢复会再次校验归档内容和哈希链，并且绝不覆盖已经存在的在线日志。归档目录、日志和清单都属于私有运行数据，已由 `data/` 规则排除在 Git 之外。

```bash
# 1. 创建归档；输出 archiveId
npm run manage:execution-log -- archive
# 2. 独立复核归档
npm run manage:execution-log -- verify <archiveId>
# 3. 灾备演练：确认归档后删除在线副本，再从归档恢复
npm run manage:execution-log -- delete-source <archiveId> DELETE_VERIFIED_EXECUTION_LOG_SOURCE
npm run manage:execution-log -- restore <archiveId>
```

线上策略应把归档目录放在访问受控、具备备份与不可篡改能力的独立存储中，并由组织的数据保留制度确定保存期限。本项目不擅自设定统一法定期限，也不提供自动删除归档的命令。

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

本地网页默认使用普通用户角色。需要执行数据源管理、查看审计日志或审批受治理写入/Sandbox 时，由本机操作者在启动前把 `.env` 中的 `LEGAL_LOCAL_ROLE` 固定为 `administrator` 并重启服务；前端不能通过参数、请求体或请求头提权。该开关只用于本地项目层门禁验证，不是生产身份认证：

```bash
LEGAL_LOCAL_ROLE=user
# 或由本机操作者显式设置：LEGAL_LOCAL_ROLE=administrator
```

默认 `LEGAL_AGENT_PROVIDER=demo`，无需外部模型即可运行。接入 DeepSeek：在 `.env` 中设置 `LEGAL_AGENT_PROVIDER=deepseek` 与 `LEGAL_AGENT_API_KEY`；或使用 `npm run demo:web:deepseek`，脚本隐藏读取 API Key，不落盘、不进命令历史。本地演示开启诚实回退：仅在网络、超时、限流或服务端故障等可重试错误时使用演示推理并如实标注；鉴权或请求错误不会回退。接入其他 OpenAI-compatible 模型：

```bash
LEGAL_AGENT_PROVIDER=openai-compatible
LEGAL_AGENT_BASE_URL=http://127.0.0.1:11434/v1
LEGAL_AGENT_MODEL=your-model-id
LEGAL_AGENT_API_KEY=optional-for-local-provider
```

密钥不要写入仓库。真实 Provider 只替换法律自检中的结构化事实推理，隐私门、输出校验、法规检索和禁止生成法律结论等边界仍然生效。

DataSource/Schema 能力绑定位于 `configs/capability-bindings/legal-v1-data-sources.json`，可选的 SQLite 只读配置位于 `configs/data-sources/legal-cases.sqlite.json`。配置只保存环境变量引用和允许访问的表名，不保存数据库路径或凭证；数据库文件、Schema 快照和查询输出均不得提交到仓库。`LEGAL_V1_SQLITE_MANIFEST` 只能选择能力绑定中已登记的只读或受治理写入清单，任意私有路径或临时清单都会在数据库打开前拒绝。当前真实数据模式开放两个受审计的受约束 Text2SQL 模板：一是按年度统计未签劳动合同案例的案件数、胜诉率和赔偿中位数，二是仅统计案件数和胜诉率。两者均接受一个年份、最多十年的年份范围，或确定性配置的“近三年”；第二个模板只读取 `year`、`issue_type`、`outcome`，不会读取赔偿字段。网页结果表和导出 PDF 也只按照查询计划中的输出契约展示白名单统计列，未知字段不会直接渲染。年份和事项均作为绑定参数，不拼接到 SQL；其他自然语言查询、用户提供的原始 SQL 和缺少相应模板所需字段的 Schema 会关闭失败。

网页创建 V1 会话时可选传入 `requestedOutputFormats`，当前支持 `table`、`chart`、`analysis-document` 和 `pdf`，顺序会规范化且不允许重复或未知格式。安全回执同时区分“请求格式”和“当前有效格式”：现阶段绑定的专业查询输出仍完整发布表格、图表、经 Artifact Store 持久化的 Markdown 分析文档以及客户端 PDF 导出，因此请求子集不会绕过强制分析产物持久化。`dataSourceId` 和 `workspaceId` 不属于客户端请求字段，夹带这些选择器会直接返回无效请求。逻辑查询 Workspace 与一次性 Docker Sandbox Workspace 是两种不同对象：前者只保存会话级状态和 Artifact 引用，严格超过 30 天未活动后归档；后者在每次脚本执行终态立即清理，绝不等待 30 天。

`configs/evaluations/legal-v1-text2sql.json` 是不含真实案件、用户文本或凭证的版本化合成验收语料。它把 12 个受支持查询变体与 8 个危险/不支持输入分开计分，逐项核对模板、参数化 SQL、Schema 字段、指标和输出列，并进行 200 次生成耗时采样。`npm run audit:text2sql` 要求受支持计划准确率不低于 90%、拒绝准确率为 100%，且任一生成耗时必须小于 2 秒；门禁失败时命令返回非零状态。该结果只证明当前两个白名单模板在固定语料上的回归质量，不代表通用或开放域 Text2SQL 准确率，也不替代 PostgreSQL/MySQL 真实 Provider 验收。

只读 SQL 使用 `constrained-readonly-v2` 策略重新计算计划哈希。策略在 Provider 执行前隔离字符串字面量并拒绝 SQL 注释、带引号标识符、控制字符、未闭合字符串、CTE、子查询、JOIN、集合操作、`SELECT INTO` 及 SQLite/PostgreSQL/MySQL 的扩展命令；参数仅允许合法名称和有限数值、字符串、布尔值或 `null`。策略版本变化会使旧确认计划失效并要求重新规划。

```bash
LEGAL_V1_RUNTIME=sqlite
LEGAL_V1_SQLITE_PATH=D:/private-data/legal-cases.sqlite
npm run demo:web
```

SQLite 文件须包含清单允许的 `labor_cases` 表，以及 `year`、`issue_type`、`outcome`、`compensation_amount` 字段。网页仍先展示 SQL、参数、Schema 指纹与计划哈希，用户确认后才在只读 Worker 中执行；确认期间会话进入 `executing`，重复确认会被拒绝。

本地 SQLite 受治理写入使用独立公开清单 `configs/data-sources/legal-cases-write.sqlite.json`，避免误把默认只读配置升级为写权限。目标表还须包含唯一 `case_id`。建议只对可恢复的本地副本启用：

```bash
LEGAL_V1_RUNTIME=sqlite
LEGAL_V1_SQLITE_MANIFEST=configs/data-sources/legal-cases-write.sqlite.json
LEGAL_V1_SQLITE_WRITE_PATH=D:/private-data/legal-cases-write.sqlite
npm run demo:web
```

支持的自然语言模板为：“新增案例 LC-2026-1，年份 2026，事项 未签劳动合同，结果 employee_win，赔偿 20000”“将案例 LC-2026-1 的赔偿金额更新为 12000”“删除案例 LC-2026-1”。这不是通用 Text2SQL；不符合模板的写入会关闭失败。

受治理脚本沙箱已提供项目层运行时、网页“计划—确认—执行—结果”入口与独立真实 Docker 验收命令。版本化 Workspace/Execution 绑定位于 `configs/execution-profiles/legal-v1-sandbox.json`；其中只保存环境变量名称和安全策略，不保存镜像值、主机路径或凭证。镜像必须同时提供 `python3`、`/bin/sh`、`sleep` 与 `ln`，并使用不可变 SHA-256 digest；不能只写可漂移的镜像标签：

```bash
LEGAL_V1_SANDBOX_ENABLED=true
LEGAL_V1_SANDBOX_IMAGE=python:3.12-alpine
LEGAL_V1_SANDBOX_IMAGE_DIGEST=sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df
npm run preflight:sandbox:docker
npm run audit:sandbox:docker
```

启用后，本地网页 Demo 会显示“脚本沙箱”入口：浏览器提交 Python/Shell 脚本与最多 32 个输入文件，服务端先返回不含正文的哈希化执行计划；用户明确确认后，才通过最新本地 Hypha 的公开 `GovernedToolRunner` 与 `DockerSandboxProviderFactory` 执行。Web 响应只返回退出状态、私有 Artifact 引用、清理证据和治理事件摘要，不回显脚本或文件正文。默认 `LEGAL_V1_SANDBOX_ENABLED=false`，因此未安装 Docker 时不影响原有 V0/V1 Demo。

预检与真实验收命令都会自动读取已忽略的 `.env`。预检只检查 Docker CLI、daemon 和本地精确镜像，不会自动拉取镜像；首次准备时由操作者显式执行：

```bash
docker pull "python:3.12-alpine@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df"
```

该命令真实执行 Python、Shell、禁网、路径逃逸、符号链接、超时与内存限制用例，并核对每个运行的 Human Review 事件、Artifact 回执和 Workspace 清理。缺少 Docker daemon、镜像或 digest 时命令以非零状态诚实失败；自动化 Mock Provider 测试只证明业务接线与治理合同，不替代 OS 级隔离验收。

PostgreSQL 与 MySQL 使用相同的计划、确认、Schema 防漂移和结果上限合同。公开清单位于 `configs/data-sources/`，只保存环境变量引用；连接值与密码只允许通过 `.env` 或进程环境传入。网络数据库默认要求 TLS，并强制只读事务；只有隔离的本地验收库可显式设置 `*_TLS_MODE=disable`。

本地网页的“数据源管理”入口只对服务器绑定的 `administrator` 角色开放，会列出 SQLite、PostgreSQL、MySQL 三个只读清单、授权表/字段、执行上限以及各环境变量是否已配置。页面没有凭据输入框，接口也只接受固定 `profileId`；主机、数据库路径、账号、密码和 Provider 原始错误不会进入响应。点击“验证连接与 Schema”后，服务端才使用启动前设置的私有环境变量进行连接和白名单 Schema 核验，并展示深冻结的初始 Schema 快照；快照只复制白名单表名以及列名、类型、可空性和主键序号，不透传 Provider 的其他元数据。回环地址和本地角色开关都不构成生产登录，生产部署仍须补充独立管理员认证、租户/对象级授权和审计。

```bash
# 二选一，并在 .env 中填写对应 LEGAL_V1_PG_* 或 LEGAL_V1_MYSQL_* 变量
LEGAL_V1_RUNTIME=postgresql
LEGAL_V1_RUNTIME=mysql

# 可复现的真实 Provider 验收；缺少凭证或 Schema 时以非零状态诚实失败
npm run audit:sql:postgresql
npm run audit:sql:mysql
```

真实验收账号必须仅拥有目标 `labor_cases` 表四个白名单字段所需的 `SELECT` 权限。驱动错误会转换为不含主机、用户名、密码和查询参数值的安全错误。

分析产物默认存入 Git 忽略的 `data/web-demo/v1-artifacts`，也可通过 `LEGAL_V1_ARTIFACT_DIR` 指向其他私有目录。存储对象键由会话、运行和产物标识的 SHA-256 派生，不包含原始标识；网页返回和哈希链日志均不暴露磁盘根路径。归档 Workspace 的历史接口只返回产物元数据与授权下载路径，不返回正文；下载接口再次通过 owner 隔离、归档回执及 Store 内容 SHA-256 校验，且不返回 Store 对象键或根路径。账号历史清除会通过当前 Hypha Store 的公开删除接口校验引用、ETag、内容哈希与大小，删除后再次确认对象不存在；多 Store 操作不宣称分布式事务，Artifact 预检失败时不会先删 Session，发生部分失败时返回冲突错误并保留汇总失败审计供重试。

## 验证

```bash
npm run verify   # verify:baseline + verify:domain + Text2SQL 评测 + verify:replay + Package Test
npm test         # 仅 Package Test
```

完整 `verify` 依次检查：本地 Hypha 仓库是否等于锁定 commit（或仅在业务锁定依赖范围外继续前进）；所需 Hypha 构建产物是否存在；Legal DomainPack 能否通过 Hypha 校验并编译为 FSM；Workspace/Execution、DataSource/Schema、Workflow State 与 Artifact/Output 项目侧能力绑定能否通过引用、指纹、完整状态覆盖、Repository 描述和安全发布契约校验；Session/Agent capability snapshot 与 Agent patch 的版本、哈希、当前 runtime 和组合关系是否一致；当前两个受约束 Text2SQL 模板能否通过版本化准确率、拒绝率和 2 秒延迟门禁；Package Test 是否通过。若 Domain、Inference、Kernel 等依赖范围发生变化，验证会主动停止，必须先重新只读审计兼容性，不能放宽门禁。

`verify` 还会加载 `configs/replay-fixtures/` 中两份版本化、SHA-256 固定的 V0/V1 脱敏合成 Fixture，通过 Hypha `ReplayEngine` / `RegressionRunner` 将当前业务路径与黄金事件、状态路径、策略决策、工具调用和最终输出逐项比较，并在临时目录执行一次清单约束的恢复复验。Fixture 不保存用户原文、会话标识、客户数据或凭证；缺失、篡改、PII/Secret 检测或业务输出漂移均会使验证失败。

法规语料可单独审计：

```bash
npm run audit:law-corpus    # 新鲜度
npm run audit:law-coverage  # 覆盖度（语料不足 100 条时按设计失败）
npm run audit:law-sources   # 官方来源只读核对（需联网）
npm run audit:sql:mysql     # MySQL 真实只读 Provider 验收（需专用凭证）
npm run audit:sql:postgresql # PostgreSQL 真实只读 Provider 验收（需专用凭证）
npm run audit:text2sql      # 两个白名单模板的合成准确率、拒绝率和生成延迟门禁
npm run audit:sandbox:docker # Docker 脚本沙箱真实隔离验收（需 Docker 与 digest 固定镜像）
npm run verify:replay       # V0/V1 脱敏 Replay、Regression 与临时恢复验收
```

## 目录结构

```text
configs/domain-packs/  Legal DomainPack（FSM 工作流契约）
configs/replay-fixtures/  V0/V1 脱敏合成 Replay 黄金 Fixture 与完整性清单
resources/law-corpus/  经官方来源核验的本地法规语料
scripts/               启动、密钥生成、语料审计与基线验证脚本
src/agent/             Hypha ReAct Agent 业务适配层（推理 Provider、输出边界校验）
src/                   法律自检、专业数据分析、只读数据源、Artifact Store、隐私网关与本地网页服务
src/web/               本地网页 Demo 服务（仅 127.0.0.1）
tests/                 Package Test
web/                   网页前端（原生 HTML/CSS/JS，零构建）
hypha.lock.json        Hypha 可复现基线
```

## 安全说明

- 网页 Demo 仅绑定 `127.0.0.1`，校验 Host 头防 DNS 重绑定，API 写入强制 `application/json`；
- API Key 只经环境变量传入，不写日志、不进错误消息、不下发前端；
- 本项目仍是本地单 owner 演示形态：已实现服务器绑定的 `user` / `administrator` 项目层门禁，但不含生产级账号登录、组织/租户 RBAC、审批人职责分离、远程 Store 授权或 HTTPS 部署。

## 尚未实现

组织账号生命周期联动删除、每日法规同步、PostgreSQL/MySQL 真实凭证环境验收及受治理写入、更广泛的多业务模板受约束 Text2SQL、归档 Workspace 的原任务恢复、生产级身份认证/租户 RBAC/审批职责分离、远程 Store 授权及生产级网页部署尚未完成。当前已完成的是服务器绑定单 owner 的本地全历史清除合同，不能替代组织账号、租户或法定保留策略验收。SQLite 已完成两个具有独立 Schema 和输出契约的自然语言只读模板，以及固定模板单行写入的项目层 Human Review、事务回滚和自动化验收；逻辑查询 Workspace 已完成 30 天不活跃归档、只读历史和本地 owner 授权下载，但为避免在旧 Schema/权限下静默执行，当前恢复策略是显式新建任务；脚本沙箱已完成网页入口、Hypha Docker Provider 接线、固定隔离策略、Artifact 持久化和当前 Docker Desktop 环境的真实验收。本业务仓库只消费 Hypha 公开接口，不修改 Hypha 源码或绕过治理门禁。
