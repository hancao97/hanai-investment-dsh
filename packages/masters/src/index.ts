import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MasterPersona } from '../../contracts/src/index.ts'

export const MASTER_VERSION = '2026.08.15-v1'

const MASTER_DEFINITIONS: readonly Omit<MasterPersona, 'version'>[] = [
  {
    id: 'duan-yongping-perspective',
    name: '段永平',
    shortName: '段',
    description: '从商业模式、消费者价值、本分与长期竞争优势出发，区分事实、框架推断和信息缺口。',
    color: '#d7a84a',
    roleTag: '价值投资',
    tags: ['本分', '消费者导向', '长期价值'],
    defaultPrompt: '请从商业模式、护城河、管理层与估值纪律出发，对这家公司做一份独立研判。',
  },
  {
    id: 'munger-perspective',
    name: '查理·芒格',
    shortName: '芒',
    description: '使用多元思维模型、逆向思考与认知偏误清单，重点检验为何不该买以及永久损失风险。',
    color: '#6e98f6',
    roleTag: '价值投资',
    tags: ['多元思维', '逆向思考', '认知偏误'],
    defaultPrompt: '请用多元思维模型和逆向检查清单，判断这家公司是否值得长期研究。',
  },
  {
    id: 'warren-buffett-perspective',
    name: '沃伦·巴菲特',
    shortName: '巴',
    description: '围绕能力圈、护城河、资本配置、所有者收益和安全边际形成可核验的长期投资判断。',
    color: '#45b67b',
    roleTag: '价值投资',
    tags: ['护城河', '内在价值', '资本配置'],
    defaultPrompt: '请评估能力圈、护城河、管理层资本配置、所有者收益与安全边际。',
  },
  {
    id: 'hunjianglong-perspective',
    name: '混江龙',
    shortName: '混',
    description: '结合当下题材、情绪周期、资金结构与交易拥挤度，给出可执行条件和明确风险边界。',
    color: '#d56c55',
    roleTag: '市场交易',
    tags: ['题材周期', '市场情绪', '弱转强'],
    defaultPrompt: '请结合当前市场事实、题材与情绪周期，给出这只股票的交易研判和退出条件。',
  },
] as const

export function listMasters(): MasterPersona[] {
  return MASTER_DEFINITIONS.map(master => ({ ...master, tags: [...master.tags], version: MASTER_VERSION }))
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
  if (stat.isDirectory()) return !/(^|[/\\])(scripts|node_modules|\.git)$/.test(source)
  return /\.(md|ya?ml|txt|json)$/i.test(source)
}

function agentsDocument(master: MasterPersona): string {
  return `# Hanai Investment 研判工作区\n\n`
    + `本工作区绑定大师：${master.name}（${master.id}，版本 ${master.version}）。\n\n`
    + `## 必须遵守\n\n`
    + `1. 在每次回答前完整读取 \`.agents/skills/${master.id}/SKILL.md\`，并按其中路由读取必要参考资料。\n`
    + `2. 整段 Session 固定使用该大师的方法论与身份状态；不要切换成其他大师。\n`
    + `3. 事实、推断和未知项必须分开；不得编造实时行情、财务数据或来源。\n`
    + `4. 初次研判与显式修订必须把完整中文 Markdown 报告写入 \`REPORT.md\`。\n`
    + `5. 报告完成后的普通追问直接回答用户，不要改写 \`REPORT.md\`；只有用户明确要求创建修订版时才更新。\n`
    + `6. 内容仅供研究参考，不构成投资建议。\n`
}

/** Validate that every release master is present and readable. */
export function validateMasterAssets(assetsRoot: string): void {
  const installed = new Set(readdirSync(assetsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name))
  for (const master of MASTER_DEFINITIONS) {
    if (!installed.has(master.id)) throw new Error(`缺少大师资源目录：${master.id}`)
    const skill = readFileSync(join(assetsRoot, master.id, 'SKILL.md'), 'utf8')
    if (!skill.trim().startsWith('---')) throw new Error(`大师 SKILL.md 缺少 frontmatter：${master.id}`)
  }
}
