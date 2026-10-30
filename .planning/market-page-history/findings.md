# 发现

- dsh-plugin 使用 trading_day_snapshots 表（trade_date 主键、captured_at、status、schema_version、payload JSON）。payload 固定列举 context / limitPools / themes / dragonTiger / analysis / dashboard。
- 参考分支各 RPC 合并自己的组；前端有日期输入和已存日期选择，历史从 tradingDay.snapshot 读取。历史未加载时清空当前视图，避免混用。
- 参考实现会静默只保留最近 90 天；自动轮询传 save:false，且 dashboard 只随 context 保存。不满足本任务所有首页面板都自动存储的目标，不能直接复制。
- 当前分支首页 dashboard.get 与 market.breadth 独立请求，dashboard 包含 overview / industry / concept / ranks / rankSources。宽度有自己的源时间和独立失败快照。
- 当前 HanaiDatabase.schema_migrations 到 2；公开 sqlite 属性可供独立 store 复用，原数据库 transaction 为 private。
- 当前板块下钻走 sector.stocks；历史模式须改成本地归档读取或明确未保存，不能继续请求实时成分数据。
- 需要区分获取时间、来源统计时间和归档日期。新浪板块/榜单未给交易时间；不能在跨日/闭市时把旧市场数据随意记作今日。
- 初始工作区干净，最近三批已提交：d40f669 / f39d0c8 / 9291bd3。
- 新实现用独立 market_panel_snapshots 表和 schema_migrations 版本 3，不修改参考分支旧表；来源时间用于防止旧响应覆盖，归档时间用于展示保存时刻。
- 运行时验证发现腾讯接口新返回的收盘报价同样标 stale（报价超 5 分钟），与刷新失败快照共用状态。不能一律丢弃 stale：明确来源时间更晚的结果可保存；无来源时间的 stale 不保存，失败复用同一来源时间不能覆盖已有记录。
- 最终真实 Profile 与浏览器验证通过：八类面板可从本地恢复；缺失日期只显示本地缺失，重启仍保留最初的已存宽度快照。
