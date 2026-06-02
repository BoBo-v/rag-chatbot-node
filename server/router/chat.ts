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
    app.post('/api/chat', {
        schema: {
            tags: ['Chat'],
            summary: 'RAG 对话',
            description: '根据最后一条用户消息检索相关知识库片段，注入 system 上下文后调用 Ollama chat 接口。可通过 rag=false 关闭 RAG。',
            body: {
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
            },
            response: {
                400: { $ref: 'ErrorResponse#' },
                502: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const body = request.body as ChatRequestBody

        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            reply.status(400)
            return reply.send({ error: 'messages cannot be empty' })
        }

        const lastMessage = body.messages[body.messages.length - 1]
        if (!lastMessage?.content || typeof lastMessage.content !== 'string') {
            reply.status(400)
            return reply.send({ error: 'last message content cannot be empty' })
        }

        try {
            const messages = [...body.messages]

            if (body.rag !== false) {
                const embeddings = await getEmbeddings([lastMessage.content])
                const relevant = await search(embeddings[0], {
                    topK: parseBoundedNumber(body.topK, config.ragTopK, 1, 20),
                    minScore: parseBoundedNumber(body.minScore, config.ragMinScore, 0, 1),
                    fileId: body.fileId,
                    query: lastMessage.content,
                })

                if (relevant.length > 0) {
                    messages.unshift({
                        role: 'system',
                        content: buildRagSystemPrompt(relevant),
                    })
                }
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

function parseBoundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
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
        'Answer the user using the reference materials below when they are relevant.',
        'If the references do not contain enough information, say so clearly.',
        'When using a reference, cite it with filename and chunk number, for example: [test.pdf chunk 2].',
        'Do not invent facts or citations that are not present in the references.',
        '',
        'References:',
        context,
    ].join('\n')
}
