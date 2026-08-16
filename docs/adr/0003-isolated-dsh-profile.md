# ADR-0003：使用独立 DSH Profile

- 状态：已接受并实现
- 日期：2026-08-15

## 背景

DSH 的 `dsh web` 使用内置 `web` Profile。若把 Hanai Bundle 直接添加到该 Profile，全屏 Workbench、Host Service 和配置层会同时影响用户原有的通用 DSH Web，两个产品也无法独立启动、升级或排障。

DSH 当前没有 Profile clone 命令；一个自定义 Profile 首次初始化时只包含 Base，因此需要在 Profile manifest 中显式保留 Web App Bundle 层。但 DSH 的 Bundle 解析是 installation-first，内置 Base、Web App 及其 runtime 必须来自当前 CLI 安装，不能作为 Profile dependency 再安装一份。

## 决策

发布包提供安装器，默认创建 `hanai-investment` Profile，并把 Bundle 顺序固定为：

1. `@deepseek-ai/dsh-base`；
2. `@deepseek-ai/dsh-web-app`；
3. `hanai-investment-dsh`。

Profile dependencies 只安装 `hanai-investment-dsh`。Base 和 Web App 由 DSH installation fallback 解析，绝不通过 pnpm 写进目标 Profile。安装器会自动迁移早期含 `@deepseek-ai/dsh-web-app` dependency 的 Hanai Profile，并清理其传递依赖；manifest 使用原子替换。安装器拒绝 `web`、`headless`、`node_modules`、`.` 和 `..` 等保留名称；若目标 Profile 已含无关直接依赖或 Bundle，则 fail closed，不继续修改。

这样做不只是减少重复依赖。rc.6 的工具调度器使用模块私有的 `Symbol(...)` 协议；若 Profile-local `dsh-tools` 遮蔽 CLI 安装中的 `dsh-tools`，而 `dsh-agent-loop` 仍从 CLI 安装加载，即使版本和文件哈希相同，服务符号也不相等，第一次工具调用会在 scheduler `prepare` 前失败。

正常启动命令为：

```bash
dsh --profile hanai-investment
```

原生 DSH Web 仍由以下命令独立启动：

```bash
dsh web
```

两个进程可使用不同端口并存。它们可以共享同一个 `$DSH_HOME` 中由 DSH 管理的凭据和 Session 基础设施，但 Profile 的插件依赖、Bundle 层和启动界面相互隔离。Hanai 业务数据仍由 ADR-0002 定义的专用根目录拥有。

## 验证

仓库中的 `profile:install` 与 `profile:verify` 会验证 exact Bundle 顺序、Web App 不在 dependencies、Profile 内不存在 `@deepseek-ai/dsh-*` shadow package，并通过真实路径确认 Profile 与 `dsh-agent-loop` 解析到同一个 `dsh-tools` 模块。脚本仍使用临时 `DSH_HOME` 做装配 smoke，发布流程会检查安装脚本已编译并包含在 npm 包内。

## 后果

- Hanai 不会污染官方 `web` Profile。
- 用户可以同时运行通用 DSH Web 与 Hanai Workbench。
- Web App 与 Base 始终来自正在运行的 DSH CLI，因此不会由 Profile dependency 偷偷引入第二套 rc runtime。
- DSH 升级必须重新执行兼容性矩阵和临时 Profile 冒烟，而不能假设 rc 版本之间兼容。
