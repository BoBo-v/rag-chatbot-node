import Fastify from 'fastify'
import cors from '@fastify/cors'
import 'dotenv/config'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { chatRoutes } from './router/chat'
import { systemRoutes } from './router/system'
import { uploadRoutes } from './router/upload'
import { config } from './utils/config'
import { registerSchemas } from './utils/schemas'

const app = Fastify({ logger: true })

app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }) // 10MB upload limit
app.register(cors, { origin: true })
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
app.register(systemRoutes)
app.register(uploadRoutes)
app.register(chatRoutes)

app.register(swaggerUi, {
    routePrefix: '/docs',
})

app.listen({ port: config.port }, (err, address) => {
    if (err) throw err
    console.log(`Server running at ${address}`)
})
