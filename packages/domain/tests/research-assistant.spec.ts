import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ResearchWorkspace } from '../src/research-assistant.ts'
import { ensureHanaiLayout, resolveHanaiPaths } from '../src/paths.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) { if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('hanai-research-test-')) throw new Error('Unexpected cleanup path'); rmSync(root, { recursive: true, force: true }) } })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hanai-research-test-')); roots.push(root)
  const paths = resolveHanaiPaths(root); ensureHanaiLayout(paths)
  return { root, paths, store: new ResearchWorkspace(paths) }
}
it('keeps dated context, instructions and uploaded bytes in the conversation workspace', () => {
  const { store, paths } = fixture()
  const context = { date: '2026-10-30', records: {} }
  const workspace = store.prepare('research-1', context)
  expect(JSON.parse(readFileSync(join(workspace, 'market-context.json'), 'utf8'))).toEqual(context)
  expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain('不把归档冒充实时')
  const file = store.upload('research-1', '财报摘要.txt', Buffer.from('营收增长，现金流待核实').toString('base64'))
  expect(file.path).toMatch(/^attachments\/[\w-]+\.txt$/)
  expect(readFileSync(join(paths.expertChatsDir, 'research-1', 'workspace', file.path), 'utf8')).toBe('营收增长，现金流待核实')
})
it('persists the screening universe without treating master identities as metric evidence', () => {
  const { store } = fixture()
  const universe = { securities: [{ code: '600000', name: '浦发银行', updatedAt: '2026-10-30' }] }
  const workspace = store.prepare('screen-1', null, universe)
  expect(JSON.parse(readFileSync(join(workspace, 'candidate-universe.json'), 'utf8'))).toEqual(universe)
  const instructions = readFileSync(join(workspace, 'AGENTS.md'), 'utf8')
  expect(instructions).toContain('当前会话：AI选股')
  expect(instructions).toContain('不能混入已确认满足全部条件')
  expect(instructions).toContain('工具不能取得数据时停止')
})
it('rejects traversal, unsupported extensions, mismatched file signatures and oversize input', () => {
  const { store } = fixture(); store.prepare('r', null)
  const data = Buffer.from('plain text').toString('base64')
  expect(() => store.upload('r', '../escape.txt', data)).toThrow('名称')
  expect(() => store.upload('r', 'run.exe', data)).toThrow('类型')
  expect(() => store.upload('r', 'fake.pdf', data)).toThrow('类型')
  expect(() => store.upload('../bad', 'ok.txt', data)).toThrow('标识')
  expect(() => store.upload('r', 'big.txt', 'A'.repeat(6990512))).toThrow('过大')
  expect(() => store.upload('r', 'bad.txt', '%%%%')).toThrow('编码')
})
it('rejects an attachment-directory junction rather than writing outside the workspace', () => {
  const { store, root } = fixture(); const workspace = store.prepare('r', null)
  const outside = join(root, 'outside'); mkdirSync(outside)
  symlinkSync(outside, join(workspace, 'attachments'), 'junction')
  expect(() => store.upload('r', 'notes.txt', Buffer.from('text').toString('base64'))).toThrow('符号链接')
  expect(existsSync(join(outside, 'notes.txt'))).toBe(false)
})
it('rejects a screening plan symlink instead of treating outside files as model output', () => {
  const { store, root } = fixture(); const workspace = store.prepare('r', null)
  const target = join(root, 'outside-plan.json'); mkdirSync(target)
  symlinkSync(target, join(workspace, 'screening-plan.json'), 'junction')
  expect(() => store.readScreeningPlan('r')).toThrow('受管 JSON')
})
