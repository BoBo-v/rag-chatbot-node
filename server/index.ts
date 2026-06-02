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
            title: 'Node Fastify RAG API',
            description: 'Fastify API for file upload, local RAG retrieval, and Ollama chat.',
            version: '1.0.0',
        },
        servers: [
            {
                url: `http://127.0.0.1:${config.port}`,
                description: 'Local server',
            },
        ],
        tags: [
            { name: 'System', description: 'Health and service metadata' },
            { name: 'Knowledge', description: 'Knowledge file upload and management' },
            { name: 'RAG', description: 'Retrieval debugging' },
            { name: 'Chat', description: 'Ollama chat proxy with RAG context' },
            { name: 'Ollama', description: 'Ollama model metadata' },
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
