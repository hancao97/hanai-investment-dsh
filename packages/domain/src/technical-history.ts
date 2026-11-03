import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { historicalLimitPoolSchema, type HistoricalLimitPool, type TechnicalBar } from '../../contracts/src/technical-screen.ts'
import { isMarketDate } from '../../contracts/src/market-history.ts'
import type { StockDataStatus } from '../../contracts/src/stock-data.ts'

const price = z.number().finite().positive()
const barsSchema = z.array(z.object({
  date: z.string().refine(isMarketDate), open: price, high: price, low: price, close: price,
  volume: z.number().finite().nonnegative(),
  amount: z.number().finite().nonnegative().nullable().optional(),
  prevClose: price.nullable().optional(), turnoverRate: z.number().finite().nullable().optional(),
  tradeStatus: z.union([z.literal(0), z.literal(1)]).optional(), isST: z.boolean().optional(),
  peTtm: z.number().finite().nullable().optional(), pb: z.number().finite().nullable().optional(),
}).strict()).min(1).max(400)
type Adjustment = 'qfq' | 'none'

/** Raw prices accumulate; adjusted prices are one complete, dated basis per security. */
export class TechnicalHistoryStore {
  constructor(private readonly sqlite: DatabaseSync) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS stock_daily_raw (
        code TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL,
        source TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(code, date)
      );
      CREATE TABLE IF NOT EXISTS stock_daily_basis (
        code TEXT NOT NULL, adjustment TEXT NOT NULL, as_of TEXT NOT NULL,
        first_date TEXT NOT NULL, payload TEXT NOT NULL, source TEXT NOT NULL,
        fetched_at TEXT NOT NULL, PRIMARY KEY(code, adjustment)
      );
      CREATE TABLE IF NOT EXISTS stock_daily_limit_pool (
        date TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL
      );
    `)
  }

  limitPool(date: string): HistoricalLimitPool | null {
    if (!isMarketDate(date)) throw new Error('历史涨停池日期无效')
    const row = this.sqlite.prepare('SELECT payload FROM stock_daily_limit_pool WHERE date = ?').get(date) as { payload: string } | undefined
    if (!row) return null
    const data = historicalLimitPoolSchema.parse(JSON.parse(row.payload))
    if (data.date !== date) throw new Error('历史涨停池存储日期不一致')
    return data
  }
  writeLimitPool(input: HistoricalLimitPool): void {
    const data = historicalLimitPoolSchema.parse(input)
    if (!isMarketDate(data.date)) throw new Error('历史涨停池日期无效')
    this.sqlite.prepare(`INSERT INTO stock_daily_limit_pool(date, payload, fetched_at) VALUES(?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at WHERE excluded.fetched_at >= stock_daily_limit_pool.fetched_at`)
      .run(data.date, JSON.stringify(data), data.fetchedAt)
  }

  sources(): NonNullable<StockDataStatus['sources']> {
    return this.sqlite.prepare(`SELECT source, adjustment, COUNT(*) AS count, MIN(as_of) AS oldestDate,
      MAX(as_of) AS newestDate, MAX(fetched_at) AS fetchedAt FROM stock_daily_basis GROUP BY source, adjustment ORDER BY source, adjustment`)
      .all() as unknown as NonNullable<StockDataStatus['sources']>
  }

  latestDate(code: string, adjustment: Adjustment): string | null {
    if (!/^\d{6}$/.test(code)) throw new Error('日线存储标识无效')
    const row = this.sqlite.prepare('SELECT as_of FROM stock_daily_basis WHERE code = ? AND adjustment = ?').get(code, adjustment) as { as_of: string } | undefined
    return row?.as_of ?? null
  }

  readyCodes(asOf: string): Set<string> {
    if (!isMarketDate(asOf)) throw new Error('日线基准日无效')
    // The writer validates each window; check its persisted coverage without decoding millions of bars.
    return new Set((this.sqlite.prepare(`SELECT r.code FROM stock_daily_basis r
      JOIN stock_daily_basis q ON q.code=r.code AND q.adjustment='qfq' AND q.as_of=?
      WHERE r.adjustment='none' AND r.as_of>=?
        AND CASE WHEN json_valid(q.payload) THEN json_extract(q.payload, '$[#-1].date') END = ?
        AND EXISTS(SELECT 1 FROM stock_daily_raw d WHERE d.code=r.code AND d.date=?)`)
      .all(asOf, asOf, asOf, asOf) as Array<{ code: string }>).map(row => row.code))
  }

  read(code: string, adjustment: Adjustment, asOf: string): TechnicalBar[] | null {
    this.identity(code, asOf)
    const row = this.sqlite.prepare('SELECT as_of, payload FROM stock_daily_basis WHERE code = ? AND adjustment = ?')
      .get(code, adjustment) as { as_of: string; payload: string } | undefined
    if (!row || (adjustment === 'qfq' ? row.as_of !== asOf : row.as_of < asOf)) return null
    const payload = adjustment === 'qfq' ? JSON.parse(row.payload) as unknown
      : (this.sqlite.prepare('SELECT payload FROM stock_daily_raw WHERE code = ? AND date <= ? ORDER BY date DESC LIMIT 400')
        .all(code, asOf) as Array<{ payload: string }>).reverse().map(item => JSON.parse(item.payload) as unknown)
    if (Array.isArray(payload) && !payload.length) return null
    const bars = this.validate(payload, asOf)
    // A later raw window does not prove that this older cutoff has any data.
    return bars.at(-1)?.date === asOf ? bars : null
  }

  write(code: string, adjustment: Adjustment, asOf: string, input: TechnicalBar[], source: string, fetchedAt: string): void {
    this.identity(code, asOf)
    if (!source.trim() || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('日线来源或获取时间无效')
    const bars = this.validate(input, asOf)
    if (bars.at(-1)?.date !== asOf) throw new Error(`日线滞后：期望 ${asOf}，实际 ${bars.at(-1)?.date ?? '无数据'}；不能标记已补齐`)
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      if (adjustment === 'none') {
        const insert = this.sqlite.prepare(`INSERT INTO stock_daily_raw(code, date, payload, source, fetched_at) VALUES(?, ?, ?, ?, ?)
          ON CONFLICT(code, date) DO UPDATE SET payload=excluded.payload, source=excluded.source, fetched_at=excluded.fetched_at
          WHERE excluded.fetched_at >= stock_daily_raw.fetched_at
            AND (stock_daily_raw.source <> 'baostock' OR excluded.source = 'baostock')`)
        for (const bar of bars) insert.run(code, bar.date, JSON.stringify(bar), source, fetchedAt)
      }
      // Never splice two qfq bases or replace a newer basis with an older query.
      this.sqlite.prepare(`INSERT INTO stock_daily_basis(code, adjustment, as_of, first_date, payload, source, fetched_at) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code, adjustment) DO UPDATE SET as_of=excluded.as_of,
          first_date=CASE WHEN excluded.adjustment='none' THEN MIN(stock_daily_basis.first_date, excluded.first_date) ELSE excluded.first_date END,
          payload=excluded.payload, source=excluded.source, fetched_at=excluded.fetched_at
        WHERE excluded.as_of > stock_daily_basis.as_of OR (excluded.as_of = stock_daily_basis.as_of AND excluded.fetched_at >= stock_daily_basis.fetched_at)`)
        .run(code, adjustment, asOf, bars[0]!.date, adjustment === 'qfq' ? JSON.stringify(bars) : '[]', source, fetchedAt)
      this.sqlite.exec('COMMIT')
    } catch (cause) { this.sqlite.exec('ROLLBACK'); throw cause }
  }

  private identity(code: string, asOf: string): void {
    if (!/^\d{6}$/.test(code) || !isMarketDate(asOf)) throw new Error('日线存储标识无效')
  }
  private validate(input: unknown, asOf: string): TechnicalBar[] {
    const bars = barsSchema.parse(input)
    if (bars.some((bar, i) => bar.date > asOf || (i > 0 && bar.date <= bars[i - 1]!.date)
      || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high)) throw new Error('日线日期、顺序或价格无效')
    return bars
  }
}
