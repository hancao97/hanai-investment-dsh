# Hanai client chat

Standalone React presentation for a DeepSeek Harness Session. It uses DSH's
runtime-owned history/live fold and Agent actions, but it does not import or
render DSH Chat UI components, shadcn, or Tailwind.

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

`ChatPanel` calls `clientContext.sessions.open(sessionId)` when needed, resolves
the stable `SessionFace` through `sessions.binding(sessionId)`, and subscribes to
its folded `ConversationSnapshot`. Selecting a report conversation therefore
also makes that Session the current DSH Session; this is required for DSH to open
and maintain its history window.

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
- structured question answer/cancel responses;
- removed, missing, loading, error, and non-resumable subagent states.

## Runtime dependencies

- `react`;
- `@deepseek-ai/dsh-client-runtime/client` for `ClientContext`, `ISessions`,
  `SessionFace`, and `ConversationSnapshot` contracts;
- `@deepseek-ai/dsh-client-connection/client` as a type-only source for the
  official approval and question response payloads;
- `@deepseek-ai/dsh-client-ui-conversation/client` as a **type-only** source for
  the folded Chat node union. The deployment must load ui-conversation so those
  business fold definitions are registered, but none of its React renderers or
  primitives are used.

Styles are a local CSS Module inlined by the repository's DSH client bundler.
