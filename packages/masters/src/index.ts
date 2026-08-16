import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MasterPersona } from '../../contracts/src/index.ts'

// Bump whenever either the immutable Skill snapshot or its workspace contract changes.
export const MASTER_VERSION = '2026.08.16-v2'

interface MasterTheme extends Omit<MasterPersona, 'description' | 'version'> {}

const MASTER_THEMES: readonly MasterTheme[] = [
  {
    id: 'duan-yongping-perspective',
    name: '段永平',
    shortName: '段',
    color: '#d4a017',
    roleTag: '价值投资',
    tags: ['本分', '消费者导向', '长期价值'],
    defaultPrompt: '请从商业模式、护城河、管理层与估值纪律出发，对这家公司做一份独立研判。',
  },
  {
    id: 'hunjianglong-perspective',
    name: '混江龙',
    shortName: '混',
    color: '#c4573d',
    roleTag: '游资大佬',
    tags: ['题材周期', '情绪', '弱转强'],
    defaultPrompt: '请结合当前市场事实、题材与情绪周期，给出这只股票的交易研判和退出条件。',
  },
  {
    id: 'munger-perspective',
    name: '查理·芒格',
    shortName: '芒',
    color: '#5b8def',
    roleTag: '价值投资',
    tags: ['多元思维', '逆向思考', '认知偏误'],
    defaultPrompt: '请用多元思维模型和逆向检查清单，判断这家公司是否值得长期研究。',
  },
  {
    id: 'warren-buffett-perspective',
    name: '沃伦·巴菲特',
    shortName: '巴',
    color: '#34a870',
    roleTag: '价值投资',
    tags: ['护城河', '内在价值', '资本配置'],
    defaultPrompt: '请评估能力圈、护城河、管理层资本配置、所有者收益与安全边际。',
  },
] as const

export function listMasters(): MasterPersona[] {
  const assetsRoot = resolveMasterAssetsRoot(import.meta.url)
  return MASTER_THEMES.map(theme => {
    const skill = readFileSync(join(assetsRoot, theme.id, 'SKILL.md'), 'utf8')
    const frontmatter = parseSkillFrontmatter(skill)
    if (frontmatter.name !== theme.id) {
      throw new Error(`大师 SKILL.md 名称不匹配：${theme.id}`)
    }
    if (!frontmatter.description) {
      throw new Error(`大师 SKILL.md 缺少 description：${theme.id}`)
    }
    const openaiPath = join(assetsRoot, theme.id, 'agents', 'openai.yaml')
    const packagedDefaultPrompt = existsSync(openaiPath)
      ? parseOpenaiDefaultPrompt(readFileSync(openaiPath, 'utf8'))
      : null
    return {
      ...theme,
      description: frontmatter.description,
      defaultPrompt: packagedDefaultPrompt ?? theme.defaultPrompt,
      tags: [...theme.tags],
      version: MASTER_VERSION,
    }
  })
}

export function getMasterPersona(id: string): MasterPersona | null {
  return listMasters().find(master => master.id === id) ?? null
}

export function resolveMasterAssetsRoot(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl))
  const candidates = [
    resolve(moduleDir, '..', 'packages', 'masters', 'assets'),
    resolve(moduleDir, '..', 'assets'),
    resolve(process.cwd(), 'packages', 'masters', 'assets'),
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new Error(`Hanai master assets are missing; checked: ${candidates.join(', ')}`)
  }
  return found
}

export interface InstalledMasterSnapshot {
  skillPath: string
  skillDirectory: string
  agentsPath: string
}

/** Copy one immutable release resource into a judgement-owned DSH workspace. */
export function installMasterSnapshot(
  assetsRoot: string,
  master: MasterPersona,
  workspace: string,
): InstalledMasterSnapshot {
  const source = join(assetsRoot, master.id)
  const skillDirectory = join(workspace, '.agents', 'skills', master.id)
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`大师能力包缺少 SKILL.md：${master.id}`)
  mkdirSync(skillDirectory, { recursive: true, mode: 0o700 })
  cpSync(source, skillDirectory, {
    recursive: true,
    force: true,
    filter: shouldCopyMasterResource,
  })
  const agentsPath = join(workspace, 'AGENTS.md')
  writeFileSync(agentsPath, agentsDocument(master), { encoding: 'utf8', mode: 0o600 })
  return { skillPath: join(skillDirectory, 'SKILL.md'), skillDirectory, agentsPath }
}

function shouldCopyMasterResource(source: string): boolean {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) return false
  if (stat.isDirectory()) return !/(^|[/\\])(node_modules|\.git)$/.test(source)
  return /\.(md|ya?ml|txt|json|py|sh)$/i.test(source)
}

export interface SkillFrontmatter {
  name: string | null
  description: string | null
}

/** Parse the two public Skill metadata fields with the same folded-block semantics as the legacy client. */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return { name: null, description: null }
  const fields: Record<string, string> = {}
  let key = ''
  let lines: string[] = []
  const flush = () => {
    if (key) fields[key] = lines.join(' ').trim()
  }
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (entry) {
      flush()
      key = entry[1]!
      lines = /^[>|][+-]?$/.test(entry[2]!) ? [] : [unquoteYamlScalar(entry[2]!)]
    }
    else if (key) lines.push(line.trim())
  }
  flush()
  return {
    name: fields.name || null,
    description: fields.description || null,
  }
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseOpenaiDefaultPrompt(yaml: string): string | null {
  const match = yaml.match(/^\s*default_prompt:\s*(.+?)\s*$/m)
  return match ? unquoteYamlScalar(match[1]!) || null : null
}

function agentsDocument(master: MasterPersona): string {
  return `# Hanai Investment 研判工作区\n\n`
    + `本工作区绑定大师：${master.name}（${master.id}，版本 ${master.version}）。\n\n`
    + `## 必须遵守\n\n`
    + `1. 在每次回答前完整读取 \`.agents/skills/${master.id}/SKILL.md\`，并按其中路由读取必要参考资料。\n`
    + `2. 整段 Session 固定使用该大师的方法论与身份状态；不要切换成其他大师。\n`
    + `3. 初次研判与显式修订时，主动联网获取最新公开信息并交叉核验；不要向用户提问，也不要等待用户补充材料。\n`
    + `4. 只可在当前工作区内写文件。初次研判与显式修订的唯一正式交付物是工作区根目录的 \`REPORT.md\`。\n`
    + `5. 报告必须使用简体中文，清楚区分事实、推断与假设，并为关键事实注明来源链接和日期。\n`
    + `6. 严禁编造实时行情、财务数据、来源或引文；资料不足时必须明确标记不确定性和待验证项。\n`
    + `7. 初次研判与显式修订必须把完整、可独立阅读的中文 Markdown 报告写入 \`REPORT.md\`。\n`
    + `8. 报告完成后的普通追问直接回答用户，不要改写 \`REPORT.md\`；只有用户明确要求创建修订版时才更新。\n`
    + `9. 完成 \`REPORT.md\` 后只用一句话确认已完成，不要在回复中重复整份报告。\n`
    + `10. 内容仅供研究参考，不构成投资建议。\n`
}

/** Validate that every release master is present and readable. */
export function validateMasterAssets(assetsRoot: string): void {
  const installed = new Set(readdirSync(assetsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name))
  for (const master of MASTER_THEMES) {
    if (!installed.has(master.id)) throw new Error(`缺少大师资源目录：${master.id}`)
    const skill = readFileSync(join(assetsRoot, master.id, 'SKILL.md'), 'utf8')
    const frontmatter = parseSkillFrontmatter(skill)
    if (frontmatter.name !== master.id || !frontmatter.description) {
      throw new Error(`大师 SKILL.md frontmatter 不完整：${master.id}`)
    }
  }
  validateMigrationManifest(assetsRoot)
}

interface MigrationManifest {
  schemaVersion: number
  source: string
  files: Record<string, string>
}

function validateMigrationManifest(assetsRoot: string): void {
  const manifestPath = join(assetsRoot, 'migration-manifest.json')
  if (!existsSync(manifestPath)) throw new Error('大师能力包缺少 migration-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<MigrationManifest>
  if (manifest.schemaVersion !== 1 || typeof manifest.source !== 'string' || !isStringRecord(manifest.files)) {
    throw new Error('大师能力包 migration-manifest.json 格式无效')
  }
  const actualFiles = walkFiles(assetsRoot)
    .map(file => relative(assetsRoot, file).split(sep).join('/'))
    .filter(file => file !== 'migration-manifest.json')
    .sort()
  const expectedFiles = Object.keys(manifest.files).sort()
  if (actualFiles.join('\n') !== expectedFiles.join('\n')) {
    throw new Error('大师能力包文件清单与原客户端不一致')
  }
  for (const file of expectedFiles) {
    const digest = createHash('sha256').update(readFileSync(join(assetsRoot, ...file.split('/')))).digest('hex')
    if (digest !== manifest.files[file]) throw new Error(`大师能力包文件校验失败：${file}`)
  }
}

function walkFiles(root: string): string[] {
  const output: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`大师能力包不允许符号链接：${path}`)
    if (entry.isDirectory()) output.push(...walkFiles(path))
    else if (entry.isFile()) output.push(path)
  }
  return output
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry))
}
