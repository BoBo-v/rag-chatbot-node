import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { chatRoutes } from './router/chat'
import { systemRoutes } from './router/system'
import { uploadRoutes } from './router/upload'
import { metricsRoutes } from './router/metrics'
import { config } from './utils/config'
import { registerSchemas } from './utils/schemas'
import { closeVectorStore, setDbReadyCallback } from './utils/vectorStore'
import { startMetricsCollector, stopMetricsCollector } from './utils/metricsCollector'
import { AppError, toErrorResponse } from './utils/errors'
import { recordHttpAccessLog } from './utils/httpAccessLog'

export function buildApp(options: { logger?: boolean } = {}) {
    const app = Fastify({ logger: options.logger ?? true })
    const requestStartedAt = new WeakMap<object, number>()

    app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })
    app.register(cors, {
        origin: (origin, callback) => {
            if (!origin || config.corsOrigins.includes(origin)) {
                callback(null, true)
                return
            }

            callback(new AppError(
                403,
                'CORS_ORIGIN_NOT_ALLOWED',
                `当前前端地址 ${origin} 不在后端 CORS_ORIGIN 白名单中，请更新 .env 后重启服务。`
            ), false)
        },
    })
    app.register(swagger, {
        openapi: {
            info: {
                title: 'Node Fastify RAG 接口文档',
                description: '用于文件上传、本地 RAG 检索和多模型厂商对话代理的 Fastify 接口。',
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
                { name: 'Chat', description: '带 RAG 上下文的多模型厂商对话接口' },
                { name: 'Ollama', description: 'Ollama 模型信息接口' },
            ],
        },
    })
    registerSchemas(app)
    app.setErrorHandler((err, request, reply) => {
        const response = toErrorResponse(err)
        if (response.shouldLog) request.log.error(err)
        reply.status(response.statusCode)
        return reply.send(response.body)
    })
    app.setNotFoundHandler((request, reply) => {
        reply.status(404)
        return reply.send({ error: '接口不存在，请检查请求路径和方法。', code: 'NOT_FOUND' })
    })
    app.addHook('onRequest', async (request) => {
        requestStartedAt.set(request, performance.now())
    })
    app.addHook('onResponse', async (request, reply) => {
        const startedAt = requestStartedAt.get(request) ?? performance.now()
        recordHttpAccessLog({
            id: request.id,
            timestamp: new Date().toISOString(),
            method: request.method,
            url: request.url,
            host: request.headers.host ?? null,
            remoteAddress: request.ip ?? null,
            statusCode: reply.statusCode,
            responseTimeMs: Math.round((performance.now() - startedAt) * 10) / 10,
        })
        requestStartedAt.delete(request)
    })
    app.addHook('preHandler', async (request, reply) => {
        if (!config.apiKey || isPublicRoute(request.url)) return

        const apiKey = request.headers['x-api-key']
        const authorization = request.headers.authorization
        const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
        const providedKey = Array.isArray(apiKey) ? apiKey[0] : apiKey

        if (providedKey === config.apiKey || bearerToken === config.apiKey) return

        reply.status(401)
        return reply.send({ error: '未授权，请提供正确的 x-api-key 或 Authorization Bearer Token。', code: 'UNAUTHORIZED' })
    })
    app.addHook('onClose', async () => {
        stopMetricsCollector()
        closeVectorStore()
    })
    app.register(systemRoutes)
    app.register(uploadRoutes)
    app.register(chatRoutes)
    app.register(metricsRoutes)

    app.register(swaggerUi, {
        routePrefix: '/docs',
    })

    // Start metrics collector when DB is first accessed
    setDbReadyCallback((database) => {
        startMetricsCollector(database)
    })

    return app
}

function isPublicRoute(url: string): boolean {
    return url === '/api/health' || url.startsWith('/docs') || url.startsWith('/api/upload/progress/') || url === '/api/metrics/dashboard'
}
