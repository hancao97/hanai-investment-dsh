# DSH Profile 部署与 upstream 合并指南

本文记录这个 fork 的 Web 插件工作流，以及与 upstream（`hancao97/hanai-investment-dsh`）合并时需要了解的差异面。分支、插件与 Profile 的名称约定：

| 名称 | 角色 |
| --- | --- |
| `hanai-investment-dsh` | 插件包名（`package.json` 的 `name`） |
| `hanai-investment` | 旧独立 Profile，保留兼容，须显式选择 |
| `web` | 默认安装目标，保留原生界面及其它插件 |
| `main` | fork 的主干分支，仅跟踪 `origin/main`，不直接开发 |
| `dsh-profile` | 从 `origin/main` 打出的基线分支：upstream 兼容修复 + 通用加固（熔断、开市轮询） |
| `dsh-plugin` | 从 `main` 打出的功能分支：今日交易数据、复盘分析等大型增量功能 |

## 1. 部署

首次部署（详见 [README「从源码安装」](../README.md#从源码安装)）：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run profile:install -- --package .
pnpm run profile:verify
dsh web
```

安装器只通过 `dsh plugin --profile web add` 添加本插件，不重写 manifest，不重排或删除其它插件。Base、Web App 来自 DSH 安装目录，在 Hanai 之前即可，不要求相邻。原生模型设置保持启用。已有其它 Web Profile 可显式传 `--profile <name>`；不支持把仅含 Base 的自定义 Profile 自动改造成 Web Profile。

启动后点击原生侧栏「值见」进入工作台，点击「返回 DSH」回到会话；加载中和失败页也可返回。内部页面使用内存导航，不覆盖原生 URL。关闭或刷新后重新进入默认页，业务数据、宿主后台任务仍保留。卸载使用 `dsh plugin --profile web remove hanai-investment-dsh` 并重启，不删除业务数据。

默认业务目录仍为 `~/.hanai-investment-dsh`，不会因迁移 Profile 初始化空库；DSH Session 使用同一 `DSH_HOME` 时可续用。禁止同时启动多个进程写同一业务目录。模型与凭据由同一 DSH 管理，修改默认模型也会影响原生界面。

开发验证使用临时 `DSH_HOME` 的内置 `web` Profile，并设置隔离的 `HANAI_INVESTMENT_DSH_HOME`。安装、校验、启动、面板进入/返回、原生模型设置及其它插件共存、卸载后原生界面均需验证；验证脚本不会改用户的真实 `web`。已有内置包副本时安装器在添加前拒绝，不代替用户删除它们。

### 本次分支整理

从 `origin/main` 建迁移分支，将 `codex/market-page-history` 已提交功能 squash 为独立提交，再独立改造插件入口及装配。保留原功能分支与旧 `dsh-plugin` 备份。旧插件分支的侧栏/main 入口复用；其旧版交易日实现不覆盖当前更完整的业务实现。未经提交的规划文件不并入功能提交。旧 [ADR-0003](adr/0003-isolated-dsh-profile.md) 记录独立 Profile 阶段的历史决策，当前部署以本指南为准。

## 2. Windows 支持的既有修复

以下修复已落在 `scripts/` 与 `packages/` 中，属于普适缺陷修复，upstream 也可直接合入；Windows 环境无需额外配置。

| 修复 | 位置 | 根因 |
| --- | --- | --- |
| `spawnSyncShell` 封装 | `scripts/win-spawn.ts` | Windows 上 npm 全局 CLI 是 `.cmd` shim，`spawnSync` 不带 shell 无法执行（ENOENT） |
| 安装锚点探测 | `scripts/profile-contract.ts` | npm Windows 全局布局中 shim 与包分居两处，需探测 bin 目录的 `node_modules/@deepseek-ai/dsh` |
| 跨盘符判定 | `scripts/profile-contract.ts` | Profile 与 DSH 分属不同盘符时 `path.relative` 返回绝对路径，需追加 `isAbsolute` 分支 |

排障细节见 [startup-and-verification.md 第 10 节](startup-and-verification.md#10-常见问题)。

## 3. fork 相对 upstream 的差异面

合并或 rebase upstream 时，先对照下表评估冲突范围：

| 文件 | 类型 | 冲突风险 | 合并策略 |
| --- | --- | --- | --- |
| `packages/domain/src/providers/source-circuit.ts` | 新增 | 无 | 直接保留 |
| `packages/client-workbench/src/market-hours.ts` | 新增 | 无 | 直接保留 |
| `scripts/win-spawn.ts` | 新增 | 无 | 直接保留 |
| `packages/domain/src/providers/index.ts` | 修改（熔断接线） | 低 | diff 限于 `callSource` 包裹，upstream 改动可叠加 |
| `packages/client-workbench/src/app.tsx` | 修改（轮询 gate、冷却按钮） | 中 | 每处 1–3 行语义独立，冲突时优先保留 upstream 主体再补 gate |
| `scripts/install-profile.ts`、`verify-profile.ts`、`profile-contract.ts` | 修改（Windows 修复） | 低 | 修复集中在 spawn 与锚点函数，与 upstream 功能演进正交 |

`dsh-plugin` 分支还包含今日交易数据、复盘分析、快照与 host 级熔断等大型增量，仅在该分支范围内合并，不与 `dsh-profile` 交叉 rebase。

## 4. 合并 upstream 的操作步骤

```bash
git fetch origin
git checkout main && git merge --ff-only origin/main   # main 保持与 upstream 同步
git checkout dsh-profile && git rebase main            # 或 merge，按团队习惯
pnpm run typecheck && pnpm vitest run && pnpm run build
pnpm run profile:install -- --package . && pnpm run profile:verify
dsh web --no-open                # 实际启动冒烟，确认 Bundle 与页面正常
```

门禁不通过时优先检查 `providers/index.ts` 与 `app.tsx` 两个中风险点；纯新增文件按表保留即可。通用修复（如 Windows 支持三项）建议以独立 commit cherry-pick 提交 PR 回 upstream，避免与功能分支纠缠。

## 本次迁移验收（2026-10-30）

- 静态与发布：`typecheck`、`build`、`pack:check` 通过，实际 npm 包含 105 个文件；Windows 打包命令及两种 npm JSON 报告格式兼容已补测试。
- 受影响回归：工作台、面板入口、Profile 合同、包清单与 Bundle 协议共 99 项通过。
- 全仓：`pnpm vitest run --maxWorkers 4` 为 570 通过、11 失败。原分支临时工作区同样重现研究渲染脚本 9 项、SQLite POSIX 权限 1 项（伴随 Windows EBUSY 清理错误）、资源可执行位 1 项；没有降低这些断言。默认并发额外出现过 Bundle 5 秒超时，单独及限制并发重跑通过。
- 真实运行：从 tarball 安装到隔离 `DSH_HOME` 的 `web`，`profile:verify` 通过；浏览器默认原生会话可用，进入值见及宏观页再返回，URL 不变且面板卸载；原生模型设置可打开。
- 插件共存：同一隔离 Profile 安装 Codex 登录插件，原生模型设置显示其提供商；重复安装 Hanai 后整个 manifest 文本不变。卸载 Hanai 后原生界面、Codex 提供商及 Hanai SQLite 均保留。
- 未验证：未安装到用户实际 `web`，未使用真实凭据调用模型，未覆盖全部第三方插件组合及其它 DSH 版本。旧业务数据目录未移动或删除。
