export type AiRequestStatus = 'success' | 'failed' | 'stream_error' | 'client_aborted'

export interface HttpRequestLogEntry {
    id: string
    timestamp: string
    method: string
    route: string
    statusCode: number
    responseTimeMs: number
    remoteAddress: string | null
}

export interface AiRequestLogEntry {
    id: string
    requestId: string | null
    compareId: string | null
    agentRunId?: string | null
    agentStep?: number | null
    finishReason?: string | null
    toolCallCount?: number | null
    timestamp: string
    endpoint: string
    provider: string
    model: string
    status: AiRequestStatus
    statusCode: number | null
    errorCode: string | null
    errorMessage: string | null
    startedAt: string
    endedAt: string
    latencyMs: number
    ragEnabled: boolean
    ragMode: string
    ragTopK: number
    ragMinScore: number
    ragHitCount: number
    ragBestScore: number | null
    ragPromptChars: number
    embeddingModel: string
    promptVersion: string
    inputChars: number | null
    outputChars: number | null
    estInputTokens: number | null
    estOutputTokens: number | null
    estCostUsd: number
    questionPreview: string | null
    isTimeout: boolean
}

export interface ApplicationEventEntry {
    id: string
    timestamp: string
    requestId: string | null
    level: 'info' | 'warn' | 'error'
    eventType: string
    module: string
    operation: string
    statusCode: number | null
    errorCode: string | null
    message: string
    contextJson: string | null
}

export type ObservabilityQueueEntry =
    | { kind: 'http'; value: HttpRequestLogEntry }
    | { kind: 'ai'; value: AiRequestLogEntry }
    | { kind: 'event'; value: ApplicationEventEntry }

export interface ObservabilityRuntimeStatus {
    queueSize: number
    droppedLogCount: number
    lastFlushError: string | null
    lastFlushAt: string | null
    lastCleanupAt: string | null
    dropPolicy: 'drop_oldest'
}
