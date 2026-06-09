import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { getEmbeddings } from '../utils/embedding'
import { search, type SearchResult } from '../utils/vectorStore'
import { config } from '../utils/config'
import { getChatProvider, listChatProviders, type ChatProviderId } from '../llm'
import { AppError } from '../utils/errors'
import { estimateTokens } from '../utils/tokenEstimator'
import { computeCost, parsePricingFromEnv } from '../utils/pricing'
import { recordMetric } from '../utils/metricsCollector'

const envPricingTable = parsePricingFromEnv(process.env.PRICING_TABLE || '')

interface ChatMessage {
    role: string
    content: string
}

interface ChatRequestBody {
    messages: ChatMessage[]
    model?: string
    provider?: ChatProviderId
    rag?: boolean
    fileId?: string
    topK?: number
    minScore?: number
    compareId?: string
}

export async function chatRoutes(app: FastifyInstance) {
    app.post('/api/chat/context', {
        schema: {
            tags: ['Chat'],
            summary: 'Preview RAG context',
            description: 'Runs the same RAG retrieval used by /api/chat without calling the model provider.',
            body: chatRequestBodySchema(),
            response: {
                200: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean', description: 'Whether RAG was enabled for this request.' },
                        prompt: { type: 'string', description: 'The system prompt that would be injected into chat.' },
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
            request.log.error(err)
            reply.status(502)
            return reply.send({ error: 'RAG context retrieval failed. Check embedding service and vector store status.', code: 'RAG_CONTEXT_FAILED' })
        }
    })

    app.post('/api/chat', {
        schema: {
            tags: ['Chat'],
            summary: 'RAG chat',
            description: 'Streams a chat response from the selected provider, optionally injecting RAG context.',
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
        const requestId = randomUUID()

        let ragEnabled = false
        let ragHitCount = 0
        let ragPromptChars = 0

        try {
            const messages = [...body.messages]
            const context = await buildRagContext(body)

            ragEnabled = context.enabled
            ragHitCount = context.results.length
            ragPromptChars = context.prompt.length

            if (context.prompt) {
                messages.unshift({
                    role: 'system',
                    content: context.prompt,
                })
            }

            const stream = await provider.streamChat({
                model,
                messages,
            })

            const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0)
            const lastMessage = body.messages[body.messages.length - 1]
            const questionPreview = lastMessage.content.slice(0, 200)
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

                recordMetric({
                    id: requestId,
                    compareId: body.compareId ?? null,
                    timestamp: startedAt,
                    endpoint: '/api/chat',
                    provider: providerId,
                    model,
                    status,
                    statusCode: null,
                    errorCode: isStreamError ? log.errorCode : null,
                    errorMessage: isStreamError ? log.errorMessage : null,
                    startedAt,
                    endedAt,
                    latencyMs,
                    ragEnabled,
                    ragHitCount,
                    ragPromptChars,
                    inputChars,
                    outputChars: log.outputChars,
                    estInputTokens,
                    estOutputTokens,
                    estCostUsd: computeCost(providerId, model, estInputTokens, estOutputTokens, envPricingTable),
                    questionPreview,
                    isTimeout: false,
                    rawError: isStreamError ? log.errorMessage : null,
                })
            }

            const wrapped = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    lineBuffer += decoder.decode(chunk, { stream: true })
                    const lines = lineBuffer.split('\n')
                    lineBuffer = lines.pop() ?? ''

                    for (const line of lines) {
                        parseMetricLine(line)
                    }

                    controller.enqueue(chunk)
                },
                flush() {
                    lineBuffer += decoder.decode()
                    parseMetricLine(lineBuffer)
                    finalizeMetric(log.status)
                },
            }))

            reply.header('Content-Type', 'application/x-ndjson')
            reply.send(wrapped)
            reply.raw.on('close', () => {
                if (!reply.raw.writableEnded) finalizeMetric('client_aborted')
            })
            return
        } catch (err) {
            request.log.error(err)
            const providerError = classifyChatProviderError(err)
            const endedAt = new Date().toISOString()
            const latencyMs = Math.round(performance.now() - requestStart)
            const isTimeout = err instanceof Error && err.name === 'AbortError'

            recordMetric({
                id: requestId,
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
                ragHitCount,
                ragPromptChars,
                inputChars: null,
                outputChars: null,
                estInputTokens: null,
                estOutputTokens: null,
                estCostUsd: 0,
                questionPreview: body.messages[body.messages.length - 1]?.content?.slice(0, 200) ?? null,
                isTimeout,
                rawError: err instanceof Error ? err.message : String(err),
            })

            reply.status(providerError.statusCode as 400 | 502)
            return reply.send({ error: providerError.message, code: providerError.code })
        }
    })

    app.get('/api/providers', {
        schema: {
            tags: ['Chat'],
            summary: 'List chat providers',
            description: 'Returns supported model providers and their default model/configured status.',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        providers: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string', description: 'Provider id.' },
                                    name: { type: 'string', description: 'Provider display name.' },
                                    defaultModel: { type: 'string', description: 'Default model.' },
                                    configured: { type: 'boolean', description: 'Whether this provider is configured.' },
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
            summary: 'List Ollama models',
            description: 'Proxies Ollama /api/tags.',
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
                    error: errText || 'Ollama returned an error while listing models.',
                    code: 'OLLAMA_TAGS_FAILED',
                })
            }

            return reply.send(await response.json())
        } catch (err) {
            request.log.error(err)
            reply.status(502)
            return reply.send({ error: 'Unable to connect to Ollama service.', code: 'OLLAMA_SERVICE_UNAVAILABLE' })
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

function chatRequestBodySchema() {
    return {
        type: 'object',
        required: ['messages'],
        properties: {
            provider: {
                type: 'string',
                enum: ['ollama', 'openai', 'anthropic'],
                default: 'ollama',
                description: 'Model provider.',
            },
            model: { type: 'string', description: 'Optional model name. Defaults to the selected provider default.' },
            rag: { type: 'boolean', default: config.ragEnabled, description: 'Whether to enable RAG retrieval.' },
            fileId: { type: 'string', description: 'Optional file id filter for RAG retrieval.' },
            topK: { type: 'number', minimum: 1, maximum: 20, default: config.ragTopK, description: 'RAG topK override.' },
            minScore: { type: 'number', minimum: 0, maximum: 1, default: config.ragMinScore, description: 'RAG minimum score override.' },
            compareId: { type: 'string', description: 'Optional group id for model comparison metrics.' },
            messages: {
                type: 'array',
                description: 'Chat messages.',
                items: {
                    type: 'object',
                    required: ['role', 'content'],
                    properties: {
                        role: { type: 'string', description: 'Message role.' },
                        content: { type: 'string', description: 'Message content.' },
                    },
                },
            },
        },
    }
}

function validateChatBody(body: ChatRequestBody): string | null {
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return 'messages must not be empty'
    }

    const lastMessage = body.messages[body.messages.length - 1]
    if (!lastMessage?.content || typeof lastMessage.content !== 'string') {
        return 'last message content must not be empty'
    }

    return null
}

async function buildRagContext(body: ChatRequestBody): Promise<{
    enabled: boolean
    prompt: string
    results: SearchResult[]
}> {
    const enabled = body.rag ?? config.ragEnabled

    if (!enabled) {
        return { enabled: false, prompt: '', results: [] }
    }

    const lastMessage = body.messages[body.messages.length - 1]
    const embeddings = await getEmbeddings([lastMessage.content])
    const results = await search(embeddings[0], {
        topK: parseBoundedNumber(body.topK, config.ragTopK, 1, 20),
        minScore: parseBoundedNumber(body.minScore, config.ragMinScore, 0, 1),
        fileId: body.fileId,
        query: lastMessage.content,
    })

    return {
        enabled: true,
        prompt: results.length > 0 ? buildRagSystemPrompt(results) : '',
        results,
    }
}

function parseBoundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
}

function toSearchResultResponse(result: SearchResult) {
    return {
        id: result.id,
        fileId: result.fileId,
        filename: result.filename,
        chunkIndex: result.chunkIndex,
        score: result.score,
        vectorScore: result.vectorScore,
        keywordScore: result.keywordScore,
        text: result.text,
        pageNumber: result.pageNumber,
    }
}

function buildRagSystemPrompt(chunks: SearchResult[]): string {
    const context = chunks
        .map(chunk => {
            const page = chunk.pageNumber ? `, page=${chunk.pageNumber}` : ''
            return [
                `[source:${chunk.filename}, chunk=${chunk.chunkIndex}, score=${chunk.score.toFixed(4)}, vector=${chunk.vectorScore.toFixed(4)}, keyword=${chunk.keywordScore.toFixed(4)}${page}]`,
                chunk.text,
            ].join('\n')
        })
        .join('\n---\n')

    return [
        'You are an assistant that answers using the provided knowledge-base context.',
        'Prefer the cited context. If the context is insufficient, say that the knowledge base does not contain enough information to confirm the answer.',
        'When using context, cite the source filename and chunk number, for example [test.pdf chunk 2].',
        'Do not invent facts, numbers, conclusions, or sources that are not in the provided context.',
        'If the context is unrelated, say that no sufficiently relevant knowledge-base content was retrieved.',
        '',
        '\u5f15\u7528\u6750\u6599:',
        context,
    ].join('\n')
}

function classifyChatProviderError(err: unknown): AppError {
    const message = err instanceof Error ? err.message : ''

    if (message.includes('OPENAI_API_KEY is not configured')) {
        return new AppError(400, 'OPENAI_NOT_CONFIGURED', 'OpenAI is not configured. Set OPENAI_API_KEY on the backend.')
    }

    if (message.includes('ANTHROPIC_API_KEY is not configured')) {
        return new AppError(400, 'ANTHROPIC_NOT_CONFIGURED', 'Anthropic is not configured. Set ANTHROPIC_API_KEY on the backend.')
    }

    if (message.includes('fetch failed') || message.includes('aborted') || message.includes('Failed to fetch')) {
        return new AppError(502, 'MODEL_PROVIDER_UNAVAILABLE', 'Model provider request failed. Check provider config, network, or local Ollama status.')
    }

    return new AppError(502, 'MODEL_PROVIDER_FAILED', 'Model provider returned an error. Check backend logs for upstream details.')
}
