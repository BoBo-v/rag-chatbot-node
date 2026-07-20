import type { FastifyInstance } from 'fastify'
import { getObservabilityDb } from '../observability/store'
import {
    decodeCursor,
    queryErrors,
    queryHttpRequests,
    queryLogSummary,
    queryRecentHttpRequests,
    queryRequestDetail,
} from '../observability/queries'

const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
const safeErrorCodePattern = '^[A-Z0-9_-]+$'
const isoDateTimePattern = '^(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)(?:\\.(\\d{1,3}))?(Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$'

export async function logRoutes(app: FastifyInstance) {
    app.get('/api/logs/summary', {
        schema: {
            tags: ['Logs'],
            summary: '日志总览',
            description: '返回 HTTP、AI 调用和日志队列状态。未指定时间时默认最近 24 小时。',
            querystring: timeRangeSchema(),
        },
    }, async (request, reply) => {
        const query = request.query as { from?: string; to?: string }
        const range = parseTimeRange(query.from, query.to)
        if (typeof range === 'string') return sendValidationError(reply, range)
        return queryLogSummary(getObservabilityDb(), range.from, range.to)
    })

    app.get('/api/logs/requests', {
        schema: {
            tags: ['Logs'],
            summary: '查询 HTTP 请求日志',
            description: '按时间、路由模板、状态和耗时筛选，使用不透明游标分页。',
            querystring: {
                type: 'object',
                properties: {
                    ...timeRangeProperties(),
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                    cursor: { type: 'string', minLength: 1, maxLength: 500 },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] },
                    route: { type: 'string', minLength: 1, maxLength: 200 },
                    statusCode: { type: 'integer', minimum: 100, maximum: 599 },
                    minDurationMs: { type: 'number', minimum: 0, maximum: 86_400_000 },
                },
            },
        },
    }, async (request, reply) => {
        const query = request.query as {
            from?: string
            to?: string
            limit?: number
            cursor?: string
            method?: string
            route?: string
            statusCode?: number
            minDurationMs?: number
        }
        const range = parseTimeRange(query.from, query.to)
        if (typeof range === 'string') return sendValidationError(reply, range)
        if (!isValidCursor(query.cursor)) return sendValidationError(reply, 'cursor 无效')

        return queryHttpRequests(getObservabilityDb(), {
            ...range,
            limit: query.limit ?? 50,
            cursor: query.cursor,
            method: query.method,
            route: query.route,
            statusCode: query.statusCode,
            minDurationMs: query.minDurationMs,
        })
    })

    app.get('/api/logs/errors', {
        schema: {
            tags: ['Logs'],
            summary: '查询脱敏错误日志',
            description: '聚合 HTTP、AI 和应用错误，不返回 stack 或 rawError。',
            querystring: {
                type: 'object',
                properties: {
                    ...timeRangeProperties(),
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                    cursor: { type: 'string', minLength: 1, maxLength: 500 },
                    errorCode: { type: 'string', minLength: 1, maxLength: 100, pattern: safeErrorCodePattern },
                },
            },
        },
    }, async (request, reply) => {
        const query = request.query as {
            from?: string
            to?: string
            limit?: number
            cursor?: string
            errorCode?: string
        }
        const range = parseTimeRange(query.from, query.to)
        if (typeof range === 'string') return sendValidationError(reply, range)
        if (!isValidCursor(query.cursor)) return sendValidationError(reply, 'cursor 无效')

        return queryErrors(getObservabilityDb(), {
            ...range,
            limit: query.limit ?? 50,
            cursor: query.cursor,
            errorCode: query.errorCode,
        })
    })

    app.get('/api/logs/requests/:requestId', {
        schema: {
            tags: ['Logs'],
            summary: '按 requestId 查询请求详情',
            params: {
                type: 'object',
                required: ['requestId'],
                properties: {
                    requestId: { type: 'string', pattern: uuidPattern },
                },
            },
        },
    }, async (request, reply) => {
        const { requestId } = request.params as { requestId: string }
        const result = queryRequestDetail(getObservabilityDb(), requestId)
        if (!result) {
            reply.status(404)
            return reply.send({ error: '未找到该 requestId 对应的日志。', code: 'LOG_REQUEST_NOT_FOUND' })
        }
        return result
    })

    app.get('/api/http-logs', {
        schema: {
            tags: ['Logs'],
            summary: '最近 HTTP 请求日志（兼容接口）',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
                },
            },
        },
    }, async (request) => {
        const { limit } = request.query as { limit?: number }
        return { rows: queryRecentHttpRequests(getObservabilityDb(), limit ?? 30) }
    })
}

function timeRangeSchema() {
    return {
        type: 'object',
        properties: timeRangeProperties(),
    }
}

function timeRangeProperties() {
    return {
        from: { type: 'string', format: 'date-time', pattern: isoDateTimePattern },
        to: { type: 'string', format: 'date-time', pattern: isoDateTimePattern },
    }
}

function parseTimeRange(from?: string, to?: string): { from: string; to: string } | string {
    const now = new Date()
    const parsedTo = to ? parseIsoDateTime(to) : now.getTime()
    const parsedFrom = from ? parseIsoDateTime(from) : parsedTo === null ? null : parsedTo - 86400000

    if (parsedFrom === null) return 'from 必须是合法的 ISO 8601 日期时间'
    if (parsedTo === null) return 'to 必须是合法的 ISO 8601 日期时间'
    if (parsedFrom > parsedTo) return 'from 不能晚于 to'
    return {
        from: from ?? new Date(parsedFrom).toISOString(),
        to: to ?? new Date(parsedTo).toISOString(),
    }
}

function parseIsoDateTime(value: string): number | null {
    const match = new RegExp(isoDateTimePattern).exec(value)
    if (!match) return null

    const [, year, month, day, hour, minute, second, fraction = '', zone] = match
    const millisecond = Number((fraction + '000').slice(0, 3))
    const offsetMs = zone === 'Z' ? 0 : parseTimezoneOffsetMs(zone)
    const timestamp = Date.UTC(
        Number(year), Number(month) - 1, Number(day), Number(hour),
        Number(minute), Number(second), millisecond
    ) - offsetMs
    if (!Number.isFinite(timestamp)) return null

    const localTime = new Date(timestamp + offsetMs)
    if (
        localTime.getUTCFullYear() !== Number(year) ||
        localTime.getUTCMonth() + 1 !== Number(month) ||
        localTime.getUTCDate() !== Number(day) ||
        localTime.getUTCHours() !== Number(hour) ||
        localTime.getUTCMinutes() !== Number(minute) ||
        localTime.getUTCSeconds() !== Number(second) ||
        localTime.getUTCMilliseconds() !== millisecond
    ) {
        return null
    }
    return timestamp
}

function parseTimezoneOffsetMs(zone: string): number {
    const sign = zone[0] === '-' ? -1 : 1
    const [hours, minutes] = zone.slice(1).split(':').map(Number)
    return sign * ((hours * 60) + minutes) * 60 * 1000
}

function isValidCursor(cursor?: string): boolean {
    if (!cursor) return true
    try {
        decodeCursor(cursor)
        return true
    } catch {
        return false
    }
}

function sendValidationError(reply: { status(code: 400): unknown; send(payload: unknown): unknown }, message: string) {
    reply.status(400)
    return reply.send({ error: message, code: 'INVALID_LOG_QUERY' })
}
