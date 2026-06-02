import type { FastifyInstance } from 'fastify'
import { createRequire } from 'node:module'
import { splitTextToChunks } from '../utils/chunker'
import { getEmbeddings } from '../utils/embedding'
import { addFileWithChunks, deleteFile, getFileDetail, listFiles, search } from '../utils/vectorStore'
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

    app.get('/api/files/:id', async (request, reply) => {
        const params = request.params as { id: string }
        const file = await getFileDetail(params.id)

        if (!file) {
            reply.status(404)
            return reply.send({ error: 'File not found' })
        }

        return { file }
    })

    app.delete('/api/files/:id', async (request, reply) => {
        const params = request.params as { id: string }
        const deleted = await deleteFile(params.id)

        if (!deleted) {
            reply.status(404)
            return reply.send({ error: 'File not found' })
        }

        return { ok: true }
    })

    app.get('/api/search', async (request, reply) => {
        const query = request.query as {
            q?: string
            topK?: string
            minScore?: string
            fileId?: string
        }

        if (!query.q || typeof query.q !== 'string') {
            reply.status(400)
            return reply.send({ error: 'q is required' })
        }

        const [embedding] = await getEmbeddings([query.q])
        const results = await search(embedding, {
            topK: parseNumber(query.topK, config.ragTopK),
            minScore: parseNumber(query.minScore, config.ragMinScore),
            fileId: query.fileId,
            query: query.q,
        })

        return {
            query: query.q,
            topK: parseNumber(query.topK, config.ragTopK),
            minScore: parseNumber(query.minScore, config.ragMinScore),
            results: results.map(result => ({
                id: result.id,
                fileId: result.fileId,
                filename: result.filename,
                chunkIndex: result.chunkIndex,
                score: result.score,
                vectorScore: result.vectorScore,
                keywordScore: result.keywordScore,
                text: result.text,
                pageNumber: result.pageNumber,
            })),
        }
    })
}

function parseNumber(value: string | undefined, fallback: number): number {
    if (!value) return fallback

    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}
