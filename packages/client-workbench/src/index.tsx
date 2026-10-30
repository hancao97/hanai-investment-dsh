import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createPortal } from 'react-dom'
import { HanaiWorkbench } from './app.tsx'
import { HanaiClient } from './api.ts'

export const inject = ['slots', 'layout', 'sessions', 'connection', 'remote', 'remote.credentials', 'remote.session', 'uiConversation', 'uiSession']

const PANEL_ID = 'hanai-investment-workbench'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Global panel icons; each list id addresses the matching main panel. */
    'sidebar.panellist': {
      kind: 'list'
      scope: 'root'
      owner: { size: number; active: boolean }
    }
  }
}

/** Sidebar glyph for the Hanai panel entry; the sidebar owns the button and label. */
function HanaiPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19V9m5 10V5m5 14v-7m5 7V3" />
      <path d="M3 20h18" />
      <path d="m4 8 5-3 5 6 5-8" />
    </svg>
  )
}

/** Mount Hanai as a DSH main panel opened from the sidebar, closing back to the conversation. */
export function apply(ctx: ClientContext): void {
  const client = new HanaiClient(ctx)
  const WorkbenchPanel = () => createPortal(
    <HanaiWorkbench client={client} onClose={() => ctx.layout.selectPanel(null)} />,
    document.body,
  )
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, WorkbenchPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 12,
    label: () => '值见',
  }, HanaiPanelIcon))
}
