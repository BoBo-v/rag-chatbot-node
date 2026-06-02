import Fastify from 'fastify'
import cors from '@fastify/cors'
import 'dotenv/config'
import multipart from '@fastify/multipart'
import { chatRoutes } from './router/chat'
import { uploadRoutes } from './router/upload'
import { config } from './utils/config'

const app = Fastify({ logger: true })

app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }) // 10MB upload limit
app.register(cors, { origin: true })
app.register(uploadRoutes)
app.register(chatRoutes)

app.get('/api/health', async () => {
    return { status: 'ok' }
})

app.listen({ port: config.port }, (err, address) => {
    if (err) throw err
    console.log(`Server running at ${address}`)
})
