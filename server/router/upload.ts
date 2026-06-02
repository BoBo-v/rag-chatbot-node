import type { FastifyInstance } from 'fastify'
import { createRequire } from 'node:module'
import { splitTextToChunks } from '../utils/chunker'
import { getEmbeddings } from '../utils/embedding'
import { addFileWithChunks, listFiles } from '../utils/vectorStore'
import { config } from '../utils/config'

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')

export async function uploadRoutes(app: FastifyInstance) {
    app.post('/api/upload', async (request, reply) => {
        const file = await request.file()
        if (!file) {
            reply.status(400)
            return reply.send({ error: 'Please upload a file' })
        }

        const buffer = await file.toBuffer()
        const ext = file.filename.split('.').pop()?.toLowerCase()
        let text = ''

        if (ext === 'txt') {
            text = buffer.toString('utf-8')
        } else if (ext === 'pdf') {
            const data = await pdfParse(buffer)
            text = data.text
        } else {
            reply.status(400)
            return reply.send({ error: 'Unsupported file type. Only txt and pdf are supported.' })
        }

        const chunks = splitTextToChunks(text, config.chunkMaxLen, config.chunkOverlap)
        if (chunks.length === 0) {
            reply.status(400)
            return reply.send({ error: 'No readable text found in this file' })
        }

        const embeddings = await getEmbeddings(chunks.map(c => c.text))
        const chunkInputs = chunks.map((chunk, i) => ({
            text: chunk.text,
            embedding: embeddings[i],
            chunkIndex: chunk.index,
        }))

        const storedFile = await addFileWithChunks({
            filename: file.filename,
            mimeType: file.mimetype,
            size: buffer.length,
            charCount: text.length,
            chunks: chunkInputs,
        })

        return reply.send({
            file: storedFile,
            chunks: chunkInputs.map(chunk => ({
                text: chunk.text,
                chunkIndex: chunk.chunkIndex,
            })),
        })
    })

    app.get('/api/files', async () => {
        return { files: await listFiles() }
    })
}
