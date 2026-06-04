import 'dotenv/config'

function numberFromEnv(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback

    const value = Number(raw)
    return Number.isFinite(value) ? value : fallback
}

function listFromEnv(name: string, fallback: string[]): string[] {
    const raw = process.env[name]
    if (!raw) return fallback

    return raw
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
}

const chunkMaxLen = Math.max(100, numberFromEnv('CHUNK_MAX_LEN', 700))
const chunkOverlap = Math.min(
    chunkMaxLen - 1,
    Math.max(0, numberFromEnv('CHUNK_OVERLAP', 100))
)

export const config = {
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    defaultModel: process.env.DEFAULT_MODEL || 'qwen3:8b',
    port: numberFromEnv('PORT', 3001),
    apiKey: process.env.API_KEY || '',
    corsOrigins: listFromEnv('CORS_ORIGIN', ['http://localhost:3000', 'http://127.0.0.1:3000']),
    embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openaiDefaultModel: process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    anthropicDefaultModel: process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-sonnet-4-5',
    ragTopK: numberFromEnv('RAG_TOP_K', 5),
    ragMinScore: numberFromEnv('RAG_MIN_SCORE', 0.35),
    ragVectorWeight: numberFromEnv('RAG_VECTOR_WEIGHT', 0.8),
    ragKeywordWeight: numberFromEnv('RAG_KEYWORD_WEIGHT', 0.2),
    chunkMaxLen,
    chunkOverlap,
    embeddingBatchSize: Math.max(1, Math.floor(numberFromEnv('EMBEDDING_BATCH_SIZE', 16))),
    ollamaTimeoutMs: Math.max(1000, numberFromEnv('OLLAMA_TIMEOUT_MS', 120000)),
    vectorStorePath: process.env.VECTOR_STORE_PATH || 'server/data/vector-store.sqlite',
}
