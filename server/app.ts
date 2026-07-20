import { randomUUID } from 'node:crypto'
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
import { closeVectorStore } from './utils/vectorStore'
import { AppError, toErrorResponse } from './utils/errors'
import {
    recordApplicationEvent,
    recordHttpRequest,
    startObservability,
    stopObservability,
} from './observability/collector'
import { routeTemplateFromRequest, safeErrorForLog, safeRemoteAddress } from './observability/privacy'

export function buildApp(options: { logger?: boolean } = {}) {
    startObservability()
    const app = Fastify({
        logger: options.logger === false ? false : {
            level: config.logLevel,
            redact: {
                paths: [
                    'req.headers.authorization',
                    'req.headers.cookie',
                    'req.headers["x-api-key"]',
                    'request.headers.authorization',
                    'request.headers.cookie',
                    'request.headers["x-api-key"]',
                    'headers.authorization',
                    'headers.cookie',
                    'headers["x-api-key"]',
                    'apiKey',
                    'openaiApiKey',
                    'anthropicApiKey',
                    'qdrantApiKey',
                    'logQueryApiKey',
                ],
                censor: '[REDACTED]',
            },
            serializers: {
                req(request) {
                    return {
                        method: request.method,
                        path: pathOnly(request.url),
                    }
                },
                res(reply) {
                    return { statusCode: reply.statusCode }
                },
                err(error) {
                    return safeErrorForLog(error)
                },
            },
        },
        genReqId: () => randomUUID(),
        bodyLimit: config.bodyLimitBytes,
    })

    app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })
    app.register(cors, {
        exposedHeaders: ['X-Request-Id'],
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
        if (response.shouldLog) {
            request.log.error({
                err,
                event: 'http.request.failed',
                errorCode: response.body.code,
            })
            recordApplicationEvent({
                requestId: request.id,
                level: 'error',
                eventType: 'http.request.failed',
                module: 'http',
                operation: routeTemplateFromRequest(request),
                statusCode: response.statusCode,
                errorCode: response.body.code ?? null,
                message: response.body.error,
            })
        }
        reply.status(response.statusCode)
        return reply.send(response.body)
    })
    app.setNotFoundHandler((request, reply) => {
        reply.status(404)
        return reply.send({ error: '接口不存在，请检查请求路径和方法。', code: 'NOT_FOUND' })
    })
    app.addHook('onRequest', async (request, reply) => {
        const startedAt = performance.now()
        let recorded = false
        const recordCompletedRequest = () => {
            if (recorded) return
            recorded = true
            recordHttpRequest({
                id: request.id,
                timestamp: new Date().toISOString(),
                method: request.method,
                route: routeTemplateFromRequest(request),
                remoteAddress: safeRemoteAddress(request.ip),
                statusCode: reply.raw.statusCode,
                responseTimeMs: Math.round((performance.now() - startedAt) * 10) / 10,
            })
        }

        reply.raw.once('finish', recordCompletedRequest)
        reply.raw.once('close', recordCompletedRequest)
        reply.header('X-Request-Id', request.id)
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
        stopObservability()
        closeVectorStore()
    })
    app.register(systemRoutes)
    app.register(uploadRoutes)
    app.register(chatRoutes)
    app.register(metricsRoutes)

    app.register(swaggerUi, {
        routePrefix: '/docs',
    })

    return app
}

function isPublicRoute(url: string): boolean {
    return url === '/api/health' || url.startsWith('/docs') || url.startsWith('/api/upload/progress/') || url === '/api/metrics/dashboard'
}

function pathOnly(url?: string): string {
    if (!url) return '/'
    return (url.split('?')[0] || '/').slice(0, 200)
}
