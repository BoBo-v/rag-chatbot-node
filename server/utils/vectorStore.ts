interface StoredChunk {
    text: string
    embedding: number[]
    filename: string  // 来自哪个文件
}

// 内存存储
const store: StoredChunk[] = []

// 添加文档的所有 chunks
export function addChunks(chunks: StoredChunk[]): void {
    // 你来写
}

// 检索：传入问题的 embedding，返回最相似的 K 个 chunk
export function search(queryEmbedding: number[], topK: number = 3): StoredChunk[] {
    // 你来写：算每个 chunk 和 query 的余弦相似度，排序取前 K
}