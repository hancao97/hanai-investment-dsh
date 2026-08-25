# 投研机器产物

本目录保存 K 线变盘点、量价扫描、缠论稳定性、历史回测和周期投研报告的机器可读产物。变盘点研究的统一分类、数据来源、cutoff、完整脚本映射和复现命令见[变盘点、扫描与回测研究总索引](../turning-point-research-index.md)。

目录约定：

- `production-turning-point-full-backtest-*.json` 是当前生产规则的汇总审计；
- `production-turning-point-events-*.jsonl.gz` 是逐事件台账；
- `full-market-*` 是候选发现研究；
- `kline-*`、`ma-volume-*` 是固定样本基线、周期与量价研究；
- `chan-*` 是缠论点位生命周期和年度稳定性研究。
- `a-share-cycle-outlook-*` 是五种 AI 方法论会商、宏观/行业/公司证据、互斥情景状态机、观点门禁和观察池的人工策展结构化快照；不提供未经校准的概率。`a-share-cycle-outlook-pre-council-2026-08-25.json` 是 Round 4 实际读取且由 SHA 绑定的冻结前置输入，最终聚合不得覆盖它。
- `a-share-cycle-market-snapshot-*` 是报告使用的点时估值、相对强弱、条件历史频率、市场/板块宽度与国债机会成本快照；2026-08-25 完成版同时保存标准化前复权日线和逐条件事件，可离线复算比例；由 `a-share-cycle-market-snapshot.ts` 生成。
- `a-share-cycle-expert-runs-*` 由 `run-a-share-expert-council.ts` 生成，保存最新事实复核的冻结输入、五份完整提示词、原始 DSH 输出、解析结果和提示词 / Skill / AGENTS / 脚本哈希；具体模型与reasoning配置若未冻结会显式标记。

回测与专家运行台账是生成物，不应手工修改；周期展望主 JSON 是经一手来源与门禁审查后的人工策展快照，必须显式披露这一边界。需要变更规则、数据或统计方法时，应修改或新增脚本，使用新的版本 / 日期生成新产物，并同步更新总索引和人类可读结论。metadata、运行台账与 SHA-256 共同构成审计链。

快速完整性检查：

```bash
jq empty docs/research-data/*.json
gzip -t docs/research-data/production-turning-point-events-2026-08-23.jsonl.gz
```

缓存和供应商 manifest 默认位于 `/tmp`，没有提交到仓库。仓库中的结果因此是可审计快照，不等于仅凭仓库内容就能离线重算；复现还需要相同证券主数据、行情缓存、外部 `chan.py` commit 和 Python 依赖环境。
