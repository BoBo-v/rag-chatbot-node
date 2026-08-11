import type { DatabaseSync } from 'node:sqlite'

export interface MetricRow {
    id: string
    request_id: string | null
    agent_run_id: string | null
    agent_step: number | null
    finish_reason: string | null
    tool_call_count: number | null
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
    rag_mode: string
    rag_top_k: number
    rag_min_score: number
    rag_hit_count: number
    rag_best_score: number | null
    rag_prompt_chars: number
    embedding_model: string
    prompt_version: string
    input_chars: number | null
    output_chars: number | null
    est_input_tokens: number | null
    est_output_tokens: number | null
    est_cost_usd: number
    question_preview: string | null
    is_timeout: number
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
        successCount: number | null
        failedCount: number | null
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
    const successCount = row.successCount ?? 0
    const failedCount = row.failedCount ?? 0
    return {
        totalRequests: row.totalRequests,
        successCount,
        failedCount,
        errorRate: failedCount / row.totalRequests,
        avgLatencyMs: row.avgLatencyMs === null ? null : Math.round(row.avgLatencyMs),
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
        avgLatencyMs: row.avgLatencyMs === null ? null : Math.round(row.avgLatencyMs),
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
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ai_request_logs ${where}`)
        .get(...params) as { count: number }
    const rows = db.prepare(`
        SELECT * FROM ai_request_logs ${where}
        ORDER BY timestamp DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown as MetricRow[]

    return { rows, total: countRow.count }
}

export function queryCompare(db: DatabaseSync, compareId: string): CompareResult | null {
    const rows = db.prepare(`
        SELECT * FROM ai_request_logs
        WHERE compare_id = ?
        ORDER BY timestamp ASC, id ASC
    `).all(compareId) as unknown as MetricRow[]
    if (rows.length === 0) return null

    return {
        compareId,
        totalRequests: rows.length,
        totalCostUsd: roundTo(rows.reduce((sum, row) => sum + row.est_cost_usd, 0), 4),
        requests: rows,
    }
}

function queryPercentile(db: DatabaseSync, percentile: number, filters?: { from?: string; to?: string }): number | null {
    const { where, params } = buildTimeFilter(filters)
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ai_request_logs ${where}`)
        .get(...params) as { count: number }
    if (countRow.count === 0) return null

    const index = Math.ceil(countRow.count * percentile) - 1
    const row = db.prepare(`
        SELECT latency_ms FROM ai_request_logs ${where}
        ORDER BY latency_ms ASC
        LIMIT 1 OFFSET ?
    `).get(...params, Math.max(0, index)) as { latency_ms: number } | undefined
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
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ai_request_logs ${where}`)
        .get(...params) as { count: number }
    if (countRow.count === 0) return null

    const index = Math.ceil(countRow.count * percentile) - 1
    const row = db.prepare(`
        SELECT latency_ms FROM ai_request_logs ${where}
        ORDER BY latency_ms ASC
        LIMIT 1 OFFSET ?
    `).get(...params, Math.max(0, index)) as { latency_ms: number } | undefined
    return row?.latency_ms ?? null
}

function buildTimeFilter(filters?: { from?: string; to?: string }): { where: string; params: string[] } {
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
