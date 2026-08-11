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

function logLevelFromEnv(): 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent' {
    const raw = process.env.LOG_LEVEL?.trim().toLowerCase()
    if (raw && ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(raw)) {
        return raw as 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
    }
    return 'info'
}

function logRemoteAddressFromEnv(): 'none' | 'masked' | 'full' {
    const raw = process.env.LOG_REMOTE_ADDRESS?.trim().toLowerCase()
    if (raw === 'masked' || raw === 'full') return raw
    return 'none'
}

function agentAccessModeFromEnv(): 'api-key' | 'loopback' {
    return process.env.AGENT_ACCESS_MODE?.trim().toLowerCase() === 'loopback' ? 'loopback' : 'api-key'
}

const chunkMaxLen = Math.min(3000, Math.max(100, numberFromEnv('CHUNK_MAX_LEN', 700)))
const chunkOverlap = Math.min(
    chunkMaxLen - 1,
    Math.max(0, numberFromEnv('CHUNK_OVERLAP', 100))
)
const globalApiKey = process.env.API_KEY || ''
const logQueryEnabled = booleanFromEnv('LOG_QUERY_ENABLED', false)
const explicitLogQueryApiKey = process.env.LOG_QUERY_API_KEY || ''
const useLegacyApiKeyForLogs = logQueryEnabled && !explicitLogQueryApiKey && Boolean(globalApiKey)

export const config = {
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    defaultModel: process.env.DEFAULT_MODEL || 'qwen3:8b',
    port: numberFromEnv('PORT', 3001),
    bodyLimitBytes: Math.max(1024, numberFromEnv('BODY_LIMIT_BYTES', 4 * 1024 * 1024)),
    apiKey: useLegacyApiKeyForLogs ? '' : globalApiKey,
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
    ragShowCitations: booleanFromEnv('RAG_SHOW_CITATIONS', false),
    ragTopK: Math.min(20, Math.max(1, Math.floor(numberFromEnv('RAG_TOP_K', 5)))),
    ragMinScore: numberFromEnv('RAG_MIN_SCORE', 0.55),
    ragVectorWeight: numberFromEnv('RAG_VECTOR_WEIGHT', 0.8),
    ragKeywordWeight: numberFromEnv('RAG_KEYWORD_WEIGHT', 0.2),
    ragVectorCandidateLimit: Math.max(100, Math.floor(numberFromEnv('RAG_VECTOR_CANDIDATE_LIMIT', 1000))),
    chunkMaxLen,
    chunkOverlap,
    maxExtractedTextChars: Math.min(5_000_000, Math.max(1, Math.floor(numberFromEnv('MAX_EXTRACTED_TEXT_CHARS', 2_000_000)))),
    maxFileChunks: Math.min(5000, Math.max(1, Math.floor(numberFromEnv('MAX_FILE_CHUNKS', 2000)))),
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
    observabilityDbPath: process.env.OBSERVABILITY_DB_PATH || 'server/data/observability.sqlite',
    logLevel: logLevelFromEnv(),
    logQueryEnabled,
    logQueryApiKey: explicitLogQueryApiKey || (useLegacyApiKeyForLogs ? globalApiKey : ''),
    logQueryUsesLegacyApiKey: useLegacyApiKeyForLogs,
    logQuestionPreview: booleanFromEnv('LOG_QUESTION_PREVIEW', false),
    logRemoteAddress: logRemoteAddressFromEnv(),
    logQueueMaxSize: Math.min(100_000, Math.max(100, Math.floor(numberFromEnv('LOG_QUEUE_MAX_SIZE', 5000)))),
    logFlushIntervalMs: Math.min(60_000, Math.max(500, Math.floor(numberFromEnv('LOG_FLUSH_INTERVAL_MS', 5000)))),
    logWriteRetryCount: Math.min(10, Math.max(0, Math.floor(numberFromEnv('LOG_WRITE_RETRY_COUNT', 3)))),
    logContextMaxChars: Math.min(10_000, Math.max(100, Math.floor(numberFromEnv('LOG_CONTEXT_MAX_CHARS', 2000)))),
    logHttpRetentionDays: Math.min(3650, Math.max(1, Math.floor(numberFromEnv('LOG_HTTP_RETENTION_DAYS', 30)))),
    logAiRetentionDays: Math.min(3650, Math.max(1, Math.floor(numberFromEnv('LOG_AI_RETENTION_DAYS', 90)))),
    logEventRetentionDays: Math.min(3650, Math.max(1, Math.floor(numberFromEnv('LOG_EVENT_RETENTION_DAYS', 90)))),
    agentEnabled: booleanFromEnv('AGENT_ENABLED', false),
    agentAccessMode: agentAccessModeFromEnv(),
    agentApiKey: process.env.AGENT_API_KEY || '',
    agentOllamaModels: listFromEnv('AGENT_OLLAMA_MODELS', ['qwen3:8b']),
    agentMaxModelTurns: 3,
    agentMaxToolCalls: 3,
    agentMaxParallelToolCalls: 1,
    agentModelConcurrency: 1,
    agentQueueMaxSize: Math.min(50, Math.max(1, Math.floor(numberFromEnv('AGENT_QUEUE_MAX_SIZE', 5)))),
    agentQueueTimeoutMs: Math.min(300_000, Math.max(1000, Math.floor(numberFromEnv('AGENT_QUEUE_TIMEOUT_MS', 30_000)))),
    agentOllamaModelTimeoutMs: Math.min(3_600_000, Math.max(1000, Math.floor(numberFromEnv('AGENT_OLLAMA_MODEL_TIMEOUT_MS', 600_000)))),
    agentRunTimeoutMs: Math.min(3_600_000, Math.max(1000, Math.floor(numberFromEnv('AGENT_RUN_TIMEOUT_MS', 1_200_000)))),
    agentConnectTimeoutMs: Math.min(120_000, Math.max(1000, Math.floor(numberFromEnv('AGENT_CONNECT_TIMEOUT_MS', 15_000)))),
    agentStreamIdleTimeoutMs: Math.min(600_000, Math.max(1000, Math.floor(numberFromEnv('AGENT_STREAM_IDLE_TIMEOUT_MS', 180_000)))),
    agentToolTimeoutMs: Math.min(60_000, Math.max(100, Math.floor(numberFromEnv('AGENT_TOOL_TIMEOUT_MS', 5000)))),
    agentToolResultMaxChars: Math.min(20_000, Math.max(256, Math.floor(numberFromEnv('AGENT_TOOL_RESULT_MAX_CHARS', 4000)))),
    agentMessageMaxCount: 20,
    agentMessageContentMaxLength: 8000,
    agentMessageTotalMaxChars: 30_000,
    agentEstimatedInputMaxTokens: 12_000,
}
