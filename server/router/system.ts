import type { FastifyInstance } from 'fastify'
import { queryHttpAccessLogs } from '../utils/httpAccessLog'

export async function systemRoutes(app: FastifyInstance) {
    app.get('/api/health', {
        schema: {
            tags: ['System'],
            summary: '健康检查',
            response: {
                200: {
                    description: '服务运行正常',
                    type: 'object',
                    properties: {
                        status: { type: 'string', description: '服务状态', example: 'ok' },
                    },
                },
            },
        },
    }, async () => {
        return { status: 'ok' }
    })

    app.get('/api/http-logs', {
        schema: {
            tags: ['System'],
            summary: '最近 HTTP 请求日志',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
                },
            },
        },
    }, async (request) => {
        const { limit } = request.query as { limit?: number }
        return { rows: queryHttpAccessLogs(limit ?? 30) }
    })
}
