import type {
  Judgement,
  ResearchFollowUp,
  ResearchPrediction,
  ReportAudit,
  ReportAuditCheck,
  ReportAuditCheckState,
  ReportEvidenceConfidence,
  ReportEvidenceItem,
  ReportEvidenceKind,
  ReportSourceReference,
  WatchResearchCoverage,
} from '../../contracts/src/index.ts'

export const DEFAULT_RESEARCH_STALE_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000
const REPORT_IN_FLIGHT = new Set<Judgement['reportStatus']>([
  'preparing',
  'generating',
  'verifying',
  'repairing',
  'revising',
])

/** Build a small, ordered projection suitable for a watch-list coverage desk. */
export function buildWatchResearchCoverage(
  secIds: readonly string[],
  judgements: readonly Judgement[],
  now = new Date(),
  staleAfterDays = DEFAULT_RESEARCH_STALE_DAYS,
  followUps: readonly ResearchFollowUp[] = [],
  predictions: readonly ResearchPrediction[] = [],
): WatchResearchCoverage[] {
  if (!Number.isSafeInteger(staleAfterDays) || staleAfterDays < 1) {
    throw new Error('研究复核周期必须是正整数天数')
  }
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new Error('研究覆盖计算时间无效')

  const bySecurity = new Map<string, Judgement[]>()
  for (const judgement of judgements) {
    const entries = bySecurity.get(judgement.secId) ?? []
    entries.push(judgement)
    bySecurity.set(judgement.secId, entries)
  }
  const followUpsBySecurity = new Map<string, ResearchFollowUp[]>()
  for (const item of followUps) {
    const entries = followUpsBySecurity.get(item.secId) ?? []
    entries.push(item)
    followUpsBySecurity.set(item.secId, entries)
  }
  const predictionsBySecurity = new Map<string, ResearchPrediction[]>()
  for (const item of predictions) {
    const entries = predictionsBySecurity.get(item.secId) ?? []
    entries.push(item)
    predictionsBySecurity.set(item.secId, entries)
  }

  return secIds.map((secId) => {
    const entries = (bySecurity.get(secId) ?? []).sort(compareJudgementRecency)
    const active = entries.find(item => REPORT_IN_FLIGHT.has(item.reportStatus))
    const reports = entries
      .filter(item => item.latestReportVersion !== null && item.completedAt !== null)
      .sort(compareReportRecency)
    const latestReport = reports[0]
    const reportVersionCount = reports.reduce((total, item) => total + (item.latestReportVersion ?? 0), 0)
    const followUp = summarizeFollowUps(followUpsBySecurity.get(secId) ?? [], now)
    const prediction = summarizePredictions(predictionsBySecurity.get(secId) ?? [], now)

    if (active !== undefined) {
      return coverageFrom(active, {
        state: 'active',
        latestReportAt: latestReport?.completedAt ?? null,
        latestReportVersion: latestReport?.latestReportVersion ?? null,
        ageDays: ageInDays(latestReport?.completedAt ?? null, nowMs),
        reportVersionCount,
        ...followUp,
        ...prediction,
      })
    }
    if (latestReport !== undefined) {
      const ageDays = ageInDays(latestReport.completedAt, nowMs) ?? 0
      return coverageFrom(latestReport, {
        state: ageDays > staleAfterDays ? 'stale' : 'current',
        latestReportAt: latestReport.completedAt,
        latestReportVersion: latestReport.latestReportVersion,
        ageDays,
        reportVersionCount,
        ...followUp,
        ...prediction,
      })
    }
    const failed = entries.find(item => item.reportStatus === 'failed')
    if (failed !== undefined) {
      return coverageFrom(failed, {
        state: 'failed',
        latestReportAt: null,
        latestReportVersion: null,
        ageDays: null,
        reportVersionCount: 0,
        ...followUp,
        ...prediction,
      })
    }
    return {
      secId,
      state: 'uncovered',
      judgementId: null,
      masterId: null,
      masterName: null,
      latestReportAt: null,
      latestReportVersion: null,
      ageDays: null,
      reportVersionCount: 0,
      ...followUp,
      ...prediction,
    }
  })
}

/**
 * Audit only mechanically observable report structure. The result deliberately
 * does not claim that sources are authoritative or that the conclusion is right.
 */
export function analyzeReport(content: string): ReportAudit {
  const normalized = content.replace(/\r\n?/g, '\n')
  const headings = normalized.match(/^#{1,6}\s+.+$/gm) ?? []
  const tableSeparators = normalized.match(/^\s*\|?(?:\s*:?-{3,}:?\s*\|){2,}.+$/gm) ?? []
  const sources = extractReportSources(normalized)
  const evidence = extractReportEvidence(normalized)

  const checks: ReportAuditCheck[] = [
    check(
      'conclusion',
      '结论先行',
      10,
      headingState(headings, /(执行摘要|核心结论|投资结论|最终研判|研判结论|结论)/i),
      '应有明确的执行摘要或最终研判，方便快速复核。',
    ),
    check(
      'information-date',
      '信息时点',
      15,
      informationDateState(normalized, headings),
      '应标明研究截止日期或数据时点，避免把旧信息当成当前事实。',
    ),
    check(
      'sources',
      '来源可追溯',
      20,
      sources.length >= 3 ? 'met' : sources.length > 0 ? 'partial' : 'missing',
      sources.length === 0 ? '未识别到公开来源链接。' : `识别到 ${sources.length} 个唯一来源链接。`,
    ),
    check(
      'evidence-ledger',
      '证据账本',
      15,
      evidenceLedgerState(normalized, headings, evidence),
      '建议把关键主张、事实/推断、来源、日期和置信度放在同一张表中。',
    ),
    check(
      'counter-evidence',
      '反方证据与风险',
      15,
      keywordSectionState(normalized, headings, /(反方证据|反证|证伪|核心风险|主要风险|失败路径|风险)/i),
      '应给出反方证据、失败路径或核心风险，而不只陈述支持性材料。',
    ),
    check(
      'scenarios',
      '情景与失效条件',
      15,
      scenarioState(normalized, headings),
      '应覆盖乐观、基准、悲观情景，或给出清晰的验证与失效条件。',
    ),
    check(
      'monitoring',
      '持续跟踪清单',
      10,
      monitoringState(normalized, headings),
      '应列出下一步要验证的事实、指标或事件，便于持续研究。',
    ),
  ]

  const score = checks.reduce((total, item) => {
    const ratio = item.state === 'met' ? 1 : item.state === 'partial' ? 0.5 : 0
    return total + item.weight * ratio
  }, 0)

  return {
    score: Math.round(score),
    rating: score >= 80 ? 'strong' : score >= 60 ? 'review' : 'thin',
    checks,
    sources,
    evidence,
    stats: {
      characters: [...normalized.trim()].length,
      headings: headings.length,
      tables: tableSeparators.length,
      links: sources.length,
    },
  }
}

/**
 * Return mechanically verifiable reasons that should stop a newly generated
 * report from being sealed. Existing sealed reports remain readable even when
 * they predate this gate.
 */
export function reportAuditBlockingReasons(audit: ReportAudit): string[] {
  const required: ReportAuditCheck['id'][] = [
    'conclusion',
    'information-date',
    'sources',
    'evidence-ledger',
    'counter-evidence',
    'scenarios',
    'monitoring',
  ]
  const reasons = required.flatMap((id) => {
    const item = audit.checks.find(check => check.id === id)
    return item === undefined || item.state === 'missing' ? [item?.label ?? id] : []
  })
  const traceableEvidence = audit.evidence.filter(isTraceableEvidence)
  if (traceableEvidence.length === 0) reasons.push('证据账本至少需要一条边界、来源链接、日期和置信度完整的主张')
  if (audit.score < 65) reasons.push(`综合结构分 ${audit.score}/100（至少 65）`)
  return reasons
}

function coverageFrom(
  judgement: Judgement,
  values: Pick<WatchResearchCoverage,
    | 'state'
    | 'latestReportAt'
    | 'latestReportVersion'
    | 'ageDays'
    | 'reportVersionCount'
    | 'openFollowUpCount'
    | 'overdueFollowUpCount'
    | 'nextFollowUpDueDate'
    | 'pendingPredictionCount'
    | 'duePredictionCount'
    | 'nextPredictionDueDate'
  >,
): WatchResearchCoverage {
  return {
    secId: judgement.secId,
    judgementId: judgement.id,
    masterId: judgement.masterId,
    masterName: judgement.masterName,
    ...values,
  }
}

function summarizePredictions(items: readonly ResearchPrediction[], now: Date) {
  const pending = items.filter(item => item.outcome === 'pending')
  const today = localDateKey(now)
  const dueDates = pending.map(item => item.dueDate).sort()
  return {
    pendingPredictionCount: pending.length,
    duePredictionCount: dueDates.filter(date => date <= today).length,
    nextPredictionDueDate: dueDates[0] ?? null,
  }
}

function summarizeFollowUps(items: readonly ResearchFollowUp[], now: Date) {
  const open = items.filter(item => item.status === 'open')
  const today = localDateKey(now)
  const dueDates = open.flatMap(item => item.dueDate === null ? [] : [item.dueDate]).sort()
  return {
    openFollowUpCount: open.length,
    overdueFollowUpCount: dueDates.filter(date => date < today).length,
    nextFollowUpDueDate: dueDates[0] ?? null,
  }
}

function localDateKey(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function compareJudgementRecency(left: Judgement, right: Judgement): number {
  return timestamp(right.updatedAt) - timestamp(left.updatedAt)
}

function compareReportRecency(left: Judgement, right: Judgement): number {
  return timestamp(right.completedAt ?? right.updatedAt) - timestamp(left.completedAt ?? left.updatedAt)
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function ageInDays(value: string | null, nowMs: number): number | null {
  if (value === null) return null
  const reportMs = Date.parse(value)
  if (!Number.isFinite(reportMs)) return null
  return Math.max(0, Math.floor((nowMs - reportMs) / DAY_MS))
}

function check(
  id: ReportAuditCheck['id'],
  label: string,
  weight: number,
  state: ReportAuditCheckState,
  detail: string,
): ReportAuditCheck {
  return { id, label, state, detail, weight }
}

function headingState(headings: readonly string[], pattern: RegExp): ReportAuditCheckState {
  return headings.some(heading => pattern.test(heading)) ? 'met' : 'missing'
}

function keywordSectionState(
  content: string,
  headings: readonly string[],
  pattern: RegExp,
): ReportAuditCheckState {
  if (headings.some(heading => pattern.test(heading))) return 'met'
  return pattern.test(content) ? 'partial' : 'missing'
}

function informationDateState(content: string, headings: readonly string[]): ReportAuditCheckState {
  const hasLabel = /(信息时点|研究时点|数据时点|截止日期|研究截止|截至)/i.test(content)
  const hasDate = /(?:20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|20\d{2}年\d{1,2}月)/.test(content)
  const hasSection = headings.some(heading => /(信息时点|数据与来源|研究范围|来源)/i.test(heading))
  if (hasLabel && hasDate && hasSection) return 'met'
  if (hasDate || hasLabel) return 'partial'
  return 'missing'
}

function evidenceLedgerState(
  content: string,
  headings: readonly string[],
  evidence: readonly ReportEvidenceItem[],
): ReportAuditCheckState {
  const hasHeading = headings.some(heading => /(证据账本|证据表|关键证据|事实清单)/i.test(heading))
  const hasClaim = /(关键主张|核心主张|主张)/i.test(content)
  const hasBoundary = /(事实|推断|假设|信息缺口|待验证)/i.test(content)
  const hasSource = /(来源|链接|出处)/i.test(content)
  const hasTable = /^\s*\|.+\|\s*$/m.test(content)
  const completeRows = evidence.filter(isTraceableEvidence)
  if (hasHeading && hasClaim && hasBoundary && hasSource && hasTable && completeRows.length === evidence.length && evidence.length > 0) return 'met'
  if ((hasHeading || hasClaim) && hasBoundary && hasSource) return 'partial'
  return 'missing'
}

function scenarioState(content: string, headings: readonly string[]): ReportAuditCheckState {
  const namedScenarios = [/(乐观|上行情景)/i, /(基准|中性情景)/i, /(悲观|下行情景)/i]
    .filter(pattern => pattern.test(content)).length
  const abcScenarios = [/(情景\s*A|情景一)/i, /(情景\s*B|情景二)/i, /(情景\s*C|情景三)/i]
    .filter(pattern => pattern.test(content)).length
  const hasSection = headings.some(heading => /(情景|失效条件|条件推演)/i.test(heading))
  if (hasSection && Math.max(namedScenarios, abcScenarios) >= 3) return 'met'
  if (hasSection || namedScenarios > 0 || abcScenarios > 0 || /(失效条件|验证条件)/i.test(content)) return 'partial'
  return 'missing'
}

function monitoringState(content: string, headings: readonly string[]): ReportAuditCheckState {
  const hasSection = headings.some(heading => /(待持续验证|持续跟踪|跟踪清单|观察清单|监测清单|下一步)/i.test(heading))
  const hasItems = /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?.{4,}/m.test(content)
  if (hasSection && hasItems) return 'met'
  if (hasSection || /(待验证|持续跟踪|下一步关注|观察点)/i.test(content)) return 'partial'
  return 'missing'
}

function extractReportSources(content: string): ReportSourceReference[] {
  const labels = new Map<string, string>()
  const markdownLinks = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/gi
  for (const match of content.matchAll(markdownLinks)) {
    const url = cleanUrl(match[2] ?? '')
    if (url !== '') labels.set(url, (match[1] ?? '').trim())
  }
  const urls = new Set<string>()
  for (const match of content.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const url = cleanUrl(match[0])
    if (url !== '') urls.add(url)
  }
  for (const url of labels.keys()) urls.add(url)

  return [...urls].flatMap((url) => {
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) return []
      return [{ url, domain: parsed.hostname.replace(/^www\./, ''), label: labels.get(url) ?? null }]
    } catch {
      return []
    }
  })
}

function extractReportEvidence(content: string): ReportEvidenceItem[] {
  const lines = content.split('\n')
  const sectionStart = lines.findIndex(line => /^#{1,6}\s+.*(证据账本|证据表|关键证据|事实清单)/i.test(line))
  if (sectionStart < 0) return []
  const sectionLevel = /^#+/.exec(lines[sectionStart] ?? '')?.[0].length ?? 6
  const section: string[] = []
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const heading = /^(#{1,6})\s+/.exec(line)
    if (heading !== null && heading[1]!.length <= sectionLevel) break
    section.push(line)
  }

  const headerIndex = section.findIndex(line => line.includes('|') && !isTableSeparator(line))
  if (headerIndex < 0 || !isTableSeparator(section[headerIndex + 1] ?? '')) return []
  const headers = splitMarkdownTableRow(section[headerIndex] ?? '').map(normalizeHeader)
  const claimIndex = headers.findIndex(value => /(关键)?主张|核心判断|结论|观点/.test(value))
  if (claimIndex < 0) return []
  const kindIndex = headers.findIndex(value => /类型|边界|属性/.test(value))
  const sourceIndex = headers.findIndex(value => /来源|出处|证据/.test(value))
  const dateIndex = headers.findIndex(value => /日期|时点|时间/.test(value))
  const confidenceIndex = headers.findIndex(value => /置信|可信|把握/.test(value))

  const entries: ReportEvidenceItem[] = []
  for (let index = headerIndex + 2; index < section.length; index += 1) {
    const line = section[index] ?? ''
    if (!line.includes('|') || isTableSeparator(line)) {
      if (entries.length > 0 && line.trim() !== '') break
      continue
    }
    const cells = splitMarkdownTableRow(line)
    const claim = stripMarkdown(cells[claimIndex] ?? '').slice(0, 500)
    if (claim === '') continue
    const sourceCell = sourceIndex < 0 ? '' : cells[sourceIndex] ?? ''
    const source = parseEvidenceSource(sourceCell)
    entries.push({
      claim,
      kind: parseEvidenceKind(kindIndex < 0 ? '' : cells[kindIndex] ?? ''),
      sourceLabel: source.label,
      sourceUrl: source.url,
      sourceDate: nullableText(dateIndex < 0 ? '' : cells[dateIndex] ?? ''),
      confidence: parseEvidenceConfidence(confidenceIndex < 0 ? '' : cells[confidenceIndex] ?? ''),
    })
    if (entries.length >= 50) break
  }
  return entries
}

function splitMarkdownTableRow(line: string): string[] {
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const character of value) {
    if (character === '|' && !escaped) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += character
    escaped = character === '\\' && !escaped
    if (character !== '\\') escaped = false
  }
  cells.push(current.trim())
  return cells
}

function isTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line)
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))
}

function normalizeHeader(value: string): string {
  return stripMarkdown(value).replace(/\s+/g, '').toLowerCase()
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#]/g, '')
    .replace(/\\\|/g, '|')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseEvidenceSource(value: string): { label: string | null; url: string | null } {
  const link = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/i.exec(value)
  const bare = link === null ? /https?:\/\/[^\s<>"'`]+/i.exec(value) : null
  const url = cleanUrl(link?.[2] ?? bare?.[0] ?? '') || null
  const label = nullableText(stripMarkdown(value).replace(bare?.[0] ?? '', '').trim())
  return { label, url }
}

function parseEvidenceKind(value: string): ReportEvidenceKind {
  if (/事实/.test(value)) return 'fact'
  if (/推断|判断|观点/.test(value)) return 'inference'
  if (/假设|情景/.test(value)) return 'assumption'
  return 'unknown'
}

function parseEvidenceConfidence(value: string): ReportEvidenceConfidence {
  if (/高|high/i.test(value)) return 'high'
  if (/中|medium|mid/i.test(value)) return 'medium'
  if (/低|low/i.test(value)) return 'low'
  return 'unknown'
}

function isTraceableEvidence(item: ReportEvidenceItem): boolean {
  return item.kind !== 'unknown'
    && item.sourceUrl !== null
    && isConcreteDate(item.sourceDate)
    && item.confidence !== 'unknown'
}

function isConcreteDate(value: string | null): boolean {
  if (value === null) return false
  const match = /^(20\d{2})(?:[-/.](\d{1,2})[-/.](\d{1,2})|年(\d{1,2})月(\d{1,2})日?)$/.exec(value.trim())
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2] ?? match[4])
  const day = Number(match[3] ?? match[5])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function nullableText(value: string): string | null {
  const text = stripMarkdown(value)
  return text === '' || /^(?:—|-|无|未知|待核验)$/.test(text) ? null : text.slice(0, 200)
}

function cleanUrl(value: string): string {
  return (value.trim().split(/[（【]/u)[0] ?? '').replace(/[)\],.;:!?，。；：！？）】》]+$/u, '')
}
