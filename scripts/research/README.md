# Research scripts

本目录包含 K 线变盘点、量价扫描、缠论重放、回测报告和周期投研报告脚本。权威的变盘脚本分类、输入输出关系、行情来源、统一 cutoff 与完整复现命令见[变盘点、扫描与回测研究总索引](../../docs/turning-point-research-index.md)。

维护约定：

- `current-*`、`production-turning-point-*` 和 `render-turning-point-*` 构成当前生产规则审计链；
- `full-market-*` 用于全市场候选发现；
- `kline-*`、`ma-volume-*` 是固定样本基线、周期研究和历史策略实验；
- `chan-*` 依赖固定 commit 的外部 `chan.py`，用于点位生命周期和年度稳定性；
- `run-a-share-expert-council.ts` 把最新冻结事实包送入五个已打包专家 Skill，保存完整提示词、原始 DSH 输出、解析结果和提示词 / Skill / AGENTS / 脚本哈希；未冻结的具体模型与reasoning配置必须显式披露；
- `render-a-share-cycle-outlook.ts` 读取人工策展的周期投研 JSON，校验三情景、六指标、五票与来源引用后生成自包含 HTML；报告不计算或展示未经校准的情景概率；
- 周期展望主 JSON 不是模型输出的无损转录，也没有单一生成器；可重跑部分是 Round 3 专家台账与 HTML 渲染。研究方法变化时应新增版本与产物，不覆盖旧日期；
- `/tmp` 下的行情缓存、中间年度产物和 manifest 不属于源码，运行前必须核对 cutoff、证券宇宙、失败数和哈希；
- `--max-symbols`、`--exchange` 等子集参数只用于诊断，不能标记为全量研究。

当前所有冻结研究均以 2026-08-20 为统一行情截止。新时间样本必须使用新的版本 / 日期，不应把 cutoff 后数据混回旧产物。

周期展望报告复现：

```bash
pnpm exec tsx scripts/research/run-a-share-expert-council.ts
pnpm exec tsx scripts/research/render-a-share-cycle-outlook.ts
```
