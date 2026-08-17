# Hanai Worth · 值见品牌基线

## 正式名称

- 中文与产品正式名：**Hanai Worth · 值见**
- 英文短名：**Hanai Worth**
- 中文短名：**值见**
- 品牌口号：**价格有报价，价值靠研究。**
- 研究原则：**每一份研判，都应能回到证据、方法与上下文。**

产品界面和面向用户的文档使用正式名，不写成 `Hanai-worth`，也不把旧字母 `H` 当作必须沿用的图形资产。

## 标志语义

![Hanai Worth · 值见标志](assets/hanai-worth-mark.svg)

标志由三组研究语义构成：

1. **向上 K 线**代表可核验的市场事实与长期成长，不承诺价格单向上涨；
2. **蓝色慢线**代表市场价格与共识，**金色快线**代表通过研究逐步形成的价值判断；
3. 金线由下向上穿越蓝线形成 MACD 式金叉，交点以**证据点**强调：判断必须建立在来源、方法和上下文之上。

标志不得只剩两根无来源的装饰曲线，也不得使用随机行情、收益承诺或没有证据语义的“必涨”箭头。A 股页面中的红涨绿跌属于业务颜色，不取代品牌的金色与深蓝色。

## 资产

- [`assets/hanai-worth-mark.svg`](assets/hanai-worth-mark.svg)：透明矢量主标志，可用于产品图标和小尺寸品牌位；
- [`assets/hanai-worth-hero.svg`](assets/hanai-worth-hero.svg)：透明矢量横幅，用于 README、文档与仓库社交预览的源稿。

两份 SVG 均无位图依赖，并为深浅色系统主题提供可读文字颜色。输出 PNG、应用图标或社交预览图时，应从这些矢量源导出，避免继续使用旧版 `H` 字母图标。

## 兼容边界

品牌迁移不等于立即破坏运行兼容性。完成独立迁移方案之前，以下标识保持不变：

- npm 包名 `hanai-investment-dsh`；
- DSH Profile `hanai-investment`；
- 数据根 `~/.hanai-investment-dsh`；
- 环境变量 `HANAI_INVESTMENT_DSH_HOME`；
- RPC 路径、已发布入口，以及尚未单独迁移的运行时兼容标识。

因此，文档首次提及兼容标识时应同时说明品牌名；命令、路径、配置键和历史记录不得为了视觉统一而直接替换。

GitHub 仓库使用统一的品牌组织与仓库名：`hanai-labs/worth-dsh` 和 `hanai-labs/worth-desktop`。clone 地址、repository/homepage/bugs 元数据和本地 remote 必须保持一致。
