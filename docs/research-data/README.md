# 变盘研究机器产物

本目录保存 K 线变盘点、量价扫描、缠论稳定性和历史回测的机器可读产物。统一分类、数据来源、cutoff、完整脚本映射和复现命令见[变盘点、扫描与回测研究总索引](../turning-point-research-index.md)。

目录约定：

- `production-turning-point-full-backtest-*.json` 是当前生产规则的汇总审计；
- `production-turning-point-events-*.jsonl.gz` 是逐事件台账；
- `full-market-*` 是候选发现研究；
- `kline-*`、`ma-volume-*` 是固定样本基线、周期与量价研究；
- `chan-*` 是缠论点位生命周期和年度稳定性研究。

这些文件是生成物，不应手工修改。需要变更规则、数据或统计方法时，应修改或新增脚本，使用新的版本 / 日期生成新产物，并同步更新总索引和人类可读结论。旧产物 metadata 中的脚本、来源产物和 SHA-256 共同构成审计链。

快速完整性检查：

```bash
jq empty docs/research-data/*.json
gzip -t docs/research-data/production-turning-point-events-2026-08-23.jsonl.gz
```

缓存和供应商 manifest 默认位于 `/tmp`，没有提交到仓库。仓库中的结果因此是可审计快照，不等于仅凭仓库内容就能离线重算；复现还需要相同证券主数据、行情缓存、外部 `chan.py` commit 和 Python 依赖环境。
