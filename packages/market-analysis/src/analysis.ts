/**
 * 单日市场分析：四轴、主线分级、角色梯队、交易结论与三套次日剧本。
 *
 * 阈值、阶段判定、文案与源项目 src/market-review.js 的 analyzeMarketReview 一一对应。
 * 唯一新增的是契约要求的结构化字段（axes / coverage / scenarios kind 等）。
 */
import type {
  TradingDayAnalysisData,
  TradingDayAxis,
  TradingDayCoverage,
  TradingDayMainline,
  TradingDayMainlineGrade,
  TradingDayRole,
  TradingDayRoleKind,
  TradingDayScenario,
  TradingDayVerdict,
  TradingDayStatus,
} from '../../contracts/src/trading-day.ts'
import type {
  MarketAnalysisOptions,
  MarketSourceKey,
  PartialTradingDayRawInput,
  RawLeaderStrengthRow,
  RawPoolRow,
} from './types.ts'
import { displayDate, optionalNumber, pct, round } from './parsers.ts'
import {
  groupLimitMainlines,
  resolveSources,
  resolveStatus,
  resolveTradeDate,
  type LimitMainlineGroup,
} from './builders.ts'

const ANALYSIS_SOURCE_KEYS: MarketSourceKey[] = [
  'indices',
  'breadth',
  'limitUp',
  'broken',
  'limitDown',
  'yesterday',
  'limitReason',
]

type MarketPhase = '冰点' | '启动' | '主升' | '高潮' | '退潮' | '震荡' | '数据不足'

interface MoneyComponent {
  key: string
  score: number | null
  weight: number
}

interface MoneyEffect {
  score: number | null
  label: string
  components: MoneyComponent[]
}

interface Expectation {
  expectation: '高预期' | '低预期' | '分歧预期'
  reality: '强现实' | '弱现实' | '结构现实' | '待确认'
  key: string
  action: string
  needsConfirmation: true
}

interface AssessedMainline extends LimitMainlineGroup {
  score: number
  grade: TradingDayMainlineGrade
  stage: string
}

interface LeaderCandidate {
  code: string
  name: string
  board: number
  rs5: number | null
  rs20: number | null
  marketCap: number | null
}

const NOTE_SPACE = '空间龙需同时验证身位、板块助攻与情绪标杆'
const NOTE_CENTER = '中军候选已按市值与相对强度自动筛出，容量与承接仍需人工确认'
const NOTE_FOLLOW = '补涨龙与穿越龙需结合跨日周期，不能由单日涨停池直接确认'

const componentLabel = (key: string): string => ({
  breadth: '涨跌广度',
  limitUp: '涨停',
  limitDown: '跌停',
  promotion: '晋级率',
  sealQuality: '封板质量',
}[key] ?? key)

/** 与源项目 scoreMoneyEffect 完全一致。 */
function scoreMoneyEffect(input: {
  upCount: number | null
  downCount: number | null
  upLimit: number | null
  downLimit: number | null
  promotionRate: number | null
  breakRate: number | null
}): MoneyEffect {
  const parts: Array<{ key: string; score: number; weight: number }> = []
  const { upCount, downCount, upLimit, downLimit, promotionRate, breakRate } = input
  if (upCount !== null && downCount !== null && upCount + downCount > 0) {
    parts.push({ key: 'breadth', score: Math.min(100, Math.max(0, upCount / (upCount + downCount) * 100)), weight: 25 })
  }
  if (upLimit !== null) parts.push({ key: 'limitUp', score: Math.min(100, upLimit / 80 * 100), weight: 20 })
  if (downLimit !== null) parts.push({ key: 'limitDown', score: Math.max(0, 100 - downLimit / 20 * 100), weight: 15 })
  if (promotionRate !== null) parts.push({ key: 'promotion', score: Math.min(100, promotionRate / 45 * 100), weight: 20 })
  if (breakRate !== null) parts.push({ key: 'sealQuality', score: Math.max(0, 100 - breakRate / 50 * 100), weight: 20 })
  const weight = parts.reduce((sum, item) => sum + item.weight, 0)
  const score = weight ? round(parts.reduce((sum, item) => sum + item.score * item.weight, 0) / weight, 0) : null
  const label = score === null ? '数据不足' : score >= 75 ? '强赚钱效应' : score >= 60 ? '赚钱效应扩散' : score >= 45 ? '结构性机会' : score >= 30 ? '亏钱效应扩散' : '强亏钱效应'
  return {
    score,
    label,
    components: parts.map((item) => ({ key: item.key, score: round(item.score, 0), weight: item.weight })),
  }
}

/** 与源项目 assessMainlines 完全一致。 */
function assessMainlines(mainlines: LimitMainlineGroup[]): AssessedMainline[] {
  return mainlines.map((item) => {
    const score = Math.min(80, item.count * 6 + item.maxBoard * 8)
    const grade: TradingDayMainlineGrade = score >= 70 ? 'A' : score >= 50 ? 'B' : 'C'
    const stage = item.maxBoard >= 6
      ? '高位一致/鱼尾观察'
      : item.maxBoard >= 4 && item.count >= 5
        ? '主升梯队'
        : item.maxBoard >= 2 && item.count >= 3
          ? '启动发酵'
          : '首日异动/待验证'
    return { ...item, score, grade, stage }
  })
}

/** 与源项目 expectationMatrix 完全一致。 */
function expectationMatrix(marketPhase: MarketPhase, moneyScore: number | null, indexChange: number | null): Expectation {
  const expectation = marketPhase === '高潮'
    ? '高预期'
    : marketPhase === '冰点' || marketPhase === '退潮'
      ? '低预期'
      : '分歧预期'
  const reality = moneyScore === null
    ? '待确认'
    : moneyScore >= 60 && (indexChange === null || indexChange >= -0.3)
      ? '强现实'
      : moneyScore < 40 || (indexChange !== null && indexChange <= -1)
        ? '弱现实'
        : '结构现实'
  const key = `${expectation}+${reality}`
  const action = expectation === '低预期' && reality === '强现实' ? '关注预期差修复，只允许小仓确认后试错'
    : expectation === '高预期' && reality === '强现实' ? '持有核心、拒绝后排加速，随一致性增强逐步兑现'
      : expectation === '高预期' && reality === '弱现实' ? '预期落空，优先离场并停止追高'
        : expectation === '低预期' && reality === '弱现实' ? '继续等待，不把冰点机械等同于见底'
          : '现实呈结构分化，只在趋势右侧寻找情绪分歧点'
  return { expectation, reality, key, action, needsConfirmation: true }
}

const positionMap: Record<MarketPhase, string> = {
  冰点: '0–5%，仅允许极小仓试错，冰点不等于见底',
  启动: '5–10%，等待主线与次日溢价确认后再递进',
  主升: '20–40%，聚焦主线核心，单票不得超过总仓位 50%',
  高潮: '20–30%，主动兑现并禁止追逐中位补涨',
  退潮: '0%，清仓等待，停止所有模式外开仓',
  震荡: '10–20%，高低切换且不追日内轮动末端',
  数据不足: '0%，关键数据不足，不形成仓位判断',
}

const cyclePositionMap: Record<MarketPhase, string> = {
  冰点: '穷',
  启动: '变',
  主升: '通',
  高潮: '久',
  退潮: '穷',
  震荡: '待确认',
  数据不足: '待确认',
}

const codeOf = (row: RawPoolRow): string => String(row.c ?? '').trim()
const nameOf = (row: RawPoolRow): string => typeof row.n === 'string' ? row.n.trim() : ''

const positiveNumber = (value: unknown): number | null => {
  const parsed = optionalNumber(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

const boardOf = (row: RawPoolRow): number => positiveNumber(row.lbc) ?? positiveNumber(row.zttj?.ct) ?? 1

/** 相对强度最多覆盖 60 只：按连板高度、成交额依次降序截断。 */
function selectStrengthCandidates(rows: RawPoolRow[], limit = 60): RawPoolRow[] {
  return [...rows]
    .filter((row) => codeOf(row))
    .sort((left, right) => {
      const boardDiff = boardOf(right) - boardOf(left)
      if (boardDiff) return boardDiff
      return (optionalNumber(right.amount) ?? -Infinity) - (optionalNumber(left.amount) ?? -Infinity)
    })
    .slice(0, limit)
}

function toRole(leader: LeaderCandidate, role: TradingDayRoleKind, note: string): TradingDayRole {
  return {
    code: leader.code,
    name: leader.name,
    role,
    boardCount: leader.board,
    rs5: leader.rs5,
    rs20: leader.rs20,
    marketCap: leader.marketCap,
    note,
  }
}

/** 单日分析主入口。 */
export function analyzeTradingDay(
  input: PartialTradingDayRawInput,
  options: MarketAnalysisOptions = {},
): TradingDayAnalysisData {
  const sources = resolveSources(input, ANALYSIS_SOURCE_KEYS, options)
  const status: TradingDayStatus = resolveStatus(sources, options)
  const limitRows = input.limitUp?.rows ?? []
  const upLimit = input.limitUp?.total ?? null
  const brokenCount = input.broken?.total ?? null
  const downLimit = input.limitDown?.total ?? null
  const breakRate = upLimit !== null && brokenCount !== null && upLimit + brokenCount > 0
    ? pct(brokenCount, upLimit + brokenCount)
    : null
  const yesterdayRows = input.yesterday?.rows ?? []
  const todayLimitCodes = new Set(limitRows.map(codeOf).filter(Boolean))
  const yesterdayCodes = [...new Set(yesterdayRows.map(codeOf).filter(Boolean))]
  const promoted = yesterdayCodes.filter((code) => todayLimitCodes.has(code)).length
  const promotionRate = yesterdayCodes.length ? pct(promoted, yesterdayCodes.length) : null
  const maxBoard = limitRows.length ? Math.max(...limitRows.map(boardOf)) : null
  const lianbanCount = upLimit === null ? null : limitRows.filter((row) => boardOf(row) >= 2).length
  const firstBoardCount = upLimit === null ? null : limitRows.filter((row) => boardOf(row) === 1).length
  const indexChange = input.indices?.indexChange ?? null
  const upCount = input.breadth?.upCount ?? null
  const downCount = input.breadth?.downCount ?? null
  const breadthStrong = upCount !== null && downCount !== null && upCount > downCount * 1.35
  const breadthWeak = upCount !== null && downCount !== null && downCount > upCount * 1.35
  const moneyEffect = scoreMoneyEffect({ upCount, downCount, upLimit, downLimit, promotionRate, breakRate })

  let marketPhase: MarketPhase = upLimit === null && upCount === null ? '数据不足' : '震荡'
  if (marketPhase !== '数据不足') {
    if ((downLimit !== null && downLimit >= 20) || (breakRate !== null && breakRate >= 40) || (moneyEffect.score !== null && moneyEffect.score < 30) || (indexChange !== null && indexChange <= -1.5 && breadthWeak)) {
      marketPhase = '退潮'
    } else if (upLimit !== null && upLimit <= 20 && downLimit !== null && downLimit >= 10) {
      marketPhase = '冰点'
    } else if (upLimit !== null && upLimit >= 80 && maxBoard !== null && maxBoard >= 6 && breakRate !== null && breakRate <= 20) {
      marketPhase = '高潮'
    } else if (upLimit !== null && upLimit >= 50 && (breadthStrong || (moneyEffect.score !== null && moneyEffect.score >= 60)) && (promotionRate === null || promotionRate >= 25)) {
      marketPhase = '主升'
    } else if (upLimit !== null && upLimit >= 35 && indexChange !== null && indexChange >= 0) {
      marketPhase = '启动'
    }
  }

  const cyclePosition = cyclePositionMap[marketPhase]
  const cycleDirection = marketPhase === '启动' || marketPhase === '主升' || marketPhase === '高潮'
    ? '上升周期'
    : marketPhase === '退潮'
      ? '下降周期'
      : marketPhase === '冰点'
        ? '下降周期末端候选'
        : '待确认'
  const marketEnvironment = moneyEffect.score === null
    ? '待确认'
    : indexChange !== null && indexChange <= -1 && moneyEffect.score < 45
      ? '偏弱/熊市策略'
      : indexChange !== null && indexChange >= 0.8 && moneyEffect.score >= 60
        ? '偏强/牛市策略'
        : '震荡/结构市策略'
  const expectation = expectationMatrix(marketPhase, moneyEffect.score, indexChange)
  const turningSignal = marketPhase === '高潮' && indexChange !== null && indexChange >= 1
    ? '上涨衰竭候选'
    : marketPhase === '冰点' && indexChange !== null && indexChange <= -1
      ? '下跌衰竭候选'
      : Math.abs(indexChange || 0) < 0.3 && expectation.expectation === '高预期'
        ? '诱多风险候选'
        : Math.abs(indexChange || 0) < 0.3 && expectation.expectation === '低预期'
          ? '诱空修复候选'
          : '暂无明确拐点信号'

  const assessed = assessMainlines(groupLimitMainlines(limitRows))
  const mainlines: TradingDayMainline[] = assessed.map((item) => ({
    name: item.name,
    grade: item.grade,
    score: item.score,
    stage: item.stage,
    height: item.maxBoard,
    width: item.count,
    depth: null,
    evidence: [
      `${item.count} 家涨停`,
      `最高 ${item.maxBoard} 板`,
      `质量 ${item.grade} 级`,
      `阶段 ${item.stage}`,
      ...item.leaders.map((leader) => `${leader.name || leader.code}（${leader.board}板）`),
    ],
    missing: input.limitUp ? (input.limitReason ? [] : ['涨停原因']) : ['涨停池'],
  }))

  const strengthByCode: Record<string, RawLeaderStrengthRow> = input.leaderStrength?.byCode ?? {}
  const leaderCandidates: LeaderCandidate[] = assessed
    .flatMap((item) => item.leaders.map((leader) => {
      const strength = strengthByCode[leader.code]
      return {
        code: leader.code,
        name: leader.name,
        board: leader.board,
        rs5: strength?.rs5 ?? null,
        rs20: strength?.rs20 ?? null,
        marketCap: strength?.marketCap ?? null,
      }
    }))
    .sort((left, right) => right.board - left.board)
  const leadersTop = leaderCandidates.slice(0, 15)
  const capped = leaderCandidates
    .filter((item) => item.marketCap !== null)
    .sort((left, right) => (right.marketCap ?? -Infinity) - (left.marketCap ?? -Infinity))
  // 中军最多 3 只：优先 RS5 非负的大市值标的，不足时按市值补足。
  const centerPool = capped.filter((item) => item.rs5 === null || item.rs5 >= 0)
  const centers = (centerPool.length > 0 ? centerPool : capped).slice(0, 3)
  const center = centers[0] ?? null

  const leaders: TradingDayRole[] = leadersTop.map((leader, index) => (
    toRole(leader, 'leader', index === 0 ? NOTE_SPACE : NOTE_FOLLOW)
  ))
  const centerCandidates: TradingDayRole[] = centers.map((item) => toRole(item, 'center', NOTE_CENTER))

  // 角色梯队：空间龙 → 中军 → 其余主线龙头/补涨候选，按代码去重。
  const roles: TradingDayRole[] = []
  const seenRoles = new Set<string>()
  const spaceLeader = leaderCandidates[0]
  if (spaceLeader) {
    roles.push(toRole(spaceLeader, 'leader', NOTE_SPACE))
    if (spaceLeader.code) seenRoles.add(spaceLeader.code)
  }
  if (center && !seenRoles.has(center.code)) {
    roles.push(toRole(center, 'center', NOTE_CENTER))
    if (center.code) seenRoles.add(center.code)
  }
  for (const leader of leadersTop) {
    if (leader.code && seenRoles.has(leader.code)) continue
    roles.push(toRole(leader, 'follow', NOTE_FOLLOW))
    if (leader.code) seenRoles.add(leader.code)
  }

  const universeCodes = new Set(limitRows.map(codeOf).filter(Boolean))
  const strengthCandidates = selectStrengthCandidates(limitRows, 60)
  const analyzed = strengthCandidates.filter((row) => strengthByCode[codeOf(row)] !== undefined).length
  const coverage: TradingDayCoverage = {
    analyzed,
    total: universeCodes.size,
    skipped: Math.max(0, universeCodes.size - analyzed),
  }

  const missing: string[] = ([
    ['indices', input.indices],
    ['breadth', input.breadth],
    ['limitUp', input.limitUp],
    ['broken', input.broken],
    ['limitDown', input.limitDown],
    ['yesterday', input.yesterday],
    ['limitReason', input.limitReason],
  ] as Array<[string, unknown]>).filter(([, value]) => !value).map(([key]) => key)

  const sourceTime = String(input.indices?.rows?.[0]?.updatedAt || '').slice(8, 14)
  const provisional = /^\d{6}$/.test(sourceTime) ? sourceTime < '153000' : true
  const coverageRatio = (7 - missing.length) / 7
  const freshness = provisional ? 0.65 : 1
  const directionAgree = indexChange === null || moneyEffect.score === null
    ? 0.5
    : (indexChange >= 0 && moneyEffect.score >= 50) || (indexChange < 0 && moneyEffect.score < 50)
      ? 1
      : 0.55
  let confidence = round(coverageRatio * 0.5 + freshness * 0.2 + directionAgree * 0.3, 2) ?? 0
  if (!input.limitUp || !input.indices) confidence = Math.min(confidence, 0.49)

  const breadthText = upCount === null ? '涨跌家数暂不可用' : `上涨 ${upCount} 家、下跌 ${downCount} 家`
  const effectText = upLimit === null
    ? '涨跌停数据暂不可用'
    : `涨停 ${upLimit} 家（连板 ${lianbanCount ?? '—'} / 首板 ${firstBoardCount ?? '—'}）、跌停 ${downLimit ?? '—'} 家、最高 ${maxBoard ?? '—'} 板、晋级率 ${promotionRate ?? '—'}%、炸板率 ${breakRate ?? '—'}%`
  const mainlineText = mainlines.length
    ? mainlines.slice(0, 3).map((item) => `${item.name}（${item.width ?? '—'} 家涨停）`).join('、')
    : '主线暂不明确'
  const summary = `${displayDate(input.indices?.tradeDate)} 市场环境为“${marketEnvironment}”，情绪阶段“${marketPhase}”，对应穷变通久位置“${cyclePosition}”。${breadthText}；${effectText}，综合为“${moneyEffect.label}”。预期现实组合为“${expectation.key}”。主线集中在${mainlineText}。`

  const scenarios: TradingDayScenario[] = [
    {
      kind: 'above',
      title: '超预期',
      trigger: '核心竞价与开盘承接增强，主线有高度、宽度并出现回流',
      response: marketPhase === '退潮' ? '只记录转强，不立即重仓；等待新周期“通”确认' : '按仓位上限递进，只做核心分歧转一致',
    },
    {
      kind: 'match',
      title: '符合预期',
      trigger: '指数、赚钱效应和主线梯队维持当前结构',
      response: '执行原计划，不因盘中噪声扩大仓位',
    },
    {
      kind: 'below',
      title: '低于预期',
      trigger: '空间龙断板无承接、炸板率上升或主线次日无溢价',
      response: '触发防守锚，停止开仓并处理弱势持仓',
    },
  ]

  const gaps: string[] = []
  if (missing.length) gaps.push(`部分数据不可用：${missing.join('、')}，结论已降级`)
  if (provisional) gaps.push('当前为盘中或源时间未确认，报告属于临时结论')

  const axisMissing = (keys: MarketSourceKey[]): string[] => missing.filter((key) => keys.includes(key as MarketSourceKey))
  const axes: TradingDayAxis[] = [
    {
      key: 'marketEnvironment',
      label: '市场环境',
      value: marketEnvironment,
      detail: `指数涨跌幅 ${indexChange === null ? '—' : `${indexChange}%`}；${breadthText}`,
      evidence: [
        `赚钱效应：${moneyEffect.label}${moneyEffect.score === null ? '' : `（${moneyEffect.score}/100）`}`,
        ...moneyEffect.components.map((item) => `${componentLabel(item.key)} ${item.score ?? '—'}/${item.weight}`),
      ],
      missing: axisMissing(['indices', 'breadth']),
    },
    {
      key: 'cyclePosition',
      label: '周期位置',
      value: `${cycleDirection} · ${cyclePosition}`,
      detail: `情绪五阶段：${marketPhase}；拐点选择：${turningSignal}（仅作证据，需趋势确认）`,
      evidence: [
        `情绪五阶段：${marketPhase} → 周期位置 ${cyclePosition}`,
        `预期现实：${expectation.key}`,
      ],
      missing: axisMissing(['indices', 'breadth', 'limitUp', 'limitDown', 'broken', 'yesterday']),
    },
    {
      key: 'emotionStage',
      label: '情绪阶段',
      value: marketPhase,
      detail: effectText,
      evidence: moneyEffect.components.map((item) => `${componentLabel(item.key)} ${item.score ?? '—'}/${item.weight}`),
      missing: axisMissing(['limitUp', 'limitDown', 'broken', 'yesterday', 'breadth']),
    },
    {
      key: 'expectationReality',
      label: '预期 × 现实',
      value: expectation.key,
      detail: expectation.action,
      evidence: [`预期：${expectation.expectation}`, `现实：${expectation.reality}`],
      missing: axisMissing(['indices', 'breadth', 'limitUp', 'limitDown', 'broken', 'yesterday']),
    },
  ]

  const verdict: TradingDayVerdict = {
    stage: marketPhase,
    position: positionMap[marketPhase],
    temperature: `${moneyEffect.label}${moneyEffect.score === null ? '' : `（${moneyEffect.score}/100）`}`,
    confidence,
    summary,
    gaps,
  }

  return {
    tradeDate: resolveTradeDate(input, options),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    status,
    axes,
    mainlines,
    leaders,
    centerCandidates,
    roles,
    verdict,
    scenarios,
    coverage,
    missingReasons: missing,
    sources,
  }
}
