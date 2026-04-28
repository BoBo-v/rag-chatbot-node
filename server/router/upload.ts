import type { FastifyInstance } from 'fastify'
import { splitTextToChunks } from '../utils/chunker'
import { createRequire } from 'module'
import { getEmbeddings } from '../utils/embedding'
import {addChunks} from "../utils/vectorStore";

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')
export async function uploadRoutes(app: FastifyInstance) {
    app.post('/api/upload', async (request, reply) => {
        const file = await request.file()
        if (!file) {
            reply.status(400)
            return reply.send({ error: '请上传文件' })
        }

        const buffer = await file.toBuffer()
        const ext = file.filename.split('.').pop()?.toLowerCase()

        let text = ''

        if(ext === 'txt'){
            text = buffer.toString('utf-8')
        }else if(ext === 'pdf'){
            const data = await pdfParse(buffer)
            text = data.text
        }else{
            reply.status(400)
            return reply.send({ error: '不支持的文件格式' })
        }

        const chunks = splitTextToChunks(text)
        const texts = chunks.map(c => c.text)
        const embeddings = await getEmbeddings(texts)

        const result = chunks.map((chunk, i) => ({
            ...chunk,
            embedding: embeddings[i],
        }))
        addChunks(result.map(chunk => ({
            text: chunk.text,
            embedding: chunk.embedding,
            filename: file.filename,
        })))

        return reply.send({
            filename: file.filename,
            charCount: text.length,
            chunkCount: chunks.length,
            chunks: result,
        })
    })
}