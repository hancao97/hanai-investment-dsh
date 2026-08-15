# ADR-0001：采用 DSH 规范的 React UI 与 Hanai 自有聊天

- 状态：已接受并实现
- 日期：2026-08-15

## 背景

旧版 Hanai Investment 是 Electron + Vue 多页应用。DSH Web 使用 React 18、Cordis Client Plugin、Slot、共享 `ui-primitives`、CSS Modules 和 `--dsw-*` 主题令牌。当前 DSH 根布局只提供 `sidebar`、`conversation`、`details` 三个单占位 Slot 和 `shell.overlay` 列表 Slot，没有面向任意业务页面的通用 Router/Page Slot。

如果插件直接占用 `conversation`，会替换 DSH 原生会话、composer 和其下游节点；如果替换 `root`，还必须接管布局、主题和所有子 Slot。两者都会扩大实现范围并降低升级兼容性。产品希望报告与追问保持在 Hanai 自己的研判页面，因此也不采用“打开报告后跳转到 DSH 原生聊天”的交互。

## 决策

### 1. 技术栈

所有新页面使用 React 18 + TypeScript 重写，不迁移 Vue 运行时。Client Plugin 使用 DSH 共享的 React/ReactDOM 单例，禁止把第二份 React 打入插件 Bundle。

### 2. 页面容器

首版保留 DSH 的 `ui-layout` 和 Slot 运行时：

- 在 `shell.overlay` 注册启动后自动显示的全屏 Hanai Workbench；
- Workbench 内部承载市场、自选、股票、估值、研判管理、报告、聊天、凭据和运行诊断页面；
- 生产配置不提供关闭 Workbench 或导航到 DSH 原生聊天的入口；启动失败显示 Hanai 自有故障页。

插件不占用 `root`、`sidebar`、`conversation` 或 `details` 单槽。DSH 原生 `ui-conversation` 可以继续在 Workbench 后方装载，但 Hanai 用户不可见，也不属于产品导航或错误降级路径。

### 3. 报告与对话

报告和持续对话都显示在 Hanai 研判详情页。Hanai 实现自己的消息时间线和 composer，通过绑定的 `dshSessionId` 读取历史、订阅事件、发送 prompt 和执行取消。

该决定只替换聊天呈现层：Session、消息事实源、队列、Agent、模型调用、工具活动、持久化和恢复仍由 DSH 负责。Hanai 不创建第二套消息数据库。

### 4. 组件和样式

组件优先级：

1. DSH `ui-primitives`；
2. Hanai 本地 React + CSS Modules 组件；
3. 确有复杂无障碍交互需求时，引入无样式 headless primitive。

不引入 shadcn、Tailwind 或全局主题。样式只使用 CSS Modules；Workbench 根节点先继承 `--dsw-alias-*`，再在自身作用域中映射“澄海蓝”和“青玉绿”两套 `--hanai-*` 产品令牌。插件不得注入 reset、修改 `body` 主题或覆盖 DSH 全局选择器。

### 5. 功能完整性

Overlay 是容器选择，不是功能降级。首版仍须实现全部核心业务页面，并在 Workbench 内提供完整的报告/聊天体验。聊天实现必须覆盖消息历史、流式输出、队列、取消、错误、重连和 Session 恢复。

## 后果

### 正面

- 不需要修改或 fork DSH。
- DSH Session 恢复、Agent 和工具活动仍作为底层能力复用。
- 报告与追问同屏，产品导航和视觉保持完整一致。
- 组件、主题、暗色模式和交互与 DSH 一致。
- Hanai 页面以后可以迁入正式 Page Slot，而无需重写业务和 Host 层。
- 避免维护 Vue、React 两套前端运行时。

### 代价

- 首版 Hanai 页面没有独立 URL deep-link。
- Workbench 是全屏常驻 Overlay，需要完整处理焦点、滚动锁、窄屏、启动故障和 HMR 恢复。
- 树外 Client Plugin 构建 API 尚未稳定，需要锁定 DSH 版本和维护构建适配器。
- ECharts 等第三方依赖会内联进单文件插件 Bundle，必须控制体积。
- Hanai 需要维护 DSH Session 事件到聊天 View Model 的折叠逻辑和交互测试。

## 被否决的方案

### 保留 Vue 独立 SPA

技术成本最低，但会保留第二套前端运行时、主题和会话桥接，不符合目标方向。

### 全量引入 shadcn/Tailwind

技术上可以增加独立构建适配，但会形成第二套主题、全局 CSS 和组件规范，并增加 React/DSH Client Bundle 的兼容风险。当前目标是功能完整而非快速堆 UI，因此不采用。

### 使用 DSH 原生 Conversation

底层能力最省，但用户会离开 Hanai 研判详情，报告和追问无法按产品需要同屏呈现，因此不采用为主流程。

### 替换 `conversation`

可以把自有聊天放进 DSH 中央栏，但会替换整个标准 Conversation Surface 及其子 Slot。使用 Overlay 已能承载完整 Hanai 页面，无需扩大替换范围。

### 替换 `root`

会接管布局、主题、Sidebar、Conversation 和 Details 的完整契约，升级风险最大，不采用。

## 后续演进

如果 DSH 提供稳定的 `shell.page`、navigation 和 URL 路由扩展，Hanai Workbench 可以从 Overlay 迁移为正式页面。该变化不得影响 Host API、领域模型、Session 绑定或报告事件格式。
