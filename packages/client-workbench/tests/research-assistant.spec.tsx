// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResearchAssistantPage, researchPrompt } from '../src/research-assistant.tsx'
import type { HanaiClient } from '../src/api.ts'
import type { ExpertChat } from '../../contracts/src/index.ts'

vi.mock('../../client-chat/src/index.tsx', () => ({ ChatPanel: ({ sessionId, variant }: { sessionId: string; variant: string }) => <div data-testid="research-session">{sessionId}:{variant}</div> }))
const chat: ExpertChat = { id: 'r1', title: '存储产业研究', masterId: 'ai-research-assistant', masterName: 'AI研究助手', masterVersion: '1', dshSessionId: 'session-r1', turnStatus: 'idle', modelProvider: null, model: null, reasoningEffort: null, createdAt: '2026-10-30T10:00:00Z', updatedAt: '2026-10-30T10:00:00Z', errorCode: null, errorMessage: null }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T18:00:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
function setup(overrides: Record<string, () => unknown> = {}, selectedId: string | null = null) {
  const call = vi.fn(async (name: string) => {
    if (overrides[name]) return overrides[name]!()
    if (name === 'research-chat.list') return [chat]
    if (name === 'research-chat.create') return chat
    if (name === 'research-chat.remove') return []
    return null
  })
  const models = vi.fn(async () => [{ id: 'provider', name: '研究模型', models: [{ id: 'model', name: '测试模型' }] }])
  const onOpen = vi.fn(), onHome = vi.fn()
  render(<ResearchAssistantPage client={{ call, models } as unknown as HanaiClient} selectedId={selectedId} onOpen={onOpen} onHome={onHome} />)
  return { call, onOpen, onHome }
}
it('shows starter prompts, lets the user edit them, and sends the selected new-chat model', async () => {
  const view = setup(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: /行业与产业链/ }))
  expect((screen.getByLabelText('研究问题') as HTMLTextAreaElement).value).toContain('存储行业')
  fireEvent.change(screen.getByLabelText('新研究对话模型'), { target: { value: 'provider\0model' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始研究' })) })
  expect(view.call).toHaveBeenCalledWith('research-chat.create', expect.objectContaining({ model: { provider: 'provider', model: 'model' }, openingMessage: expect.stringContaining('存储行业') }))
  expect(view.onOpen).toHaveBeenCalledWith('r1')
})
it('keeps the question after creation failure and prevents duplicate in-flight creation', async () => {
  let reject: (error: Error) => void = () => {}
  const pending = new Promise((_, no) => { reject = no })
  const view = setup({ 'research-chat.create': () => pending }); await act(async () => {})
  fireEvent.change(screen.getByLabelText('研究问题'), { target: { value: '分析现金流' } })
  fireEvent.click(screen.getByRole('button', { name: '开始研究' }))
  fireEvent.submit(screen.getByLabelText('研究问题').closest('form')!)
  expect(view.call.mock.calls.filter(([name]) => name === 'research-chat.create')).toHaveLength(1)
  await act(async () => { reject(new Error('模型暂不可用')) })
  expect(screen.getByRole('alert').textContent).toContain('模型暂不可用')
  expect((screen.getByLabelText('研究问题') as HTMLTextAreaElement).value).toBe('分析现金流')
  expect(view.onOpen).not.toHaveBeenCalled()
})
it('restores a deep-linked research session and deletes only after confirmation', async () => {
  const view = setup({}, 'r1'); await act(async () => {})
  expect(screen.getByTestId('research-session').textContent).toBe('session-r1:research')
  fireEvent.click(screen.getByRole('button', { name: '删除研究：存储产业研究' }))
  expect(view.call.mock.calls.some(([name]) => name === 'research-chat.remove')).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认删除' })) })
  expect(view.call).toHaveBeenCalledWith('research-chat.remove', { id: 'r1' })
  expect(view.onHome).toHaveBeenCalledOnce()
})
it('rejects oversized attachments without creating a session or uploading bytes', async () => {
  const view = setup(); await act(async () => {})
  const file = new File(['x'.repeat(5 * 1024 * 1024 + 1)], 'large.txt', { type: 'text/plain' })
  await act(async () => { fireEvent.change(screen.getByLabelText('选择研究材料'), { target: { files: [file] } }) })
  expect(screen.getByRole('alert').textContent).toContain('5 MB')
  expect(view.call.mock.calls.some(([name]) => ['research-chat.create', 'research-chat.upload'].includes(name))).toBe(false)
})
it('uploads a file into the selected research and lets the user remove only the pending reference', async () => {
  class Reader {
    result = 'data:text/plain;base64,bm90ZXM='
    onload: (() => void) | null = null
    readAsDataURL() { queueMicrotask(() => this.onload?.()) }
  }
  vi.stubGlobal('FileReader', Reader)
  const view = setup({ 'research-chat.upload': () => ({ id: 'f1', name: '报告.txt', path: 'attachments/f1.txt', mediaType: 'text/plain', bytes: 5 }) }, 'r1')
  await act(async () => {})
  await act(async () => { fireEvent.change(screen.getByLabelText('选择研究材料'), { target: { files: [new File(['notes'], '报告.txt')] } }) })
  expect(view.call).toHaveBeenCalledWith('research-chat.upload', { id: 'r1', name: '报告.txt', data: 'bm90ZXM=' })
  expect(screen.getByText('报告.txt')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '移除附件：报告.txt' }))
  expect(screen.queryByText('报告.txt')).toBeNull()
  expect(view.call.mock.calls.some(([name]) => name === 'research-chat.remove')).toBe(false)
})
it('keeps file references as text and uses the native image part for model vision', () => {
  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'base64bytes', name: '图.png' }
  const parts = researchPrompt('分析图表', [{ id: 'f', name: '图.png', bytes: 10, path: 'attachments/f.png', mediaType: 'image/png', image }])
  expect(parts[0]).toEqual({ type: 'text', text: expect.stringContaining('attachments/f.png') })
  expect(parts[1]).toEqual(image)
  expect(researchPrompt('纯文本问题', [])).toEqual([{ type: 'text', text: '纯文本问题' }])
})
