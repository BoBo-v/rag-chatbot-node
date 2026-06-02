import { addFileWithChunks, deleteFile, getFileDetail, listFiles, search } from '../utils/vectorStore'
import { splitTextToChunks } from '../utils/chunker'
import { getEmbeddings } from '../utils/embedding'

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

async function main() {
    await verifyChunker()
    await verifyEmbeddingFastPath()
    await verifyVectorStore()

    console.log(JSON.stringify({
        ok: true,
        checks: ['chunker', 'embedding-empty-input', 'vector-store'],
    }))
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
