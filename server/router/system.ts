import type { FastifyInstance } from 'fastify'

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
}
