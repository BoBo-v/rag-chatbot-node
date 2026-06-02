import type { FastifyInstance } from 'fastify'
import { getEmbeddings } from '../utils/embedding'
import { search, type SearchResult } from '../utils/vectorStore'
import { getAllDefinitions } from '../utils/tools'
import { config } from '../utils/config'

export async function chatRoutes(app: FastifyInstance) {
    app.post('/api/chat', async (request, reply) => {
        const body = request.body as { messages: Array<{ role: string; content: string }>; model?: string }

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
            const embeddings = await getEmbeddings([lastMessage.content])
            const relevant = await search(embeddings[0], {
                topK: config.ragTopK,
                minScore: config.ragMinScore,
            })

            const messages = [...body.messages]
            if (relevant.length > 0) {
                messages.unshift({
                    role: 'system',
                    content: buildRagSystemPrompt(relevant),
                })
            }

            const response = await fetch(`${config.ollamaUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: body.model || config.defaultModel,
                    messages,
                    tools: getAllDefinitions(),
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

    app.get('/api/tags', async (request, reply) => {
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

function buildRagSystemPrompt(chunks: SearchResult[]): string {
    const context = chunks
        .map(chunk => {
            const page = chunk.pageNumber ? `, page=${chunk.pageNumber}` : ''
            return [
                `[source:${chunk.filename}, chunk=${chunk.chunkIndex}, score=${chunk.score.toFixed(4)}${page}]`,
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
