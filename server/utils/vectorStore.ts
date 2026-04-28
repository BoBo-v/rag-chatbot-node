interface StoredChunk {
    text: string
    embedding: number[]
    filename: string  // 来自哪个文件
}

// 内存存储
const store: StoredChunk[] = []

// 添加文档的所有 chunks
export function addChunks(chunks: StoredChunk[]): void {
    store.push(...chunks)
}

// 检索：传入问题的 embedding，返回最相似的 K 个 chunk
export function search(queryEmbedding: number[], topK: number = 3): StoredChunk[] {
    const scored = store.map(chunk => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, topK)
}
function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}