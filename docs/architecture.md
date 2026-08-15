# Hanai Investment for DSH 总体架构设计

- 状态：核心架构已实现
- 更新日期：2026-08-15
- DSH 分析基线：`deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`

## 1. 结论

`hanai-investment-dsh` 实现为一个树外 DeepSeek Harness Bundle。它复用 DSH 的模型、凭据、Agent、Session、会话历史、流式事件和 Web Client 插件机制；Hanai 自己拥有股票、行情、估值、自选、大师研判、报告版本和聊天呈现等业务能力。

新 UI 全部使用 React 重写。首版不要求 DSH 新增通用 Router：`hanai-investment` Profile 启动后在 `shell.overlay` 中自动挂载全屏常驻的 Hanai 工作台，完成行情、自选、股票详情、估值、研判管理、报告阅读和持续对话。Hanai 自己渲染消息时间线和 composer，所有轮次仍发送给绑定的 DSH Session。

该结构不向 Hanai 用户展示 DSH 原生聊天页面，但仍复用 DSH 的 Session 持久化、Agent、队列、取消、恢复和事件流。Hanai 只重写呈现和交互层，不实现第二套 Agent 运行时或聊天存储。

## 2. 目标与非目标

### 2.1 目标

- 以可安装的 DSH Bundle 发布，不 fork DSH。
- 保留旧产品的行情、自选、搜索、股票详情、估值和大师研判能力。
- 使用 DeepSeek 模型生成大师研判报告。
- 页面可以设置、删除和验证 DeepSeek API Key，但不读取或保存明文副本。
- 每份报告与一个持久 DSH Session 绑定，报告完成后可以和原大师持续对话。
- 报告支持封存、校验、哈希和显式版本修订。
- 新旧数据目录完全隔离，新版只初始化自己的空数据根。
- 桌面和本地优先，不建设 Hanai 云端业务后端。

### 2.2 首版非目标

- 不恢复旧 Codex Thread；它不能转换成 DSH Session。
- 不把 Hanai 消息复制到第二套 Conversation/Message 表；DSH Session 日志是聊天事实源。
- 不支持在已有对话中原地切换大师；切换大师创建新 Session 或 Fork。
- 不在首版提供 Hanai 页面的 URL deep-link。需要该能力时，向 DSH 增加正式的 `shell.page`/navigation 扩展面。
- 不引入 shadcn、Tailwind 或第二套全局主题。
- 不检测、读取或导入旧版 `~/.hanai-investment`。

## 3. 系统结构

```mermaid
flowchart LR
    User["用户"] --> Workbench["Hanai React 工作台\nshell.overlay"]
    Workbench --> ReportView["Hanai 报告页面"]
    Workbench --> Chat["Hanai 聊天页面"]

    Workbench --> Remote["/hanai 类型化 Connection RPC"]
    Workbench --> Credentials["DSH Credentials API"]
    Chat --> SessionClient["DSH Session API / Event Stream"]
    SessionClient --> Sessions["DSH Session / Agent"]

    Remote --> Domain["Hanai Domain Service"]
    Domain --> Market["行情与估值 Provider"]
    Domain --> Database["Hanai SQLite"]
    Domain --> Reports["封存报告"]
    Domain --> Sessions

    Credentials --> DeepSeek["DeepSeek Provider"]
    Sessions --> DeepSeek
    Sessions --> SessionLog["$DSH_HOME/sessions"]
    Sessions --> Workspace["研判 Workspace"]
    Reports --> ReportView
```

### 3.1 数据所有权

| 数据 | 所有者 | 默认位置 |
| --- | --- | --- |
| DeepSeek API Key | DSH Credentials | `$DSH_HOME/.credentials.yaml` |
| 模型及普通 DSH 设置 | DSH Settings | `$DSH_HOME/settings.yaml` |
| 会话事件、消息和工具历史 | DSH Session Persistence | `$DSH_HOME/sessions` |
| 聊天附件 | DSH Attachment Service | `$DSH_HOME/attachments` |
| 自选、证券主数据、研判索引 | Hanai | `~/.hanai-investment-dsh/db/hanai.sqlite` |
| 研判工作区 | Hanai | `~/.hanai-investment-dsh/judgements/<id>/workspace` |
| 正式报告快照 | Hanai | `~/.hanai-investment-dsh/judgements/<id>/reports` |
| 行情和估值缓存 | Hanai | `~/.hanai-investment-dsh/cache` |

详细规则见 [ADR-0002](adr/0002-data-root-isolation.md)。

## 4. 仓库结构

```text
hanai-investment-dsh/
├── docs/
├── packages/
│   ├── contracts/              # Host/Client 共享的 JSON-safe TypeScript 合约
│   ├── domain/                 # 股票、自选、估值、研判与报告领域逻辑
│   ├── host/                   # Cordis Service、Connection RPC、Agent 编排和持久化
│   ├── client-workbench/       # 侧栏入口、全屏 Hanai 工作台和业务页面
│   ├── client-chat/            # 报告详情、消息时间线和 composer
│   └── masters/                # 四位大师 Skill、参考资料及版本元数据
├── tooling/
│   └── dsh-client-bundle/      # 锁定 DSH 基线的最小 Client Bundle 构建适配器
├── package.json
├── pnpm-workspace.yaml
└── tsconfig*.json
```

DSH 当前没有发布稳定的树外 Client Plugin 构建 SDK。首版在本仓库维护一个最小构建适配器，生成 DSH Module Loader 所需的单文件 `client.js`，并通过真实 Profile 启动测试约束兼容性。该适配器必须锁定 DSH 版本，不能从相邻源码目录做隐式相对导入。

## 5. Bundle 与插件装配

### 5.1 Bundle

仓库根包同时声明 `dsh.bundle` 与 `dsh.client` 两个 sibling role，`cordis.patch.yml` 是 Bundle Patch。它装配：

- Hanai Host Service；
- Hanai `/hanai` Connection RPC；
- Hanai 数据库和 Provider；
- `client-workbench` 的 Host/Client 两面；
- `client-chat` 的 Host/Client 两面；
- 研判 Session Projection；
- 大师资源发现与工作区安装器。

插件安装到独立的 `hanai-investment` Profile。Profile 由 DSH Base、Web App 和 Hanai Bundle 组成；官方 `web` Profile 保持不变。Hanai 不覆盖凭据、Session Persistence 或 WebServer，并只禁用会覆盖 Hanai 首次配置体验的原生 Models Onboarding Surface。

### 5.2 Host/Client 边界

- Host 负责网络、SQLite、文件、报告封存、数据库版本升级和 Agent 生命周期。
- Client 只通过 `/hanai` 类型化 Connection RPC、DSH Credentials/Models API、DSH Session hooks 和 Slot 注入读取状态、发起动作。
- Client 组件不接触 Node API、文件路径、SQLite 或 Cordis `ctx`；`ctx` 仅存在于插件 `apply()` 和 inject 工厂。
- 跨插件 UI 组合只使用 DSH Slot，不从另一个业务插件导入其内部 React 组件。

## 6. React UI 设计

### 6.1 入口和页面容器

`client-workbench` 在 `shell.overlay` 注册 Hanai 工作台，并在插件激活后直接显示。生产配置中工作台没有“关闭并返回 DSH”动作；它是 `hanai-investment` Profile 唯一的产品界面。开发配置可以显式启用宿主调试出口，但默认关闭，且不得成为用户导航的一部分。

`shell.overlay` 里的 “shell” 指 DSH 的页面框架，不是命令行 Shell。它是 `ui-layout` 在 Sidebar、Conversation 和 Details 之上声明的一个列表 Slot；Hanai 插件在这个最上层 Slot 中常驻渲染覆盖整个 Frame 的工作台。

```text
DSH AppFrame
├── sidebar
├── conversation
├── details
└── shell.overlay            # 最上层；Hanai Workbench 打开时占满 Frame
```

它的交互效果是完整的全屏应用，不是新窗口、iframe 或独立 URL 页面。工作台根元素负责恢复 pointer events、焦点管理、滚动管理和窄屏布局；生产模式下 Escape 不会退出到 DSH 原生聊天。若工作台启动失败，必须渲染 Hanai 自己的故障页和重试/诊断操作，不得把原生 DSH Conversation 当作降级界面。

工作台是一个完整、常驻的 React Surface，内部导航状态由该插件自己的 Slot Store 管理。它包含：

- 市场概览；
- 股票搜索；
- 自选分组与自选列表；
- 股票详情；
- 估值分析；
- 大师列表和研判发起器；
- 研判任务列表、运行进度和报告版本；
- DeepSeek 配置状态、写入/删除 Key 和可用模型目录；
- 数据目录、缓存和运行诊断。

Overlay 只是 DSH 当前缺少通用业务页槽时的容器选择，不改变业务组件边界。未来若 DSH 提供 `shell.page`，工作台各页面可以迁入新 Slot，而 Host、Domain、RPC 和页面组件保持不变。

### 6.2 报告与 Hanai 自有聊天

用户打开研判后始终停留在 Hanai Workbench。研判详情通过“研判报告 / 继续对话”两个 Tab 管理信息密度；聊天 Tab 使用同一个 `dshSessionId`，不跳转到 DSH 原生 Conversation。

报告区域展示：

- 股票、大师、模型和信息时点；
- 报告 Markdown；
- 版本、生成时间、字节数和 SHA-256；
- 数据来源/免责声明；
- “创建修订版”动作。

聊天区域由 `client-chat` 提供，负责：

- 通过 `dshSessionId` 加载 DSH 持久历史；
- 将 Session 事件折叠为用户消息、助手消息、流式草稿、工具活动和错误状态；
- 提供输入框、发送、队列、steer、停止/取消、审批和问题响应；
- 处理断线重连、冷 Session 恢复和历史分页；
- 切换 Session 时重挂聊天桥接与本地交互状态，避免不同研判串话；
- 在同一 Session 忙碌时禁止并发创建第二个研判 Turn。

DSH 继续负责：

- Session 创建、日志持久化和冷恢复；
- Agent、模型路由、大师工作区和工具执行；
- prompt queue/steer、取消和状态事件；
- 用户/助手/工具事件的完整事实记录。

Hanai 不创建 `messages` 或 `turns` 表。聊天页从 DSH 历史和实时事件构建视图，浏览器中只保存未发送草稿等纯 UI 状态。DSH 原生 `ui-conversation` 可以继续随 Web Profile 装载，但 Hanai 产品入口不导航到它，也不依赖它的内部 React 组件。

### 6.3 组件与样式

UI 遵循 DSH Web 规范：

- React `^18.2.0`，运行时使用 DSH 共享的 React 单例；
- DSH Slot 和标准 Props shares；
- DSH `ui-primitives` 优先，包括 Button、Input、Menu、Modal、Tooltip、Toast、Markdown 和图标；
- CSS Modules 和 `clsx`；
- Workbench 根节点继承 `--dsw-alias-*`，并在自身作用域映射“澄海蓝 / 青玉绿”两套 `--hanai-*` 语义令牌；
- 不使用 Tailwind、shadcn 或全局 reset；
- DSH 缺少的复杂控件优先用本地 React + CSS Modules 实现；只有确有无障碍/交互价值时才引入无样式 headless primitive。

图表使用树外 Client Bundle 内的轻量 React/SVG 实现，避免把 ECharts 整体内联进单文件插件；必须呈现真实序列和来源，禁止用当前价格人工合成走势。

详细决策见 [ADR-0001](adr/0001-dsh-native-react-ui.md)。

### 6.4 DeepSeek API Key 页面

Hanai 设置页复用 DSH Credentials 和 Provider API，不建立自己的 secret store。页面仅提供：

- 当前是否已配置；
- 凭据来源和是否可写；
- 写入或替换 Key；
- 删除受管 Key；
- 读取 DSH 当前可用的 Provider 与模型目录。

规则：

- Key 输入只存在于受控组件的临时状态，提交后立即清空。
- Host 和 Client 日志禁止记录 Key、请求头或完整错误对象中的 secret。
- API 永不返回明文 Key。
- 环境变量提供的 Key 是高优先级只读来源，页面不得伪装写入成功。
- Key 不进入 Hanai SQLite、缓存、报告、Session 自定义事件或浏览器存储。

## 7. 大师研判与持续对话

### 7.1 核心不变量

- 一条 `Judgement` 最多绑定一个根 DSH Session。
- 一条已创建 Session 的 `Judgement` 必须记录 `masterId` 和 `dshSessionId`。
- 报告状态与 Session/Turn 状态分离。
- 报告 `ready` 不意味着 Session 结束或归档。
- Session 一旦产生内容，不能原地更换大师。
- UI 的正式报告来源永远是封存快照，不是可变的工作区 `REPORT.md`。

### 7.2 生命周期

报告与会话轮次是两个独立状态机：

```mermaid
stateDiagram-v2
    state "报告" as Report {
        [*] --> Preparing
        Preparing --> Generating: 创建 DSH Session
        Generating --> Verifying: 首轮结束
        Verifying --> Repairing: 校验失败且可修复
        Repairing --> Verifying: 同 Session 补全
        Verifying --> Ready: 封存报告并发布事件
        Ready --> Revising: 用户明确创建修订版
        Revising --> Ready: 封存 v2+
        Generating --> Failed
        Verifying --> Failed
        Repairing --> Failed
        Revising --> Failed
    }

    state "轮次" as Turn {
        [*] --> Idle
        Idle --> Queued: 用户追问
        Queued --> Running
        Running --> Idle: Turn 完成
        Running --> Cancelling: 用户取消
        Cancelling --> Idle
        Queued --> TurnFailed
        Running --> TurnFailed
        TurnFailed --> Idle: 重试或清除错误
    }
```

推荐状态字段：

```text
reportStatus: preparing | generating | verifying | repairing | ready | revising | failed
turnStatus: idle | queued | running | cancelling | failed
```

二者不能合并。`reportStatus=ready` 与 `turnStatus=running` 是报告完成后用户正在追问的正常组合。

### 7.3 大师身份

首版通过以下三层保证恢复后仍是同一大师：

1. `Judgement.masterId` 和 Session 领域事件记录稳定身份；
2. 研判工作区保存本次使用的大师 Skill 快照；
3. 工作区 `AGENTS.md` 对整段 Session 约束大师身份、研究规则和报告文件语义。

如果 DSH 后续为树外 Bundle 提供稳定的 Preset Root Provider，再把四位大师提升为独立 Agent Preset。后续升级不能改变已有 Session 的组合。

### 7.4 Session 事件与报告协调器

Host 订阅 DSH Session 的 `turn/start` 与 `turn/end`：报告状态处于生成、校验、修复或修订时，成功结束的 Turn 会进入报告校验与封存队列；普通追问只更新 `turnStatus`，不会创建报告版本。聊天页直接使用 DSH Client Runtime 已折叠的 Conversation Snapshot，因此不需要 Hanai 自定义消息 Projection。

发布顺序是：报告文件原子封存成功 → SQLite 事务提交报告版本和最新版本指针 → RPC 下一次读取可见。报告 Markdown 不复制进 DSH 消息或第二套消息表；UI 始终从正式封存文件读取。

### 7.5 报告封存

Agent 只写：

```text
judgements/<id>/workspace/REPORT.md
```

Host 校验通过后复制为：

```text
judgements/<id>/reports/0001/report.md
judgements/<id>/reports/0001/manifest.json
```

`manifest.json` 至少记录：

- judgement/report/version ID；
- 股票和大师；
- DSH Session ID；
- 模型路由；
- 创建和封存时间；
- 内容字节数和 SHA-256；
- Skill 版本；
- 来源报告工作副本；
- Schema 版本。

后续对话可以读取工作副本，但不能改变 UI 已展示的 v1。只有显式“创建修订版”才生成 `0002`。

## 8. 业务数据模型

SQLite 当前包含：

```text
schema_migrations
app_settings
security_master
watch_groups
watch_items
judgements
report_versions
```

`judgements` 的核心字段：

```text
id
sec_id / code / stock_name
master_id / master_version
dsh_session_id nullable
report_status
turn_status
latest_report_version nullable
created_at / updated_at / completed_at
error_code / error_message
```

`report_versions` 的核心字段：

```text
judgement_id / version
relative_path
sha256 / size_bytes
model_provider / model_id
sealed_at
manifest_version
```

路径只保存相对 `dataRoot` 的值，禁止把某台机器的绝对路径写入持久化记录。

Hanai 不创建 `messages`、`turns` 或 `activities` 表。聊天历史、工具活动和 Turn 生命周期由 DSH Session 日志及 Projection 提供；Hanai 只保存业务关联和不可变报告。

## 9. Host Service 与 Connection RPC

Host 在 DSH Connection 上注册唯一的 `/hanai` channel。业务 endpoint 由共享 TypeScript map 约束：

```text
bootstrap / diagnostics.get / theme.set
dashboard.get / sector.stocks
security.sync / security.search / security.detail
watch.list / watch.quotes
watch.group.create / watch.group.rename / watch.group.remove
watch.item.add / watch.item.remove / watch.item.move
judgement.list / judgement.get / judgement.create / judgement.revise
```

DeepSeek Key 与模型目录不经过 Hanai RPC，而是直接调用 DSH 的 `credentials.describe/set/unset` 与 Models capability。所有 Hanai 返回类型是 JSON 兼容的普通数据；诊断页会显示本机绝对数据路径，其他业务记录只持久化相对路径和 opaque Session ID。

Provider 传输层使用 Node/DSH Host 能力重写，不能继续依赖 Electron `net.fetch`。东方财富、腾讯等源必须通过集成测试重新验证，并保留 provider fallback、抓取时间、来源和缓存状态。

## 10. 新版初始化与旧版隔离

新版第一次启动时只创建 `~/.hanai-investment-dsh`，以空数据库开始。实现不得对 `~/.hanai-investment` 做存在性检查、目录遍历、数据库读取、文件复制或删除操作，也不提供导入按钮、迁移命令或兼容读取层。

旧版应用和目录可以继续独立保留。用户以后手动删除旧版数据属于独立的人工操作，不由本插件提供或触发。

详细数据所有权和备份规则见 [ADR-0002](adr/0002-data-root-isolation.md)。

## 11. 安全与权限

- Hanai 数据根目录创建为 `0700`；数据库、报告和 manifest 等普通文件创建为 `0600`。
- Agent 使用 `workspace-write`，写权限限定到当前研判工作区。
- 报告封存目录不作为 Agent cwd，也不授予 Agent 写权限。
- 不沿用旧版 `danger-full-access + never`。
- 网络 Provider 使用明确的目标和超时；错误消息在进入 UI 前脱敏。
- Connection RPC 默认只依赖 DSH 的 loopback 部署假设。若 WebServer 绑定非 loopback，必须先增加真实认证和 CSRF/Origin 策略。
- 报告属于投资研究辅助内容，界面和导出均保留数据时点、不确定性和非收益承诺提示。

## 12. 测试策略

### 12.1 单元测试

- 行情解析、证券标识和估值计算；
- SQLite migration 和事务；
- 报告校验、哈希、封存及版本冲突；
- 数据根路径 containment、目录权限和相对路径持久化；
- Client Store 和页面状态。

### 12.2 真实装配测试

- 从发布产物安装 Hanai Bundle 到临时 DSH Profile；
- 启动 Host 和 Web Client Plugin；
- 验证 `shell.overlay` 自动常驻、原生 Conversation 不可见和 Hanai 聊天页面；
- 验证 Client Bundle 没有第二份 React；
- 验证 CSS 在卸载/HMR 后清理；
- 验证缺少 Host 注入时启动明确失败。

### 12.3 关键链路测试

- 无 Key 时进入配置页，写入 Key 后模型可用且 API 不回传明文；
- 创建研判 → 生成 → 校验/修复 → 封存 → 报告与聊天页面更新；
- 报告完成后同 Session 追问；
- 重启 DSH 后恢复 Session，仍使用同一大师工作区；
- 流式消息、取消、错误和断线重连在 Hanai 页面正确呈现；
- 后续对话不能改变已封存报告；
- 启动和业务请求都不会访问 `~/.hanai-investment`；
- 新数据根初始化失败时明确报错，不回退到旧目录。

## 13. 实现状态

| 子系统 | 状态 | 证据 |
| --- | --- | --- |
| 树外 Bundle / Client Bundle | 已实现 | 根包 sibling roles、单文件 `lib/client.js`、ModuleLoader 协议测试 |
| Domain / SQLite / 数据隔离 | 已实现 | 路径权限、migration、Provider 与报告封存测试 |
| 市场、自选、个股、估值 | 已实现 | React 工作台与真实 Provider 降级链；所有来源必须显示 fresh/stale/fallback |
| 大师研判与报告版本 | 已实现 | 独立工作区、能力包快照、同一 Session、原子封存与 SHA-256 |
| Hanai 自绘聊天 | 已实现 | 历史、流式、工具树、queue/steer/cancel、审批、问题响应和生命周期冻结 |
| 两套主题 | 已实现 | 澄海蓝 / 青玉绿，SQLite 持久化 |
| 独立 Profile | 已实现 | 临时 `DSH_HOME` 上真实安装、配置校验和随机端口启动 |
| 后续演进 | 持续 | URL deep-link、正式树外 Client SDK、更完整附件与供应商 SLA |

## 14. 首版验收标准

只有同时满足以下条件，首版才算完成：

1. 用户可以安装 Bundle 并启动 `hanai-investment` Profile，且官方 `dsh web` 不受影响。
2. 页面可以配置 DeepSeek Key，明文不进入 Hanai 数据目录。
3. 行情、自选、股票详情和估值功能完整可用。
4. 四位大师均可创建研判，并且每次研判有独立工作区和 DSH Session。
5. 报告校验后形成带 SHA-256 的不可变快照。
6. 报告和消息时间线出现在 Hanai 自有研判详情页中，不要求显示 DSH 原生聊天。
7. 用户可以通过 Hanai composer 在同一 Session 继续追问，重启后仍可恢复。
8. 新版不会检测或读取旧版 `~/.hanai-investment`。
9. Agent 没有报告封存目录或凭据文件的写权限。
10. 发布产物通过真实 DSH Profile 启动和关键链路测试。

## 15. 已知风险

- DSH 仍处于 pre-release，Client Bundle 和 Slot API 可能变化；必须锁版本并维护兼容测试。
- 当前没有通用 Page/Router Slot，Overlay 首版没有 URL deep-link。
- Client Bundle 是单文件 closure；新增第三方 UI/图表依赖必须受包体预算约束。
- 自有聊天页需要跟踪 DSH Session 事件语义；DSH 升级时必须通过历史折叠、流式、取消和恢复的兼容测试。
- 东方财富实时集群会拒绝部分 Node TLS 指纹；实现必须快速降级到东财延迟行情与腾讯分时/K 线，并在 UI 明确展示来源，不能标成 LIVE。
- DSH Session 当前没有完整删除能力，需要在产品中说明保留与清理策略。
- 大师成为正式树外 Agent Preset 仍依赖更稳定的 Preset Root 扩展能力。

## 16. DSH 基线参考

以下链接固定到本设计分析时使用的 DSH commit：

- [Bundle 发布与安装](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/develop/basic/publish.md)
- [Web 样式规范](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/web-styling.md)
- [根布局 Slot](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/client/ui-layout/src/client/index.ts)
- [Sidebar Slot](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/client/ui-sidebar/src/client/index.ts)
- [Session Host API](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api/sessions.ts)
- [Client Session Runtime](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a/packages/client/runtime/src/client/sessions)
- [DeepSeek、Credentials 与 Session Persistence 装配](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/base/cordis.patch.yml)
