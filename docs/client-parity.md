# Hanai Investment DSH 客户端迁移与验收基线

## 1. 文档目的

本文档是 `hanai-investment-dsh` 客户端恢复旧版产品能力和视觉布局时的执行清单。它约束页面结构、交互、数据语义和验收方式，避免在 React/DSH 重写过程中丢失、重命名或重新发明旧版功能。

旧版冻结基线：

- 仓库：`../hanai-investment`
- 提交：`8b8c7e7e4d2cfb281ffb45e64caf8888913b557e`
- 主窗口基准：1520 × 940 CSS px，最小 1280 × 720 CSS px。
- 源码优先级：运行版源码和旧版实际界面高于过期 PRD、未使用组件及新客户端现状。

本轮完成定义：

1. 旧版已有的页面、功能、字段、状态和交互全部保留。
2. 唯一功能增量只有“报告完成后在同一 DSH Session 继续对话”和“使用 DSH Credentials 管理 DeepSeek 凭据”。
3. 亮色/黑夜模式是受控视觉增量，只能替换语义色彩 token，不得改变页面内容或几何布局。
4. 除上述项目外，不增加路线、入口、模式、概念、营销内容或业务动作。

## 2. 变更预算

| 分类 | 允许范围 | 验收原则 |
| --- | --- | --- |
| 旧版必须保留 | 路由语义、侧栏顺序、页面区域、字段、筛选、按钮、图表、状态、空态、错误态、数据计算 | 逐页逐项与旧版源码和截图对照，功能与位置不能缺失或改义 |
| 唯一功能增量 | 报告后基于同一 DSH Session 继续对话；DeepSeek Key 由 DSH Credentials 查看、写入、移除 | 增量嵌入旧版结构，不替换报告、执行过程、原设置诊断或业务存储 |
| 受控视觉增量 | 普通亮色和普通黑夜模式 | 只换 token；暗色像素级贴近旧版；两种主题 DOM、文案、尺寸和顺序完全一致 |
| 明确禁止 | 新页面、新导航、新人物展示法、新图表语义、新筛选、新状态、新业务动作、虚构数据 | 任何未在本文件列明的产品变化先停止实现并回到需求确认 |

## 3. 全局壳层与导航

### 3.1 必须保留

- [ ] 桌面窗口默认 1520 × 940、最小 1280 × 720；macOS 使用 `hiddenInset` 标题栏。
  - 证据：`../hanai-investment/packages/app/src/main/index.ts:42-57`
- [ ] 产品导航顺序和中文名称固定为：
  1. 今日市场
  2. 自选与发现
  3. 大师研判
  4. 专家中心
  5. 设置与诊断
  - 证据：`../hanai-investment/packages/app/src/renderer/src/App.vue:24-30`
- [ ] 导航语义固定为 `/dashboard`、`/watch`、`/judgements`、`/personas`、`/settings`；个股详情为 `/stock/:secId`，研判详情为 `/judgements/:id`。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/router/index.ts:3-20`
- [ ] `/` 默认进入今日市场；旧 `/chat/*` 和 `/committee/*` 归并到大师研判，不恢复为独立产品入口。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/router/index.ts:3-20`
- [ ] 左侧栏固定宽 176px；顶栏高 46px；内容区滚动，页面基础 padding 为 20px 24px 40px。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/App.vue:110-277`
  - 证据：`../hanai-investment/packages/app/src/renderer/src/styles/main.css:371-400`
- [ ] 品牌区、活动项、侧栏底部“市场数据/Agent 状态”保持原位，不把侧栏改成带二级文案的大型展示导航。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/App.vue:65-87`
- [ ] 顶栏左侧保留 340px 全局股票搜索；右侧原本为空，主题开关可使用该空位，但不能挤压搜索或内容区。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/App.vue:89-100`
- [ ] 卡片基础圆角 14px、padding 16px，除旧版已有专用规则外不扩大卡片尺寸。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/styles/main.css:83-100`

### 3.2 全局搜索

- [ ] 支持 `Cmd/Ctrl + K` 聚焦，方向键选择，Enter 打开，Escape 关闭。
- [ ] 搜索代码、中文名、完整拼音和拼音首字母；排序优先级为代码前缀、名称包含、拼音首字母前缀、完整拼音。
- [ ] 结果最多展示股票代码、名称、交易所、最新价、涨跌幅，并可加入自选。
- [ ] 行情请求失败时仍返回本地证券搜索结果，不把网络错误变成“无股票”。
- [ ] 查询为空时展示搜索提示；查询有值但无结果时展示明确空态。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/components/GlobalSearch.vue:20-120`
  - 证据：`../hanai-investment/packages/app/src/main/master.ts:92-135`

### 3.3 壳层验收

- [ ] 在 1520 × 940 和 1280 × 720 两个 CSS viewport 截图比对侧栏、顶栏和内容起点。
- [ ] 所有页面内容起点一致；不出现整页水平滚动。
- [ ] 键盘完整走通全局搜索；鼠标点击结果与加入自选互不串扰。
- [ ] 页面刷新或重启后仍回到可用产品界面，不暴露 DSH 原生 Conversation 作为降级页。

## 4. 今日市场

### 4.1 页面区域顺序

- [ ] 页头“今日市场”包含开闭市状态、数据源、更新时间和刷新动作。
- [ ] 第一行依次为六张指数卡：上证指数、深证成指、创业板指、沪深300、科创50、北证50。
- [ ] 第二块为市场宽度。
- [ ] 第三块为两列：左侧板块热力图，右侧榜单。
- [ ] 不得把市场宽度、热力图或榜单拆成其它页面，也不得更换顺序。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/DashboardView.vue:318-562`
  - 证据：`../hanai-investment/packages/app/src/main/providers/eastmoney.ts:148-187`

### 4.2 指数与市场宽度

- [ ] 指数卡字段为名称、指数点位、涨跌额、涨跌幅、成交额；按 A 股习惯涨红跌绿，平盘中性色。
- [ ] 六列在旧版桌面宽度保持同排，不改成轮播、列表或大号 hero。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/DashboardView.vue:341-362,715-759`
- [ ] 市场宽度按“涨停、上涨、平盘、下跌、跌停”五段展示；上涨和下跌数量必须扣除相应涨跌停，五段互斥。
- [ ] 同时显示两市成交额，段宽由数量占比驱动。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/DashboardView.vue:297-315,364-416`

### 4.3 ECharts 板块热力图

- [ ] 热力图必须由 ECharts `treemap` 绘制，渲染结果存在 ECharts canvas；禁止用普通 `div` 网格模拟。
- [ ] 面积严格代表板块成交额，颜色严格代表板块涨跌幅；涨红跌绿，平盘/缺值使用中性色。
- [ ] 有效项先按成交额降序；最多绘制 40 个主要板块，单项低于总成交额 0.4% 的尾部合并为“其他”。
- [ ] “其他”采用固定 3.5% 布局权重，但 tooltip 中仍展示真实合并数据，避免尾部不可点击。
- [ ] 色彩强度按 `clamp(abs(changePct) / 6, 0, 1) ^ 0.7` 映射；不改用任意审美色阶。
- [ ] 主块 label 展示板块名与涨跌幅；tooltip 展示成交额、涨跌幅、领涨股。
- [ ] “其他” tooltip 可进入，列出全部尾部板块，按成交额排序并可点击。
- [ ] `roam=false`、`nodeClick=false`、`sort=false`、无 breadcrumb；点击逻辑由页面统一处理。
- [ ] 保留“行业 / 概念”切换，切换后刷新对应热力图和榜单数据。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/DashboardView.vue:100-288,418-503`
  - 证据：`../hanai-investment/packages/app/src/renderer/src/components/EChart.vue:3-30,52-73`

### 4.4 榜单

- [ ] 保留四个 tab：涨幅榜、跌幅榜、成交额、换手率。
- [ ] 每类最多 20 条，字段依次为名称/代码、最新价、涨跌幅、成交额、换手率、总市值。
- [ ] 点击榜单股票进入个股详情；tab 切换不改变热力图筛选语义。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/DashboardView.vue:290-295,505-560`
  - 证据：`../hanai-investment/packages/app/src/main/providers/eastmoney.ts:344-365`

### 4.5 加载、错误与刷新

- [ ] 指数、市场宽度、板块数据并行加载，并能独立显示 loading、error 和重试。
- [ ] 首次进入立即加载；每 30 秒自动刷新；手动刷新不破坏当前行业/概念和榜单 tab。
- [ ] 热力图无数据时显示明确空态，不伪造演示方块。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/DashboardView.vue:36-98,336-416,457-461,526-560`

### 4.6 布局验收

- [ ] 主区域比例维持约 `1.7fr : minmax(340px, 1fr)`，gap 与旧版一致。
- [ ] 热力图容器最小宽约 560px、图表高约 480px；榜单约 560px 高并在卡内滚动。
- [ ] 使用固定行情 fixture 验证面积排序、颜色、合并项、tooltip 和点击钻取，而非只看截图。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/DashboardView.vue:817-883`

## 5. 自选与发现

### 5.1 页面与工具栏

- [ ] 页头保留标题、说明和缓存陈旧提示。
- [ ] 工具栏左侧为分组管理，右侧为添加股票搜索；添加搜索宽约 280px。
- [ ] 当前分组每 15 秒刷新；使用缓存时展示陈旧状态，不静默冒充实时。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/WatchView.vue:91-117,159-222,318-382`

### 5.2 表格字段与行为

- [ ] 列顺序固定：名称/代码、最新价、涨跌幅、成交额、换手率、总市值、PE(动)、PB、加入日期、加入以来、操作。
- [ ] 点击数据行进入个股详情；行内移动/删除按钮必须停止冒泡。
- [ ] “加入以来”以加入时基准价计算，缺少基准价时显示 `—`，不可用当前涨跌幅替代。
- [ ] 排序支持涨跌幅、成交额、总市值、PE(动)、加入日期；每列循环“降序 → 升序 → 恢复默认”，空值始终末尾。
- [ ] 默认排序为加入日期倒序。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/WatchView.vue:37-89,225-290`
  - 证据：`../hanai-investment/packages/app/src/main/watchlist.ts:194-249`

### 5.3 分组与添加

- [ ] 始终存在默认分组；支持新建、重命名、删除自定义分组和移动股票。
- [ ] 删除分组必须二次确认；删除后成员按旧版规则迁移到默认分组，不能连股票记录一并静默删除。
- [ ] 移动股票保留其加入时间与基准价。
- [ ] 添加搜索最多 8 条结果；已加入状态可识别；成功后当前分组立即刷新。
- [ ] 分组弹窗保留 add、move、manage 三种上下文及各自 loading、error、empty 状态。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/components/WatchGroupManager.vue:19-163`
  - 证据：`../hanai-investment/packages/app/src/renderer/src/components/WatchGroupDialog.vue:5-145`
  - 证据：`../hanai-investment/packages/app/src/main/watchlist.ts:21-74,134-249`

### 5.4 空态与验收

- [ ] 区分“当前分组为空”“筛选无结果”“报价暂不可用”；提供与场景对应的添加或重试动作。
- [ ] 用两个分组和至少三只股票完整验证创建、重命名、移动、删除迁移、排序三态、重启持久化。
- [ ] 用固定加入基准价验证正负“加入以来”计算。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/WatchView.vue:253-294`

## 6. 个股详情

### 6.1 页面布局

- [ ] 顶部为股票名称、代码、交易所、报价状态、最新价、涨跌额/幅及自选动作。
- [ ] 主体两列比例约 `1.65fr : minmax(330px, 1fr)`，gap 14px。
- [ ] 左列顺序：行情图 → 行情快照 → 基本面；右列顺序：估值研判 → 价值曲线。
- [ ] 行情图约 380px，雷达图约 210px，价值曲线约 260px；不得把价值曲线移到其它页或折叠进聊天。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/StockDetailView.vue:414-595,638-718`

### 6.2 行情图

- [ ] 保留分时、日 K、周 K、月 K 四种模式，默认日 K。
- [ ] 分时图为金色价格线、蓝色均价线、成交量柱和昨收参考线。
- [ ] K 线使用 A 股红涨绿跌，带成交量、inside zoom 和 slider zoom。
- [ ] 日线使用前复权；范围分别约为日 3 年、周 8 年、月 20 年；东方财富失败时保留腾讯 fallback。
- [ ] 15 秒刷新报价；只有当前处于分时模式时同步刷新分时图，避免重置 K 线视图。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/StockDetailView.vue:61-262,406-462`
  - 证据：`../hanai-investment/packages/app/src/main/providers/eastmoney.ts:545-621`

### 6.3 行情快照与基本面字段

- [ ] 行情快照字段完整保留：今开、最高、最低、昨收、均价、振幅、总手、成交额、换手率、量比、主力净流入、总市值、流通市值。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/StockDetailView.vue:464-481`
- [ ] 基本面字段完整保留：PE 动/静/TTM、PB、PS(TTM)、ROE、EPS、BVPS、股息率、总股本、营业收入及同比、净利润及同比、毛利率、净利率、资产负债率。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/StockDetailView.vue:483-508`

### 6.4 估值研判

- [ ] 估值等级保持 0 到 7 的旧版映射和文字，不重新命名评分体系。
- [ ] 保留估值摘要、依据/提示和五维雷达图。
- [ ] 雷达维度固定为价值、成长、动量、盈利、财务，对应数据字段 `gfValue`、`growth`、`momentum`、`profitability`、`financialStrength`。
- [ ] 估值接口错误必须独立显示，不阻断行情和基本面。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/StockDetailView.vue:27-44,362-397,511-557`

### 6.5 价值曲线：不可改动的数据语义

- [ ] 供应方返回的完整价格序列和 MEDPS 序列均保留；不得只取当前点后用前端伪造历史或未来。
- [ ] 当前 MEDPS 必须取“日期不晚于今天”的最后一个点；未来 MEDPS 只能作为供应方预测曲线，不得冒充当前基本面。
- [ ] 合理价为 MEDPS 曲线；五条估值带逐点按 0.7、0.9、1.0、1.1、1.3 倍计算。
- [ ] 高估区使用红色语义、低估区使用绿色语义；价格线蓝色、合理价金色。
- [ ] tooltip 只展示对应日期的真实价格、合理价和偏离率；缺失值不补零、不跨日期混配。
- [ ] 曲线下方保留“未来区间来自供应方预测”的解释，清楚区分历史事实和未来预测。
  - 证据：`../hanai-investment/packages/app/src/main/providers/gurufocus.ts:140-200`
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/StockDetailView.vue:264-360,559-568`

### 6.6 个股页验收

- [ ] 使用包含历史 MEDPS、当天前最后点、未来预测点和缺失点的固定 fixture 校验当前值、五条带和 tooltip。
- [ ] 切换分时/日/周/月后验证图例、涨跌色、缩放和刷新不跳回默认。
- [ ] 分别断开行情、估值和基本面数据源，验证各区域独立错误/重试，不出现整页假空态。

## 7. 大师研判列表

### 7.1 页面结构和筛选

- [ ] 页头固定为“大师研判”，副文为“由一位专家独立检索并核验公开资料，形成完整投资研判报告”，右侧为“+ 新建研判”。
- [ ] 工具栏依次为股票名称/代码搜索、分析人下拉（默认“全部分析人”）、结果总数。
- [ ] 卡片网格桌面三列，1350px 以下两列，卡片最小高度约 214px。
- [ ] 卡片内容顺序：股票名称/代码/状态 → 专家头像/姓名 → 日期/模型 → 可选失败原因 → 查看动作。
- [ ] 完成态动作写“查看报告”，其它状态写“查看执行过程”；整卡进入 `/judgements/:id`。
- [ ] 只保留股票与分析人两类筛选，不增加“策略、风格、风险”等虚构筛选。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/JudgementsView.vue:18-24,56-133`

### 7.2 状态与空态

- [ ] 状态映射固定：preparing/正在准备、running/研判进行中、verifying/正在整理报告、completed/已完成、failed/未完成。
- [ ] preparing、running、verifying 使用金色进行中语义；completed 绿色；failed 红色。
- [ ] 页面可见时接收事件刷新，不以手动刷新作为唯一更新途径。
- [ ] 区分“筛选无结果”和“尚无研判”；首次空态提供新建按钮。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/JudgementsView.vue:27-53,96-101`

## 8. 新建研判

### 8.1 必须保留

- [ ] 弹窗最大宽约 650px；内容顺序为说明、股票搜索/已选股票、单选专家、运行环境提示、取消/开始。
- [ ] 从个股详情打开时预选股票并锁定该搜索；普通入口搜索最多 8 条。
- [ ] 默认选择第一位可用专家；必须同时选中股票和专家才能创建。
- [ ] 创建成功的顺序为：创建业务记录 → 跳转详情 → 启动执行。
- [ ] DSH 未就绪或无可用模型时明确阻止开始，不创建半成品伪任务。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/components/JudgementLauncher.vue:26-92,95-198`

### 8.2 唯一允许的文案和行为变化

- [ ] 旧文案“单专家、一次性执行；完成后形成不可续聊的只读报告归档”必须改为：首次形成完整报告，报告封存后仍可在同一 DSH Session 继续对话。
- [ ] 这项变化不能引出多专家委员会、多人群聊、策略编排、模板市场或其它研判模式。
- [ ] 一个研判最多绑定一个根 DSH Session；大师能力包和工作区在创建时快照并保持稳定。
  - 旧行为证据：`../hanai-investment/packages/app/src/renderer/src/components/JudgementLauncher.vue:95-167`
  - DSH 约束证据：`./docs/architecture.md:156-182,222-284`

## 9. 研判详情、报告与继续对话

### 9.1 旧版必须保留

- [ ] 顶部依次为返回、股票名称/代码、专家/日期/模型、状态；失败态提供“重新研判”。
- [ ] 状态文案固定为正在准备、正在分析、正在整理报告、研判完成、研判失败。
- [ ] 完成态首先展示报告，不自动跳入聊天。
- [ ] 报告态维持两栏：左侧约 230px 归档信息，右侧 Markdown 报告。
- [ ] 归档信息完整保留股票、专家、开始时间、完成时间、模型、报告大小，并可在“查看执行过程 / 返回报告”间切换。
- [ ] 生成中或失败时保留 max-width 1120 的执行过程卡：用户任务请求、专家消息、reasoning/commentary、stage、工具批次与详情、draft、thinking 按事件顺序呈现。
- [ ] Markdown 必须 sanitize；外部链接新窗口打开，不执行报告内 HTML/脚本。
- [ ] stream 与 4 秒轮询兜底并存，确保断流后状态可收敛。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/JudgementDetailView.vue:71-77,84-253,257-406,419-495`

### 9.2 报告生成和封存语义

- [ ] 状态机保持 preparing → running → verifying → completed/failed；重启发现中断任务时转 failed，不伪装继续运行。
- [ ] 首轮报告仍执行完整研究；报告至少 800 字，校验失败最多自动补写一次。
- [ ] 报告文件原子封存成功后才更新业务状态与版本；报告 hash、大小和版本元数据保留。
- [ ] 生成超时、模型错误、工具错误和报告校验错误均进入可理解的失败态。
  - 证据：`../hanai-investment/packages/app/src/main/judgements.ts:67-75,146-180,190-282`

### 9.3 唯一增量：报告后继续对话

- [ ] 完成态在原详情页增加“研判报告 / 继续对话”两个视图；默认仍为研判报告。
- [ ] “继续对话”必须使用该研判已经绑定的同一个 `dshSessionId`，不能创建第二个聊天线程或复制上下文。
- [ ] DSH Session 的持久历史、消息、工具活动、排队、取消、恢复和事件流是唯一事实源；Hanai 不建 messages、turns 或 activities 表。
- [ ] 报告生成期间可查看同一 Session 的实时执行过程，但 composer 保持只读；正式报告封存完成后才允许普通追问。
- [ ] 普通追问不会自动生成新的报告版本；只有明确的报告修订动作才能进入校验和封存流程。
- [ ] Session 缺失、被归档或打开失败时显示明确错误和恢复路径，不回落到无上下文的新会话。
- [ ] 对话渲染保留文本、reasoning、工具活动、批准请求、问题批次、流式状态、取消与重试等 DSH 原生事件语义。
- [ ] 浏览器只保存未发送草稿等 UI 状态，不持久化消息副本。
  - 旧版已有可恢复 Thread 能力证据：`../hanai-investment/packages/app/src/main/codex.ts:433-445`
  - DSH 增量设计证据：`./docs/architecture.md:156-182,280-286,358-374`
  - 当前 Session 适配证据：`./packages/client-chat/src/session.ts:17-27,99-205`
  - 当前聊天表面证据：`./packages/client-chat/src/ChatPanel.tsx:106-150`

### 9.4 研判详情验收

- [ ] 覆盖 preparing、running、verifying、completed、failed 和重启中断六类 fixture。
- [ ] 验证报告/执行过程切换不会丢失滚动位置、状态或归档字段。
- [ ] 封存后发送两轮追问，确认 Session ID 未变化、历史可在 DSH 重启后恢复、普通追问未增加报告版本。
- [ ] 在工具批准、批量问题、取消、最大 token、网络断开和 Session 丢失场景验证状态与可恢复性。

## 10. 专家中心

### 10.1 必须保留

- [ ] 页面只保留普通页头“专家中心”和说明，下方为两列专家卡；1100px 以下单列。
- [ ] 卡片顺序为：头像/姓名/角色标签 → 分隔线 → “专家介绍”正文 → 分隔线 → “核心方法”标签。
- [ ] 卡片约 min-height 210px、padding 18px、gap 14px。
- [ ] 名称、介绍、核心方法必须读取专家 skill frontmatter，不写死新的营销描述。
- [ ] 专家标识和颜色：
  - 段永平：“段”，`#d4a017`
  - 查理·芒格：“芒”，`#5b8def`
  - 沃伦·巴菲特：“巴”，`#34a870`
  - 混江龙：“混”，`#c4573d`
  - 证据：`../hanai-investment/packages/app/src/main/personas.ts:7-15,91-123`
- [ ] 不因 `PersonaRail.vue` 文件存在而加入右侧人物栏；该组件未被旧版 App 使用。
  - 布局证据：`../hanai-investment/packages/app/src/renderer/src/views/PersonasView.vue:7-120`

### 10.2 明确禁止的专家页改造

- [ ] 禁止 hero、英文 breadcrumb、大型口号、四张超宽竖卡、编号、能力包版本和卡内 CTA。
- [ ] 禁止把“段、芒、巴、混”改成“一个花、一个澄”等品牌装饰字。
- [ ] 禁止重排专家、改名、改角色定位或加入未经 skill 声明的投资方法。

## 11. 设置与诊断

### 11.1 旧版四块结构

- [ ] 页面标题后为 max-width 1100 的两列网格，卡片顺序固定：Codex/Agent 运行状态、数据源、本地存储、关于与声明。
- [ ] DSH 化可以把第一张卡的运行时称谓调整为 DSH Agent，但不得删其状态、版本、账户/凭据、模型、检测/刷新和访问说明。
- [ ] 数据源卡保留东方财富状态和最近成功时间、价值数据源状态和说明、证券总数和更新时间、同步基础数据动作。
- [ ] 本地存储卡保留数据目录、运行目录、总量、市场缓存、估值缓存、研判记录、打开目录、清理两类缓存和风险提示。
- [ ] 关于与声明保留版本、产品定位、数据免责声明和“不构成投资建议”。
- [ ] 加载不到值时显示 `—`；动作执行中显示 pending 文案；不使用假数据填满卡片。
  - 证据：`../hanai-investment/packages/app/src/renderer/src/views/SettingsView.vue:11-48,75-177`
- [ ] 清缓存必须经系统确认，只清选定缓存目录内容，不删除业务数据库、报告、会话或数据根。
  - 证据：`../hanai-investment/packages/app/src/main/ipc.ts:140-171`

### 11.2 唯一增量：DSH Credentials

- [ ] DeepSeek Key 由 DSH Credentials API 描述、设置和移除；禁止进入 Hanai RPC、SQLite、浏览器存储、日志或错误详情。
- [ ] 页面只显示“是否已配置、来源、是否可写”，永不回显现有 Key。
- [ ] 仅 loopback 本机页面允许写入/移除；非本机访问显示明确安全提示。
- [ ] 环境变量来源优先且只读时，禁用覆盖和移除动作并解释原因。
- [ ] 模型目录直接读取 DSH Models capability；选择模型不得伪造本地模型列表。
- [ ] 凭据能力嵌入原设置与诊断布局，不新增顶级“凭据中心”导航。
  - 设计证据：`./docs/architecture.md:202-213,362-374`
  - API 证据：`./packages/client-workbench/src/api.ts:37-72`
  - 当前界面证据：`./packages/client-workbench/src/app.tsx:473-487`
- [ ] 业务数据继续写入独立 Hanai 根；DSH Key、模型设置、Session 和附件仍由 `$DSH_HOME` 所有，两个根之间不复制。
  - 证据：`./docs/adr/0002-data-root-isolation.md:18-28,63-73,99-114`

### 11.3 已知文案/行为矛盾

- [ ] 旧设置页写“估值缓存 90 天”，旧 provider 实际 TTL 为 24 小时。迁移时必须统一为一个有测试的真实策略；不得继续保留互相矛盾的显示和实现。
  - UI 证据：`../hanai-investment/packages/app/src/renderer/src/views/SettingsView.vue:135`
  - 行为证据：`../hanai-investment/packages/app/src/main/providers/gurufocus.ts:14`

## 12. 亮色与黑夜模式

### 12.1 受控增量规则

- [ ] 黑夜模式以旧版颜色、对比度和层级为像素级基线。
- [ ] 亮色模式只映射语义 token：页面背景、侧栏、卡片、浮层、边框、主/次文字、禁用态、阴影、focus、tooltip、表格 sticky 背景和图表辅助线。
- [ ] 两个主题使用完全相同的 DOM、组件树、文案、尺寸、间距、断点、图表数据和交互。
- [ ] 主题开关放在旧顶栏右侧空位；选择持久化，并支持首次跟随系统偏好。
- [ ] A 股涨红跌绿、专家识别色、警告/成功/错误等业务色不因主题反转。
- [ ] 主题仅作用在 Hanai Workbench 根节点，不注入全局 reset、不覆盖 DSH `body` 或宿主全局选择器。
  - 旧暗色 token 证据：`../hanai-investment/packages/app/src/renderer/src/styles/main.css:1-41`
  - 顶栏空位证据：`../hanai-investment/packages/app/src/renderer/src/App.vue:89-100`
  - DSH 样式隔离约束：`./docs/adr/0001-dsh-native-react-ui.md:38-55`

### 12.2 ECharts 主题化

- [ ] 只将 tooltip、axis、grid、label、legend、dataZoom、空值色和容器背景改为主题 token。
- [ ] series 类型、series 顺序、数据字段、坐标轴、markLine、visual mapping、treemap 面积及点击行为完全不变。
- [ ] Dashboard 现有硬编码图色审计范围：
  - `../hanai-investment/packages/app/src/renderer/src/views/DashboardView.vue:102-110,174,182-184,241,247,263,270`
- [ ] Stock 现有硬编码图色审计范围：
  - `../hanai-investment/packages/app/src/renderer/src/views/StockDetailView.vue:95-99,119-121,128-133,154-182,196-198,217,238,245-255,305-356,378-391`

### 12.3 主题验收

- [ ] 每个产品页面在两种主题各拍摄 1520 × 940 和 1280 × 720 截图。
- [ ] 暗色截图与旧版做视觉 diff；主题间再做 geometry diff，除颜色/阴影外不应有像素位移。
- [ ] 检查所有弹窗、下拉、tooltip、表格 sticky header、滚动条、空态、错误态、disabled/focus/hover。
- [ ] 对折线、K 线、雷达、treemap、成交量和 dataZoom 分别做亮色可读性检查。

## 13. 数据与 API 合同

- [ ] 迁移前按旧 preload 能力表逐项建立 React/DSH 端等价调用，不删除字段、不改单位、不将 `null` 转成 0。
  - 证据：`../hanai-investment/packages/app/src/preload/index.ts:6-63`
  - 类型证据：`../hanai-investment/packages/app/src/preload/index.d.ts:23-85`
- [ ] 所有行情值保留来源、抓取时间和缓存状态；provider fallback 失败顺序可诊断。
- [ ] 金额、手数、市值、比例和日期使用旧版同一单位与格式化规则。
- [ ] 行情、估值、自选、研判和设置错误保持区域隔离，不能因为一个 provider 失败让整个 Workbench 失效。
- [ ] 不用静态演示数组替代真实 provider 或业务数据库；测试 fixture 只存在于测试环境。

## 14. 明确禁止项

以下任一项出现即视为 parity 失败：

- [ ] 修改侧栏顺序、名称、数量或将“今日市场/自选与发现/大师研判/专家中心/设置与诊断”重新品牌化。
- [ ] 将旧页面改成 hero landing page、大型宣传卡、瀑布流、横向故事页或其它信息架构。
- [ ] 将板块热力图改为普通 `div` 方块、固定模板、随机布局或与成交额无关的面积。
- [ ] 改变价值曲线 MEDPS 时点选择、估值带倍数、未来预测含义或价格/合理价字段。
- [ ] 删除自选分组、移动、排序三态、加入以来或原表格字段。
- [ ] 删除研判执行过程、归档信息、报告默认视图或失败/中断状态。
- [ ] 新增委员会、多大师会诊、投资组合、回测、交易、提醒、资讯流、社区、版本市场等未经授权能力。
- [ ] 为专家新增宣传口号、CTA、版本号、排名或改变其顺序/方法。
- [ ] 把亮色/黑夜误解为专家色主题，或让主题切换改变布局、图表语义和业务色。
- [ ] 新建 Hanai 凭据表、消息表、Turn 表或把 secret/聊天历史复制出 DSH。
- [ ] 暴露完整 API Key、请求头、含 secret 的错误对象、DSH 内部路径或会话敏感内容到日志。
- [ ] 用 DSH 原生 Conversation 替换 Hanai 的研判详情，或在错误时把用户带出 Hanai Workbench。
- [ ] 因旧仓库存在未使用组件或过期 PRD 条目而新增当前运行版没有的 UI。
- [ ] 在未获得明确需求前添加任何新 route、按钮、筛选、状态、数据字段或自动化动作。

## 15. 发布前验收门槛

### 15.1 静态核对

- [ ] 路由/导航/标题/按钮/筛选/表头文本已与本文件逐项核对。
- [ ] 所有旧版字段都有明确的新数据来源和类型映射。
- [ ] 所有页面有 loading、empty、error、retry 设计，且与旧版语义一致。
- [ ] ECharts 仍负责折线、K 线、雷达和 treemap；无 DOM 热力图替代物。
- [ ] 新增代码只落在“DSH 续聊、DSH 凭据、主题 token、框架迁移”四类必要范围。

### 15.2 自动化与集成

- [ ] 单元测试覆盖市场宽度互斥计算、treemap 合并/颜色、加入以来、排序三态、MEDPS 当前点和估值带。
- [ ] 组件测试覆盖全部 tab、筛选、弹窗、空态、错误态、按钮 pending、键盘搜索和事件冒泡。
- [ ] Host 集成测试覆盖 provider fallback、缓存新鲜度、分组迁移、研判状态机、报告校验/补写/原子封存。
- [ ] DSH 集成测试覆盖凭据写入限制、模型目录、同一 Session 续聊、历史恢复、批准/问题/取消、普通追问不产生报告版本。
- [ ] 使用独立临时 `DSH_HOME` 和 Hanai 数据根跑真实 Profile 安装、启动、重启与恢复。

### 15.3 视觉和人工验收

- [ ] 在 1520 × 940 对照旧版逐页截图，关键区域位置和尺寸无肉眼漂移。
- [ ] 在最小 1280 × 720 完整操作，无截断、遮挡、不可达按钮和整页横向滚动。
- [ ] 黑夜模式逐页视觉 diff；亮色模式逐页可读性；两主题 geometry diff。
- [ ] 热力图用真实 ECharts canvas 验证 hover、tooltip、“其他”、行业/概念和钻取。
- [ ] 个股页用固定 fixture 验证分时/K 线、雷达、价值曲线及独立错误态。
- [ ] 自选完整跑通分组 CRUD、移动、删除迁移、加入以来和重启持久化。
- [ ] 研判完整跑通创建、执行、工具活动、报告、过程切换、失败重试、重启恢复、封存后两轮续聊。
- [ ] 设置完整跑通 DSH 状态、凭据、模型、数据同步、打开目录、缓存清理和关于声明。

## 16. 变更审查模板

每个客户端 PR 必须回答：

1. 对应本文件哪些 checklist ID 或章节？
2. 属于“必须保留、唯一增量、受控增量”中的哪一类？
3. 是否新增了 route、按钮、筛选、状态、字段、自动动作或数据持久化？若是，授权依据是什么？
4. 是否附有 1520 × 940 和 1280 × 720 的暗色截图，以及亮色截图？
5. 是否提供数据语义测试，而不只是视觉截图？
6. 是否验证没有把凭据、消息或工具事件复制到 Hanai 数据库和日志？

无法明确归类或没有授权依据的改动不得合并。
