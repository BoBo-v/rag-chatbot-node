import {
    addFileWithChunks,
    deleteFile,
    getFileByContentHash,
    getFileDetail,
    listFiles,
    replaceFileWithChunks,
    search,
} from '../utils/vectorStore'
import { splitTextToChunks } from '../utils/chunker'
import { getEmbeddings } from '../utils/embedding'
import { existsSync, rmSync, writeFileSync } from 'node:fs'

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
    await verifyLegacyMigration()
    await verifyVectorStore()
    await verifyContentHashDedupe()
    await verifyHybridSearch()
    await verifyFtsAndVectorCandidateMerge()

    console.log(JSON.stringify({
        ok: true,
        checks: [
            'chunker',
            'embedding-empty-input',
            'legacy-migration',
            'vector-store',
            'content-hash-dedupe',
            'hybrid-search',
            'fts-vector-merge',
        ],
    }))
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
