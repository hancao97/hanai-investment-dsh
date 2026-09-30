# Hanai client chat

Standalone React presentation for a DeepSeek Harness 0.2.0-rc.2 Session. It uses
DSH-owned history/live projections and Agent actions with Hanai's own chat rows
and composer. Shared DSH Markdown primitives render rich text.

## Workbench integration

```tsx
import { ChatPanel } from '../../client-chat/src/index.tsx'

<ChatPanel
  clientContext={client.ctx}
  sessionId={judgement.dshSessionId}
  compact
/>
```

While the report-producing turn is still being sealed, pass
`readOnlyReason="报告封存完成后即可继续对话"`. The panel continues to render
history, streaming activity, approvals, and questions, but hides the prompt
composer and freezes queued-message mutations until the guard is removed.

`ChatPanel` retains its Session with `sessions.retain(sessionId, { source:
'hanaiChat' })`. The local adapter activates the `uiConversation` Chat target and
joins its transcript with the native Session lifecycle, inbox queue/steering
projection, and `uiSession.sessionStatus` pending interaction. It caches each
read snapshot until one source publishes, without copying conversation data
into another store. Switching Sessions or unmounting releases every subscription
and the underlying Session reference.

The lower-level `DshChatPanel` accepts `sessions` directly, and
`useDshChatSession` exposes the same bridge for custom workbench layouts.

## Capabilities

- history pagination with scroll-anchor preservation;
- per-node streaming text/reasoning updates;
- user/context/assistant, command, retry, compaction, error, and nested tool rows;
- queue and steer prompt delivery, run cancellation, queue edit/remove/steer;
- ordinary Sessions expose queue/steer; continuable subagents use continuation
  delivery without presenting a misleading steer control;
- approval allow-once/reject responses;
- structured question answer/cancel responses, with focus and draft engagement
  preserving the latest DSH asynchronous question deadline semantics;
- removed, missing, loading, error, and non-resumable subagent states.

## Runtime dependencies

- `react`;
- `@deepseek-ai/cordis` for `Context`;
- `@deepseek-ai/dsh-api-session-controller/client` for Session references and actions;
- `@deepseek-ai/dsh-client-ui-conversation/client` and `dsh-client-ui-chat/client`
  for the folded Chat target and node contracts;
- `@deepseek-ai/dsh-client-ui-session/client` for pending interaction selection;
- `@deepseek-ai/dsh-client-ui-approval/client` and `dsh-client-ui-user-questions/client`
  for the native answerable request carriers;
- `@deepseek-ai/dsh-client-ui-primitives` for shared Markdown rendering.

Only React and the Markdown primitive are imported as runtime values by this
presentation package. Other DSH contracts are type-only imports; the deployment
loads the matching service plugins before activating Hanai.

Styles are a local CSS Module inlined by the repository's DSH client bundler.
