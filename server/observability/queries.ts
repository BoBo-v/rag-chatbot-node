import type { DatabaseSync } from 'node:sqlite'
import { querySummary as queryAiSummary } from '../utils/metricsStore'
import { getObservabilityRuntimeStatus } from './collector'

export interface LogListOptions {
    from: string
    to: string
    limit: number
    cursor?: string
}

interface CursorValue {
    timestamp: string
    id: string
}

export function queryLogSummary(db: DatabaseSync, from: string, to: string) {
    const http = db.prepare(`
        SELECT
            COUNT(*) AS totalRequests,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errorCount,
            SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS serverErrorCount,
            AVG(response_time_ms) AS avgResponseTimeMs
        FROM http_request_logs
        WHERE timestamp >= ? AND timestamp <= ?
    `).get(from, to) as {
        totalRequests: number
        errorCount: number | null
        serverErrorCount: number | null
        avgResponseTimeMs: number | null
    }
    const application = db.prepare(`
        SELECT
            COUNT(*) AS totalEvents,
            SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errorCount
        FROM application_events
        WHERE timestamp >= ? AND timestamp <= ?
    `).get(from, to) as { totalEvents: number; errorCount: number | null }

    return {
        from,
        to,
        http: {
            totalRequests: http.totalRequests,
            errorCount: http.errorCount ?? 0,
            serverErrorCount: http.serverErrorCount ?? 0,
            errorRate: http.totalRequests > 0 ? (http.errorCount ?? 0) / http.totalRequests : 0,
            avgResponseTimeMs: http.avgResponseTimeMs === null ? null : Math.round(http.avgResponseTimeMs),
            p95ResponseTimeMs: queryHttpPercentile(db, from, to, 0.95),
        },
        ai: queryAiSummary(db, { from, to }),
        application: {
            totalEvents: application.totalEvents,
            errorCount: application.errorCount ?? 0,
        },
        collector: getObservabilityRuntimeStatus(),
    }
}

export function queryHttpRequests(db: DatabaseSync, options: LogListOptions & {
    method?: string
    route?: string
    statusCode?: number
    minDurationMs?: number
}) {
    const conditions = ['timestamp >= ?', 'timestamp <= ?']
    const params: Array<string | number> = [options.from, options.to]
    appendCursorCondition(conditions, params, options.cursor)

    if (options.method) {
        conditions.push('method = ?')
        params.push(options.method)
    }
    if (options.route) {
        conditions.push('route = ?')
        params.push(options.route)
    }
    if (options.statusCode !== undefined) {
        conditions.push('status_code = ?')
        params.push(options.statusCode)
    }
    if (options.minDurationMs !== undefined) {
        conditions.push('response_time_ms >= ?')
        params.push(options.minDurationMs)
    }

    const rows = db.prepare(`
        SELECT id, timestamp, method, route, status_code, response_time_ms, remote_address
        FROM http_request_logs
        WHERE ${conditions.join(' AND ')}
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
    `).all(...params, options.limit) as Array<{
        id: string
        timestamp: string
        method: string
        route: string
        status_code: number
        response_time_ms: number
        remote_address: string | null
    }>

    return {
        rows,
        nextCursor: rows.length === options.limit ? encodeCursor(rows[rows.length - 1]) : null,
    }
}

export function queryErrors(db: DatabaseSync, options: LogListOptions & {
    errorCode?: string
}) {
    const cursor = decodeCursor(options.cursor)
    const limit = options.limit

    const httpCodeMatch = options.errorCode ? /^HTTP_([45]\d{2})$/.exec(options.errorCode) : null
    const includeHttpErrors = !options.errorCode || Boolean(httpCodeMatch)
    const httpConditions = ['timestamp >= ?', 'timestamp <= ?', 'status_code >= 400']
    const httpParams: Array<string | number> = [options.from, options.to]
    if (httpCodeMatch) {
        httpConditions.push('status_code = ?')
        httpParams.push(Number(httpCodeMatch[1]))
    }
    if (cursor) {
        httpConditions.push('(timestamp < ? OR (timestamp = ? AND id < ?))')
        httpParams.push(cursor.timestamp, cursor.timestamp, cursor.id)
    }
    const httpRows = includeHttpErrors ? db.prepare(`
        SELECT id, id AS request_id, timestamp, 'http' AS source,
               'HTTP_' || status_code AS error_code,
               'HTTP ' || status_code AS message,
               status_code, route AS operation
        FROM http_request_logs
        WHERE ${httpConditions.join(' AND ')}
        ORDER BY timestamp DESC, id DESC LIMIT ?
    `).all(...httpParams, limit) as unknown as ErrorRow[] : []

    const aiConditions = ["timestamp >= ?", "timestamp <= ?", "status != 'success'"]
    const aiParams: Array<string | number> = [options.from, options.to]
    if (options.errorCode) {
        aiConditions.push('error_code = ?')
        aiParams.push(options.errorCode)
    }
    if (cursor) {
        aiConditions.push('(timestamp < ? OR (timestamp = ? AND id < ?))')
        aiParams.push(cursor.timestamp, cursor.timestamp, cursor.id)
    }
    const aiRows = db.prepare(`
        SELECT id, request_id, timestamp, 'ai' AS source,
               error_code, COALESCE(error_message, status) AS message,
               status_code, endpoint AS operation
        FROM ai_request_logs
        WHERE ${aiConditions.join(' AND ')}
        ORDER BY timestamp DESC, id DESC LIMIT ?
    `).all(...aiParams, limit) as unknown as ErrorRow[]

    const eventConditions = ["timestamp >= ?", "timestamp <= ?", "level = 'error'"]
    const eventParams: Array<string | number> = [options.from, options.to]
    if (options.errorCode) {
        eventConditions.push('error_code = ?')
        eventParams.push(options.errorCode)
    }
    if (cursor) {
        eventConditions.push('(timestamp < ? OR (timestamp = ? AND id < ?))')
        eventParams.push(cursor.timestamp, cursor.timestamp, cursor.id)
    }
    const eventRows = db.prepare(`
        SELECT id, request_id, timestamp, 'application' AS source,
               error_code, message, status_code, operation
        FROM application_events
        WHERE ${eventConditions.join(' AND ')}
        ORDER BY timestamp DESC, id DESC LIMIT ?
    `).all(...eventParams, limit) as unknown as ErrorRow[]

    const rows = [...httpRows, ...aiRows, ...eventRows]
        .sort(compareTimestampAndId)
        .slice(0, limit)

    return {
        rows,
        nextCursor: rows.length === limit ? encodeCursor(rows[rows.length - 1]) : null,
    }
}

export function queryRequestDetail(db: DatabaseSync, requestId: string) {
    const request = db.prepare(`
        SELECT id, timestamp, method, route, status_code, response_time_ms, remote_address
        FROM http_request_logs WHERE id = ?
    `).get(requestId)
    const aiInvocations = db.prepare(`
        SELECT * FROM ai_request_logs
        WHERE request_id = ?
        ORDER BY timestamp ASC, id ASC
    `).all(requestId)
    const events = db.prepare(`
        SELECT id, timestamp, request_id, level, event_type, module, operation,
               status_code, error_code, message, context_json
        FROM application_events
        WHERE request_id = ?
        ORDER BY timestamp ASC, id ASC
    `).all(requestId)

    if (!request && aiInvocations.length === 0 && events.length === 0) return null
    return { request: request ?? null, aiInvocations, events }
}

export function queryRecentHttpRequests(db: DatabaseSync, limit: number) {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100)
    const rows = db.prepare(`
        SELECT id, timestamp, method, route, status_code, response_time_ms, remote_address
        FROM http_request_logs
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
    `).all(safeLimit) as Array<{
        id: string
        timestamp: string
        method: string
        route: string
        status_code: number
        response_time_ms: number
        remote_address: string | null
    }>
    return rows.map(row => ({
        id: row.id,
        timestamp: row.timestamp,
        method: row.method,
        route: row.route,
        statusCode: row.status_code,
        responseTimeMs: row.response_time_ms,
        remoteAddress: row.remote_address,
    }))
}

export function decodeCursor(value?: string): CursorValue | null {
    if (!value) return null
    if (value.length > 500) throw new Error('INVALID_CURSOR')

    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorValue>
        if (typeof parsed.timestamp !== 'string' || typeof parsed.id !== 'string') throw new Error('INVALID_CURSOR')
        if (!Number.isFinite(Date.parse(parsed.timestamp)) || parsed.id.length === 0 || parsed.id.length > 100) {
            throw new Error('INVALID_CURSOR')
        }
        return { timestamp: parsed.timestamp, id: parsed.id }
    } catch {
        throw new Error('INVALID_CURSOR')
    }
}

function encodeCursor(value: CursorValue): string {
    return Buffer.from(JSON.stringify({ timestamp: value.timestamp, id: value.id })).toString('base64url')
}

function appendCursorCondition(
    conditions: string[],
    params: Array<string | number>,
    encodedCursor?: string
): void {
    const cursor = decodeCursor(encodedCursor)
    if (!cursor) return
    conditions.push('(timestamp < ? OR (timestamp = ? AND id < ?))')
    params.push(cursor.timestamp, cursor.timestamp, cursor.id)
}

function queryHttpPercentile(db: DatabaseSync, from: string, to: string, percentile: number): number | null {
    const count = db.prepare(`
        SELECT COUNT(*) AS count FROM http_request_logs
        WHERE timestamp >= ? AND timestamp <= ?
    `).get(from, to) as { count: number }
    if (count.count === 0) return null

    const offset = Math.max(0, Math.ceil(count.count * percentile) - 1)
    const row = db.prepare(`
        SELECT response_time_ms FROM http_request_logs
        WHERE timestamp >= ? AND timestamp <= ?
        ORDER BY response_time_ms ASC LIMIT 1 OFFSET ?
    `).get(from, to, offset) as { response_time_ms: number } | undefined
    return row ? Math.round(row.response_time_ms) : null
}

interface ErrorRow extends CursorValue {
    request_id: string | null
    source: string
    error_code: string | null
    message: string
    status_code: number | null
    operation: string
}

function compareTimestampAndId(a: CursorValue, b: CursorValue): number {
    if (a.timestamp !== b.timestamp) return b.timestamp.localeCompare(a.timestamp)
    return b.id.localeCompare(a.id)
}
