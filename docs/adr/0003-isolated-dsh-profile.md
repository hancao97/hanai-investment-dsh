# ADR-0003：使用独立 DSH Profile

- 状态：已接受并实现
- 日期：2026-08-15

## 背景

DSH 的 `dsh web` 使用内置 `web` Profile。若把 Hanai Bundle 直接添加到该 Profile，全屏 Workbench、Host Service 和配置层会同时影响用户原有的通用 DSH Web，两个产品也无法独立启动、升级或排障。

DSH 当前没有 Profile clone 命令；一个自定义 Profile 首次初始化时只包含 Base，因此还必须显式安装与 CLI 版本一致的 Web App Bundle。

## 决策

发布包提供安装器，默认创建 `hanai-investment` Profile，并按顺序加入：

1. `@deepseek-ai/dsh-web-app@<当前 DSH 版本>`；
2. `hanai-investment-dsh`。

插件命令显式使用 pnpm workspace-root 语义。安装器拒绝 `web`、`headless`、`node_modules`、`.` 和 `..` 等保留名称；若目标 Profile 已含无关的直接依赖，则 fail closed，不继续修改。

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

仓库中的 `profile:install` 与 `profile:verify` 脚本已使用临时 `DSH_HOME`、DSH `0.1.0-rc.6` 做过真实安装和配置装配验证；Hanai Host/Web 随后可以在随机 loopback 端口启动。发布流程还会检查安装脚本已编译并包含在 npm 包内。

## 后果

- Hanai 不会污染官方 `web` Profile。
- 用户可以同时运行通用 DSH Web 与 Hanai Workbench。
- 安装要求 DSH CLI 与可发布的 Web App Bundle 版本匹配；pre-release 版本不匹配时安装器会明确失败。
- DSH 升级必须重新执行兼容性矩阵和临时 Profile 冒烟，而不能假设 rc 版本之间兼容。
