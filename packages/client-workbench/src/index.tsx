import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { HanaiWorkbench } from './app.tsx'
import { HanaiClient } from './api.ts'

export const inject = ['slots', 'sessions', 'connection']

interface WorkbenchInjected {
  client: HanaiClient
}

type WorkbenchProps = PropsRuntime<'shell.overlay'> & WorkbenchInjected

function WorkbenchRoot({ client }: WorkbenchProps) {
  return <HanaiWorkbench client={client} />
}

/** Mount Hanai as a persistent full-frame React workbench above the stock DSH surface. */
export function apply(ctx: ClientContext): void {
  const client = new HanaiClient(ctx)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'hanai-investment-workbench',
    inject: (): WorkbenchInjected => ({ client }),
  }, WorkbenchRoot))
}
