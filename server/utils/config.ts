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

function booleanFromEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name]
    if (!raw) return fallback

    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

function ragModeFromEnv(): boolean | 'auto' {
    const raw = process.env.RAG_MODE?.trim().toLowerCase()
    if (raw === 'auto') return 'auto'
    if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false

    if (process.env.RAG_ENABLED) return booleanFromEnv('RAG_ENABLED', true)
    return 'auto'
}

function vectorBackendFromEnv(): 'sqlite' | 'qdrant' {
    const raw = process.env.VECTOR_BACKEND?.trim().toLowerCase()
    return raw === 'qdrant' ? 'qdrant' : 'sqlite'
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
    bodyLimitBytes: Math.max(1024, numberFromEnv('BODY_LIMIT_BYTES', 4 * 1024 * 1024)),
    apiKey: process.env.API_KEY || '',
    corsOrigins: listFromEnv('CORS_ORIGIN', ['http://localhost:3000', 'http://127.0.0.1:3000']),
    embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    openaiDefaultModel: process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    anthropicDefaultModel: process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-sonnet-4-5',
    ragMode: ragModeFromEnv(),
    ragEnabled: booleanFromEnv('RAG_ENABLED', true),
    ragTopK: numberFromEnv('RAG_TOP_K', 5),
    ragMinScore: numberFromEnv('RAG_MIN_SCORE', 0.55),
    ragVectorWeight: numberFromEnv('RAG_VECTOR_WEIGHT', 0.8),
    ragKeywordWeight: numberFromEnv('RAG_KEYWORD_WEIGHT', 0.2),
    ragVectorCandidateLimit: Math.max(100, Math.floor(numberFromEnv('RAG_VECTOR_CANDIDATE_LIMIT', 1000))),
    chunkMaxLen,
    chunkOverlap,
    maxFileChunks: Math.max(1, Math.floor(numberFromEnv('MAX_FILE_CHUNKS', 2000))),
    embeddingBatchSize: Math.max(1, Math.floor(numberFromEnv('EMBEDDING_BATCH_SIZE', 16))),
    ollamaTimeoutMs: Math.max(1000, numberFromEnv('OLLAMA_TIMEOUT_MS', 900000)),
    visionModel: process.env.VISION_MODEL || 'qwen3-vl:2b',
    uploadDir: process.env.UPLOAD_DIR || 'server/data/uploads',
    vectorStorePath: process.env.VECTOR_STORE_PATH || 'server/data/vector-store.sqlite',
    vectorBackend: vectorBackendFromEnv(),
    qdrantUrl: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
    qdrantApiKey: process.env.QDRANT_API_KEY || '',
    qdrantCollection: process.env.QDRANT_COLLECTION || 'knowledge_chunks',
    qdrantDistance: process.env.QDRANT_DISTANCE || 'Cosine',
    defaultTenantId: process.env.DEFAULT_TENANT_ID || 'default',
    defaultProjectId: process.env.DEFAULT_PROJECT_ID || 'default',
    defaultOwnerUserId: process.env.DEFAULT_OWNER_USER_ID || 'local',
    metricsRetentionDays: numberFromEnv('METRICS_RETENTION_DAYS', 30),
}
