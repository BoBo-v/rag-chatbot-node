import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { splitTextToChunks } from '../utils/chunker'
import { getEmbeddings } from '../utils/embedding'
import {
    addFileWithChunks,
    deleteFile,
    getFileByContentHash,
    getFileDetail,
    getVectorStoreStatus,
    listFiles,
    replaceFileWithChunks,
    resetVectorStore,
    search,
    type FileDetail,
} from '../utils/vectorStore'
import { config } from '../utils/config'
import { classifyUploadError } from '../utils/errors'
import { isSupportedImageMime, parseImageWithVision } from '../utils/vision'

const pdfParse = require('pdf-parse')

type UploadProgressPhase = 'receiving' | 'parsing' | 'chunking' | 'embedding' | 'storing' | 'completed' | 'failed'

interface UploadProgress {
    id: string
    phase: UploadProgressPhase
    percent: number
    message: string
    loaded?: number
    total?: number
    done: boolean
    error?: string
    updatedAt: string
}

const uploadProgressEvents = new EventEmitter()
const uploadProgressSessions = new Map<string, UploadProgress>()
const uploadProgressTimers = new Map<string, NodeJS.Timeout>()
const uploadProgressTtlMs = 10 * 60 * 1000

export async function uploadRoutes(app: FastifyInstance) {
    app.get('/api/upload/progress/:id', {
        schema: {
            tags: ['Knowledge'],
            summary: '订阅上传进度',
            description: '通过 Server-Sent Events 返回指定 progressId 的上传和后端处理进度。',
            params: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string', description: '上传进度 ID，由前端生成并传给 /api/upload?progressId=...' },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as { id: string }
        const eventName = progressEventName(id)
        let closed = false

        const cleanup = () => {
            if (closed) return
            closed = true
            uploadProgressEvents.off(eventName, sendProgress)
        }

        reply.hijack()
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        })
        reply.raw.write('\n')

        const sendProgress = (progress: UploadProgress) => {
            if (closed || reply.raw.destroyed) return
            reply.raw.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`)
            if (progress.done) {
                cleanup()
                reply.raw.end()
            }
        }

        uploadProgressEvents.on(eventName, sendProgress)
        const currentProgress = uploadProgressSessions.get(id)
        if (currentProgress) sendProgress(currentProgress)

        request.raw.on('close', cleanup)
    })

    app.post('/api/upload', {
        schema: {
            tags: ['Knowledge'],
            summary: '上传知识库文件',
            description: '上传 txt、md 或 pdf 文件，解析文本后切块、生成 embedding，并写入本地向量存储。',
            consumes: ['multipart/form-data'],
            querystring: {
                type: 'object',
                properties: {
                    overwrite: {
                        type: 'boolean',
                        default: false,
                        description: '是否覆盖相同内容 hash 的已有文件',
                    },
                    progressId: {
                        type: 'string',
                        description: '可选，前端生成的上传进度 ID。传入后可通过 /api/upload/progress/:id 订阅进度。',
                    },
                },
            },
            response: {
                200: {
                    description: '上传成功',
                    type: 'object',
                    properties: {
                        file: { $ref: 'StoredFile#' },
                        chunks: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    text: { type: 'string', description: '切块文本' },
                                    chunkIndex: { type: 'number', description: '切块序号' },
                                },
                            },
                        },
                        deduplicated: { type: 'boolean', description: '是否命中已有相同内容文件' },
                        overwritten: { type: 'boolean', description: '是否覆盖了已有相同内容文件' },
                    },
                },
                400: { $ref: 'ErrorResponse#' },
                413: { $ref: 'ErrorResponse#' },
                500: { $ref: 'ErrorResponse#' },
                502: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const query = request.query as { overwrite?: boolean | string; progressId?: string }
        const progressId = normalizeProgressId(query.progressId)

        try {
            const file = await request.file()
            if (!file) {
                publishUploadProgress(progressId, {
                    phase: 'failed',
                    percent: 100,
                    message: '请上传文件。',
                    done: true,
                    error: 'UPLOAD_FILE_REQUIRED',
                })
                reply.status(400)
                return reply.send({ error: '请上传文件。', code: 'UPLOAD_FILE_REQUIRED' })
            }

            const ext = file.filename.split('.').pop()?.toLowerCase()
            if (!ext || !['txt', 'md', 'pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
                publishUploadProgress(progressId, {
                    phase: 'failed',
                    percent: 100,
                    message: '不支持的文件类型，仅支持 txt、md、pdf、png、jpg、webp。',
                    done: true,
                    error: 'UNSUPPORTED_FILE_TYPE',
                })
                reply.status(400)
                return reply.send({ error: '不支持的文件类型，仅支持 txt、md、pdf、png、jpg、webp。', code: 'UNSUPPORTED_FILE_TYPE' })
            }

            const buffer = await readFileWithProgress(file.file, progressId, request.headers['content-length'])
            const contentHash = createHash('sha256').update(buffer).digest('hex')
            const overwrite = query.overwrite === true || query.overwrite === 'true'
            const existingFile = await getFileByContentHash(contentHash)

            if (existingFile && !overwrite) {
                publishUploadProgress(progressId, {
                    phase: 'completed',
                    percent: 100,
                    message: '已存在相同内容文件，复用已有知识库记录。',
                    loaded: buffer.length,
                    total: buffer.length,
                    done: true,
                })
                return reply.send({
                    file: fileDetailToStoredFile(existingFile),
                    chunks: existingFile.chunks.map(chunk => ({
                        text: chunk.text,
                        chunkIndex: chunk.chunkIndex,
                    })),
                    deduplicated: true,
                    overwritten: false,
                })
            }

            let text = ''

            publishUploadProgress(progressId, {
                phase: 'parsing',
                percent: 65,
                message: '正在解析文件内容。',
                loaded: buffer.length,
                total: buffer.length,
            })
            const isImage = isSupportedImageMime(file.mimetype)
            let sourcePath: string | undefined

            if (ext === 'txt' || ext === 'md') {
                text = buffer.toString('utf-8')
            } else if (ext === 'pdf') {
                const data = await pdfParse(buffer)
                text = data.text
            } else if (isImage) {
                sourcePath = await saveUploadedSourceFile(buffer, contentHash, ext)
                publishUploadProgress(progressId, {
                    phase: 'parsing',
                    percent: 68,
                    message: `正在使用视觉模型 ${config.visionModel} 识别图片。`,
                    loaded: buffer.length,
                    total: buffer.length,
                })
                const vision = await parseImageWithVision(buffer, file.mimetype)
                text = buildVisionKnowledgeText({
                    filename: file.filename,
                    sourcePath,
                    model: vision.model,
                    markdown: vision.markdown,
                })
            }

            publishUploadProgress(progressId, {
                phase: 'chunking',
                percent: 72,
                message: '正在切分文本。',
                loaded: buffer.length,
                total: buffer.length,
            })
            const chunks = splitTextToChunks(text, config.chunkMaxLen, config.chunkOverlap)
            if (chunks.length === 0) {
                publishUploadProgress(progressId, {
                    phase: 'failed',
                    percent: 100,
                    message: '文件中没有解析到可读取文本。',
                    loaded: buffer.length,
                    total: buffer.length,
                    done: true,
                    error: 'NO_READABLE_TEXT',
                })
                reply.status(400)
                return reply.send({ error: '文件中没有解析到可读取文本。', code: 'NO_READABLE_TEXT' })
            }

            publishUploadProgress(progressId, {
                phase: 'embedding',
                percent: 82,
                message: `正在生成 ${chunks.length} 个文本块的 embedding。`,
                loaded: buffer.length,
                total: buffer.length,
            })
            const embeddings = await getEmbeddings(chunks.map(c => c.text))
            const chunkInputs = chunks.map((chunk, i) => ({
                text: chunk.text,
                embedding: embeddings[i],
                chunkIndex: chunk.index,
            }))

            const storeInput = {
                filename: file.filename,
                mimeType: file.mimetype,
                size: buffer.length,
                charCount: text.length,
                contentHash,
                chunks: chunkInputs,
            }
            let deduplicatedAfterRace = false
            publishUploadProgress(progressId, {
                phase: 'storing',
                percent: 95,
                message: '正在写入知识库。',
                loaded: buffer.length,
                total: buffer.length,
            })
            const storedFile = overwrite
                ? await replaceFileWithChunks(storeInput)
                : await addFileWithChunks(storeInput).catch(async err => {
                    if (!isContentHashConflict(err)) throw err

                    const currentFile = await getFileByContentHash(contentHash)
                    if (!currentFile) throw err
                    deduplicatedAfterRace = true
                    return fileDetailToStoredFile(currentFile)
                })

            publishUploadProgress(progressId, {
                phase: 'completed',
                percent: 100,
                message: '上传完成。',
                loaded: buffer.length,
                total: buffer.length,
                done: true,
            })
            return reply.send({
                file: storedFile,
                chunks: chunkInputs.map(chunk => ({
                    text: chunk.text,
                    chunkIndex: chunk.chunkIndex,
                })),
                deduplicated: deduplicatedAfterRace,
                overwritten: Boolean(existingFile && overwrite),
            })
        } catch (err) {
            const uploadError = classifyUploadError(err)
            publishUploadProgress(progressId, {
                phase: 'failed',
                percent: 100,
                message: uploadError.message,
                done: true,
                error: uploadError.code,
            })
            if (uploadError.statusCode >= 500) request.log.error(err)
            reply.status(uploadError.statusCode as 400 | 413 | 500 | 502)
            return reply.send({ error: uploadError.message, code: uploadError.code })
        }
    })

    app.get('/api/files', {
        schema: {
            tags: ['Knowledge'],
            summary: '查询已上传文件列表',
            response: {
                200: {
                    description: '文件列表',
                    type: 'object',
                    properties: {
                        files: {
                            type: 'array',
                            items: { $ref: 'StoredFile#' },
                        },
                    },
                },
            },
        },
    }, async () => {
        return { files: await listFiles() }
    })

    app.get('/api/files/:id', {
        schema: {
            tags: ['Knowledge'],
            summary: '查询文件详情',
            description: '查询文件元数据和 chunk 信息。响应不会返回原始 embedding 数组，只返回 embeddingSize。',
            params: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string', description: '文件 ID' },
                },
            },
            response: {
                200: {
                    description: '文件详情',
                    type: 'object',
                    properties: {
                        file: { $ref: 'FileDetail#' },
                    },
                },
                404: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const params = request.params as { id: string }
        const file = await getFileDetail(params.id)

        if (!file) {
            reply.status(404)
            return reply.send({ error: '文件不存在。', code: 'FILE_NOT_FOUND' })
        }

        return { file }
    })

    app.delete('/api/files/:id', {
        schema: {
            tags: ['Knowledge'],
            summary: '删除文件',
            description: '删除指定文件以及它对应的所有 chunk。',
            params: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string', description: '文件 ID' },
                },
            },
            response: {
                200: {
                    description: '删除成功',
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean', description: '是否删除成功' },
                    },
                },
                404: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const params = request.params as { id: string }
        const deleted = await deleteFile(params.id)

        if (!deleted) {
            reply.status(404)
            return reply.send({ error: '文件不存在。', code: 'FILE_NOT_FOUND' })
        }

        return { ok: true }
    })

    app.post('/api/vector-store/reset', {
        schema: {
            tags: ['Knowledge'],
            summary: '重置向量库',
            description: '清空本地知识库中的所有文件、chunk 和全文检索索引。该操作不可恢复，需要请求体传入确认字段。',
            body: {
                type: 'object',
                required: ['confirm'],
                properties: {
                    confirm: {
                        type: 'string',
                        description: '固定确认文本，用于避免误操作。',
                    },
                },
            },
            response: {
                200: {
                    description: '重置成功',
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean', description: '是否重置成功' },
                        filesDeleted: { type: 'number', description: '已删除文件数量' },
                        chunksDeleted: { type: 'number', description: '已删除 chunk 数量' },
                    },
                },
                400: { $ref: 'ErrorResponse#' },
                500: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const body = request.body as { confirm?: string }

        if (body.confirm !== 'RESET_VECTOR_STORE') {
            reply.status(400)
            return reply.send({
                error: '重置向量库需要传入 confirm=RESET_VECTOR_STORE。',
                code: 'VECTOR_STORE_RESET_CONFIRM_REQUIRED',
            })
        }

        const result = await resetVectorStore()
        return {
            ok: true,
            ...result,
        }
    })

    app.get('/api/vector-store/status', {
        schema: {
            tags: ['Knowledge'],
            summary: '查询向量库状态',
            description: '返回当前知识库规模、embedding 模型分布，以及是否存在与当前 EMBEDDING_MODEL 不兼容的旧向量。',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        currentEmbeddingModel: { type: 'string', description: '当前配置的 embedding 模型' },
                        fileCount: { type: 'number', description: '文件数量' },
                        chunkCount: { type: 'number', description: 'chunk 数量' },
                        compatibleChunkCount: { type: 'number', description: '与当前 embedding 模型兼容的 chunk 数量' },
                        incompatibleChunkCount: { type: 'number', description: '与当前 embedding 模型不兼容或模型未知的 chunk 数量' },
                        needsReindex: { type: 'boolean', description: '是否建议重置并重新入库' },
                        embeddingDistributions: {
                            type: 'array',
                            description: '按 embedding 模型和维度统计的 chunk 分布',
                            items: {
                                type: 'object',
                                properties: {
                                    embeddingModel: { type: 'string' },
                                    embeddingDim: { type: ['number', 'null'] },
                                    chunkCount: { type: 'number' },
                                },
                            },
                        },
                    },
                },
            },
        },
    }, async () => {
        return getVectorStoreStatus()
    })

    app.get('/api/search', {
        schema: {
            tags: ['RAG'],
            summary: '调试 RAG 检索',
            description: '对查询文本生成 embedding，并使用向量分数和关键词分数做混合检索。',
            querystring: {
                type: 'object',
                required: ['q'],
                properties: {
                    q: { type: 'string', description: '检索问题或关键词' },
                    topK: { type: 'number', minimum: 1, maximum: 20, default: config.ragTopK, description: '返回结果数量，范围 1-20' },
                    minScore: { type: 'number', minimum: 0, maximum: 1, default: config.ragMinScore, description: '最低综合分数，范围 0-1' },
                    fileId: { type: 'string', description: '可选，限定只检索某个文件' },
                },
            },
            response: {
                200: {
                    description: '检索结果',
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: '检索问题' },
                        topK: { type: 'number', description: '实际使用的返回数量' },
                        minScore: { type: 'number', description: '实际使用的最低分数' },
                        results: {
                            type: 'array',
                            items: { $ref: 'SearchResult#' },
                        },
                    },
                },
                400: { $ref: 'ErrorResponse#' },
                502: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        try {
            const query = request.query as {
                q?: string
                topK?: string
                minScore?: string
                fileId?: string
            }

            if (!query.q || typeof query.q !== 'string') {
                reply.status(400)
                return reply.send({ error: '查询参数 q 不能为空。', code: 'QUERY_REQUIRED' })
            }

            const topK = parseBoundedNumber(query.topK, config.ragTopK, 1, 20)
            const minScore = parseBoundedNumber(query.minScore, config.ragMinScore, 0, 1)
            const [embedding] = await getEmbeddings([query.q])
            const results = await search(embedding, {
                topK,
                minScore,
                fileId: query.fileId,
                query: query.q,
            })

            return {
                query: query.q,
                topK,
                minScore,
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
        } catch (err) {
            request.log.error(err)
            reply.status(502)
            return reply.send({ error: 'RAG 检索失败，请确认 Ollama embedding 服务和向量库状态正常。', code: 'RAG_SEARCH_FAILED' })
        }
    })
}

function parseBoundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
    if (!value) return fallback

    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
}

function fileDetailToStoredFile(file: FileDetail) {
    const { chunks, ...storedFile } = file
    return storedFile
}

function isContentHashConflict(err: unknown): boolean {
    return err instanceof Error && err.message.includes('UNIQUE constraint failed: files.content_hash')
}

async function saveUploadedSourceFile(buffer: Buffer, contentHash: string, ext: string): Promise<string> {
    const safeExt = ext === 'jpeg' ? 'jpg' : ext
    const relativePath = path.join(contentHash.slice(0, 2), `${contentHash}.${safeExt}`)
    const absolutePath = path.resolve(process.cwd(), config.uploadDir, relativePath)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, buffer)
    return path.join(config.uploadDir, relativePath).replace(/\\/g, '/')
}

function buildVisionKnowledgeText(input: {
    filename: string
    sourcePath: string
    model: string
    markdown: string
}): string {
    const markdown = stripOuterMarkdownFence(input.markdown)

    return [
        `# 图片资料：${input.filename}`,
        '',
        `- 原始文件：${input.sourcePath}`,
        `- 视觉模型：${input.model}`,
        '',
        '## 识别与翻译结果',
        '',
        markdown,
    ].join('\n')
}

function stripOuterMarkdownFence(markdown: string): string {
    const trimmed = markdown.trim()
    const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
    return match ? match[1].trim() : trimmed
}

async function readFileWithProgress(
    stream: NodeJS.ReadableStream,
    progressId: string | undefined,
    contentLength: string | number | string[] | undefined
): Promise<Buffer> {
    const chunks: Buffer[] = []
    const total = parseContentLength(contentLength)
    let loaded = 0

    publishUploadProgress(progressId, {
        phase: 'receiving',
        percent: 0,
        message: '正在接收上传文件。',
        loaded,
        total,
    })

    for await (const chunk of stream) {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        chunks.push(bufferChunk)
        loaded += bufferChunk.length
        publishUploadProgress(progressId, {
            phase: 'receiving',
            percent: total ? Math.min(60, Math.round((loaded / total) * 60)) : 0,
            message: '正在接收上传文件。',
            loaded,
            total,
        })
    }

    publishUploadProgress(progressId, {
        phase: 'receiving',
        percent: 60,
        message: '文件接收完成。',
        loaded,
        total: loaded,
    })

    return Buffer.concat(chunks)
}

function normalizeProgressId(value: string | undefined): string | undefined {
    if (!value) return undefined
    const trimmed = value.trim()
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(trimmed)) return undefined
    return trimmed
}

function parseContentLength(value: string | number | string[] | undefined): number | undefined {
    const rawValue = Array.isArray(value) ? value[0] : value
    if (rawValue === undefined) return undefined

    const parsed = Number(rawValue)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function publishUploadProgress(
    id: string | undefined,
    progress: Omit<UploadProgress, 'id' | 'updatedAt' | 'done'> & { done?: boolean }
): void {
    if (!id) return

    const nextProgress: UploadProgress = {
        id,
        phase: progress.phase,
        percent: Math.max(0, Math.min(100, progress.percent)),
        message: progress.message,
        loaded: progress.loaded,
        total: progress.total,
        done: progress.done ?? false,
        error: progress.error,
        updatedAt: new Date().toISOString(),
    }
    uploadProgressSessions.set(id, nextProgress)
    uploadProgressEvents.emit(progressEventName(id), nextProgress)

    if (nextProgress.done) {
        const existingTimer = uploadProgressTimers.get(id)
        if (existingTimer) clearTimeout(existingTimer)
        uploadProgressTimers.set(id, setTimeout(() => {
            uploadProgressSessions.delete(id)
            uploadProgressTimers.delete(id)
        }, uploadProgressTtlMs))
    }
}

function progressEventName(id: string): string {
    return `upload-progress:${id}`
}
