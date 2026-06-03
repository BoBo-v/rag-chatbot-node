import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { chatRoutes } from './router/chat'
import { systemRoutes } from './router/system'
import { uploadRoutes } from './router/upload'
import { config } from './utils/config'
import { registerSchemas } from './utils/schemas'
import { closeVectorStore } from './utils/vectorStore'

export function buildApp(options: { logger?: boolean } = {}) {
    const app = Fastify({ logger: options.logger ?? true })

    app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })
    app.register(cors, {
        origin: (origin, callback) => {
            if (!origin || config.corsOrigins.includes(origin)) {
                callback(null, true)
                return
            }

            callback(new Error('CORS origin is not allowed'), false)
        },
    })
    app.register(swagger, {
        openapi: {
            info: {
                title: 'Node Fastify RAG 接口文档',
                description: '用于文件上传、本地 RAG 检索和 Ollama 对话代理的 Fastify 接口。',
                version: '1.0.0',
            },
            servers: [
                {
                    url: `http://127.0.0.1:${config.port}`,
                    description: '本地服务',
                },
            ],
            tags: [
                { name: 'System', description: '系统健康检查和服务状态' },
                { name: 'Knowledge', description: '知识库文件上传、查看和删除' },
                { name: 'RAG', description: 'RAG 检索调试接口' },
                { name: 'Chat', description: '带 RAG 上下文的 Ollama 对话接口' },
                { name: 'Ollama', description: 'Ollama 模型信息接口' },
            ],
        },
    })
    registerSchemas(app)
    app.addHook('preHandler', async (request, reply) => {
        if (!config.apiKey || isPublicRoute(request.url)) return

        const apiKey = request.headers['x-api-key']
        const authorization = request.headers.authorization
        const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
        const providedKey = Array.isArray(apiKey) ? apiKey[0] : apiKey

        if (providedKey === config.apiKey || bearerToken === config.apiKey) return

        reply.status(401)
        return reply.send({ error: 'Unauthorized' })
    })
    app.addHook('onClose', async () => {
        closeVectorStore()
    })
    app.register(systemRoutes)
    app.register(uploadRoutes)
    app.register(chatRoutes)

    app.register(swaggerUi, {
        routePrefix: '/docs',
    })

    return app
}

function isPublicRoute(url: string): boolean {
    return url === '/api/health' || url.startsWith('/docs')
}
