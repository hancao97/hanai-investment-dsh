import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Judgement, MasterPersona, ReportVersion, StockDetail } from '../../contracts/src/index.ts'
import type { HanaiPaths } from './paths.ts'
import { installMasterSnapshot } from '../../masters/src/index.ts'

export interface PreparedWorkspace {
  workspace: string
  workingReport: string
  skillPath: string
}

export interface ReportManifest {
  schemaVersion: 1
  judgementId: string
  reportVersion: number
  secId: string
  code: string
  stockName: string
  masterId: string
  masterVersion: string
  dshSessionId: string
  modelProvider: string | null
  model: string | null
  reasoningEffort: string | null
  sealedAt: string
  sizeBytes: number
  sha256: string
  source: 'workspace/REPORT.md'
}

export class ReportStore {
  constructor(
    private readonly paths: HanaiPaths,
    private readonly assetsRoot: string,
    private readonly minChars: number,
  ) {}

  prepareWorkspace(judgementId: string, master: MasterPersona): PreparedWorkspace {
    assertIdentifier(judgementId)
    const workspace = join(this.paths.judgementsDir, judgementId, 'workspace')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    chmodSync(workspace, 0o700)
    const installed = installMasterSnapshot(this.assetsRoot, master, workspace)
    return {
      workspace,
      workingReport: join(workspace, 'REPORT.md'),
      skillPath: installed.skillPath,
    }
  }

  writeResearchContext(workspace: string, detail: StockDetail): string {
    this.assertInDataRoot(workspace)
    const target = join(workspace, 'RESEARCH_CONTEXT.md')
    const content = researchContextMarkdown(detail)
    writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 })
    return target
  }

  validateWorkingReport(judgementId: string): { content: string; sizeBytes: number; sha256: string } {
    const path = this.workingReportPath(judgementId)
    if (!existsSync(path)) throw new ReportValidationError('report-missing', 'Agent 未生成 REPORT.md')
    const content = readFileSync(path, 'utf8').trim()
    const charCount = [...content].length
    if (charCount < this.minChars) {
      throw new ReportValidationError(
        'report-too-short',
        `REPORT.md 仅 ${charCount} 个字符，至少需要 ${this.minChars} 个字符`,
      )
    }
    if (!/^#\s+.+/m.test(content)) {
      throw new ReportValidationError('report-heading-missing', 'REPORT.md 缺少一级标题')
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    return { content, sizeBytes: bytes, sha256: sha256(content) }
  }

  seal(judgement: Judgement, version: number): ReportVersion & { relativePath: string } {
    if (judgement.dshSessionId === null) throw new Error('无法封存未绑定 DSH Session 的研判')
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('报告版本必须是正整数')
    const validated = this.validateWorkingReport(judgement.id)
    const sealedAt = new Date().toISOString()
    const versionName = String(version).padStart(4, '0')
    const targetDirectory = join(this.paths.judgementsDir, judgement.id, 'reports', versionName)
    const stagingDirectory = `${targetDirectory}.staging`
    if (existsSync(targetDirectory)) return this.readExistingSeal(judgement, version, targetDirectory)
    rmSync(stagingDirectory, { recursive: true, force: true })
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 })
    const reportPath = join(stagingDirectory, 'report.md')
    const manifestPath = join(stagingDirectory, 'manifest.json')
    writeFileSync(reportPath, validated.content, { encoding: 'utf8', mode: 0o600 })
    const manifest: ReportManifest = {
      schemaVersion: 1,
      judgementId: judgement.id,
      reportVersion: version,
      secId: judgement.secId,
      code: judgement.code,
      stockName: judgement.stockName,
      masterId: judgement.masterId,
      masterVersion: judgement.masterVersion,
      dshSessionId: judgement.dshSessionId,
      modelProvider: judgement.modelProvider,
      model: judgement.model,
      reasoningEffort: judgement.reasoningEffort,
      sealedAt,
      sizeBytes: validated.sizeBytes,
      sha256: validated.sha256,
      source: 'workspace/REPORT.md',
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(reportPath, 0o600)
    chmodSync(manifestPath, 0o600)
    renameSync(stagingDirectory, targetDirectory)
    chmodSync(targetDirectory, 0o700)
    const finalReport = join(targetDirectory, 'report.md')
    const relativePath = relative(this.paths.root, finalReport).split(sep).join('/')
    return {
      judgementId: judgement.id,
      version,
      content: validated.content,
      sha256: validated.sha256,
      sizeBytes: validated.sizeBytes,
      sealedAt,
      modelProvider: judgement.modelProvider,
      model: judgement.model,
      relativePath,
    }
  }

  read(relativePath: string): string {
    const absolute = resolve(this.paths.root, relativePath)
    this.assertInDataRoot(absolute)
    return readFileSync(absolute, 'utf8')
  }

  workingReportPath(judgementId: string): string {
    assertIdentifier(judgementId)
    return join(this.paths.judgementsDir, judgementId, 'workspace', 'REPORT.md')
  }

  hasWorkingReport(judgementId: string): boolean {
    return existsSync(this.workingReportPath(judgementId))
  }

  /** Recover an already-renamed version whose following SQLite transaction did not commit. */
  private readExistingSeal(
    judgement: Judgement,
    version: number,
    targetDirectory: string,
  ): ReportVersion & { relativePath: string } {
    const reportPath = join(targetDirectory, 'report.md')
    const manifestPath = join(targetDirectory, 'manifest.json')
    if (!existsSync(reportPath) || !existsSync(manifestPath)) throw new Error('既有报告版本不完整，拒绝覆盖')
    const content = readFileSync(reportPath, 'utf8')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<ReportManifest>
    const digest = sha256(content)
    if (
      manifest.schemaVersion !== 1
      || manifest.judgementId !== judgement.id
      || manifest.reportVersion !== version
      || manifest.dshSessionId !== judgement.dshSessionId
      || manifest.sha256 !== digest
      || manifest.sizeBytes !== Buffer.byteLength(content, 'utf8')
      || typeof manifest.sealedAt !== 'string'
    ) throw new Error('既有报告版本校验失败，拒绝覆盖')
    return {
      judgementId: judgement.id,
      version,
      content,
      sha256: digest,
      sizeBytes: manifest.sizeBytes,
      sealedAt: manifest.sealedAt,
      modelProvider: manifest.modelProvider ?? null,
      model: manifest.model ?? null,
      relativePath: relative(this.paths.root, reportPath).split(sep).join('/'),
    }
  }

  private assertInDataRoot(path: string): void {
    const root = resolve(this.paths.root)
    const target = resolve(path)
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('路径超出 Hanai 数据根目录')
  }
}

export class ReportValidationError extends Error {
  override readonly name = 'ReportValidationError'

  constructor(readonly code: string, message: string) {
    super(message)
  }
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('非法研判标识')
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function researchContextMarkdown(detail: StockDetail): string {
  const serialized = JSON.stringify(detail, null, 2)
  return `# Hanai Worth · 值见 研究数据快照\n\n`
    + `生成时间：${new Date().toISOString()}\n\n`
    + `以下数据由 Hanai Worth Host Provider 获取。必须检查每个对象的 meta、fetchedAt、sourceTimestamp 和 cacheState；`
    + `缺失值为 null，不得推断成 0。该快照不替代必要的公开资料核验。\n\n`
    + `\`\`\`json\n${serialized}\n\`\`\`\n`
}
