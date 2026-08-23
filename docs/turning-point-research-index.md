# 变盘点、扫描与回测研究总索引

> 索引更新：2026-08-23
> 统一行情截止：2026-08-20
> 适用范围：`docs/`、`docs/research-data/`、`scripts/research/` 中与 K 线变盘点、缠论信号、量价扫描和历史回测直接相关的材料
> 性质：研究归档与复现导航，不构成投资建议或收益承诺

本文是这一类材料的统一入口。已有研究产物没有移动或改名，因为报告、脚本和产物内部记录了相对路径与 SHA-256；移动或直接修改会破坏既有引用和可审计性。

## 1. 先读哪一份

| 需求 | 首选材料 | 状态 |
| --- | --- | --- |
| 看当前系统到底实现了哪些变盘标记 | [K 线观察标记产品决策](kline-turning-marker-product-decision-2026-08-22.md) | **当前产品口径**；规则真值仍以 `packages/client-workbench/src/kline-ma.ts` 为准 |
| 看全部已实现标记的统计比例、对照增量和结论 | [变盘点能力审计 HTML](turning-point-capability-audit-2026-08-23.html) | **当前汇总报告**；由机器产物生成，不是规则定义 |
| 查某一事件的原始回测记录 | [生产逐事件台账](research-data/production-turning-point-events-2026-08-23.jsonl.gz) | **逐事件证据**；压缩 JSONL，不应手工编辑 |
| 查完整统计字段、门禁和数据质量 | [生产全量审计 JSON](research-data/production-turning-point-full-backtest-2026-08-23.json) | **当前机器可读结果** |
| 看尚未引入或曾经考虑过的候选形态 | [全市场 16 类变盘候选研究](full-market-turning-point-study-2026-08-22.md) | **候选研究**；不能据此宣称已上线 |
| 看日、周、月的独立证据 | [日 / 周 / 月周期研究](kline-period-turning-study-2026-08-22.md) | **当前 tooltip 证据来源之一** |
| 看缠论点位会不会重绘、多久确认 | [K 线信号设计与缠论逐时点回放](kline-buy-sell-signal-design-2026-08-21.md) | **历史设计 / 稳定性研究**；缠论点未作为当前生产买卖点 |

“当前产品规则”“统计审计结果”和“候选研究”是三件不同的事：产品规则回答系统会画什么点；统计审计回答历史数据中这些点之后发生了什么；候选研究回答下一轮值得验证什么。任何一份历史研究都不能自动改变产品规则。

## 2. 状态词汇

| 状态 | 含义 |
| --- | --- |
| 当前产品口径 | 当前界面会使用或展示的规则、命名与边界 |
| 当前审计 | 对当前生产规则的最近一次冻结回测；结果可更新，但不能反向改写当时的规则 |
| 支撑研究 | 为现有标记、tooltip 或统计解释提供证据，不是单独的上线授权 |
| 候选研究 | 尚未引入，或只适合影子观察；必须再过冻结规则、折外与前瞻验证 |
| 未验证 / 否决 | 已补测但证据不足，当前不应画点或输出方向性概率 |
| 历史研究 | 曾用于方案探索，后来已被产品决策替代；保留用于追溯，不能作为当前实现依据 |
| 机器产物 | 脚本生成的 JSON / JSONL；应重新运行脚本生成，不应手改 |

## 3. 当前证据链

### 3.1 当前生产规则审计

```text
Hanai 当前证券主数据（hanai.sqlite）
  ├─ current-market-history-download.py ── 日线缓存 + 沪深 300 基准
  └─ current-native-month-history-download.py ── 原生月线缓存
          ↓
packages/client-workbench/src/kline-ma.ts（生产规则真值）
          ↓ production-turning-point-full-backtest.ts
生产全量审计 JSON + 逐事件 JSONL.gz
          ↓ render-turning-point-capability-report.ts
变盘点能力审计 HTML
```

这一条链复用了产品的 `buildKlineTurningStudy`，覆盖当前 10 类标记的 22 个已支持“标记 × 周期”格。最新产物请求 5,557 只当前上市证券；日线缓存成功清单为 5,549，只实际解析 5,548，日 / 周 / 月分别有 5,452 / 5,257 / 2,589 只满足预热与可评估条件。共有 138,262 条成熟事件，另有 887 条因观察窗未结束而按右删失排除。

这里的“全量”指**全量生产规则与所有可评估缓存证券**，不代表无缺口的历史全 A 股。日线 manifest 有 8 个失败证券；原生月线 manifest 有 435 个失败证券；样本以当前上市证券为主，存在生存者偏差。完整失败清单、供应商分布和 period coverage 必须从生产审计 JSON 的 `metadata.*_manifest_audit` 与 `universe` 读取。

### 3.2 历史候选与产品决策

```text
BaoStock 前复权固定样本 / 混合公开行情全市场缓存
  ├─ 基线与 MA / 成交量研究
  ├─ 日周月周期补测
  ├─ 16 类全市场候选研究
  └─ 连跌缩量十字星等专项补测
          ↓
K 线观察标记产品决策
```

这一条链解释现有标记如何被筛选、哪些候选被保留为观察点、哪些被否决。它与当前上市证券生产审计的样本宇宙、复权口径和行情供应商不同，因此比例不能直接拼接成一个“总胜率”。

### 3.3 缠论稳定性研究

```text
BaoStock 前复权日线 + 固定时点指数样本
          ↓
Vespa314/chan.py @ 429d6ed3… 逐根重放
          ↓
首次出现 / 承载笔确定 / 标记冻结 / 失效生命周期
          ↓
单年稳定性 JSON + 2021—2026 walk-forward 聚合 JSON
```

缠论产物用于检查重绘、确认滞后和逐年稳定性，不是当前 K 线 10 类观察标记的生产扫描器，也不是完整的多级别缠论交易系统。

## 4. 行情来源、cutoff 与可比性

| 研究族 | 主要来源与复权 | 宇宙 / 时间 | 主要产物 | 当前判断 |
| --- | --- | --- | --- | --- |
| 生产规则全量审计 | 新浪日线后复权派生；周线由日线聚合；腾讯原生月线前复权；沪深 300 原始指数 | 5,557 只当前上市证券；统一截止 2026-08-20；最后完整周 2026-08-14、最后完整月 2026-07-31 | `production-turning-point-*` | 当前审计；有数据缺口和生存者偏差 |
| 全市场 16 类候选 | 新浪 / 腾讯 / 东方财富混合后复权缓存 | 请求 5,813，取得 5,809；2014-01-01—2026-08-20；含 256 只沪深历史非当前证券 | `full-market-turning-point-study-*` | 候选研究；0 / 16 通过当时的严格上线门槛 |
| 固定样本 MA / 量价 / 周期 | BaoStock 前复权 `adjustflag=2` | 固定时点沪深 300 / 中证 500 样本；2014-01-01—2026-08-20 | `kline-signal-*`、`ma-volume-*`、`kline-period-*` | 支撑与历史研究；不能代表全市场无偏估计 |
| 缠论稳定性 | BaoStock 前复权 + `chan.py` 固定 commit | 固定时点指数样本；2014-01-01—2026-08-20，年度决策折为 2021—2026 | `chan-signal-*` | 结构生命周期研究；未接入生产标记 |

跨产物比较前至少检查：行情供应商、复权方式、证券宇宙、事件去重、信号确认时钟、观察窗口、费用、对照池和 cutoff。只比较两个百分比而忽略这些字段，会产生错误结论。

## 5. 人类可读文档清单

| 文档 | 分类 | 数据 / cutoff | 当前状态 |
| --- | --- | --- | --- |
| [turning-point-capability-audit-2026-08-23.html](turning-point-capability-audit-2026-08-23.html) | 当前生产审计汇总 | 聚合生产审计、全市场候选、周期、缠论与旧量价 case；cutoff 2026-08-20 | 当前 HTML 报告；生成物 |
| [kline-turning-marker-product-decision-2026-08-22.md](kline-turning-marker-product-decision-2026-08-22.md) | 产品决策 | 量价、周期与全市场研究；cutoff 2026-08-20 | 当前产品口径 |
| [full-market-turning-point-study-2026-08-22.md](full-market-turning-point-study-2026-08-22.md) | 候选发现 | 混合公开行情，5,809 只有行情证券；cutoff 2026-08-20 | 16 类冻结候选的历史研究 |
| [kline-period-turning-study-2026-08-22.md](kline-period-turning-study-2026-08-22.md) | 周期补测 | BaoStock 前复权；cutoff 2026-08-20 | 日 / 周 / 月 tooltip 支撑研究 |
| [ma-volume-turning-point-study-2026-08-21.md](ma-volume-turning-point-study-2026-08-21.md) | 量价观察点 | BaoStock 前复权；cutoff 2026-08-20 | 原六类标记的重要证据来源 |
| [ma-volume-special-turning-study-2026-08-21.md](ma-volume-special-turning-study-2026-08-21.md) | 专项补测 | BaoStock 前复权；cutoff 2026-08-20 | 缩量十字星、深跌巨量等未验证补测 |
| [decline-quiet-doji-study-2026-08-22.md](decline-quiet-doji-study-2026-08-22.md) | 专项补测 | BaoStock 前复权；cutoff 2026-08-20 | 连跌后缩量十字星未达门槛，不标记 |
| [ma-volume-buy-sell-strategy-2026-08-21.md](ma-volume-buy-sell-strategy-2026-08-21.md) | 策略探索 | BaoStock 前复权；cutoff 2026-08-20 | 历史实验，已明确不作为当前实现依据 |
| [kline-buy-sell-signal-design-2026-08-21.md](kline-buy-sell-signal-design-2026-08-21.md) | 产品 / 缠论探索 | BaoStock + `chan.py`；cutoff 2026-08-20 | 历史设计与方法论，不是当前买卖点方案 |

`client-parity.md` 与 `product-capability-analysis-2026-08-17.md` 会提及 K 线或扫描能力，但属于界面验收和广义产品分析，不作为变盘点统计证据源，因此不并入回测结果链。

## 6. 机器产物清单

所有 JSON 的 `metadata` 都是第一审计入口。能用脚本重建的文件禁止手工改数；若脚本改变，应生成新版本文件并更新引用，不能覆盖旧结论而保留旧日期。

| 产物 | 生成脚本 | 作用 | 状态 |
| --- | --- | --- | --- |
| [production-turning-point-full-backtest-2026-08-23.json](research-data/production-turning-point-full-backtest-2026-08-23.json) | `production-turning-point-full-backtest.ts` | 当前 10 类规则、22 个周期格的汇总、对照、置信区间、门禁和数据质量 | 当前机器结果 |
| [production-turning-point-events-2026-08-23.jsonl.gz](research-data/production-turning-point-events-2026-08-23.jsonl.gz) | 同上 | 138,262 条成熟事件逐行台账 | 当前逐事件证据 |
| [full-market-turning-point-study-2026-08-22.json](research-data/full-market-turning-point-study-2026-08-22.json) | `full-market-turning-point-study.py` | 16 类候选的全市场历史研究 | 候选研究 |
| [kline-period-turning-study-2026-08-22.json](research-data/kline-period-turning-study-2026-08-22.json) | `kline-period-turning-study.ts` | 六类旧标记的日 / 周 / 月独立频率 | 支撑研究 |
| [kline-signal-backtest-2026-08-21.json](research-data/kline-signal-backtest-2026-08-21.json) | `kline-signal-backtest.py` | 固定样本 K 线 / 缠论 / 基线清单和缓存校验基础 | 旧研究基线；多份下游产物依赖 |
| [ma-volume-signal-study-2026-08-21.json](research-data/ma-volume-signal-study-2026-08-21.json) | `ma-volume-signal-study.py` | MA / 成交量参数网格与固定分折研究 | 历史策略探索 |
| [ma-volume-confirmation-study-2026-08-21.json](research-data/ma-volume-confirmation-study-2026-08-21.json) | `ma-volume-confirmation-study.py` | 锁参后逆风样本确认 | 历史策略确认 |
| [ma-volume-turning-point-study-2026-08-21.json](research-data/ma-volume-turning-point-study-2026-08-21.json) | `ma-volume-turning-point-study.py` | 10 个量价事件及匹配对照 | 原标记支撑研究 |
| [ma-volume-special-turning-study-2026-08-21.json](research-data/ma-volume-special-turning-study-2026-08-21.json) | `ma-volume-special-turning-study.py` | 两类专项形态补测 | 未验证研究 |
| [decline-quiet-doji-study-2026-08-22.json](research-data/decline-quiet-doji-study-2026-08-22.json) | `decline-quiet-doji-study.py` | 连跌后缩量十字星补测 | 否决证据 |
| [chan-signal-stability-2026-08-21.json](research-data/chan-signal-stability-2026-08-21.json) | `chan-signal-stability.py` | 缠论生命周期、参数敏感性和单 cohort 结果 | 研究用途 |
| [chan-signal-walk-forward-2026-08-21.json](research-data/chan-signal-walk-forward-2026-08-21.json) | `aggregate-chan-walk-forward.py` | 2021—2026 年度产物聚合 | 研究用途 |

## 7. 脚本清单

| 脚本 | 类别 | 输入 / 输出说明 |
| --- | --- | --- |
| `current-market-history-download.py` | 当前审计取数 | 从 Hanai 当前证券主数据生成 universe，下载日线与基准缓存；缓存默认在 `/tmp`，不入库 |
| `current-native-month-history-download.py` | 当前审计取数 | 下载原生前复权月线，弥补日线供应商约 1,900 行上限 |
| `production-turning-point-full-backtest.ts` | 当前生产审计 | 调用真实产品 marker builder，输出汇总 JSON 和事件 JSONL.gz |
| `render-turning-point-capability-report.ts` | 报告生成 | 聚合当前审计、候选、周期、缠论与量价 case，输出自包含 HTML |
| `full-market-turning-point-study.py` | 候选发现 | 构建含历史非当前证券的混合源全市场研究，产出 16 类候选结果 |
| `kline-period-turning-study.ts` | 周期补测 | 用产品规则从固定 BaoStock 日线聚合日 / 周 / 月结果 |
| `kline-signal-backtest.py` | 旧基线 | 下载固定时点指数 cohort 并生成多项旧研究共享基线 |
| `ma-volume-signal-study.py` | 历史策略探索 | MA / 成交量参数选择、分折与执行回测 |
| `ma-volume-confirmation-study.py` | 历史策略确认 | 对上一脚本选出的规则做锁参逆风确认 |
| `ma-volume-turning-point-study.py` | 量价事件研究 | 不交易的量价变盘事件与同日匹配研究 |
| `ma-volume-special-turning-study.py` | 专项补测 | 缩量十字星回踩与深跌巨量补测 |
| `decline-quiet-doji-study.py` | 专项补测 | 连续下跌后缩量十字星补测 |
| `chan-signal-stability.py` | 缠论重放 | 依赖外部固定 commit 的 `chan.py`，逐根记录点位生命周期 |
| `aggregate-chan-walk-forward.py` | 缠论聚合 | 聚合六个年度 `chan-signal-stability-YYYY.json` 中间产物 |

旧 JSON 内记录了生成脚本 SHA-256。为保持审计链，旧脚本应视为冻结实现；需要修改方法时，优先新增版本号、日期和新产物，不要用新逻辑覆盖旧日期文件。

## 8. 复现命令

以下命令都从仓库根目录执行。Node 侧先运行 `pnpm install`；Python 脚本需要 `numpy`、`pandas`、`baostock` 等研究依赖。仓库目前没有锁定独立 Python 环境，复现时应同时保存 Python 与依赖版本。

### 8.1 当前生产规则全量审计与 HTML

```bash
HANAI_CURRENT_AUDIT_CACHE=/tmp/hanai-current-production-turning-cache-v1
HANAI_RESEARCH_DB=/absolute/path/to/hanai.sqlite

python3 scripts/research/current-market-history-download.py \
  --cache-dir "$HANAI_CURRENT_AUDIT_CACHE" \
  --database "$HANAI_RESEARCH_DB"

python3 scripts/research/current-market-history-download.py \
  --cache-dir "$HANAI_CURRENT_AUDIT_CACHE" \
  --database "$HANAI_RESEARCH_DB" \
  --benchmark-only

python3 scripts/research/current-native-month-history-download.py \
  --cache-dir "$HANAI_CURRENT_AUDIT_CACHE/native-month" \
  --database "$HANAI_RESEARCH_DB"

pnpm exec tsx scripts/research/production-turning-point-full-backtest.ts \
  --cache-dir "$HANAI_CURRENT_AUDIT_CACHE" \
  --output docs/research-data/production-turning-point-full-backtest-2026-08-23.json \
  --ledger docs/research-data/production-turning-point-events-2026-08-23.jsonl.gz

pnpm exec tsx scripts/research/render-turning-point-capability-report.ts \
  --output docs/turning-point-capability-audit-2026-08-23.html
```

供应商缺口会使下载脚本以非零状态退出，但仍会写 manifest；不要忽略退出码，也不要仅因缓存文件存在就宣称覆盖完整。先核对 manifest 的失败数、证券集合和 cutoff，再运行分析。`--max-symbols` 或 `--exchange` 只生成诊断子集，不能替代全量证据。

### 8.2 固定 BaoStock 基线与下游研究

```bash
HANAI_LEGACY_RESEARCH_CACHE=/tmp/hanai-kline-backtest-cache

python3 scripts/research/kline-signal-backtest.py \
  --cache-dir "$HANAI_LEGACY_RESEARCH_CACHE" \
  --start 2014-01-01 \
  --end 2026-08-20 \
  --output docs/research-data/kline-signal-backtest-2026-08-21.json

python3 scripts/research/ma-volume-signal-study.py \
  --cache-dir "$HANAI_LEGACY_RESEARCH_CACHE" \
  --output docs/research-data/ma-volume-signal-study-2026-08-21.json

python3 scripts/research/ma-volume-confirmation-study.py \
  --cache-dir "$HANAI_LEGACY_RESEARCH_CACHE" \
  --output docs/research-data/ma-volume-confirmation-study-2026-08-21.json

python3 scripts/research/ma-volume-turning-point-study.py \
  --cache-dir "$HANAI_LEGACY_RESEARCH_CACHE" \
  --output docs/research-data/ma-volume-turning-point-study-2026-08-21.json

python3 scripts/research/ma-volume-special-turning-study.py \
  --cache-dir "$HANAI_LEGACY_RESEARCH_CACHE" \
  --output docs/research-data/ma-volume-special-turning-study-2026-08-21.json

python3 scripts/research/decline-quiet-doji-study.py \
  --cache-dir "$HANAI_LEGACY_RESEARCH_CACHE" \
  --output docs/research-data/decline-quiet-doji-study-2026-08-22.json

pnpm exec tsx scripts/research/kline-period-turning-study.ts \
  --cache-dir "$HANAI_LEGACY_RESEARCH_CACHE" \
  --output docs/research-data/kline-period-turning-study-2026-08-22.json
```

上述产物相互记录 SHA-256。若重跑基线后哈希改变，应把它视为新研究批次，重新生成所有依赖产物并解释差异，而不是只更新其中一个 JSON。

### 8.3 全市场候选研究

```bash
python3 scripts/research/full-market-turning-point-study.py all \
  --cache-dir /tmp/hanai-full-market-turning-cache-v0 \
  --output docs/research-data/full-market-turning-point-study-2026-08-22.json
```

该命令依赖 Hanai 证券主数据与网络行情源。默认产物日期对应冻结的 V0 方法；如果改变信号、成本、数据源或 cutoff，应生成新版本，不覆盖 V0。

### 8.4 缠论稳定性

```bash
HANAI_CHAN_ROOT=/absolute/path/to/chan.py
HANAI_LEGACY_RESEARCH_CACHE=/tmp/hanai-kline-backtest-cache

python3 scripts/research/chan-signal-stability.py \
  --chan-root "$HANAI_CHAN_ROOT" \
  --cache-dir "$HANAI_LEGACY_RESEARCH_CACHE" \
  --cohort 2024 \
  --analysis-end 2024-12-31 \
  --output /tmp/chan-signal-stability-2024.json

python3 scripts/research/aggregate-chan-walk-forward.py \
  --input-dir /tmp \
  --output docs/research-data/chan-signal-walk-forward-2026-08-21.json
```

聚合脚本要求 `/tmp/chan-signal-stability-2021.json` 至 `...-2026.json` 六份年度输入全部存在；2021—2025 使用各年年末 cutoff，2026 使用 2026-08-20。外部 `chan.py` 必须固定到产物 metadata 记录的 commit `429d6ed3043e27c93a003ba2b10e70a05575e1f5`。

## 9. 统计口径最低检查清单

任何新增扫描点或“高胜率”结论进入此目录前，至少记录：

1. 规则 ID、参数、信号何时可知，以及是否会在未收盘周期内重绘；
2. 行情来源、复权方式、证券宇宙、上市 / 退市处理与明确 cutoff；
3. 事件分子、分母、去重 / 冷却和右删失数量；
4. 原始方向率及区间，而不只给一个百分比；
5. 同日、同市场状态和相似前置条件的对照比例，以及独立增量；
6. 买侧费用、涨跌停、停牌、执行时钟；风险侧必须说明是回避跌幅还是可执行做空；
7. 股票与时间聚类、不同时期稳定性、多重检验和参数选择过程；
8. 验证折、测试折，以及冻结 cutoff 之后的前瞻样本计划；
9. 机器产物、逐事件台账、生成脚本和哈希；
10. 产品状态：已引入、影子观察、候选、否决或历史归档。

历史比例是条件频率，不是单只股票的确定预测。只有原始比例、同场景基线、增量、区间和可执行性一起成立，才有资格讨论是否形成可用优势。
