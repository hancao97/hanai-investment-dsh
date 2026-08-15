# Hanai Investment for DSH 设计文档

本文档目录记录 `hanai-investment-dsh` 的实现架构和关键决策。核心 Host、领域层、React 工作台、自绘 DSH Session 聊天、隔离数据根和独立 Profile 已完成；文档中的“后续”条目表示仍需继续演进的能力。

## 文档索引

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 已实现架构、插件装配、Agent/报告/续聊链路、数据模型和验收证据 | 已实现 |
| [ADR-0001](adr/0001-dsh-native-react-ui.md) | DSH 规范的 React UI、工作台 Overlay 和 Hanai 自有聊天页面 | 已接受 |
| [ADR-0002](adr/0002-data-root-isolation.md) | `~/.hanai-investment-dsh` 数据隔离与 DSH 数据所有权 | 已接受 |
| [ADR-0003](adr/0003-isolated-dsh-profile.md) | 独立 `hanai-investment` Profile，与官方 `dsh web` 并存 | 已接受 |

## 当前已确定的原则

1. Agent 运行时由 DeepSeek Harness 提供，不保留 Codex app-server 适配层。
2. 新 UI 使用 React 18 和 DSH Client Plugin 机制，不迁移旧 Vue 组件。
3. UI 遵循 DSH 的 Slot、共享 React、CSS Modules 与宿主语义令牌；Hanai 在其全屏根节点内映射两套隔离的 `--hanai-*` 产品主题，不引入 shadcn/Tailwind 或全局 reset。
4. 一次大师研判对应一个持久 DSH Session；报告完成后 Session 继续存在，Hanai 自有聊天页向同一 Session 追问。
5. 正式报告是不可变快照；后续修订生成新版本，不覆盖旧版本。
6. Hanai 业务数据默认写入 `~/.hanai-investment-dsh`，DeepSeek Key、模型设置、Session 日志和附件继续由 `$DSH_HOME` 管理。
7. 新版不检测、读取或导入旧版 `~/.hanai-investment`，两个版本从数据层完全独立。
8. 插件默认安装到 `hanai-investment` Profile；`dsh web` 的官方 `web` Profile 不被修改。
