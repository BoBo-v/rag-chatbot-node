import type { FastifyInstance } from 'fastify'

export async function systemRoutes(app: FastifyInstance) {
    app.get('/api/health', {
        schema: {
            tags: ['System'],
            summary: 'Health check',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        status: { type: 'string', example: 'ok' },
                    },
                },
            },
        },
    }, async () => {
        return { status: 'ok' }
    })
}
