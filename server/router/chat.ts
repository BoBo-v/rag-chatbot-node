// server/router/chat.ts
import type { FastifyInstance } from 'fastify'
import {getEmbeddings} from "../utils/embedding";
import {search} from "../utils/vectorStore";
const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434'
const defaultModel = process.env.DEFAULT_MODEL || 'qwen2.5:7b'

export async function chatRoutes(app: FastifyInstance) {
    app.post('/api/chat', async (request, reply) => {

        const body = request.body as { messages: any[], model?: string }

        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            reply.status(400)
            return reply.send({ error: 'messages 不能为空' })
        }
        try {
            let lastContent =body.messages[body.messages.length-1].content
             const embeddings = await getEmbeddings([lastContent])
            const relevant=search(embeddings[0],3)
            // 有相关文档时才注入
            if (relevant.length > 0) {
                const context = relevant.map(c => c.text).join('\n---\n')
                body.messages.unshift({
                    role: 'system',
                    content: `请基于以下参考资料回答用户问题，如果参考资料中没有相关信息，请如实告知：\n---\n${context}`,
                })
            }
            const response = await fetch(`${ollamaUrl}/api/chat`, {
                method: 'POST',
                body: JSON.stringify({
                    model: body.model||defaultModel,
                    messages:body.messages,
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
            reply.status(502)
            return reply.send({ error: '无法连接到 Ollama 服务，请确认 Ollama 已启动' })
        }
    })
    app.get('/api/tags', async (request, reply) => {

        try {
            const response = await fetch(`${ollamaUrl}/api/tags`, {
                method: 'GET',

            })
            if (!response.ok) {
                const errText = await response.text()
                reply.status(response.status)
                return reply.send({ error: errText })
            }
            return reply.send(await response.json())
        } catch (err) {
            reply.status(502)
            return reply.send({ error: '无法连接到 Ollama 服务，请确认 Ollama 已启动' })
        }
    })
}

//POST /api/chat
// Content-Type: application/json
//
// {
//   messages: [
//     { role: "user", content: "你好" },
//     { role: "assistant", content: "..." },
//     // ...
//   ],
//   model: "qwen2.5",        // 可选，有默认值
//   stream: true
// }
