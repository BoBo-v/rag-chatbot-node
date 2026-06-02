import type { FastifyInstance } from 'fastify'

export function registerSchemas(app: FastifyInstance): void {
    app.addSchema({
        $id: 'ErrorResponse',
        type: 'object',
        properties: {
            error: { type: 'string' },
        },
    })

    app.addSchema({
        $id: 'StoredFile',
        type: 'object',
        properties: {
            id: { type: 'string' },
            filename: { type: 'string' },
            mimeType: { type: 'string' },
            size: { type: 'number' },
            charCount: { type: 'number' },
            chunkCount: { type: 'number' },
            createdAt: { type: 'string' },
        },
    })

    app.addSchema({
        $id: 'ChunkDetail',
        type: 'object',
        properties: {
            id: { type: 'string' },
            fileId: { type: 'string' },
            filename: { type: 'string' },
            chunkIndex: { type: 'number' },
            text: { type: 'string' },
            createdAt: { type: 'string' },
            pageNumber: { type: 'number' },
            embeddingSize: { type: 'number' },
        },
    })

    app.addSchema({
        $id: 'FileDetail',
        type: 'object',
        properties: {
            id: { type: 'string' },
            filename: { type: 'string' },
            mimeType: { type: 'string' },
            size: { type: 'number' },
            charCount: { type: 'number' },
            chunkCount: { type: 'number' },
            createdAt: { type: 'string' },
            chunks: {
                type: 'array',
                items: { $ref: 'ChunkDetail#' },
            },
        },
    })

    app.addSchema({
        $id: 'SearchResult',
        type: 'object',
        properties: {
            id: { type: 'string' },
            fileId: { type: 'string' },
            filename: { type: 'string' },
            chunkIndex: { type: 'number' },
            score: { type: 'number' },
            vectorScore: { type: 'number' },
            keywordScore: { type: 'number' },
            text: { type: 'string' },
            pageNumber: { type: 'number' },
        },
    })
}
