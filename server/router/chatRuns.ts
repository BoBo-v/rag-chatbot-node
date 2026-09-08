import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { FastifyInstance } from 'fastify'
import { executeChatRun } from '../chat/runExecutor'
import type { ChatRunRequestBody } from '../chat/types'
import {
    chatRunRequestBodySchema,
    normalizeConversationId,
    uuidPattern,
    validateChatRunBody,
} from '../chat/validation'
import { createGenerationRequestHash } from '../generation/requestHash'
import { isGenerationError } from '../generation/errors'
import type { GenerationRun } from '../generation/types'
import {
    GenerationSseQueue,
    isTerminalGenerationEvent,
    serializeGenerationSseEvent,
} from '../generation/sse'
import { getChatProvider } from '../llm'
import { config } from '../utils/config'
import { AppError } from '../utils/errors'

const idempotencyHeaderMaxLength = 80
const sseHeartbeatIntervalMs = 15_000

export async function chatRunRoutes(app: FastifyInstance) {
    app.post('/api/chat/runs', {
        schema: {
            tags: ['Chat'],
            summary: '创建可恢复的聊天生成任务',
            description: '幂等创建后台生成任务。浏览器断开不会取消任务，使用返回的 runId 查询状态或订阅事件。',
            body: chatRunRequestBodySchema(),
            response: {
                200: runEnvelopeSchema(),
                202: runEnvelopeSchema(),
                400: { $ref: 'ErrorResponse#' },
                404: { $ref: 'ErrorResponse#' },
                409: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const body = request.body as ChatRunRequestBody
        const validation = validateChatRunBody(body)
        if (validation) throw new AppError(400, 'CHAT_RUN_INVALID_REQUEST', validation)

        const idempotencyKey = headerValue(request.headers['idempotency-key'])
        if (!idempotencyKey || idempotencyKey.length > idempotencyHeaderMaxLength) {
            throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', '必须提供有效的 Idempotency-Key 请求头。')
        }
        if (idempotencyKey !== body.turnId) {
            throw new AppError(400, 'IDEMPOTENCY_KEY_MISMATCH', 'Idempotency-Key 必须与 turnId 相同。')
        }

        const providerId = body.provider || 'ollama'
        const provider = getChatProvider(providerId)
        if (!provider.info().configured) {
            throw new AppError(400, 'MODEL_PROVIDER_NOT_CONFIGURED', '所选模型厂商尚未在后端配置。')
        }
        const model = body.model || provider.info().defaultModel
        validateRegeneratedRun(app, body.regeneratedFromRunId)

        try {
            const created = app.generationRuns.create({
                runId: randomUUID(),
                runType: 'chat',
                conversationId: normalizeConversationId(body.conversationId),
                turnId: body.turnId,
                sourceUserMessageId: body.sourceUserMessageId,
                assistantMessageId: body.assistantMessageId,
                ownerId: config.defaultOwnerUserId,
                provider: providerId,
                model,
                idempotencyKey,
                requestHash: createGenerationRequestHash({ ...body, provider: providerId, model }),
                regeneratedFromRunId: body.regeneratedFromRunId,
            })

            if (created.created) {
                app.generationRuns.runInBackground(created.run.runId, signal => executeChatRun({
                    runId: created.run.runId,
                    requestId: request.id,
                    body,
                    providerId,
                    model,
                    generationRuns: app.generationRuns,
                    logger: request.log,
                }, signal))
            }

            reply.status(created.created ? 202 : 200)
            return { created: created.created, run: toRunResponse(created.run) }
        } catch (error) {
            throw asAppError(error)
        }
    })

    app.get('/api/chat/runs/:runId', {
        schema: {
            tags: ['Chat'],
            summary: '查询聊天生成任务快照',
            params: runParamsSchema(),
            response: {
                200: runEnvelopeSchema(false),
                404: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request) => {
        const { runId } = request.params as { runId: string }
        return { run: toRunResponse(requireOwnedChatRun(app, runId)) }
    })

    app.get('/api/chat/runs/:runId/events', {
        schema: {
            tags: ['Chat'],
            summary: '订阅并重放聊天生成事件',
            description: '通过 Last-Event-ID 指定已收到的 sequence。连接断开只停止订阅，不取消后台生成任务。',
            params: runParamsSchema(),
            headers: {
                type: 'object',
                properties: {
                    'last-event-id': { type: 'string', pattern: '^(0|[1-9][0-9]{0,9})$' },
                },
            },
            response: {
                400: { $ref: 'ErrorResponse#' },
                404: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const { runId } = request.params as { runId: string }
        requireOwnedChatRun(app, runId)
        const afterSequence = parseLastEventId(request.headers['last-event-id'])
        const queue = new GenerationSseQueue()
        let unsubscribe: () => void = () => undefined
        let heartbeat: ReturnType<typeof setInterval> | null = null
        let cleaned = false

        const cleanup = () => {
            if (cleaned) return
            cleaned = true
            unsubscribe()
            if (heartbeat) clearInterval(heartbeat)
            heartbeat = null
            queue.end()
        }

        reply.hijack()
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Request-Id': request.id,
        })
        reply.raw.flushHeaders()
        reply.raw.once('close', cleanup)

        unsubscribe = app.generationRuns.subscribe(runId, afterSequence, event => {
            queue.push(serializeGenerationSseEvent(event))
            if (isTerminalGenerationEvent(event)) queue.end()
        })
        heartbeat = setInterval(() => queue.push(': heartbeat\n\n'), sseHeartbeatIntervalMs)
        heartbeat.unref?.()

        const current = requireOwnedChatRun(app, runId)
        if (isTerminal(current.status)) queue.end()

        try {
            while (!reply.raw.destroyed && !reply.raw.writableEnded) {
                const chunk = await queue.shift()
                if (chunk === null) break
                if (!reply.raw.write(chunk)) {
                    await Promise.race([
                        once(reply.raw, 'drain'),
                        once(reply.raw, 'close'),
                    ])
                }
            }
        } finally {
            cleanup()
            reply.raw.removeListener('close', cleanup)
            if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end()
        }
        return
    })

    app.delete('/api/chat/runs/:runId', {
        schema: {
            tags: ['Chat'],
            summary: '取消聊天生成任务',
            description: '取消操作幂等。只有该接口会主动终止生成，SSE 或页面断开不会取消任务。',
            params: runParamsSchema(),
            response: {
                200: runEnvelopeSchema(false),
                202: runEnvelopeSchema(false),
                404: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const { runId } = request.params as { runId: string }
        const before = requireOwnedChatRun(app, runId)
        if (isTerminal(before.status)) return { run: toRunResponse(before) }

        app.generationRuns.cancel(runId)
        const current = requireOwnedChatRun(app, runId)
        reply.status(isTerminal(current.status) ? 200 : 202)
        return { run: toRunResponse(current) }
    })
}

function validateRegeneratedRun(app: FastifyInstance, runId?: string): void {
    if (!runId) return
    if (!app.generationRuns.getOwned(runId, config.defaultOwnerUserId, 'chat')) {
        throw new AppError(404, 'GENERATION_RUN_NOT_FOUND', '原生成任务不存在。')
    }
}

function requireOwnedChatRun(app: FastifyInstance, runId: string): GenerationRun {
    const run = app.generationRuns.getOwned(runId, config.defaultOwnerUserId, 'chat')
    if (!run) throw new AppError(404, 'GENERATION_RUN_NOT_FOUND', '生成任务不存在。')
    return run
}

function asAppError(error: unknown): Error {
    if (error instanceof AppError) return error
    if (isGenerationError(error)) return new AppError(error.statusCode, error.code, error.message)
    return error instanceof Error ? error : new Error('Unknown generation error')
}

function headerValue(value: string | string[] | undefined): string {
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

function parseLastEventId(value: string | string[] | undefined): number {
    const raw = headerValue(value)
    if (!raw) return 0
    if (!/^(0|[1-9][0-9]{0,9})$/.test(raw)) {
        throw new AppError(400, 'LAST_EVENT_ID_INVALID', 'Last-Event-ID 必须是非负整数。')
    }
    return Number(raw)
}

function isTerminal(status: GenerationRun['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function toRunResponse(run: GenerationRun) {
    return {
        runId: run.runId,
        runType: run.runType,
        conversationId: run.conversationId,
        turnId: run.turnId,
        sourceUserMessageId: run.sourceUserMessageId,
        assistantMessageId: run.assistantMessageId,
        status: run.status,
        provider: run.provider,
        model: run.model,
        regeneratedFromRunId: run.regeneratedFromRunId,
        outputText: run.outputText,
        lastSequence: run.lastSequence,
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        cancelRequestedAt: run.cancelRequestedAt,
    }
}

function runParamsSchema() {
    return {
        type: 'object',
        required: ['runId'],
        additionalProperties: false,
        properties: { runId: { type: 'string', pattern: uuidPattern } },
    }
}

function runEnvelopeSchema(includeCreated = true) {
    const properties: Record<string, unknown> = {
        run: {
            type: 'object',
            additionalProperties: false,
            properties: {
                runId: { type: 'string', pattern: uuidPattern },
                runType: { type: 'string', enum: ['chat', 'agent'] },
                conversationId: { type: 'string' },
                turnId: { type: 'string', pattern: uuidPattern },
                sourceUserMessageId: { type: 'string', pattern: uuidPattern },
                assistantMessageId: { type: 'string', pattern: uuidPattern },
                status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] },
                provider: { type: 'string' },
                model: { type: 'string' },
                regeneratedFromRunId: { anyOf: [{ type: 'string', pattern: uuidPattern }, { type: 'null' }] },
                outputText: { type: 'string' },
                lastSequence: { type: 'integer' },
                errorCode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                errorMessage: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { type: 'string', format: 'date-time' },
                startedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
                finishedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
                cancelRequestedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
            },
        },
    }
    if (includeCreated) properties.created = { type: 'boolean' }
    return { type: 'object', additionalProperties: false, properties }
}
