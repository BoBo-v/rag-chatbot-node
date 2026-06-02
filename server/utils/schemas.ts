import type { FastifyInstance } from 'fastify'

export function registerSchemas(app: FastifyInstance): void {
    app.addSchema({
        $id: 'ErrorResponse',
        type: 'object',
        properties: {
            error: { type: 'string', description: '错误信息' },
        },
    })

    app.addSchema({
        $id: 'StoredFile',
        type: 'object',
        properties: {
            id: { type: 'string', description: '文件 ID' },
            filename: { type: 'string', description: '文件名' },
            mimeType: { type: 'string', description: '文件 MIME 类型' },
            size: { type: 'number', description: '文件大小，单位字节' },
            charCount: { type: 'number', description: '解析后的文本字符数' },
            chunkCount: { type: 'number', description: '切块数量' },
            createdAt: { type: 'string', description: '创建时间' },
        },
    })

    app.addSchema({
        $id: 'ChunkDetail',
        type: 'object',
        properties: {
            id: { type: 'string', description: 'chunk ID' },
            fileId: { type: 'string', description: '所属文件 ID' },
            filename: { type: 'string', description: '所属文件名' },
            chunkIndex: { type: 'number', description: 'chunk 序号' },
            text: { type: 'string', description: 'chunk 文本' },
            createdAt: { type: 'string', description: '创建时间' },
            pageNumber: { type: 'number', description: '页码，当前仅在可解析时返回' },
            embeddingSize: { type: 'number', description: 'embedding 向量维度' },
        },
    })

    app.addSchema({
        $id: 'FileDetail',
        type: 'object',
        properties: {
            id: { type: 'string', description: '文件 ID' },
            filename: { type: 'string', description: '文件名' },
            mimeType: { type: 'string', description: '文件 MIME 类型' },
            size: { type: 'number', description: '文件大小，单位字节' },
            charCount: { type: 'number', description: '解析后的文本字符数' },
            chunkCount: { type: 'number', description: '切块数量' },
            createdAt: { type: 'string', description: '创建时间' },
            chunks: {
                type: 'array',
                description: '文件切块列表',
                items: { $ref: 'ChunkDetail#' },
            },
        },
    })

    app.addSchema({
        $id: 'SearchResult',
        type: 'object',
        properties: {
            id: { type: 'string', description: 'chunk ID' },
            fileId: { type: 'string', description: '所属文件 ID' },
            filename: { type: 'string', description: '所属文件名' },
            chunkIndex: { type: 'number', description: 'chunk 序号' },
            score: { type: 'number', description: '综合检索分数' },
            vectorScore: { type: 'number', description: '向量相似度分数' },
            keywordScore: { type: 'number', description: '关键词命中分数' },
            text: { type: 'string', description: 'chunk 文本' },
            pageNumber: { type: 'number', description: '页码，当前仅在可解析时返回' },
        },
    })
}
