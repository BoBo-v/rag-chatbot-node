import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { getObservabilityDb } from '../observability/store'
import {
    querySummary,
    queryProviders,
    queryRequests,
    queryCompare,
} from '../utils/metricsStore'

const metricProviderMaxLength = 40
const metricStatusValues = ['success', 'failed', 'stream_error', 'client_aborted']
const compareIdMaxLength = 80
const safeTokenPattern = '^[A-Za-z0-9_-]+$'
const isoDateTimePattern = '^(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)(?:\\.(\\d{1,3}))?(Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$'

export async function metricsRoutes(app: FastifyInstance) {
    app.get('/api/metrics/summary', {
        schema: {
            tags: ['Metrics'],
            summary: '运行统计总览',
            description: '返回总请求数、成功率、延迟统计、总 token 和总成本。',
            querystring: {
                type: 'object',
                properties: {
                    from: { type: 'string', format: 'date-time', description: 'ISO 8601 起始时间' },
                    to: { type: 'string', format: 'date-time', description: 'ISO 8601 结束时间' },
                },
            },
        },
    }, async (request, reply) => {
        const { from, to } = request.query as { from?: string; to?: string }
        const validation = validateTimeRange(from, to)
        if (validation) {
            reply.status(400)
            return reply.send({ error: validation, code: 'INVALID_TIME_RANGE' })
        }

        const db = getObservabilityDb()
        return querySummary(db, { from, to })
    })

    app.get('/api/metrics/providers', {
        schema: {
            tags: ['Metrics'],
            summary: '按厂商/模型统计',
            description: '按 provider + model 分组的请求成功率、延迟和成本。',
            querystring: {
                type: 'object',
                properties: {
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                },
            },
        },
    }, async (request, reply) => {
        const { from, to } = request.query as { from?: string; to?: string }
        const validation = validateTimeRange(from, to)
        if (validation) {
            reply.status(400)
            return reply.send({ error: validation, code: 'INVALID_TIME_RANGE' })
        }

        const db = getObservabilityDb()
        return { providers: queryProviders(db, { from, to }) }
    })

    app.get('/api/metrics/requests', {
        schema: {
            tags: ['Metrics'],
            summary: '请求日志',
            description: '分页查询最近的 AI 请求记录。',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                    offset: { type: 'integer', minimum: 0, default: 0 },
                    provider: { type: 'string', minLength: 1, maxLength: metricProviderMaxLength, pattern: safeTokenPattern },
                    status: { type: 'string', enum: metricStatusValues },
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                },
            },
        },
    }, async (request, reply) => {
        const { limit, offset, provider, status, from, to } = request.query as {
            limit?: number
            offset?: number
            provider?: string
            status?: string
            from?: string
            to?: string
        }
        const validation = validateTimeRange(from, to)
        if (validation) {
            reply.status(400)
            return reply.send({ error: validation, code: 'INVALID_TIME_RANGE' })
        }

        const db = getObservabilityDb()
        return queryRequests(db, { limit, offset, provider, status, from, to })
    })

    app.get('/api/metrics/compare/:compareId', {
        schema: {
            tags: ['Metrics'],
            summary: '对比详情',
            description: '查询一次用户对比（同一 compareId）的所有请求和总成本。',
            params: {
                type: 'object',
                properties: {
                    compareId: { type: 'string', minLength: 1, maxLength: compareIdMaxLength, pattern: safeTokenPattern },
                },
                required: ['compareId'],
            },
        },
    }, async (request, reply) => {
        const { compareId } = request.params as { compareId: string }
        const db = getObservabilityDb()
        const result = queryCompare(db, compareId)

        if (!result) {
            reply.status(404)
            return reply.send({ error: '未找到该 compareId 对应的记录。', code: 'COMPARE_NOT_FOUND' })
        }

        return result
    })

    app.get('/api/metrics/dashboard', {
        schema: {
            tags: ['Metrics'],
            summary: '统计面板',
            description: '返回运行统计的 HTML 面板页面。',
        },
    }, async (_request, reply) => {
        const htmlPath = path.resolve(process.cwd(), 'server/dashboard.html')
        try {
            const html = readFileSync(htmlPath, 'utf-8')
            reply.type('text/html; charset=utf-8')
            return reply.send(html)
        } catch {
            reply.status(404)
            return reply.send({ error: 'Dashboard 页面未找到。', code: 'DASHBOARD_NOT_FOUND' })
        }
    })
}

function validateTimeRange(from?: string, to?: string): string | null {
    const fromTime = parseIsoDateTime(from)
    const toTime = parseIsoDateTime(to)

    if (from && fromTime === null) return 'from 必须是合法的 ISO 8601 日期时间'
    if (to && toTime === null) return 'to 必须是合法的 ISO 8601 日期时间'
    if (fromTime !== null && toTime !== null && fromTime > toTime) return 'from 不能晚于 to'

    return null
}

function parseIsoDateTime(value?: string): number | null {
    if (!value) return null

    const match = new RegExp(isoDateTimePattern).exec(value)
    if (!match) return null

    const [, year, month, day, hour, minute, second, fraction = '', zone] = match
    const millisecond = Number((fraction + '000').slice(0, 3))
    const offsetMs = zone === 'Z' ? 0 : parseTimezoneOffsetMs(zone)
    const timestamp = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        millisecond,
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
