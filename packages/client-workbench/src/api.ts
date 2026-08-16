import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CredentialView,
  ConnectionHandle,
  ModelProviderGroup,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  HanaiEndpoint,
  HanaiRequest,
  HanaiResponse,
} from '../../contracts/src/index.ts'

export const DEEPSEEK_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'

export interface DefaultModelView {
  provider: string
  model: string
  reasoningEffort?: string
  writable: boolean
  revision: number
}

export class HanaiClient {
  constructor(readonly ctx: ClientContext) {}

  private get connection(): ConnectionHandle {
    // Host and browser halves augment the same Cordis Context in this dual-entry package.
    return this.ctx.get('connection') as unknown as ConnectionHandle
  }

  get isLoopback(): boolean {
    return this.connection.isLoopback
  }

  async call<K extends HanaiEndpoint>(
    endpoint: K,
    request: HanaiRequest<K>,
    signal?: AbortSignal,
  ): Promise<HanaiResponse<K>> {
    const response = await this.connection.rpc.call('/hanai', endpoint, request, signal)
    if (!response.ok) throw new Error(response.error.message)
    return response.value as HanaiResponse<K>
  }

  async credential(): Promise<CredentialView> {
    this.assertLoopback()
    const response = await this.connection.api.credentials.describe({ refs: [DEEPSEEK_CREDENTIAL_REF] })
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value.credentials[DEEPSEEK_CREDENTIAL_REF]
      ?? { configured: false, writable: true }
  }

  async setDeepSeekKey(value: string): Promise<void> {
    this.assertLoopback()
    const key = normalizeApiKey(value)
    const response = await this.connection.api.credentials.set({
      ref: DEEPSEEK_CREDENTIAL_REF,
      value: key,
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
  }

  async unsetDeepSeekKey(): Promise<void> {
    this.assertLoopback()
    const response = await this.connection.api.credentials.unset({ ref: DEEPSEEK_CREDENTIAL_REF })
    if (!response.result.ok) throw new Error(response.result.error.message)
  }

  async models(): Promise<ModelProviderGroup[]> {
    const response = await this.connection.api.llm.models({})
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value.groups
  }

  /** Read DSH's process-wide Agent default through the loopback Hanai Host bridge. */
  async defaultModel(): Promise<DefaultModelView | null> {
    this.assertLoopback()
    return defaultModelView(await this.call('model.default.get', {}))
  }

  /**
   * Save the complete DSH default route. Omitting reasoning effort deliberately
   * clears any effort inherited from the previously selected model.
   */
  async setDefaultModel(
    selection: { provider: string; model: string },
    _expectedRevision?: number,
  ): Promise<DefaultModelView> {
    this.assertLoopback()
    const provider = selection.provider.trim()
    const model = selection.model.trim()
    if (provider === '' || model === '') throw new Error('请选择有效的模型')
    return defaultModelView(await this.call('model.default.set', { provider, model }))
  }

  openSession(sessionId: string): void {
    this.ctx.sessions.open(sessionId as never)
  }

  private assertLoopback(): void {
    if (!this.isLoopback) throw new Error('API Key 只能在运行 DSH 的本机页面设置')
  }
}

export function normalizeApiKey(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new Error('API Key 不能为空')
  if (value.includes('=')) throw new Error('请只粘贴 Key，不要包含变量名或等号')
  if (!/^[\x21-\x7E]+$/.test(value) || /["']/.test(value)) throw new Error('API Key 包含不支持的字符')
  return value
}

function defaultModelView(value: unknown): DefaultModelView {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.model !== 'string') {
    throw new Error('DSH 默认模型设置格式无效')
  }
  const reasoningEffort = typeof value.reasoningEffort === 'string' && value.reasoningEffort !== ''
    ? value.reasoningEffort
    : undefined
  return {
    provider: value.provider,
    model: value.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    writable: true,
    // agentDefaultModel intentionally exposes no Settings revision. This
    // compatibility field keeps the current page contract stable while all
    // writes are serialized and validated by the DSH owner service itself.
    revision: 0,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
