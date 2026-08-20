import { chmodSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  Judgement, ReportStatus, ReportVersion, ResearchFollowUp, ResearchFollowUpStatus,
  ResearchPrediction, ResearchPredictionOutcome, SecurityMaster, ThemeId, TurnStatus, WatchGroup,
} from '../../contracts/src/index.ts'

interface WatchGroupRow {
  id: string
  name: string
  sort_order: number
  is_default: number
}

interface WatchItemRow {
  group_id: string
  sec_id: string
  sort_order: number
  added_at: string
  base_price: number | null
}

interface JudgementRow {
  id: string
  sec_id: string
  code: string
  stock_name: string
  master_id: string
  master_name: string
  master_version: string
  dsh_session_id: string | null
  report_status: ReportStatus
  turn_status: TurnStatus
  latest_report_version: number | null
  model_provider: string | null
  model: string | null
  reasoning_effort: string | null
  repair_attempts: number
  created_at: string
  updated_at: string
  completed_at: string | null
  error_code: string | null
  error_message: string | null
}

interface ResearchFollowUpRow {
  id: string
  sec_id: string
  judgement_id: string | null
  report_version: number | null
  title: string
  due_date: string | null
  status: ResearchFollowUpStatus
  created_at: string
  completed_at: string | null
}

interface ResearchPredictionRow {
  id: string
  sec_id: string
  judgement_id: string | null
  report_version: number | null
  statement: string
  resolution_criteria: string
  probability_pct: number
  due_date: string
  outcome: ResearchPredictionOutcome
  brier_score: number | null
  created_at: string
  resolved_at: string | null
}

export interface ReportRow {
  judgement_id: string
  version: number
  relative_path: string
  sha256: string
  size_bytes: number
  sealed_at: string
  model_provider: string | null
  model: string | null
}

export interface CreateJudgementRecord {
  id: string
  secId: string
  code: string
  stockName: string
  masterId: string
  masterName: string
  masterVersion: string
  modelProvider?: string
  model?: string
  reasoningEffort?: string
}

export interface JudgementUpdate {
  dshSessionId?: string | null
  reportStatus?: ReportStatus
  turnStatus?: TurnStatus
  latestReportVersion?: number | null
  completedAt?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  repairAttempts?: number
}

export interface CreateResearchFollowUpRecord {
  secId: string
  judgementId?: string
  reportVersion?: number
  title: string
  dueDate?: string
}

export interface ResearchFollowUpUpdate {
  completed?: boolean
  title?: string
  dueDate?: string | null
}

export interface CreateResearchPredictionRecord {
  secId: string
  judgementId?: string
  reportVersion?: number
  statement: string
  resolutionCriteria: string
  probabilityPct: number
  dueDate: string
}

export interface SecuritySnapshotRow extends SecurityMaster {
  updatedAt: string
}

/** SQLite business store. Session messages and credentials deliberately have no tables here. */
export class HanaiDatabase {
  readonly sqlite: DatabaseSync

  constructor(readonly path: string) {
    this.sqlite = new DatabaseSync(path)
    if (existsSync(path)) chmodSync(path, 0o600)
    this.sqlite.exec('PRAGMA journal_mode = WAL')
    this.sqlite.exec('PRAGMA foreign_keys = ON')
    this.sqlite.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
    chmodSync(path, 0o600)
  }

  close(): void {
    this.sqlite.close()
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_master (
        sec_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        exchange TEXT NOT NULL CHECK (exchange IN ('SH', 'SZ', 'BJ')),
        pinyin_full TEXT NOT NULL,
        pinyin_initial TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_security_code ON security_master(code);
      CREATE INDEX IF NOT EXISTS idx_security_name ON security_master(name);
      CREATE TABLE IF NOT EXISTS watch_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        sort_order INTEGER NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_one_default ON watch_groups(is_default) WHERE is_default = 1;
      CREATE TABLE IF NOT EXISTS watch_items (
        group_id TEXT NOT NULL REFERENCES watch_groups(id) ON DELETE CASCADE,
        sec_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        added_at TEXT NOT NULL,
        base_price REAL,
        PRIMARY KEY(group_id, sec_id)
      );
      CREATE TABLE IF NOT EXISTS judgements (
        id TEXT PRIMARY KEY,
        sec_id TEXT NOT NULL,
        code TEXT NOT NULL,
        stock_name TEXT NOT NULL,
        master_id TEXT NOT NULL,
        master_name TEXT NOT NULL,
        master_version TEXT NOT NULL,
        dsh_session_id TEXT UNIQUE,
        report_status TEXT NOT NULL,
        turn_status TEXT NOT NULL,
        latest_report_version INTEGER,
        model_provider TEXT,
        model TEXT,
        reasoning_effort TEXT,
        repair_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error_code TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_judgements_updated ON judgements(updated_at DESC);
      CREATE TABLE IF NOT EXISTS report_versions (
        judgement_id TEXT NOT NULL REFERENCES judgements(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sealed_at TEXT NOT NULL,
        model_provider TEXT,
        model TEXT,
        PRIMARY KEY(judgement_id, version)
      );
      CREATE TABLE IF NOT EXISTS research_follow_ups (
        id TEXT PRIMARY KEY,
        sec_id TEXT NOT NULL,
        judgement_id TEXT REFERENCES judgements(id) ON DELETE SET NULL,
        report_version INTEGER,
        title TEXT NOT NULL,
        due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_research_follow_ups_security
        ON research_follow_ups(sec_id, status, due_date, created_at DESC);
      CREATE TABLE IF NOT EXISTS research_predictions (
        id TEXT PRIMARY KEY,
        sec_id TEXT NOT NULL,
        judgement_id TEXT REFERENCES judgements(id) ON DELETE SET NULL,
        report_version INTEGER,
        statement TEXT NOT NULL,
        resolution_criteria TEXT NOT NULL,
        probability_pct INTEGER NOT NULL CHECK (probability_pct BETWEEN 1 AND 99),
        due_date TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'pending'
          CHECK (outcome IN ('pending', 'occurred', 'not-occurred', 'invalid')),
        brier_score REAL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_research_predictions_security
        ON research_predictions(sec_id, outcome, due_date, created_at DESC);
    `)
    const version = this.sqlite.prepare('SELECT MAX(version) AS value FROM schema_migrations').get() as
      | { value: number | null }
      | undefined
    if ((version?.value ?? 0) < 1) {
      this.sqlite.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)')
        .run(new Date().toISOString())
    }
    if ((version?.value ?? 0) < 2) {
      this.sqlite.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)')
        .run(new Date().toISOString())
    }
    if ((version?.value ?? 0) < 3) {
      this.sqlite.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)')
        .run(new Date().toISOString())
    }
    this.ensureDefaultWatchGroup()
  }

  getTheme(): ThemeId {
    const row = this.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'theme'").get() as
      | { value: string }
      | undefined
    // `ocean` and `jade` were shipped briefly before the UI was restored to
    // conventional light/dark appearance. Both were dark palettes, so retain
    // the user's effective contrast preference when reading an existing DB.
    return row?.value === 'light' ? 'light' : 'dark'
  }

  setTheme(theme: ThemeId): void {
    this.sqlite.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES('theme', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(theme, new Date().toISOString())
  }

  getSetting(key: string): string | null {
    const row = this.sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.sqlite.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString())
  }

  securityCount(): number {
    const row = this.sqlite.prepare('SELECT COUNT(*) AS count FROM security_master').get() as { count: number }
    return row.count
  }

  getSecurity(secId: string): SecurityMaster | null {
    const row = this.sqlite.prepare(`
      SELECT sec_id, code, name, exchange, pinyin_full, pinyin_initial
      FROM security_master WHERE sec_id = ?
    `).get(secId) as {
      sec_id: string
      code: string
      name: string
      exchange: SecurityMaster['exchange']
      pinyin_full: string
      pinyin_initial: string
    } | undefined
    return row === undefined ? null : {
      secId: row.sec_id,
      code: row.code,
      name: row.name,
      exchange: row.exchange,
      pinyinFull: row.pinyin_full,
      pinyinInitial: row.pinyin_initial,
    }
  }

  searchSecurities(query: string, limit = 20): SecurityMaster[] {
    const normalized = query.trim().toLowerCase()
    if (normalized === '') return []
    const like = `%${normalized}%`
    const prefix = `${normalized}%`
    const rows = this.sqlite.prepare(`
      SELECT sec_id, code, name, exchange, pinyin_full, pinyin_initial,
        CASE
          WHEN code LIKE ? THEN 0
          WHEN name LIKE ? THEN 1
          WHEN pinyin_initial LIKE ? THEN 2
          ELSE 3
        END AS search_rank
      FROM security_master
      WHERE code LIKE ? OR name LIKE ? OR pinyin_initial LIKE ? OR pinyin_full LIKE ?
      ORDER BY search_rank, code
      LIMIT ?
    `).all(prefix, like, prefix, prefix, like, prefix, like, Math.max(1, Math.min(limit, 100))) as unknown as Array<{
      sec_id: string
      code: string
      name: string
      exchange: SecurityMaster['exchange']
      pinyin_full: string
      pinyin_initial: string
    }>
    return rows.map(row => ({
      secId: row.sec_id,
      code: row.code,
      name: row.name,
      exchange: row.exchange,
      pinyinFull: row.pinyin_full,
      pinyinInitial: row.pinyin_initial,
    }))
  }

  /** Replace the complete security snapshot atomically after the provider completeness gate. */
  replaceSecuritySnapshot(rows: readonly SecuritySnapshotRow[]): void {
    if (rows.length < 1000) throw new Error(`主数据拉取不完整（${rows.length} 条），保留现状待重试`)
    const ids = new Set(rows.map(row => row.secId))
    const existing = this.sqlite.prepare('SELECT sec_id FROM security_master').all() as unknown as Array<{ sec_id: string }>
    this.transaction(() => {
      const upsert = this.sqlite.prepare(`
        INSERT INTO security_master(sec_id, code, name, exchange, pinyin_full, pinyin_initial, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sec_id) DO UPDATE SET
          code = excluded.code,
          name = excluded.name,
          exchange = excluded.exchange,
          pinyin_full = excluded.pinyin_full,
          pinyin_initial = excluded.pinyin_initial,
          updated_at = excluded.updated_at
      `)
      for (const row of rows) {
        upsert.run(
          row.secId,
          row.code,
          row.name,
          row.exchange,
          row.pinyinFull,
          row.pinyinInitial,
          row.updatedAt,
        )
      }
      const remove = this.sqlite.prepare('DELETE FROM security_master WHERE sec_id = ?')
      for (const row of existing) {
        if (!ids.has(row.sec_id)) remove.run(row.sec_id)
      }
    })
  }

  judgementCount(): number {
    const row = this.sqlite.prepare('SELECT COUNT(*) AS count FROM judgements').get() as { count: number }
    return row.count
  }

  ensureDefaultWatchGroup(): WatchGroupRow {
    const row = this.sqlite.prepare(
      'SELECT id, name, sort_order, is_default FROM watch_groups WHERE is_default = 1 LIMIT 1',
    ).get() as WatchGroupRow | undefined
    if (row !== undefined) return row
    const id = randomUUID()
    this.sqlite.prepare('INSERT INTO watch_groups(id, name, sort_order, is_default) VALUES(?, ?, 0, 1)')
      .run(id, '默认分组')
    return { id, name: '默认分组', sort_order: 0, is_default: 1 }
  }

  listWatchGroups(): WatchGroup[] {
    this.ensureDefaultWatchGroup()
    const groups = this.sqlite.prepare(
      'SELECT id, name, sort_order, is_default FROM watch_groups ORDER BY is_default DESC, sort_order, id',
    ).all() as unknown as WatchGroupRow[]
    const items = this.sqlite.prepare(
      'SELECT group_id, sec_id, sort_order, added_at, base_price FROM watch_items ORDER BY sort_order DESC',
    ).all() as unknown as WatchItemRow[]
    return groups.map((group) => {
      const mine = items.filter(item => item.group_id === group.id)
      return {
        id: group.id,
        name: group.name,
        isDefault: group.is_default === 1,
        secIds: mine.map(item => item.sec_id),
        items: mine.map(item => ({
          secId: item.sec_id,
          addedAt: item.added_at,
          basePrice: item.base_price,
        })),
      }
    })
  }

  createWatchGroup(rawName: string): WatchGroup {
    const name = normalizeGroupName(rawName)
    const duplicate = this.sqlite.prepare('SELECT 1 AS value FROM watch_groups WHERE lower(name) = lower(?)').get(name)
    if (duplicate !== undefined) throw new Error('已存在同名分组')
    const max = this.sqlite.prepare('SELECT MAX(sort_order) AS value FROM watch_groups').get() as { value: number | null }
    const id = randomUUID()
    this.sqlite.prepare('INSERT INTO watch_groups(id, name, sort_order, is_default) VALUES(?, ?, ?, 0)')
      .run(id, name, (max.value ?? 0) + 1)
    return { id, name, isDefault: false, secIds: [], items: [] }
  }

  renameWatchGroup(id: string, rawName: string): void {
    const name = normalizeGroupName(rawName)
    const duplicate = this.sqlite.prepare(
      'SELECT 1 AS value FROM watch_groups WHERE lower(name) = lower(?) AND id != ?',
    ).get(name, id)
    if (duplicate !== undefined) throw new Error('已存在同名分组')
    const result = this.sqlite.prepare('UPDATE watch_groups SET name = ? WHERE id = ?').run(name, id)
    if (result.changes === 0) throw new Error('分组不存在')
  }

  removeWatchGroup(id: string): void {
    const defaultGroup = this.ensureDefaultWatchGroup()
    if (id === defaultGroup.id) throw new Error('默认分组不能删除')
    const source = this.sqlite.prepare(
      'SELECT group_id, sec_id, sort_order, added_at, base_price FROM watch_items WHERE group_id = ? ORDER BY sort_order',
    ).all(id) as unknown as WatchItemRow[]
    const max = this.sqlite.prepare('SELECT MAX(sort_order) AS value FROM watch_items WHERE group_id = ?')
      .get(defaultGroup.id) as { value: number | null }
    this.transaction(() => {
      let order = max.value ?? 0
      const insert = this.sqlite.prepare(`
        INSERT INTO watch_items(group_id, sec_id, sort_order, added_at, base_price)
        VALUES(?, ?, ?, ?, ?) ON CONFLICT(group_id, sec_id) DO NOTHING
      `)
      for (const item of source) {
        insert.run(defaultGroup.id, item.sec_id, ++order, item.added_at, item.base_price)
      }
      this.sqlite.prepare('DELETE FROM watch_groups WHERE id = ?').run(id)
    })
  }

  addWatchItem(groupId: string, secId: string, basePrice: number | null): void {
    if (this.sqlite.prepare('SELECT 1 AS value FROM watch_groups WHERE id = ?').get(groupId) === undefined) {
      throw new Error('分组不存在')
    }
    const max = this.sqlite.prepare('SELECT MAX(sort_order) AS value FROM watch_items WHERE group_id = ?')
      .get(groupId) as { value: number | null }
    this.sqlite.prepare(`
      INSERT INTO watch_items(group_id, sec_id, sort_order, added_at, base_price)
      VALUES(?, ?, ?, ?, ?) ON CONFLICT(group_id, sec_id) DO NOTHING
    `).run(groupId, secId, (max.value ?? 0) + 1, new Date().toISOString(), basePrice)
  }

  removeWatchItem(groupId: string, secId: string): void {
    this.sqlite.prepare('DELETE FROM watch_items WHERE group_id = ? AND sec_id = ?').run(groupId, secId)
  }

  moveWatchItem(fromGroupId: string, toGroupId: string, secId: string): void {
    if (fromGroupId === toGroupId) return
    const item = this.sqlite.prepare(
      'SELECT group_id, sec_id, sort_order, added_at, base_price FROM watch_items WHERE group_id = ? AND sec_id = ?',
    ).get(fromGroupId, secId) as WatchItemRow | undefined
    if (item === undefined) throw new Error('当前分组中不存在该自选')
    const max = this.sqlite.prepare('SELECT MAX(sort_order) AS value FROM watch_items WHERE group_id = ?')
      .get(toGroupId) as { value: number | null }
    this.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO watch_items(group_id, sec_id, sort_order, added_at, base_price)
        VALUES(?, ?, ?, ?, ?) ON CONFLICT(group_id, sec_id) DO NOTHING
      `).run(toGroupId, secId, (max.value ?? 0) + 1, item.added_at, item.base_price)
      this.removeWatchItem(fromGroupId, secId)
    })
  }

  createResearchFollowUp(input: CreateResearchFollowUpRecord): ResearchFollowUp {
    const title = normalizeFollowUpTitle(input.title)
    const dueDate = normalizeDueDate(input.dueDate ?? null)
    const judgementId = input.judgementId ?? null
    const reportVersion = input.reportVersion ?? null
    if (reportVersion !== null && (!Number.isSafeInteger(reportVersion) || reportVersion < 1)) {
      throw new Error('报告版本必须是正整数')
    }
    if (judgementId !== null) {
      const judgement = this.getJudgement(judgementId)
      if (judgement === null) throw new Error('研判不存在')
      if (judgement.secId !== input.secId) throw new Error('跟踪事项与研判股票不一致')
      if (reportVersion !== null && (judgement.latestReportVersion ?? 0) < reportVersion) {
        throw new Error('报告版本不存在')
      }
    } else if (reportVersion !== null) {
      throw new Error('报告版本必须关联研判')
    }
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO research_follow_ups(
        id, sec_id, judgement_id, report_version, title, due_date, status, created_at, completed_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'open', ?, NULL)
    `).run(id, input.secId, judgementId, reportVersion, title, dueDate, createdAt)
    return this.getResearchFollowUp(id) as ResearchFollowUp
  }

  getResearchFollowUp(id: string): ResearchFollowUp | null {
    const row = this.sqlite.prepare('SELECT * FROM research_follow_ups WHERE id = ?').get(id) as
      | ResearchFollowUpRow
      | undefined
    return row === undefined ? null : researchFollowUpFromRow(row)
  }

  listResearchFollowUps(secId: string): ResearchFollowUp[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM research_follow_ups WHERE sec_id = ?
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
        CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
        due_date,
        created_at DESC
    `).all(secId) as unknown as ResearchFollowUpRow[]
    return rows.map(researchFollowUpFromRow)
  }

  listResearchFollowUpsForSecurities(secIds: readonly string[]): ResearchFollowUp[] {
    const unique = [...new Set(secIds)]
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.sqlite.prepare(`
      SELECT * FROM research_follow_ups WHERE sec_id IN (${placeholders})
      ORDER BY sec_id,
        CASE status WHEN 'open' THEN 0 ELSE 1 END,
        CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
        due_date,
        created_at DESC
    `).all(...unique) as unknown as ResearchFollowUpRow[]
    return rows.map(researchFollowUpFromRow)
  }

  listAllResearchFollowUps(status: ResearchFollowUpStatus | 'all' = 'all'): ResearchFollowUp[] {
    const where = status === 'all' ? '' : 'WHERE status = ?'
    const statement = this.sqlite.prepare(`
      SELECT * FROM research_follow_ups ${where}
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
        CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
        due_date,
        created_at DESC
    `)
    const rows = (status === 'all' ? statement.all() : statement.all(status)) as unknown as ResearchFollowUpRow[]
    return rows.map(researchFollowUpFromRow)
  }

  updateResearchFollowUp(id: string, update: ResearchFollowUpUpdate): ResearchFollowUp {
    const current = this.getResearchFollowUp(id)
    if (current === null) throw new Error('跟踪事项不存在')
    const fields: string[] = []
    const values: SQLInputValue[] = []
    const add = (column: string, value: SQLInputValue): void => {
      fields.push(`${column} = ?`)
      values.push(value)
    }
    if (update.title !== undefined) add('title', normalizeFollowUpTitle(update.title))
    if (update.dueDate !== undefined) add('due_date', normalizeDueDate(update.dueDate))
    if (update.completed !== undefined) {
      add('status', update.completed ? 'done' : 'open')
      add('completed_at', update.completed ? new Date().toISOString() : null)
    }
    if (fields.length === 0) throw new Error('没有需要更新的跟踪事项字段')
    this.sqlite.prepare(`UPDATE research_follow_ups SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
    return this.getResearchFollowUp(id) as ResearchFollowUp
  }

  removeResearchFollowUp(id: string): void {
    const result = this.sqlite.prepare('DELETE FROM research_follow_ups WHERE id = ?').run(id)
    if (result.changes === 0) throw new Error('跟踪事项不存在')
  }

  createResearchPrediction(input: CreateResearchPredictionRecord): ResearchPrediction {
    const statement = normalizePredictionText(input.statement, '研究命题', 200)
    const resolutionCriteria = normalizePredictionText(input.resolutionCriteria, '判定口径', 300)
    const dueDate = normalizeDueDate(input.dueDate)
    if (dueDate === null) throw new Error('研究命题必须设置判定日期')
    if (!Number.isSafeInteger(input.probabilityPct) || input.probabilityPct < 1 || input.probabilityPct > 99) {
      throw new Error('主观概率必须是 1 到 99 的整数')
    }
    const judgementId = input.judgementId ?? null
    const reportVersion = input.reportVersion ?? null
    if (reportVersion !== null && (!Number.isSafeInteger(reportVersion) || reportVersion < 1)) {
      throw new Error('报告版本必须是正整数')
    }
    if (judgementId !== null) {
      const judgement = this.getJudgement(judgementId)
      if (judgement === null) throw new Error('研判不存在')
      if (judgement.secId !== input.secId) throw new Error('研究命题与研判股票不一致')
      if (reportVersion !== null && (judgement.latestReportVersion ?? 0) < reportVersion) {
        throw new Error('报告版本不存在')
      }
    } else if (reportVersion !== null) {
      throw new Error('报告版本必须关联研判')
    }
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO research_predictions(
        id, sec_id, judgement_id, report_version, statement, resolution_criteria,
        probability_pct, due_date, outcome, brier_score, created_at, resolved_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
    `).run(
      id, input.secId, judgementId, reportVersion, statement, resolutionCriteria,
      input.probabilityPct, dueDate, createdAt,
    )
    return this.getResearchPrediction(id) as ResearchPrediction
  }

  getResearchPrediction(id: string): ResearchPrediction | null {
    const row = this.sqlite.prepare('SELECT * FROM research_predictions WHERE id = ?').get(id) as
      | ResearchPredictionRow
      | undefined
    return row === undefined ? null : researchPredictionFromRow(row)
  }

  listResearchPredictions(secId: string): ResearchPrediction[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM research_predictions WHERE sec_id = ?
      ORDER BY CASE outcome WHEN 'pending' THEN 0 ELSE 1 END, due_date, created_at DESC
    `).all(secId) as unknown as ResearchPredictionRow[]
    return rows.map(researchPredictionFromRow)
  }

  listResearchPredictionsForSecurities(secIds: readonly string[]): ResearchPrediction[] {
    const unique = [...new Set(secIds)]
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.sqlite.prepare(`
      SELECT * FROM research_predictions
      WHERE sec_id IN (${placeholders}) AND outcome = 'pending'
      ORDER BY sec_id, due_date, created_at DESC
    `).all(...unique) as unknown as ResearchPredictionRow[]
    return rows.map(researchPredictionFromRow)
  }

  listAllResearchPredictions(status: 'pending' | 'resolved' | 'all' = 'all'): ResearchPrediction[] {
    const where = status === 'pending'
      ? "WHERE outcome = 'pending'"
      : status === 'resolved'
        ? "WHERE outcome != 'pending'"
        : ''
    const rows = this.sqlite.prepare(`
      SELECT * FROM research_predictions ${where}
      ORDER BY CASE outcome WHEN 'pending' THEN 0 ELSE 1 END, due_date, created_at DESC
    `).all() as unknown as ResearchPredictionRow[]
    return rows.map(researchPredictionFromRow)
  }

  resolveResearchPrediction(
    id: string,
    outcome: Exclude<ResearchPredictionOutcome, 'pending'>,
  ): ResearchPrediction {
    if (!['occurred', 'not-occurred', 'invalid'].includes(outcome)) throw new Error('研究命题判定结果无效')
    const current = this.getResearchPrediction(id)
    if (current === null) throw new Error('研究命题不存在')
    if (current.outcome !== 'pending') {
      if (current.outcome === outcome) return current
      throw new Error('研究命题已经完成判定，不能覆盖历史结果')
    }
    const probability = current.probabilityPct / 100
    const brierScore = outcome === 'invalid'
      ? null
      : roundCalibrationScore((probability - (outcome === 'occurred' ? 1 : 0)) ** 2)
    this.sqlite.prepare(`
      UPDATE research_predictions
      SET outcome = ?, brier_score = ?, resolved_at = ?
      WHERE id = ? AND outcome = 'pending'
    `).run(outcome, brierScore, new Date().toISOString(), id)
    return this.getResearchPrediction(id) as ResearchPrediction
  }

  createJudgement(input: CreateJudgementRecord): Judgement {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO judgements(
        id, sec_id, code, stock_name, master_id, master_name, master_version,
        report_status, turn_status, model_provider, model, reasoning_effort,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'preparing', 'idle', ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.secId,
      input.code,
      input.stockName,
      input.masterId,
      input.masterName,
      input.masterVersion,
      input.modelProvider ?? null,
      input.model ?? null,
      input.reasoningEffort ?? null,
      now,
      now,
    )
    return this.getJudgement(input.id) as Judgement
  }

  getJudgement(id: string): Judgement | null {
    const row = this.sqlite.prepare('SELECT * FROM judgements WHERE id = ?').get(id) as JudgementRow | undefined
    return row === undefined ? null : judgementFromRow(row)
  }

  getJudgementBySession(sessionId: string): Judgement | null {
    const row = this.sqlite.prepare('SELECT * FROM judgements WHERE dsh_session_id = ?').get(sessionId) as
      | JudgementRow
      | undefined
    return row === undefined ? null : judgementFromRow(row)
  }

  getRepairAttempts(id: string): number {
    const row = this.sqlite.prepare('SELECT repair_attempts FROM judgements WHERE id = ?').get(id) as
      | { repair_attempts: number }
      | undefined
    return row?.repair_attempts ?? 0
  }

  listJudgements(): Judgement[] {
    const rows = this.sqlite.prepare('SELECT * FROM judgements ORDER BY updated_at DESC').all() as unknown as JudgementRow[]
    return rows.map(judgementFromRow)
  }

  removeJudgement(id: string): void {
    this.transaction(() => {
      this.sqlite.prepare(`
        UPDATE research_follow_ups SET report_version = NULL WHERE judgement_id = ?
      `).run(id)
      this.sqlite.prepare(`
        UPDATE research_predictions SET report_version = NULL WHERE judgement_id = ?
      `).run(id)
      const result = this.sqlite.prepare('DELETE FROM judgements WHERE id = ?').run(id)
      if (result.changes === 0) throw new Error('研判不存在')
    })
  }

  updateJudgement(id: string, update: JudgementUpdate): Judgement {
    const fields: string[] = []
    const values: SQLInputValue[] = []
    const add = (column: string, value: SQLInputValue): void => {
      fields.push(`${column} = ?`)
      values.push(value)
    }
    if ('dshSessionId' in update) add('dsh_session_id', update.dshSessionId ?? null)
    if ('reportStatus' in update) add('report_status', update.reportStatus)
    if ('turnStatus' in update) add('turn_status', update.turnStatus)
    if ('latestReportVersion' in update) add('latest_report_version', update.latestReportVersion ?? null)
    if ('completedAt' in update) add('completed_at', update.completedAt ?? null)
    if ('errorCode' in update) add('error_code', update.errorCode ?? null)
    if ('errorMessage' in update) add('error_message', update.errorMessage ?? null)
    if ('repairAttempts' in update) add('repair_attempts', update.repairAttempts)
    add('updated_at', new Date().toISOString())
    const result = this.sqlite.prepare(`UPDATE judgements SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
    if (result.changes === 0) throw new Error('研判不存在')
    return this.getJudgement(id) as Judgement
  }

  addReportVersion(record: Omit<ReportRow, 'relative_path'> & { relativePath: string }): void {
    this.sqlite.prepare(`
      INSERT INTO report_versions(
        judgement_id, version, relative_path, sha256, size_bytes, sealed_at, model_provider, model
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.judgement_id,
      record.version,
      record.relativePath,
      record.sha256,
      record.size_bytes,
      record.sealed_at,
      record.model_provider,
      record.model,
    )
  }

  /** Commit the immutable report index and the judgement's ready pointer together. */
  commitReportVersion(record: Omit<ReportRow, 'relative_path'> & { relativePath: string }): Judgement {
    this.transaction(() => {
      this.addReportVersion(record)
      const result = this.sqlite.prepare(`
        UPDATE judgements SET
          report_status = 'ready',
          turn_status = 'idle',
          latest_report_version = ?,
          completed_at = ?,
          repair_attempts = 0,
          error_code = NULL,
          error_message = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(record.version, record.sealed_at, record.sealed_at, record.judgement_id)
      if (result.changes === 0) throw new Error('研判不存在')
    })
    return this.getJudgement(record.judgement_id) as Judgement
  }

  listReportRows(judgementId: string): ReportRow[] {
    return this.sqlite.prepare(
      'SELECT * FROM report_versions WHERE judgement_id = ? ORDER BY version DESC',
    ).all(judgementId) as unknown as ReportRow[]
  }

  listReportMetadata(judgementId: string): Omit<ReportVersion, 'content' | 'audit'>[] {
    return this.listReportRows(judgementId).map(row => ({
      judgementId: row.judgement_id,
      version: row.version,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      sealedAt: row.sealed_at,
      modelProvider: row.model_provider,
      model: row.model,
    }))
  }

  private transaction(fn: () => void): void {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.sqlite.exec('COMMIT')
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }
}

function normalizeGroupName(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new Error('分组名称不能为空')
  if ([...value].length > 20) throw new Error('分组名称不能超过 20 个字符')
  return value
}

function normalizeFollowUpTitle(raw: string): string {
  const value = raw.trim().replace(/\s+/g, ' ')
  if (value === '') throw new Error('跟踪事项不能为空')
  if ([...value].length > 160) throw new Error('跟踪事项不能超过 160 个字符')
  return value
}

function normalizePredictionText(raw: string, label: string, maxLength: number): string {
  const value = raw.trim().replace(/\s+/g, ' ')
  if (value === '') throw new Error(`${label}不能为空`)
  if ([...value].length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`)
  return value
}

function normalizeDueDate(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null
  const value = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('到期日格式必须为 YYYY-MM-DD')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('到期日无效')
  }
  return value
}

function judgementFromRow(row: JudgementRow): Judgement {
  return {
    id: row.id,
    secId: row.sec_id,
    code: row.code,
    stockName: row.stock_name,
    masterId: row.master_id,
    masterName: row.master_name,
    masterVersion: row.master_version,
    dshSessionId: row.dsh_session_id,
    reportStatus: row.report_status,
    turnStatus: row.turn_status,
    latestReportVersion: row.latest_report_version,
    modelProvider: row.model_provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  }
}

function researchFollowUpFromRow(row: ResearchFollowUpRow): ResearchFollowUp {
  return {
    id: row.id,
    secId: row.sec_id,
    judgementId: row.judgement_id,
    reportVersion: row.report_version,
    title: row.title,
    dueDate: row.due_date,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function researchPredictionFromRow(row: ResearchPredictionRow): ResearchPrediction {
  return {
    id: row.id,
    secId: row.sec_id,
    judgementId: row.judgement_id,
    reportVersion: row.report_version,
    statement: row.statement,
    resolutionCriteria: row.resolution_criteria,
    probabilityPct: row.probability_pct,
    dueDate: row.due_date,
    outcome: row.outcome,
    brierScore: row.brier_score,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

function roundCalibrationScore(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
