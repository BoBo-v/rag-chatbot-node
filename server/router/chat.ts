import type { FastifyInstance } from 'fastify'
import { getEmbeddings } from '../utils/embedding'
import { search, type SearchResult } from '../utils/vectorStore'
import { config } from '../utils/config'

interface ChatMessage {
    role: string
    content: string
}

interface ChatRequestBody {
    messages: ChatMessage[]
    model?: string
    rag?: boolean
    fileId?: string
    topK?: number
    minScore?: number
}

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
            request.log.error(err)
            reply.status(502)
            return reply.send({ error: 'Failed to retrieve RAG context' })
        }
    })

    app.post('/api/chat', {
        schema: {
            tags: ['Chat'],
            summary: 'RAG 对话',
            description: '根据最后一条用户消息检索相关知识库片段，注入 system 上下文后调用 Ollama chat 接口。可通过 rag=false 关闭 RAG。',
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

        try {
            const messages = [...body.messages]
            const context = await buildRagContext(body)

            if (context.prompt) {
                messages.unshift({
                    role: 'system',
                    content: context.prompt,
                })
            }

            const response = await fetch(`${config.ollamaUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: body.model || config.defaultModel,
                    messages,
                    stream: true,
                }),
            })

            if (!response.ok) {
                const errText = await response.text()
                reply.status(response.status)
                return reply.send({ error: errText })
            }

            reply.header('Content-Type', 'application/x-ndjson')
            return reply.send(response.body)
        } catch (err) {
            request.log.error(err)
            reply.status(502)
            return reply.send({ error: 'Failed to call Ollama or retrieve RAG context' })
        }
    })

    app.get('/api/tags', {
        schema: {
            tags: ['Ollama'],
            summary: '查询 Ollama 模型列表',
            description: '代理调用 Ollama 的 /api/tags 接口，返回本地可用模型。',
            response: {
                502: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        try {
            const response = await fetch(`${config.ollamaUrl}/api/tags`, {
                method: 'GET',
            })

            if (!response.ok) {
                const errText = await response.text()
                reply.status(response.status)
                return reply.send({ error: errText })
            }

            return reply.send(await response.json())
        } catch (err) {
            request.log.error(err)
            reply.status(502)
            return reply.send({ error: 'Failed to connect to Ollama service' })
        }
    })
}

function chatRequestBodySchema() {
    return {
        type: 'object',
        required: ['messages'],
        properties: {
            model: { type: 'string', default: config.defaultModel, description: '可选，Ollama 对话模型名称' },
            rag: { type: 'boolean', default: true, description: '是否启用 RAG 检索。设为 false 时只调用模型，不注入知识库上下文。' },
            fileId: { type: 'string', description: '可选，限定只检索某个已上传文件。' },
            topK: { type: 'number', minimum: 1, maximum: 20, default: config.ragTopK, description: '可选，覆盖本次 RAG 返回数量。' },
            minScore: { type: 'number', minimum: 0, maximum: 1, default: config.ragMinScore, description: '可选，覆盖本次 RAG 最低综合分数。' },
            messages: {
                type: 'array',
                description: '对话消息列表',
                items: {
                    type: 'object',
                    required: ['role', 'content'],
                    properties: {
                        role: { type: 'string', description: '消息角色，例如 user、assistant、system' },
                        content: { type: 'string', description: '消息内容' },
                    },
                },
            },
        },
    }
}

function validateChatBody(body: ChatRequestBody): string | null {
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return 'messages cannot be empty'
    }

    const lastMessage = body.messages[body.messages.length - 1]
    if (!lastMessage?.content || typeof lastMessage.content !== 'string') {
        return 'last message content cannot be empty'
    }

    return null
}

async function buildRagContext(body: ChatRequestBody): Promise<{
    enabled: boolean
    prompt: string
    results: SearchResult[]
}> {
    if (body.rag === false) {
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
        '你是一个基于知识库回答问题的助手。',
        '请优先使用下面的引用材料回答用户问题；如果引用材料不足以支持答案，必须明确说明“知识库资料不足，无法确认”。',
        '使用引用材料时，必须标注来源文件名和 chunk 编号，例如：[test.pdf chunk 2]。',
        '不要编造引用材料中不存在的事实、数字、结论或来源。',
        '如果引用材料与问题无关，请直接说明没有检索到足够相关的知识库内容。',
        '',
        '引用材料：',
        context,
    ].join('\n')
}
