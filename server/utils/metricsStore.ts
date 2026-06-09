import { DatabaseSync } from 'node:sqlite'

export interface MetricRow {
    id: string
    compare_id: string | null
    timestamp: string
    endpoint: string
    provider: string
    model: string
    status: string
    status_code: number | null
    error_code: string | null
    error_message: string | null
    started_at: string
    ended_at: string
    latency_ms: number
    rag_enabled: number
    rag_hit_count: number
    rag_prompt_chars: number
    input_chars: number | null
    output_chars: number | null
    est_input_tokens: number | null
    est_output_tokens: number | null
    est_cost_usd: number
    question_preview: string | null
    is_timeout: number
    raw_error: string | null
}

export interface SummaryResult {
    totalRequests: number
    successCount: number
    failedCount: number
    errorRate: number
    avgLatencyMs: number | null
    p50LatencyMs: number | null
    p95LatencyMs: number | null
    totalEstTokens: number
    totalEstCostUsd: number
}

export interface ProviderStat {
    provider: string
    model: string
    totalRequests: number
    successCount: number
    successRate: number
    avgLatencyMs: number | null
    p95LatencyMs: number | null
    totalEstTokens: number
    totalEstCostUsd: number
}

export interface CompareResult {
    compareId: string
    totalRequests: number
    totalCostUsd: number
    requests: MetricRow[]
}

const CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS ai_request_logs (
        id                TEXT PRIMARY KEY,
        compare_id        TEXT,
        timestamp         TEXT NOT NULL,
        endpoint          TEXT NOT NULL,
        provider          TEXT NOT NULL,
        model             TEXT NOT NULL,
        status            TEXT NOT NULL,
        status_code       INTEGER,
        error_code        TEXT,
        error_message     TEXT,
        started_at        TEXT NOT NULL,
        ended_at          TEXT NOT NULL,
        latency_ms        INTEGER NOT NULL,
        rag_enabled       INTEGER NOT NULL DEFAULT 0,
        rag_hit_count     INTEGER NOT NULL DEFAULT 0,
        rag_prompt_chars  INTEGER NOT NULL DEFAULT 0,
        input_chars       INTEGER,
        output_chars      INTEGER,
        est_input_tokens  INTEGER,
        est_output_tokens INTEGER,
        est_cost_usd      REAL NOT NULL DEFAULT 0,
        question_preview  TEXT,
        is_timeout        INTEGER NOT NULL DEFAULT 0,
        raw_error         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON ai_request_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_metrics_provider ON ai_request_logs(provider);
    CREATE INDEX IF NOT EXISTS idx_metrics_status ON ai_request_logs(status);
    CREATE INDEX IF NOT EXISTS idx_metrics_compare_id ON ai_request_logs(compare_id);
`

export function initMetricsTable(db: DatabaseSync): void {
    db.exec(CREATE_TABLE_SQL)

    // Migration: add raw_error column if missing
    const columns = db.prepare('PRAGMA table_info(ai_request_logs)').all() as Array<{ name: string }>
    if (!columns.some(c => c.name === 'raw_error')) {
        db.exec('ALTER TABLE ai_request_logs ADD COLUMN raw_error TEXT')
    }
}

const INSERT_SQL = `
    INSERT INTO ai_request_logs (
        id, compare_id, timestamp, endpoint, provider, model,
        status, status_code, error_code, error_message,
        started_at, ended_at, latency_ms,
        rag_enabled, rag_hit_count, rag_prompt_chars,
        input_chars, output_chars,
        est_input_tokens, est_output_tokens, est_cost_usd,
        question_preview, is_timeout, raw_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

export function insertMetrics(db: DatabaseSync, rows: MetricRow[]): void {
    if (rows.length === 0) return

    const stmt = db.prepare(INSERT_SQL)
    db.exec('BEGIN')
    try {
        for (const row of rows) {
            stmt.run(
                row.id, row.compare_id, row.timestamp, row.endpoint, row.provider, row.model,
                row.status, row.status_code, row.error_code, row.error_message,
                row.started_at, row.ended_at, row.latency_ms,
                row.rag_enabled, row.rag_hit_count, row.rag_prompt_chars,
                row.input_chars, row.output_chars,
                row.est_input_tokens, row.est_output_tokens, row.est_cost_usd,
                row.question_preview, row.is_timeout, row.raw_error
            )
        }
        db.exec('COMMIT')
    } catch (err) {
        db.exec('ROLLBACK')
        throw err
    }
}

export function querySummary(db: DatabaseSync, filters?: { from?: string; to?: string }): SummaryResult {
    const { where, params } = buildTimeFilter(filters)

    const row = db.prepare(`
        SELECT
            COUNT(*) AS totalRequests,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
            SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS failedCount,
            AVG(latency_ms) AS avgLatencyMs,
            SUM(COALESCE(est_input_tokens, 0) + COALESCE(est_output_tokens, 0)) AS totalEstTokens,
            SUM(est_cost_usd) AS totalEstCostUsd
        FROM ai_request_logs
        ${where}
    `).get(...params) as {
        totalRequests: number
        successCount: number
        failedCount: number
        avgLatencyMs: number | null
        totalEstTokens: number | null
        totalEstCostUsd: number | null
    } | undefined

    if (!row || row.totalRequests === 0) {
        return {
            totalRequests: 0, successCount: 0, failedCount: 0, errorRate: 0,
            avgLatencyMs: null, p50LatencyMs: null, p95LatencyMs: null,
            totalEstTokens: 0, totalEstCostUsd: 0,
        }
    }

    const p50 = queryPercentile(db, 0.5, filters)
    const p95 = queryPercentile(db, 0.95, filters)

    return {
        totalRequests: row.totalRequests,
        successCount: row.successCount,
        failedCount: row.failedCount,
        errorRate: row.totalRequests > 0 ? row.failedCount / row.totalRequests : 0,
        avgLatencyMs: row.avgLatencyMs ? Math.round(row.avgLatencyMs) : null,
        p50LatencyMs: p50,
        p95LatencyMs: p95,
        totalEstTokens: row.totalEstTokens ?? 0,
        totalEstCostUsd: roundTo(row.totalEstCostUsd ?? 0, 4),
    }
}

export function queryProviders(db: DatabaseSync, filters?: { from?: string; to?: string }): ProviderStat[] {
    const { where, params } = buildTimeFilter(filters)

    const rows = db.prepare(`
        SELECT
            provider,
            model,
            COUNT(*) AS totalRequests,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
            AVG(latency_ms) AS avgLatencyMs,
            SUM(COALESCE(est_input_tokens, 0) + COALESCE(est_output_tokens, 0)) AS totalEstTokens,
            SUM(est_cost_usd) AS totalEstCostUsd
        FROM ai_request_logs
        ${where}
        GROUP BY provider, model
        ORDER BY totalRequests DESC
    `).all(...params) as Array<{
        provider: string
        model: string
        totalRequests: number
        successCount: number
        avgLatencyMs: number | null
        totalEstTokens: number | null
        totalEstCostUsd: number | null
    }>

    return rows.map(row => ({
        provider: row.provider,
        model: row.model,
        totalRequests: row.totalRequests,
        successCount: row.successCount,
        successRate: row.totalRequests > 0 ? roundTo(row.successCount / row.totalRequests, 4) : 0,
        avgLatencyMs: row.avgLatencyMs ? Math.round(row.avgLatencyMs) : null,
        p95LatencyMs: queryPercentileForGroup(db, 0.95, row.provider, row.model, filters),
        totalEstTokens: row.totalEstTokens ?? 0,
        totalEstCostUsd: roundTo(row.totalEstCostUsd ?? 0, 4),
    }))
}

export function queryRequests(
    db: DatabaseSync,
    options: {
        limit?: number
        offset?: number
        provider?: string
        status?: string
        from?: string
        to?: string
    } = {}
): { rows: MetricRow[]; total: number } {
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (options.provider) {
        conditions.push('provider = ?')
        params.push(options.provider)
    }
    if (options.status) {
        conditions.push('status = ?')
        params.push(options.status)
    }
    if (options.from) {
        conditions.push('timestamp >= ?')
        params.push(options.from)
    }
    if (options.to) {
        conditions.push('timestamp <= ?')
        params.push(options.to)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const offset = Math.max(options.offset ?? 0, 0)

    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ai_request_logs ${where}`).get(...params) as unknown as { count: number }
    const rows = db.prepare(`
        SELECT * FROM ai_request_logs ${where}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown as MetricRow[]

    return { rows, total: countRow.count }
}

export function queryCompare(db: DatabaseSync, compareId: string): CompareResult | null {
    const rows = db.prepare(`
        SELECT * FROM ai_request_logs
        WHERE compare_id = ?
        ORDER BY timestamp ASC
    `).all(compareId) as unknown as MetricRow[]

    if (rows.length === 0) return null

    const totalCostUsd = rows.reduce((sum, row) => sum + row.est_cost_usd, 0)

    return {
        compareId,
        totalRequests: rows.length,
        totalCostUsd: roundTo(totalCostUsd, 4),
        requests: rows,
    }
}

export function cleanupOldMetrics(db: DatabaseSync, retentionDays: number): number {
    if (retentionDays <= 0) return 0

    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()
    const result = db.prepare('DELETE FROM ai_request_logs WHERE timestamp < ?').run(cutoff)
    return Number(result.changes)
}

function queryPercentile(db: DatabaseSync, percentile: number, filters?: { from?: string; to?: string }): number | null {
    const { where, params } = buildTimeFilter(filters)
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ai_request_logs ${where}`).get(...params) as unknown as { count: number }
    if (countRow.count === 0) return null

    const index = Math.ceil(countRow.count * percentile) - 1
    const row = db.prepare(`
        SELECT latency_ms FROM ai_request_logs ${where}
        ORDER BY latency_ms ASC
        LIMIT 1 OFFSET ?
    `).get(...params, Math.max(0, index)) as unknown as { latency_ms: number } | undefined

    return row?.latency_ms ?? null
}

function queryPercentileForGroup(
    db: DatabaseSync,
    percentile: number,
    provider: string,
    model: string,
    filters?: { from?: string; to?: string }
): number | null {
    const conditions = ['provider = ?', 'model = ?']
    const params: Array<string | number> = [provider, model]

    if (filters?.from) {
        conditions.push('timestamp >= ?')
        params.push(filters.from)
    }
    if (filters?.to) {
        conditions.push('timestamp <= ?')
        params.push(filters.to)
    }

    const where = `WHERE ${conditions.join(' AND ')}`
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ai_request_logs ${where}`).get(...params) as unknown as { count: number }
    if (countRow.count === 0) return null

    const index = Math.ceil(countRow.count * percentile) - 1
    const row = db.prepare(`
        SELECT latency_ms FROM ai_request_logs ${where}
        ORDER BY latency_ms ASC
        LIMIT 1 OFFSET ?
    `).get(...params, Math.max(0, index)) as unknown as { latency_ms: number } | undefined

    return row?.latency_ms ?? null
}

function buildTimeFilter(filters?: { from?: string; to?: string }): { where: string; params: Array<string | number> } {
    const conditions: string[] = []
    const params: string[] = []

    if (filters?.from) {
        conditions.push('timestamp >= ?')
        params.push(filters.from)
    }
    if (filters?.to) {
        conditions.push('timestamp <= ?')
        params.push(filters.to)
    }

    return {
        where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
        params,
    }
}

function roundTo(value: number, decimals: number): number {
    const factor = 10 ** decimals
    return Math.round(value * factor) / factor
}
