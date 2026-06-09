import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { getMetricsDb } from '../utils/vectorStore'
import {
    querySummary,
    queryProviders,
    queryRequests,
    queryCompare,
} from '../utils/metricsStore'

export async function metricsRoutes(app: FastifyInstance) {
    app.get('/api/metrics/summary', {
        schema: {
            tags: ['Metrics'],
            summary: '运行统计总览',
            description: '返回总请求数、成功率、延迟统计、总 token 和总成本。',
            querystring: {
                type: 'object',
                properties: {
                    from: { type: 'string', description: 'ISO 8601 起始时间' },
                    to: { type: 'string', description: 'ISO 8601 结束时间' },
                },
            },
        },
    }, async (request) => {
        const { from, to } = request.query as { from?: string; to?: string }
        const db = getMetricsDb()
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
                    from: { type: 'string' },
                    to: { type: 'string' },
                },
            },
        },
    }, async (request) => {
        const { from, to } = request.query as { from?: string; to?: string }
        const db = getMetricsDb()
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
                    provider: { type: 'string' },
                    status: { type: 'string' },
                    from: { type: 'string' },
                    to: { type: 'string' },
                },
            },
        },
    }, async (request) => {
        const { limit, offset, provider, status, from, to } = request.query as {
            limit?: number
            offset?: number
            provider?: string
            status?: string
            from?: string
            to?: string
        }
        const db = getMetricsDb()
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
                    compareId: { type: 'string' },
                },
                required: ['compareId'],
            },
        },
    }, async (request, reply) => {
        const { compareId } = request.params as { compareId: string }
        const db = getMetricsDb()
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
