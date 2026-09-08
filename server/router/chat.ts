import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { config } from '../utils/config'
import { getChatProvider, listChatProviders } from '../llm'
import { estimateTokens } from '../utils/tokenEstimator'
import { computeCost, parsePricingFromEnv } from '../utils/pricing'
import { hideRagCitationsInUnifiedStream } from '../llm/stream'
import { recordAiRequest, recordApplicationEvent } from '../observability/collector'
import {
    buildRagContext,
    normalizeRagMode,
    parseBoundedNumber,
    ragModeLabel,
    ragPromptVersion,
    toSearchResultResponse,
} from '../chat/rag'
import type { ChatRequestBody } from '../chat/types'
import { chatRequestBodySchema, validateChatBody } from '../chat/validation'
import { classifyChatProviderError, isChatProviderTimeout } from '../chat/errors'

const envPricingTable = parsePricingFromEnv(process.env.PRICING_TABLE || '')
export async function chatRoutes(app: FastifyInstance) {
    app.post('/api/chat/context', {
        schema: {
            tags: ['Chat'],
            summary: '调试对话 RAG 上下文',
            description: '只执行与 /api/chat 相同的 RAG 检索，不调用 Ollama，用于检查将要注入的引用上下文。',
            body: chatRequestBodySchema(),
            response: {
                200: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean', description: '本次是否启用 RAG' },
                        prompt: { type: 'string', description: '将要注入的 system prompt。未命中时为空字符串。' },
                        results: {
                            type: 'array',
                            items: { $ref: 'SearchResult#' },
                        },
                    },
                },
                400: { $ref: 'ErrorResponse#' },
                502: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const body = request.body as ChatRequestBody
        const validation = validateChatBody(body)
        if (validation) {
            reply.status(400)
            return reply.send({ error: validation })
        }

        try {
            const context = await buildRagContext(body)
            return {
                enabled: context.enabled,
                prompt: context.prompt,
                results: context.results.map(toSearchResultResponse),
            }
        } catch (err) {
            request.log.error({ err, event: 'rag.context.failed', errorCode: 'RAG_CONTEXT_FAILED' })
            recordApplicationEvent({
                requestId: request.id,
                level: 'error',
                eventType: 'rag.context.failed',
                module: 'rag',
                operation: 'context',
                statusCode: 502,
                errorCode: 'RAG_CONTEXT_FAILED',
                message: 'RAG 上下文检索失败',
            })
            reply.status(502)
            return reply.send({ error: 'RAG 上下文检索失败，请确认 Ollama embedding 服务和向量库状态正常。', code: 'RAG_CONTEXT_FAILED' })
        }
    })

    app.post('/api/chat', {
        schema: {
            tags: ['Chat'],
            summary: 'RAG 对话',
            description: '根据最后一条用户消息检索相关知识库片段，注入 system 上下文后调用选定模型厂商。默认行为由 RAG_ENABLED 控制，可通过 rag=true/false 单次覆盖。',
            body: chatRequestBodySchema(),
            response: {
                400: { $ref: 'ErrorResponse#' },
                502: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const body = request.body as ChatRequestBody
        const validation = validateChatBody(body)
        if (validation) {
            reply.status(400)
            return reply.send({ error: validation })
        }

        const providerId = body.provider || 'ollama'
        const provider = getChatProvider(providerId)
        const model = body.model || provider.info().defaultModel
        const startedAt = new Date().toISOString()
        const requestStart = performance.now()
        const aiInvocationId = randomUUID()

        let ragEnabled = false
        let ragMode = ragModeLabel(normalizeRagMode(body.rag ?? config.ragMode))
        let ragTopK = parseBoundedNumber(body.topK, config.ragTopK, 1, 20)
        let ragMinScore = parseBoundedNumber(body.minScore, config.ragMinScore, 0, 1)
        let ragHitCount = 0
        let ragBestScore: number | null = null
        let ragPromptChars = 0

        try {
            const messages = [...body.messages]
            const context = await buildRagContext(body)

            ragEnabled = context.enabled
            ragMode = context.mode
            ragTopK = context.topK
            ragMinScore = context.minScore
            ragHitCount = context.results.length
            ragBestScore = context.bestScore
            ragPromptChars = context.prompt.length

            if (context.prompt) {
                messages.unshift({
                    role: 'system',
                    content: context.prompt,
                })
            }

            const providerStream = await provider.streamChat({
                model,
                messages,
            })
            const stream = ragEnabled && !config.ragShowCitations
                ? hideRagCitationsInUnifiedStream(providerStream)
                : providerStream

            const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0)
            const lastMessage = body.messages[body.messages.length - 1]
            const questionPreview = config.logQuestionPreview ? lastMessage.content.slice(0, 200) : null
            const decoder = new TextDecoder()
            let lineBuffer = ''
            let metricRecorded = false
            const log = {
                outputChars: 0,
                status: 'success' as 'success' | 'stream_error',
                errorCode: null as string | null,
                errorMessage: null as string | null,
            }

            const parseMetricLine = (line: string) => {
                if (!line.trim()) return

                try {
                    const parsed = JSON.parse(line) as {
                        message?: { content?: string }
                        done?: boolean
                        error?: string
                    }

                    if (parsed.message?.content) {
                        log.outputChars += parsed.message.content.length
                    }
                    if (parsed.done === true && parsed.error) {
                        log.status = 'stream_error'
                        log.errorCode = 'STREAM_ERROR'
                        log.errorMessage = parsed.error
                    }
                } catch {
                    // Ignore non-JSON fragments; the original stream is still forwarded unchanged.
                }
            }

            const finalizeMetric = (status: 'success' | 'stream_error' | 'client_aborted') => {
                if (metricRecorded) return
                metricRecorded = true

                const endedAt = new Date().toISOString()
                const latencyMs = Math.round(performance.now() - requestStart)
                const estInputTokens = estimateTokens(messages.map(message => message.content).join(' '))
                const estOutputTokens = estimateTokens('x'.repeat(log.outputChars))
                const isStreamError = status === 'stream_error'

                recordAiRequest({
                    id: aiInvocationId,
                    requestId: request.id,
                    compareId: body.compareId ?? null,
                    timestamp: startedAt,
                    endpoint: '/api/chat',
                    provider: providerId,
                    model,
                    status,
                    statusCode: status === 'client_aborted' ? null : 200,
                    errorCode: isStreamError ? log.errorCode : null,
                    errorMessage: isStreamError ? log.errorMessage : null,
                    startedAt,
                    endedAt,
                    latencyMs,
                    ragEnabled,
                    ragMode,
                    ragTopK,
                    ragMinScore,
                    ragHitCount,
                    ragBestScore,
                    ragPromptChars,
                    embeddingModel: config.embeddingModel,
                    promptVersion: ragPromptVersion,
                    inputChars,
                    outputChars: log.outputChars,
                    estInputTokens,
                    estOutputTokens,
                    estCostUsd: computeCost(providerId, model, estInputTokens, estOutputTokens, envPricingTable),
                    questionPreview,
                    isTimeout: false,
                })
            }

            const streamChunks = async function* () {
                const reader = stream.getReader()
                try {
                    while (true) {
                        const { value, done } = await reader.read()
                        if (done) break
                        if (!value) continue

                        lineBuffer += decoder.decode(value, { stream: true })
                        const lines = lineBuffer.split('\n')
                        lineBuffer = lines.pop() ?? ''

                        for (const line of lines) {
                            parseMetricLine(line)
                        }

                        yield value
                    }
                } finally {
                    lineBuffer += decoder.decode()
                    parseMetricLine(lineBuffer)
                    finalizeMetric(log.status)
                    reader.releaseLock()
                }
            }

            reply.hijack()
            reply.raw.writeHead(200, {
                'Content-Type': 'application/x-ndjson',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Request-Id': request.id,
            })
            reply.raw.on('close', () => {
                if (!reply.raw.writableEnded) finalizeMetric('client_aborted')
            })

            try {
                for await (const chunk of streamChunks()) {
                    if (!reply.raw.write(chunk)) {
                        await new Promise<void>(resolve => reply.raw.once('drain', resolve))
                    }
                }
                reply.raw.end()
            } catch (err) {
                if (!reply.raw.writableEnded) {
                    reply.raw.write(JSON.stringify({ error: err instanceof Error ? err.message : 'Stream write failed', done: true }) + '\n')
                    reply.raw.end()
                }
            }
            return
        } catch (err) {
            request.log.error({ err, event: 'chat.provider.failed', errorCode: 'MODEL_PROVIDER_FAILED' })
            const providerError = classifyChatProviderError(err)
            const endedAt = new Date().toISOString()
            const latencyMs = Math.round(performance.now() - requestStart)
            const isTimeout = isChatProviderTimeout(err)

            recordAiRequest({
                id: aiInvocationId,
                requestId: request.id,
                compareId: body.compareId ?? null,
                timestamp: startedAt,
                endpoint: '/api/chat',
                provider: providerId,
                model,
                status: 'failed',
                statusCode: providerError.statusCode,
                errorCode: providerError.code,
                errorMessage: providerError.message,
                startedAt,
                endedAt,
                latencyMs,
                ragEnabled,
                ragMode,
                ragTopK,
                ragMinScore,
                ragHitCount,
                ragBestScore,
                ragPromptChars,
                embeddingModel: config.embeddingModel,
                promptVersion: ragPromptVersion,
                inputChars: null,
                outputChars: null,
                estInputTokens: null,
                estOutputTokens: null,
                estCostUsd: 0,
                questionPreview: config.logQuestionPreview
                    ? body.messages[body.messages.length - 1]?.content?.slice(0, 200) ?? null
                    : null,
                isTimeout,
            })

            reply.status(providerError.statusCode as 400 | 502)
            return reply.send({ error: providerError.message, code: providerError.code })
        }
    })

    app.get('/api/providers', {
        schema: {
            tags: ['Chat'],
            summary: '查询可用模型厂商',
            description: '返回后端支持的模型厂商及默认模型。OpenAI 和 Claude 只有配置 API Key 后才标记为可用。',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        providers: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string', description: '厂商 ID，例如 ollama、openai、anthropic' },
                                    name: { type: 'string', description: '厂商名称' },
                                    defaultModel: { type: 'string', description: '默认模型' },
                                    configured: { type: 'boolean', description: '是否已经配置可用' },
                                    capabilities: {
                                        type: 'object',
                                        properties: {
                                            chatStream: { type: 'boolean', description: '是否支持普通文本流' },
                                            agentTools: { type: 'boolean', description: '当前是否开放 Agent Tool Calling' },
                                        },
                                    },
                                    agentModels: {
                                        type: 'array',
                                        items: { type: 'string' },
                                        description: '后端允许用于 Agent 的模型白名单',
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    }, async () => {
        return { providers: listChatProviders() }
    })

    app.get('/api/tags', {
        schema: {
            tags: ['Ollama'],
            summary: '查询 Ollama 模型列表',
            description: '代理调用 Ollama 的 /api/tags 接口，返回本地可用模型。',
            response: {
                400: { $ref: 'ErrorResponse#' },
                502: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        try {
            const response = await fetchWithTimeout(`${config.ollamaUrl}/api/tags`, {
                method: 'GET',
            }, config.ollamaTimeoutMs)

            if (!response.ok) {
                const errText = await response.text()
                reply.raw.statusCode = response.status
                return reply.send({
                    error: errText || 'Ollama 返回错误，请检查 Ollama 服务状态。',
                    code: 'OLLAMA_TAGS_FAILED',
                })
            }

            return reply.send(await response.json())
        } catch (err) {
            request.log.error({ err, event: 'ollama.tags.failed', errorCode: 'OLLAMA_SERVICE_UNAVAILABLE' })
            recordApplicationEvent({
                requestId: request.id,
                level: 'error',
                eventType: 'ollama.tags.failed',
                module: 'ollama',
                operation: 'list_models',
                statusCode: 502,
                errorCode: 'OLLAMA_SERVICE_UNAVAILABLE',
                message: '无法连接 Ollama 服务',
            })
            reply.status(502)
            return reply.send({ error: '无法连接 Ollama 服务，请确认 Ollama 已启动。', code: 'OLLAMA_SERVICE_UNAVAILABLE' })
        }
    })
}
function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    return fetch(url, {
        ...init,
        signal: controller.signal,
    }).finally(() => clearTimeout(timeout))
}
