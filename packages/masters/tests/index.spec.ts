import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installMasterSnapshot,
  listMasters,
  parseSkillFrontmatter,
  validateMasterAssets,
} from '../src/index.ts'

const ASSETS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../assets')
const temporaryRoots: string[] = []

interface MigrationManifest {
  schemaVersion: number
  source: string
  files: Record<string, string>
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function walkFiles(root: string): string[] {
  const output: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...walkFiles(path))
    else if (entry.isFile()) output.push(path)
  }
  return output.sort()
}

function relativeFiles(root: string): string[] {
  return walkFiles(root).map(file => relative(root, file).split('\\').join('/'))
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

describe('legacy master Skill migration', () => {
  it('keeps the complete 51-file source snapshot byte-for-byte intact', () => {
    const manifest = JSON.parse(readFileSync(join(ASSETS_ROOT, 'migration-manifest.json'), 'utf8')) as MigrationManifest
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.source).toBe('hanai-investment/packages/agents')
    expect(Object.keys(manifest.files)).toHaveLength(51)
    expect(Object.keys(manifest.files).filter(file => file.includes('/scripts/'))).toHaveLength(8)
    expect(relativeFiles(ASSETS_ROOT).filter(file => file !== 'migration-manifest.json'))
      .toEqual(Object.keys(manifest.files).sort())
    for (const [file, digest] of Object.entries(manifest.files)) {
      expect(sha256(join(ASSETS_ROOT, ...file.split('/'))), file).toBe(digest)
    }
    for (const file of Object.keys(manifest.files).filter(file => file.startsWith('duan-yongping-perspective/scripts/'))) {
      expect(statSync(join(ASSETS_ROOT, ...file.split('/'))).mode & 0o111, `${file} executable`).not.toBe(0)
    }
    for (const file of Object.keys(manifest.files).filter(file => file.startsWith('warren-buffett-perspective/scripts/'))) {
      expect(statSync(join(ASSETS_ROOT, ...file.split('/'))).mode & 0o111, `${file} non-executable`).toBe(0)
    }
    expect(() => validateMasterAssets(ASSETS_ROOT)).not.toThrow()
  })

  it('uses the original Skill frontmatter and legacy client theme metadata without truncation', () => {
    const masters = listMasters()
    expect(masters.map(master => master.id)).toEqual([
      'duan-yongping-perspective',
      'hunjianglong-perspective',
      'munger-perspective',
      'warren-buffett-perspective',
    ])
    expect(new Set(masters.map(master => master.version))).toEqual(new Set(['2026.08.20-v3']))
    expect(masters.map(({ color, roleTag, tags }) => ({ color, roleTag, tags }))).toEqual([
      { color: '#d4a017', roleTag: '价值投资', tags: ['本分', '消费者导向', '长期价值'] },
      { color: '#c4573d', roleTag: '游资大佬', tags: ['题材周期', '情绪', '弱转强'] },
      { color: '#5b8def', roleTag: '价值投资', tags: ['多元思维', '逆向思考', '认知偏误'] },
      { color: '#34a870', roleTag: '价值投资', tags: ['护城河', '内在价值', '资本配置'] },
    ])
    for (const master of masters) {
      const markdown = readFileSync(join(ASSETS_ROOT, master.id, 'SKILL.md'), 'utf8')
      const frontmatter = parseSkillFrontmatter(markdown)
      expect(frontmatter.name).toBe(master.id)
      expect(master.description).toBe(frontmatter.description)
      expect(master.description.length).toBeGreaterThan(200)
      expect(markdown.length).toBeGreaterThan(2_000)
    }
    expect(masters[0]!.defaultPrompt).toContain('$duan-yongping-perspective')
    expect(masters[1]!.defaultPrompt).toContain('$hunjianglong-perspective')
  })

  it('installs every Skill file, including scripts, into each judgement snapshot', () => {
    for (const master of listMasters()) {
      const workspace = mkdtempSync(join(tmpdir(), `hanai-${master.shortName}-`))
      temporaryRoots.push(workspace)
      const installed = installMasterSnapshot(ASSETS_ROOT, master, workspace)
      const sourceRoot = join(ASSETS_ROOT, master.id)
      expect(relativeFiles(installed.skillDirectory)).toEqual(relativeFiles(sourceRoot))
      for (const file of relativeFiles(sourceRoot)) {
        expect(sha256(join(installed.skillDirectory, ...file.split('/'))), `${master.id}/${file}`)
          .toBe(sha256(join(sourceRoot, ...file.split('/'))))
        expect(statSync(join(installed.skillDirectory, ...file.split('/'))).mode & 0o777, `${master.id}/${file} mode`)
          .toBe(statSync(join(sourceRoot, ...file.split('/'))).mode & 0o777)
      }
    }
  })

  it('preserves the legacy research discipline while adding same-session follow-up rules', () => {
    const master = listMasters()[0]!
    const workspace = mkdtempSync(join(tmpdir(), 'hanai-master-instructions-'))
    temporaryRoots.push(workspace)
    const installed = installMasterSnapshot(ASSETS_ROOT, master, workspace)
    const instructions = readFileSync(installed.agentsPath, 'utf8')

    expect(instructions).toContain('# Hanai Worth · 值见 研判工作区')
    expect(instructions).toContain('本工作区由 Hanai Worth · 值见创建')
    expect(instructions).toContain(`.agents/skills/${master.id}/SKILL.md`)
    expect(instructions).toContain('整段 Session 固定使用该大师')
    expect(instructions).toContain('主动联网获取最新公开信息并交叉核验')
    expect(instructions).toContain('不要向用户提问，也不要等待用户补充材料')
    expect(instructions).toContain('只可在当前工作区内写文件')
    expect(instructions).toContain('报告必须使用简体中文')
    expect(instructions).toContain('来源链接和日期')
    expect(instructions).toContain('YYYY-MM-DD')
    expect(instructions).toContain('严禁编造实时行情、财务数据、来源或引文')
    expect(instructions).toContain('明确标记不确定性和待验证项')
    expect(instructions).toContain('普通追问直接回答用户，不要改写 `REPORT.md`')
    expect(instructions).toContain('明确要求创建修订版时才更新')
    expect(instructions).toContain('只用一句话确认已完成')
    expect(instructions).toContain('不要在回复中重复整份报告')
  })

  it('rejects a truncated or modified release asset', () => {
    const copiedRoot = mkdtempSync(join(tmpdir(), 'hanai-master-assets-'))
    temporaryRoots.push(copiedRoot)
    cpSync(ASSETS_ROOT, copiedRoot, { recursive: true })
    const skill = join(copiedRoot, 'munger-perspective', 'SKILL.md')
    const original = readFileSync(skill, 'utf8')
    writeFileSync(skill, `${original.slice(0, -1)}x\n`)
    expect(() => validateMasterAssets(copiedRoot)).toThrow('文件校验失败')
  })
})
