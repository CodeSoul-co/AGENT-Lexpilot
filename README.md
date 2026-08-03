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
- 删除需显式确认并执行物理删除；90 天未活跃会话自动清理。

### 法规依据可核验

- 结果卡片只引用本地法规语料，每条法条录入时经官方来源核验并记录正文 SHA-256；
- 提供 `npm run audit:law-corpus`（新鲜度）、`audit:law-coverage`（覆盖度）、`audit:law-sources`（官方来源只读核对）三个审计命令；
- 当前语料版本为 `0.7.0`，Batch 001-005 已覆盖 31/100 个唯一法条；五批新增的 25 条在完成独立检索与结果卡回归前保持不可检索。`audit:law-coverage` 在达到 100 条前按设计以退出码 1 "诚实失败"；未匹配不代表不存在相关法律。

### 真实模型、受控智能

- 默认 `demo` 确定性推理可离线运行；`deepseek` / `openai-compatible` 模式接入真实模型；
- 模型只负责领域识别、事实抽取与追问生成，且输出必须通过结构化边界校验（禁止法律结论、行动建议检测、PII 复检）；校验失败自动回退到确定性管线并在页面如实标注；
- 模型提取的事实须经字段/枚举白名单校验后才会合入会话；确定性提取优先，模型只补缺。

### 专业分析须确认后执行

- 查询计划（参数化 SQL + 注释）先展示；默认只读策略门校验单条 `SELECT`、数据表、字段和绑定参数，用户确认后才执行。SQLite 写入专用配置仅允许固定单行 `INSERT` / `UPDATE` / `DELETE` 模板，并强制进入 Hypha Human Review；多语句和 DDL 一律在数据库前拒绝；
- 计划同时保存白名单范围内的 Schema 快照、Schema 指纹与计划哈希；确认时重新读取真实 Schema，发生漂移即在到达数据库前停止旧计划，并返回新增、移除或属性变化的表/字段清单；
- Schema 变化会在会话和网页中主动通知用户，并提供显式重新规划入口；重新规划只基于当前白名单 Schema 生成新计划，仍须再次人工确认，绝不会因重新规划而自动执行；漂移检测与重新规划同样适用于 SQLite、PostgreSQL 和 MySQL；
- 计划、取消和执行操作写入只增不改的 SHA-256 哈希链日志；日志损坏或篡改时停止读取与追加，日志写入失败时不发布执行结果；旧版 Demo 日志可读，并由首条新版记录建立兼容锚点；
- 产物（表格/图表/Markdown 分析文档）包含内容 SHA-256，可下载并可一键导出 PDF；Markdown 分析文档在发布前写入 Hypha 本地 Artifact Store 并回读校验，持久化失败时停止发布结果；执行日志关联计划、Schema、执行 Provider 与产物存储回执；
- 当前网页专业数据分析流程默认使用匿名合成的固定演示数据结构与本地受控求值器；显式启用 `sqlite` 模式后，使用 Hypha 已构建的公开 `loadSqlite()` 驱动入口连接真实 SQLite 文件，支持连接测试、白名单表 Schema 快照、确认前 Schema 指纹复验、参数化 `SELECT`、15 秒硬超时、500 行与 1 MiB 输出上限。所有组合与治理均位于本项目，不会通过修改 Hypha 绕过治理门。
- SQLite 写入专用配置通过 Hypha `GovernedToolRunner` 创建真实待审批 invocation；拒绝时 handler 不执行，批准后只执行一次。Worker 使用单个事务，失败、超时或影响超过 1 行时不提交，写操作不自动重试。审计日志仅记录 invocation ID、审批状态、事件数量、事务状态和影响行数，不记录参数、数据库路径或凭证。PostgreSQL/MySQL 在取得专用写账号和独立验收环境前继续保持只读。
- Python / Shell 脚本执行同样强制进入 Hypha Human Review。批准后才把已校验路径、数量、总大小与 SHA-256 的输入文件写入独立的一次性 Workspace，并调用锁定 Hypha 基线公开导出的 `DockerSandboxProviderFactory`：网络与 DNS 默认关闭，根文件系统只读，只挂载当前 Workspace，固定非 root 用户、丢弃全部 capability，最多 1 核 CPU、512 MiB 内存和 30 秒命令执行时间。标准输出、标准错误和生成文件通过 Hypha Artifact Store 接口持久化；成功、失败和超时都必须验证执行容器已删除，再清理逻辑 Sandbox 与临时 Workspace。

Schema 差异只包含数据源清单授权的表和字段，不扫描或输出其他客户 Schema。漂移事件、旧/新指纹、受影响表/字段数量和重新规划状态会写入哈希链审计日志；数据库路径、主机、账号、密码和字段数据不会进入通知或日志。对应接口为 `POST /api/sessions/:sessionId/schema-replan`，请求体固定为 `{ "requested": true }`。

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

可选的 SQLite 数据源配置位于 `configs/data-sources/legal-cases.sqlite.json`。配置只保存环境变量引用和允许访问的表名，不保存数据库路径或凭证；数据库文件、Schema 快照和查询输出均不得提交到仓库。当前真实数据模式只开放一个受审计查询模板：近三年未签劳动合同案例的胜诉率与赔偿中位数；其他自然语言查询会关闭失败，不会猜测生成 SQL。

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

受治理脚本沙箱已提供项目层运行时、网页“计划—确认—执行—结果”入口与独立真实 Docker 验收命令。镜像必须同时提供 `python3`、`/bin/sh`、`sleep` 与 `ln`，并使用不可变 SHA-256 digest；不能只写可漂移的镜像标签：

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

```bash
# 二选一，并在 .env 中填写对应 LEGAL_V1_PG_* 或 LEGAL_V1_MYSQL_* 变量
LEGAL_V1_RUNTIME=postgresql
LEGAL_V1_RUNTIME=mysql

# 可复现的真实 Provider 验收；缺少凭证或 Schema 时以非零状态诚实失败
npm run audit:sql:postgresql
npm run audit:sql:mysql
```

真实验收账号必须仅拥有目标 `labor_cases` 表四个白名单字段所需的 `SELECT` 权限。驱动错误会转换为不含主机、用户名、密码和查询参数值的安全错误。

分析产物默认存入 Git 忽略的 `data/web-demo/v1-artifacts`，也可通过 `LEGAL_V1_ARTIFACT_DIR` 指向其他私有目录。存储对象键由会话、运行和产物标识的 SHA-256 派生，不包含原始标识；网页返回和哈希链日志均不暴露磁盘根路径。

## 验证

```bash
npm run verify   # verify:baseline + verify:domain + verify:replay + Package Test
npm test         # 仅 Package Test
```

完整 `verify` 依次检查：本地 Hypha 仓库是否等于锁定 commit（或仅在业务锁定依赖范围外继续前进）；所需 Hypha 构建产物是否存在；Legal DomainPack 能否通过 Hypha 校验并编译为 FSM；Package Test 是否通过。若 Domain、Inference、Kernel 等依赖范围发生变化，验证会主动停止，必须先重新只读审计兼容性，不能放宽门禁。

`verify` 还会加载 `configs/replay-fixtures/` 中两份版本化、SHA-256 固定的 V0/V1 脱敏合成 Fixture，通过 Hypha `ReplayEngine` / `RegressionRunner` 将当前业务路径与黄金事件、状态路径、策略决策、工具调用和最终输出逐项比较，并在临时目录执行一次清单约束的恢复复验。Fixture 不保存用户原文、会话标识、客户数据或凭证；缺失、篡改、PII/Secret 检测或业务输出漂移均会使验证失败。

法规语料可单独审计：

```bash
npm run audit:law-corpus    # 新鲜度
npm run audit:law-coverage  # 覆盖度（语料不足 100 条时按设计失败）
npm run audit:law-sources   # 官方来源只读核对（需联网）
npm run audit:sql:mysql     # MySQL 真实只读 Provider 验收（需专用凭证）
npm run audit:sql:postgresql # PostgreSQL 真实只读 Provider 验收（需专用凭证）
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
- 本项目是本地单用户演示形态，不含生产级账号体系、权限系统与 HTTPS 部署。

## 尚未实现

生产级账号删除、每日法规同步、PostgreSQL/MySQL 真实凭证环境验收及受治理写入、通用受约束 Text2SQL、生产级权限系统及生产级网页部署尚未完成。SQLite 固定模板单行写入已经完成项目层 Human Review、事务回滚和自动化验收；脚本沙箱已完成网页入口、Hypha Docker Provider 接线、固定隔离策略、Artifact 持久化和当前 Docker Desktop 环境的真实验收。本业务仓库只消费 Hypha 公开接口，不修改 Hypha 源码或绕过治理门禁。
