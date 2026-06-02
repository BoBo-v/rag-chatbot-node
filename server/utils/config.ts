import 'dotenv/config'

function numberFromEnv(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback

    const value = Number(raw)
    return Number.isFinite(value) ? value : fallback
}

export const config = {
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    defaultModel: process.env.DEFAULT_MODEL || 'qwen2.5:7b',
    port: numberFromEnv('PORT', 3001),
    embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
    ragTopK: numberFromEnv('RAG_TOP_K', 5),
    ragMinScore: numberFromEnv('RAG_MIN_SCORE', 0.35),
    chunkMaxLen: numberFromEnv('CHUNK_MAX_LEN', 700),
    chunkOverlap: numberFromEnv('CHUNK_OVERLAP', 100),
    vectorStorePath: process.env.VECTOR_STORE_PATH || 'server/data/vector-store.json',
}
