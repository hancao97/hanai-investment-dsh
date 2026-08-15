# ADR-0002：隔离 Hanai 数据根且不读取旧版数据

- 状态：已接受并实现
- 日期：2026-08-15

## 背景

旧版 Hanai Investment 将数据库、缓存、persona 副本、研判工作区、报告和日志统一写在 `~/.hanai-investment`。新版运行在 DSH 内，而 DSH 已经拥有自己的 Home、凭据、设置、Session Persistence 和附件存储。

如果新版继续使用旧目录，会让两个版本竞争同一 SQLite/WAL、覆盖工作区，并把 Codex Thread 和 DSH Session 混在一个生命周期里。如果把 DSH Home 直接改成 Hanai 目录，又会劫持用户已有的 DSH Profile、Key 和其他 Session。产品不要求继承旧版业务数据，因此没有必要承担迁移格式、路径和失败恢复的复杂度。

## 决策

### 1. 双根目录

Hanai 业务数据默认根目录：

```text
~/.hanai-investment-dsh
```

解析优先级：

1. Bundle/Host 的显式 `dataRoot` 配置；
2. `HANAI_INVESTMENT_DSH_HOME`；
3. `~/.hanai-investment-dsh`。

DSH 继续使用当前 `$DSH_HOME`，未设置时为 `~/.dsh`。插件不得修改进程的 `DSH_HOME`，不得在两个根之间复制 Session、附件或凭据。

### 2. Hanai 目录布局

```text
~/.hanai-investment-dsh/
├── db/
│   └── hanai.sqlite
├── cache/
│   ├── market/
│   └── valuation/
├── judgements/
│   └── <judgement-id>/
│       ├── workspace/
│       │   ├── AGENTS.md
│       │   ├── REPORT.md
│       │   └── .agents/skills/<master-id>/...
│       └── reports/
│           └── 0001/
│               ├── report.md
│               └── manifest.json
├── exports/
└── tmp/
```

规则：

- 根目录和子目录使用 `0700`；普通数据文件使用 `0600`。
- 数据库只保存相对路径。
- `workspace` 是 Agent 可写区；`reports` 是 Host 封存区。
- UI 只读取封存报告。
- 大师资源以插件包为源，每次研判复制版本快照到工作区；不建立全局 `personas` 派生目录。
- 应用日志使用 DSH/Cordis logger，不另建长期明文日志目录。
- `tmp` 中的内容没有备份语义，可以安全清理。

### 3. DSH 所有的数据

以下数据不进入 Hanai 根目录：

| 数据 | DSH 位置 |
| --- | --- |
| API Key | `$DSH_HOME/.credentials.yaml` |
| 模型设置 | `$DSH_HOME/settings.yaml` |
| Session 日志 | `$DSH_HOME/sessions` |
| 聊天附件 | `$DSH_HOME/attachments` |
| Profile 和 Bundle 安装 | `$DSH_HOME/profiles` |

Hanai SQLite 只保存 opaque `dshSessionId` 作为关联键，不复制消息、Turn、工具活动或附件。

### 4. 旧版数据

新版不提供旧数据导入，也不做兼容性探测：

- 不检查 `~/.hanai-investment` 是否存在；
- 不打开旧 `hanai.db` 或 WAL；
- 不读取旧报告、工作区、persona、缓存或 exports；
- 不提供导入按钮、迁移命令或双写层；
- 不修改、重命名或删除旧目录。

新版以空数据库开始，用户重新建立自选和研判。旧版应用及其数据是否保留，由用户在插件之外独立决定。

## 备份与恢复

备份 `~/.hanai-investment-dsh` 可以恢复自选、研判索引和正式报告，但不能单独恢复持续对话。

完整恢复还需要：

- `$DSH_HOME/sessions`；
- `$DSH_HOME/attachments`；
- 与 Session 匹配的 Hanai Bundle、大师 Skill 和 DSH 版本。

`$DSH_HOME/.credentials.yaml` 是 secret，不自动进入普通 Hanai 备份。用户应通过自己的安全凭据备份方式管理它。

## 后果

### 正面

- 新旧应用可以并存，互不竞争数据库和工作区。
- 新版启动失败不会损坏或依赖旧数据。
- Hanai 业务备份和 DSH 会话备份职责清晰。
- 凭据只由 DSH 的 write-only Credentials 流程管理。
- 无需维护一次性导入器、旧 Schema 解析和兼容状态。

### 代价

- 完整备份需要同时理解 Hanai 和 DSH 两个根目录。
- 删除 Hanai 研判记录不能自动删除 DSH Session；首版必须采用“隐藏/归档”语义并记录孤儿清理策略。
- 用户需要在新版重新建立自选和研判，旧报告不会出现在新 UI。

## 未来独立发行版

如果未来提供完全独立的 Hanai 桌面启动器，可以为该发行版显式选择专用 DSH Home，例如 `~/.hanai-investment-dsh/dsh-home`。这是发行版部署决策，不是插件默认行为；不能在普通 DSH Profile 中静默切换。
