# Hanai Worth · 值见 DSH 启动与验收报告

> 验收日期：2026-08-23

## 1. 结论

Hanai Worth · 值见当前以兼容包名 `hanai-investment-dsh` 和独立 DSH Profile 运行，不修改官方 `web` Profile。客户端是 Hanai Worth 自有 React 工作台，DSH 提供 Agent、模型、工具、Session 与会话持久化。新版业务数据只写入 `~/.hanai-investment-dsh`，不会检测、读取或导入旧版数据。

## 2. 已验证环境

| 组件 | 实测版本 |
| --- | --- |
| Node.js | `v22.22.0` |
| pnpm | `11.7.0` |
| DeepSeek Harness | `0.1.1-rc.2` |
| Profile | `hanai-investment` |
| 默认监听 | `http://127.0.0.1:3080` |

如果本机 pnpm 不是 11.7.0，可以先执行：

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm --version
```

## 3. 首次安装与启动

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run profile:install -- --package .
pnpm run profile:verify
dsh --profile hanai-investment
```

终端出现以下输出后，在浏览器打开对应地址：

```text
dsh web: http://127.0.0.1:3080
```

安装器会执行以下装配与迁移：

1. 安装当前 Hanai 插件包；
2. 把 Bundle 顺序规范化为 `@deepseek-ai/dsh-base` → `@deepseek-ai/dsh-web-app` → `hanai-investment-dsh`；
3. 从 Profile dependencies 中移除早期版本错误安装的 `@deepseek-ai/dsh-web-app`，再由 pnpm 清理它带入的本地 DSH runtime 副本；
4. 校验 Profile 与 `dsh-agent-loop` 解析到同一个真实 `@deepseek-ai/dsh-tools` 模块。

Base 和 Web App 是当前 DSH CLI 自带的 installation-owned Bundle，不应安装成 Profile dependency。Profile 中只保留 `hanai-investment-dsh` 这一项直接依赖。

安装器明确拒绝 `web`、`headless`、`node_modules` 等保留名称，也会拒绝覆盖包含无关插件的同名 Profile。

## 4. 第一次进入后的设置

1. 打开左侧“设置与诊断”。
2. 在“DeepSeek API Key”卡片写入 Key 并点击“安全保存”。输入框提交后会清空；页面和 RPC 都不会回显明文。
3. 在“默认模型”选择 DSH 当前提供的模型并保存。
4. 确认数据源、证券主数据和本地存储状态。
5. 回到“大师研判”，选择股票和一位大师开始研判；或进入“专家对谈”，不选股票直接开始开放讨论。

报告封存完成后，详情页默认仍展示正式报告；切换“继续对话”会复用生成该报告的同一个 `dshSessionId`。专家开放对谈使用独立业务索引，但消息、工具和 Turn 历史仍只由对应的 DSH Session 持有，不会创建第二个本地消息库。

## 5. 日常启动与停止

后续只需：

```bash
dsh --profile hanai-investment
```

端口被占用时可以指定其它 loopback 端口：

```bash
dsh --profile hanai-investment --port 3081
```

在运行终端按 `Ctrl+C` 停止。原生 DSH Web 仍使用：

```bash
dsh web
```

两个 Profile 可以使用不同端口并行运行。

## 6. 数据与凭据边界

| 数据 | 所有者 | 默认位置 |
| --- | --- | --- |
| 自选、证券主数据、研判/专家对谈索引、报告、行情/估值缓存 | Hanai | `~/.hanai-investment-dsh` |
| DeepSeek Key、默认模型、Session 消息、工具事件、附件 | DSH | 当前 `$DSH_HOME` |

实测新数据根目录权限为 `0700`，SQLite 文件权限为 `0600`。旧版目录保留原状，新版没有数据导入入口。

## 7. 自动化验收

完整门禁命令：

```bash
pnpm run check
```

它依次覆盖 TypeScript、单元/集成测试、Host 与 Client 生产构建、npm tarball allowlist、DSH ModuleLoader 协议、source map、三方许可证、私有绝对路径和旧数据路径隔离。

本次最终运行结果：

| 门禁 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过 |
| `pnpm run test` | 27 个测试文件、187 项测试全部通过 |
| `pnpm run build` | Host、Client 与 Profile tools 构建通过 |
| `pnpm run pack:check` | 71 个发布文件通过 |
| `git diff --check` | 通过 |

五个专家 Skill 均通过结构校验，其中新增孙宇晨视角还通过 `skill-creator` 的 `quick_validate.py`；原始迁移资产中的 51 个文件继续由 SHA-256 清单校验，发布包包含全部 8 个脚本。已在 rc.2 Host/Web 上完成 Profile 启动、页面加载、Session 创建与 prompt/event 链路 smoke；临时无 Key 环境中的模型调用按预期停在凭据校验。

另外已使用全新的临时 `DSH_HOME` 实际执行：

```bash
pnpm run profile:install -- --package .
pnpm run profile:verify
```

验证结果为独立 Profile 按 Base → Web App → Hanai 顺序组合，只有 Hanai 是 Profile dependency，DSH runtime 不存在 Profile-local shadow，且没有写入官方 `web` Profile。

## 8. 浏览器验收

已在真实 DSH Host/Web 中完成以下检查：

- 1520 × 940：侧栏 176px、顶栏 46px、页面无水平溢出；
- 1280 × 720：Dashboard 和股票详情无水平溢出；
- 亮色与黑夜模式：只改变语义色彩，布局尺寸不变并可持久化；
- Dashboard：六指数、五段市场宽度、ECharts treemap、行业/概念切换、原位成分股下钻、四类榜单；
- 股票详情：默认日 K、完整 dataZoom、分时、雷达、真实时间轴价值曲线、±10%/±30% 红绿价值带与未来预测提示；
- 股票详情渐进加载：本机实测约 0.6 秒内先出现证券名称与页面结构，日 K、估值和其它分面随后独立收敛；周/月 K 仅在切换时加载；
- 自选：分组管理、三态排序、加入/移动/移除和整行进入详情；
- 研判：原列表、筛选、创建弹窗、执行过程、报告归档与同 Session 继续对话入口；
- 专家对谈：股票无关入口、五位专家选择、孙宇晨开场问题与身份披露、空白 Session、历史列表、深链、删除约束和专家语境聊天文案；
- 900 × 800 专家对谈详情：响应式上下分栏且无水平溢出；
- 设置：Key write-only、默认模型真实读写、缓存、存储、数据源和主题；
- Hash 路由：直接打开、刷新、后退和前进均保持页面语义；
- 全局搜索：代码/名称/拼音搜索、打开股票与选择自选分组。
- 最终 DSH 重启后的浏览器日志没有新增运行错误；仅记录了重启瞬间的预期连接重试警告。

黑夜与亮色市场页实测截图：

![黑夜模式市场页](assets/dashboard-dark.jpg)

![亮色模式市场页](assets/dashboard-light.jpg)

股票详情、日 K、五维雷达与价值曲线实测截图：

![股票详情与价值曲线](assets/stock-detail-dark.jpg)

## 9. 验收边界

为避免消耗用户 API 额度，浏览器验收没有发起真实模型 Turn；已在全新临时 Profile 中创建孙宇晨空白对谈并验证 DSH Session、页面深链和 composer。研判/对谈状态机、报告校验与封存、开场 prompt、生成期只读、普通多轮消息流由 Host/Client 集成测试覆盖。实际发起模型请求前，请确认 DeepSeek Key、模型与网络可用。

## 10. 常见问题

### `profile:install` 报“未知参数：--”

当前仓库已经兼容 pnpm 11 传入的参数分隔符。请先重新执行 `pnpm run build`，确认使用的是最新 `lib/install-profile.js`，再运行安装命令。

### 页面能打开但 Agent 无法运行

在“设置与诊断”检查 Key 状态和默认模型；Key 由 DSH Credentials 持有，不应写进 `.env`、Hanai SQLite、报告或截图。

如果 Session 在第一次调用工具时出现 `Cannot read properties of undefined (reading 'prepare')`，说明旧 Profile 很可能安装过 `@deepseek-ai/dsh-web-app` dependency，导致 DSH runtime identity 分裂。先停止 Hanai DSH 进程，再在仓库根目录执行：

```bash
pnpm run build
pnpm run profile:install -- --package .
pnpm run profile:verify
```

验证器会同时检查 manifest、Bundle 顺序、Profile-local DSH shadow packages，以及 `dsh-tools` 与 `dsh-agent-loop` 的真实模块路径；不能只看二者版本号是否相同。

### 行情显示 stale 或 unavailable

页面会保留最近成功快照并明确标记来源状态。分时/K 线可降级到腾讯行情；不要把缓存或延迟值当作实时行情。

### 如何确认没有修改官方 Profile

```bash
pnpm run profile:verify
dsh --profile hanai-investment --dump-default-config
```

安装器只修改 `hanai-investment` 的 Profile manifest、lockfile 与依赖目录；它不会修改官方 `web` Profile 的 manifest 或 patch。以下命令还会拒绝 Bundle 顺序错误、Web App 被直接安装、无关 dependency，以及 DSH runtime identity 分裂：

```bash
pnpm run profile:verify
```
