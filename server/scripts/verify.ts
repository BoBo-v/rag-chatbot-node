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
} from '../utils/vectorStore'
import { splitTextToChunks } from '../utils/chunker'
import { getEmbeddings } from '../utils/embedding'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { ollamaNdjsonToUnifiedStream } from '../llm/ollamaProvider'
import { sseJsonToUnifiedStream } from '../llm/stream'

function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message)
}

async function verifyChunker() {
    const chunks = splitTextToChunks('一、背景\n\n这是第一句。这是第二句。\n\n二、风险\n\n风险内容。', 40, 8)

    assert(chunks.length > 0, 'chunker should return chunks')
    assert(chunks[0].text.startsWith('一、背景\n'), `Chinese heading failed: ${JSON.stringify(chunks)}`)
    assert(chunks.some(chunk => chunk.text.includes('二、风险')), `Second heading failed: ${JSON.stringify(chunks)}`)
}

async function verifyEmbeddingFastPath() {
    const embeddings = await getEmbeddings([])
    assert(embeddings.length === 0, 'empty embedding input should return []')
}

async function verifyUnifiedChatStreams() {
    const ollamaEvents = await readNdjsonObjects(ollamaNdjsonToUnifiedStream(streamFromText([
        JSON.stringify({ message: { content: '你' }, done: false }) + '\n',
        JSON.stringify({ message: { content: '好' }, done: true }) + '\n',
    ])))
    assert(
        JSON.stringify(ollamaEvents) === JSON.stringify([
            { message: { role: 'assistant', content: '你' }, done: false },
            { message: { role: 'assistant', content: '好' }, done: false },
            { message: { role: 'assistant', content: '' }, done: true },
        ]),
        `ollama stream normalization failed: ${JSON.stringify(ollamaEvents)}`
    )

    const openAiEvents = await readNdjsonObjects(sseJsonToUnifiedStream(streamFromText([
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '好' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed' })}\n\n`,
    ]), {
        extractDelta(event) {
            return event.type === 'response.output_text.delta' && typeof event.delta === 'string' ? event.delta : ''
        },
        isDone(event) {
            return event.type === 'response.completed'
        },
    }))
    assert(
        JSON.stringify(openAiEvents) === JSON.stringify([
            { message: { role: 'assistant', content: '你' }, done: false },
            { message: { role: 'assistant', content: '好' }, done: false },
            { message: { role: 'assistant', content: '' }, done: true },
        ]),
        `openai stream normalization failed: ${JSON.stringify(openAiEvents)}`
    )

    const anthropicEvents = await readNdjsonObjects(sseJsonToUnifiedStream(streamFromText([
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ]), {
        extractDelta(event) {
            const delta = event.delta as { type?: string; text?: string } | undefined
            return event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string'
                ? delta.text
                : ''
        },
        isDone(event) {
            return event.type === 'message_stop'
        },
    }))
    assert(
        JSON.stringify(anthropicEvents) === JSON.stringify([
            { message: { role: 'assistant', content: '你' }, done: false },
            { message: { role: 'assistant', content: '好' }, done: false },
            { message: { role: 'assistant', content: '' }, done: true },
        ]),
        `anthropic stream normalization failed: ${JSON.stringify(anthropicEvents)}`
    )
}

async function verifyVectorStore() {
    const created = await Promise.all([
        addFileWithChunks({
            filename: 'a.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 1,
            chunks: [{ text: 'ticket-9527', embedding: [1, 0], chunkIndex: 0 }],
        }),
        addFileWithChunks({
            filename: 'b.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 1,
            chunks: [{ text: 'other', embedding: [0, 1], chunkIndex: 0 }],
        }),
    ])

    const files = await listFiles()
    assert(created.every(file => files.some(item => item.id === file.id)), 'created files should be listed')

    const results = await search([1, 0], {
        query: 'ticket-9527',
        topK: 20,
        minScore: 0,
        fileId: created[0].id,
    })
    assert(results.length === 1 && results[0].fileId === created[0].id, `scoped search failed: ${JSON.stringify(results)}`)

    await Promise.all(created.map(file => deleteFile(file.id)))
    for (const file of created) {
        assert(await getFileDetail(file.id) === null, `delete failed for ${file.id}`)
    }
}

async function verifyContentHashDedupe() {
    const hash = 'verify-hash-9527'
    const created = await addFileWithChunks({
        filename: 'dedupe-a.txt',
        mimeType: 'text/plain',
        size: 1,
        charCount: 11,
        contentHash: hash,
        chunks: [{ text: 'first hash', embedding: [1, 0], chunkIndex: 0 }],
    })

    const byHash = await getFileByContentHash(hash)
    assert(byHash?.id === created.id, `get by content hash failed: ${JSON.stringify(byHash)}`)

    let duplicateRejected = false
    try {
        await addFileWithChunks({
            filename: 'dedupe-b.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 12,
            contentHash: hash,
            chunks: [{ text: 'second hash', embedding: [0, 1], chunkIndex: 0 }],
        })
    } catch {
        duplicateRejected = true
    }
    assert(duplicateRejected, 'duplicate content hash should be rejected by store')

    const replaced = await replaceFileWithChunks({
        filename: 'dedupe-replaced.txt',
        mimeType: 'text/plain',
        size: 2,
        charCount: 13,
        contentHash: hash,
        chunks: [{ text: 'replaced hash', embedding: [0, 1], chunkIndex: 0 }],
    })

    assert(replaced.id !== created.id, 'replace should create a fresh file record')
    assert(await getFileDetail(created.id) === null, 'replace should delete old file record')

    const replacedDetail = await getFileByContentHash(hash)
    assert(
        replacedDetail?.id === replaced.id && replacedDetail.chunks[0]?.text === 'replaced hash',
        `replace by hash failed: ${JSON.stringify(replacedDetail)}`
    )

    await deleteFile(replaced.id)
}

async function verifyVectorStoreReset() {
    await Promise.all([
        addFileWithChunks({
            filename: 'reset-a.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 30,
            chunks: [{ text: 'reset ticket alpha', embedding: [1, 0], chunkIndex: 0 }],
        }),
        addFileWithChunks({
            filename: 'reset-b.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 30,
            chunks: [{ text: 'reset ticket beta', embedding: [0, 1], chunkIndex: 0 }],
        }),
    ])

    const reset = await resetVectorStore()
    assert(reset.filesDeleted >= 2, `reset should delete files: ${JSON.stringify(reset)}`)
    assert(reset.chunksDeleted >= 2, `reset should delete chunks: ${JSON.stringify(reset)}`)
    assert((await listFiles()).length === 0, 'reset should leave no files')

    const results = await search([1, 0], {
        query: 'reset ticket alpha',
        topK: 5,
        minScore: 0,
    })
    assert(results.length === 0, `reset should clear searchable chunks: ${JSON.stringify(results)}`)
}

async function verifyEmbeddingMetadata() {
    const beforeStatus = await getVectorStoreStatus()
    const created = await addFileWithChunks({
        filename: 'metadata.txt',
        mimeType: 'text/plain',
        size: 1,
        charCount: 40,
        chunks: [{ text: 'metadata current model chunk', embedding: [1, 0], chunkIndex: 0 }],
    })

    const detail = await getFileDetail(created.id)
    assert(detail?.embeddingModel === beforeStatus.currentEmbeddingModel, `file should record embedding model: ${JSON.stringify(detail)}`)
    assert(detail?.embeddingDim === 2, `file should record embedding dim: ${JSON.stringify(detail)}`)
    assert(detail?.chunks[0]?.embeddingModel === beforeStatus.currentEmbeddingModel, `chunk should record embedding model: ${JSON.stringify(detail)}`)
    assert(detail?.chunks[0]?.embeddingDim === 2, `chunk should record embedding dim: ${JSON.stringify(detail)}`)

    const status = await getVectorStoreStatus()
    assert(status.compatibleChunkCount >= 1, `status should count compatible chunks: ${JSON.stringify(status)}`)
    assert(status.needsReindex === status.incompatibleChunkCount > 0, `status needsReindex should follow incompatible chunks: ${JSON.stringify(status)}`)

    await deleteFile(created.id)
}

async function verifyHybridSearch() {
    const created = await Promise.all([
        addFileWithChunks({
            filename: 'hybrid-a.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 40,
            chunks: [{ text: 'alpha-9527 exact keyword policy', embedding: [0, 1], chunkIndex: 0 }],
        }),
        addFileWithChunks({
            filename: 'hybrid-b.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 40,
            chunks: [{ text: 'semantic fallback only', embedding: [1, 0], chunkIndex: 0 }],
        }),
        addFileWithChunks({
            filename: 'hybrid-c.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 80,
            chunks: [
                { text: 'duplicate overlap ticket-9527 section one', embedding: [1, 0], chunkIndex: 0 },
                { text: 'duplicate overlap ticket-9527 section one', embedding: [1, 0], chunkIndex: 1 },
            ],
        }),
    ])

    const keywordResults = await search([0, 1], {
        query: 'alpha-9527',
        topK: 5,
        minScore: 0,
    })
    assert(
        keywordResults[0]?.fileId === created[0].id,
        `FTS keyword ranking failed: ${JSON.stringify(keywordResults)}`
    )

    const fallbackResults = await search([1, 0], {
        query: 'no matching lexical token',
        topK: 5,
        minScore: 0,
        fileId: created[1].id,
    })
    assert(
        fallbackResults.length === 1 && fallbackResults[0].fileId === created[1].id,
        `vector fallback failed: ${JSON.stringify(fallbackResults)}`
    )

    const dedupedResults = await search([1, 0], {
        query: 'duplicate overlap ticket-9527',
        topK: 5,
        minScore: 0,
        fileId: created[2].id,
    })
    assert(dedupedResults.length === 1, `near duplicate chunks should be collapsed: ${JSON.stringify(dedupedResults)}`)

    await Promise.all(created.map(file => deleteFile(file.id)))
}

async function verifyFtsAndVectorCandidateMerge() {
    const created = await Promise.all([
        addFileWithChunks({
            filename: 'merge-keyword.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 50,
            chunks: [{ text: 'merge-token lexical but weak semantic', embedding: [0, 1], chunkIndex: 0 }],
        }),
        addFileWithChunks({
            filename: 'merge-vector.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 50,
            chunks: [{ text: 'semantic answer without lexical token', embedding: [1, 0], chunkIndex: 0 }],
        }),
    ])

    const results = await search([1, 0], {
        query: 'merge-token',
        topK: 2,
        minScore: 0,
    })

    assert(
        results.some(result => result.fileId === created[1].id),
        `vector candidate should survive when FTS has hits: ${JSON.stringify(results)}`
    )

    await Promise.all(created.map(file => deleteFile(file.id)))
}

async function verifyChineseFtsNgrams() {
    const created = await addFileWithChunks({
        filename: 'cn-fts.txt',
        mimeType: 'text/plain',
        size: 1,
        charCount: 30,
        chunks: [{ text: '知识图谱检索可以提升中文召回质量', embedding: [0, 1], chunkIndex: 0 }],
    })

    const results = await search([0, 1], {
        query: '图谱',
        topK: 3,
        minScore: 0,
        fileId: created.id,
    })

    assert(
        results.length === 1 && results[0].keywordScore > 0,
        `Chinese FTS ngram search failed: ${JSON.stringify(results)}`
    )

    await deleteFile(created.id)
}

async function verifyLegacyMigration() {
    const target = process.env.VECTOR_STORE_PATH
    if (!target || !target.endsWith('.sqlite')) return

    const legacyPath = target.replace(/\.sqlite$/, '.json')
    for (const file of [target, `${target}-wal`, `${target}-shm`, legacyPath]) {
        if (existsSync(file)) rmSync(file, { force: true })
    }

    writeFileSync(legacyPath, JSON.stringify({
        files: [{
            id: 'legacy-file',
            filename: 'legacy.txt',
            mimeType: 'text/plain',
            size: 1,
            charCount: 12,
            chunkCount: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
        }],
        chunks: [{
            id: 'legacy-chunk',
            fileId: 'legacy-file',
            filename: 'legacy.txt',
            chunkIndex: 0,
            text: 'legacy ticket-9527',
            embedding: [1, 0],
            createdAt: '2026-01-01T00:00:00.000Z',
        }],
    }), 'utf-8')

    const detail = await getFileDetail('legacy-file')
    assert(detail?.chunks.length === 1, `legacy migration failed: ${JSON.stringify(detail)}`)
    await deleteFile('legacy-file')
}

async function main() {
    await verifyChunker()
    await verifyEmbeddingFastPath()
    await verifyUnifiedChatStreams()
    await verifyLegacyMigration()
    await verifyVectorStore()
    await verifyContentHashDedupe()
    await verifyVectorStoreReset()
    await verifyEmbeddingMetadata()
    await verifyHybridSearch()
    await verifyFtsAndVectorCandidateMerge()
    await verifyChineseFtsNgrams()

    console.log(JSON.stringify({
        ok: true,
        checks: [
            'chunker',
            'embedding-empty-input',
            'unified-chat-streams',
            'legacy-migration',
            'vector-store',
            'content-hash-dedupe',
            'vector-store-reset',
            'embedding-metadata',
            'hybrid-search',
            'fts-vector-merge',
            'chinese-fts-ngrams',
        ],
    }))
}

function streamFromText(parts: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
        start(controller) {
            for (const part of parts) {
                controller.enqueue(encoder.encode(part))
            }
            controller.close()
        },
    })
}

async function readNdjsonObjects(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const result: Array<Record<string, unknown>> = []

    while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
            if (line.trim()) result.push(JSON.parse(line) as Record<string, unknown>)
        }
    }

    buffer += decoder.decode()
    if (buffer.trim()) result.push(JSON.parse(buffer.trim()) as Record<string, unknown>)

    return result
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
