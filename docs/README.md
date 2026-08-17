# Hanai Worth · 值见 DSH 设计文档

本文档目录记录 **Hanai Worth · 值见**（当前兼容包名 `hanai-investment-dsh`）的实现架构和关键决策。核心 Host、领域层、React 工作台、自绘 DSH Session 聊天、隔离数据根和独立 Profile 已完成；文档中的“后续”条目表示仍需继续演进的能力。

## 文档索引

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [product-capability-analysis-2026-08-17.md](product-capability-analysis-2026-08-17.md) | 参考产品/仓库解读、能力差距、目标产品形态与分阶段升级路线 | 建议方案 |
| [architecture.md](architecture.md) | 已实现架构、插件装配、Agent/报告/续聊链路、数据模型和验收证据 | 已实现 |
| [client-parity.md](client-parity.md) | 旧版客户端功能、页面位置、图表语义和逐项验收基线 | 已实现 |
| [startup-and-verification.md](startup-and-verification.md) | 已实测的安装、启动、数据隔离与浏览器验收报告 | 已验证 |
| [brand.md](brand.md) | 品牌名称、价值主张、标志语义与兼容边界 | 已确定 |
| [ADR-0001](adr/0001-dsh-native-react-ui.md) | DSH 规范的 React UI、工作台 Overlay 和 Hanai 自有聊天页面 | 已接受 |
| [ADR-0002](adr/0002-data-root-isolation.md) | `~/.hanai-investment-dsh` 数据隔离与 DSH 数据所有权 | 已接受 |
| [ADR-0003](adr/0003-isolated-dsh-profile.md) | 独立 `hanai-investment` Profile，与官方 `dsh web` 并存 | 已接受 |

## 当前已确定的原则

1. Agent 运行时由 DeepSeek Harness 提供，不保留 Codex app-server 适配层。
2. 新 UI 使用 React 18 和 DSH Client Plugin 机制，不迁移旧 Vue 组件。
3. 一级导航固定为旧版的“今日市场、自选与发现、大师研判、专家中心、设置与诊断”；个股和研判详情保持从一级页面进入的详情结构。
4. Workbench 使用 `location.hash` 保留 `/dashboard`、`/watch`、`/stock/:secId`、`/judgements`、`/judgements/:id`、`/personas`、`/settings` 的路由语义和 deep-link。
5. ECharts 负责 treemap、分时/K 线、雷达和价值曲线；React 重写不得更换图表类型、计算或数据含义。
6. UI 遵循 DSH 的 Slot、共享 React、CSS Modules 与宿主语义令牌；普通亮色/黑夜模式只切换 Workbench 内的 `--hanai-*` token，不改变布局，也不引入 shadcn/Tailwind 或全局 reset。
7. 一次大师研判对应一个持久 DSH Session；报告 `ready` 后 Session 继续存在，Hanai 自有聊天页向同一 Session 追问。
8. 正式报告是不可变快照；内部版本机制不得被普通追问触发，也不作为未经授权的一级产品能力。
9. DeepSeek API Key 通过原“设置与诊断”页面内的 DSH Credentials 管理，不进入 Hanai 数据库。
10. Hanai 业务数据默认写入 `~/.hanai-investment-dsh`，DeepSeek Key、模型设置、Session 日志和附件继续由 `$DSH_HOME` 管理。
11. 新版不检测、读取或导入旧版 `~/.hanai-investment`，两个版本从数据层完全独立。
12. 插件默认安装到 `hanai-investment` Profile；`dsh web` 的官方 `web` Profile 不被修改。
