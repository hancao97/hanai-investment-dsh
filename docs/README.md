# Hanai Worth · 值见 DSH 设计文档

本文档目录记录 **Hanai Worth · 值见**（当前兼容包名 `hanai-investment-dsh`）的实现架构和关键决策。核心 Host、领域层、React 工作台、自绘 DSH Session 聊天、隔离数据根和独立 Profile 已完成；文档中的“后续”条目表示仍需继续演进的能力。

GitHub Pages 研究站点：<https://hancao97.github.io/hanai-investment-dsh/>

- [变盘点能力审计](https://hancao97.github.io/hanai-investment-dsh/turning-point-capability-audit-2026-08-23.html)
- [A 股未来一年周期展望（完整门禁版）](https://hancao97.github.io/hanai-investment-dsh/a-share-cycle-outlook.html)

## 文档索引

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [a-share-cycle-outlook-2026-08-25.html](a-share-cycle-outlook-2026-08-25.html) | 补齐点时行情、相对强弱、市场宽度、估值、粗FCF与六门状态，并以全状态 Round 4 复核主题和六股 | **当前完整周期投研报告** |
| [a-share-cycle-market-snapshot-2026-08-25.json](research-data/a-share-cycle-market-snapshot-2026-08-25.json) | 六股与主题代理的点时行情、标准化前复权日线、逐条件事件、20/60/120日相对收益、市场/板块宽度和10年国债收益率 | **可复算点时市场证据** |
| [a-share-cycle-outlook-pre-council-2026-08-25.json](research-data/a-share-cycle-outlook-pre-council-2026-08-25.json) | Round 4 实际读取的冻结前置输入；与最终聚合 JSON 分离，并由运行台账中的 SHA 绑定 | **可复核会商输入** |
| [a-share-cycle-expert-runs-2026-08-25.json](research-data/a-share-cycle-expert-runs-2026-08-25.json) | Round 4 五个专家 Skill 的冻结事实包、完整提示词、原始输出、解析结果及运行哈希 | **可审计执行证据** |
| [a-share-cycle-outlook-2026-08-23.html](a-share-cycle-outlook-2026-08-23.html) | 2026-08-23 至 2027-08-23 的互斥情景状态机、五种 AI 方法论会商、最新财报、主题证据、六股严格门禁与月度开关 | 历史初版（保留原始缺口） |
| [a-share-cycle-expert-runs-2026-08-23.json](research-data/a-share-cycle-expert-runs-2026-08-23.json) | Round 3 五个专家 Skill 的冻结事实包、完整提示词、原始输出、解析结果、提示词 / Skill / AGENTS 哈希与运行状态 | **可审计执行证据** |
| [turning-point-research-index.md](turning-point-research-index.md) | 变盘点、扫描与回测材料的统一分类、数据血缘、cutoff、产物映射与复现命令 | **研究总入口** |
| [turning-point-capability-audit-2026-08-23.html](turning-point-capability-audit-2026-08-23.html) | 当前 10 类生产标记、22 个有效周期格、候选 case 与统计比例的自包含审计报告 | 当前汇总报告 |
| [full-market-turning-point-study-2026-08-22.md](full-market-turning-point-study-2026-08-22.md) | 5,809 只 A 股、981 万行日 K 上的金针探底、底部巨量、极度缩量、低位反包、巨量长上影等 16 个观察/确认规则 | 已完成：2 类建议观察，0 类达到高胜率上线门槛 |
| [kline-period-turning-study-2026-08-22.md](kline-period-turning-study-2026-08-22.md) | 日 / 周 / 月 K 量价标记的独立后续方向频率、样本量与产品表达边界 | 已接入产品 |
| [kline-turning-marker-product-decision-2026-08-22.md](kline-turning-marker-product-decision-2026-08-22.md) | 达到频率门槛的量价观察标记、精确触发规则、证据展示与统计边界 | 当前产品口径 |
| [decline-quiet-doji-study-2026-08-22.md](decline-quiet-doji-study-2026-08-22.md) | 连续 3 跌 / 5 日 4 跌后的缩量十字星独立补测 | 已补测：不标记 |
| [ma-volume-turning-point-study-2026-08-21.md](ma-volume-turning-point-study-2026-08-21.md) | MA5/10 与 MA20/60 量价变盘事件、历史条件频率、同日对照与非买卖点产品形态 | 当前建议 |
| [ma-volume-special-turning-study-2026-08-21.md](ma-volume-special-turning-study-2026-08-21.md) | 缩量十字星回踩、深跌区巨量及后续均线确认的专项补测 | 已补测：未验证 |
| [ma-volume-buy-sell-strategy-2026-08-21.md](ma-volume-buy-sell-strategy-2026-08-21.md) | 均线＋成交量买卖点锁参回测；保留为历史研究，不作为当前产品买卖点方案 | 历史研究 |
| [kline-buy-sell-signal-design-2026-08-21.md](kline-buy-sell-signal-design-2026-08-21.md) | K 线买卖点产品调研与逐时点回放；保留为历史设计，当前不实现买卖点 | 历史研究 |
| [product-capability-analysis-2026-08-17.md](product-capability-analysis-2026-08-17.md) | 参考产品/仓库解读、能力差距、目标产品形态与分阶段升级路线 | 建议方案 |
| [architecture.md](architecture.md) | 已实现架构、插件装配、Agent/报告/续聊链路、数据模型和验收证据 | 已实现 |
| [client-parity.md](client-parity.md) | 旧版客户端功能、页面位置、图表语义和逐项验收基线 | 已实现 |
| [startup-and-verification.md](startup-and-verification.md) | 已实测的安装、启动、数据隔离与浏览器验收报告 | 已验证 |
| [brand.md](brand.md) | 品牌名称、价值主张、标志语义与兼容边界 | 已确定 |
| [ADR-0001](adr/0001-dsh-native-react-ui.md) | DSH 规范的 React UI、工作台 Overlay 和 Hanai 自有聊天页面 | 已接受 |
| [ADR-0002](adr/0002-data-root-isolation.md) | `~/.hanai-investment-dsh` 数据隔离与 DSH 数据所有权 | 已接受 |
| [ADR-0003](adr/0003-isolated-dsh-profile.md) | 独立 `hanai-investment` Profile，与官方 `dsh web` 并存 | 已接受 |
| [ADR-0004](adr/0004-open-expert-conversations.md) | 不绑定股票或报告的专家开放对谈、DSH Session 所有权与孙宇晨视角边界 | 已接受 |

## 当前已确定的原则

1. Agent 运行时由 DeepSeek Harness 提供，不保留 Codex app-server 适配层。
2. 新 UI 使用 React 18 和 DSH Client Plugin 机制，不迁移旧 Vue 组件。
3. 一级导航为“今日市场、自选与发现、大师研判、专家对谈、专家中心、设置与诊断”；个股、研判与对谈详情保持可直接访问的详情结构。
4. Workbench 使用 `location.hash` 保留 `/dashboard`、`/watch`、`/stock/:secId`、`/judgements`、`/judgements/:id`、`/expert-chats`、`/expert-chats/:id`、`/personas`、`/settings` 的路由语义和 deep-link。
5. ECharts 负责 treemap、分时/K 线、雷达和价值曲线；React 重写不得更换图表类型、计算或数据含义。
6. UI 遵循 DSH 的 Slot、共享 React、CSS Modules 与宿主语义令牌；普通亮色/黑夜模式只切换 Workbench 内的 `--hanai-*` token，不改变布局，也不引入 shadcn/Tailwind 或全局 reset。
7. 一次大师研判对应一个持久 DSH Session；报告 `ready` 后 Session 继续存在，Hanai 自有聊天页向同一 Session 追问。
8. 一次专家开放对谈也对应一个独立持久 DSH Session，但不绑定股票、不生成或封存 `REPORT.md`；Hanai 只保存对谈业务索引。
9. 正式报告是不可变快照；内部版本机制不得被普通追问触发，也不作为未经授权的一级产品能力。
10. DeepSeek API Key 通过原“设置与诊断”页面内的 DSH Credentials 管理，不进入 Hanai 数据库。
11. Hanai 业务数据默认写入 `~/.hanai-investment-dsh`，DeepSeek Key、模型设置、Session 日志和附件继续由 `$DSH_HOME` 管理。
12. 新版不检测、读取或导入旧版 `~/.hanai-investment`，两个版本从数据层完全独立。
13. 插件默认安装到 `hanai-investment` Profile；`dsh web` 的官方 `web` Profile 不被修改。
