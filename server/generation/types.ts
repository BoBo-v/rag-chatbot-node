export type GenerationRunType = 'chat' | 'agent'
export type GenerationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type GenerationTerminalStatus = Extract<GenerationRunStatus, 'completed' | 'failed' | 'cancelled'>

export interface GenerationRun {
    runId: string
    runType: GenerationRunType
    conversationId: string
    turnId: string
    sourceUserMessageId: string
    assistantMessageId: string
    ownerId: string
    status: GenerationRunStatus
    provider: string
    model: string
    idempotencyKey: string
    requestHash: string
    regeneratedFromRunId: string | null
    outputText: string
    lastSequence: number
    errorCode: string | null
    errorMessage: string | null
    createdAt: string
    startedAt: string | null
    finishedAt: string | null
    cancelRequestedAt: string | null
}

export interface GenerationEvent {
    runId: string
    sequence: number
    eventType: string
    data: Record<string, unknown>
    createdAt: string
}

export interface CreateGenerationRunInput {
    runId: string
    runType: GenerationRunType
    conversationId: string
    turnId: string
    sourceUserMessageId: string
    assistantMessageId: string
    ownerId: string
    provider: string
    model: string
    idempotencyKey: string
    requestHash: string
    regeneratedFromRunId?: string | null
    createdAt?: string
}

export interface CreateGenerationRunResult {
    created: boolean
    run: GenerationRun
}

export interface AppendGenerationEventInput {
    eventType: string
    data?: Record<string, unknown>
    outputDelta?: string
    transitionTo?: GenerationRunStatus
    errorCode?: string | null
    errorMessage?: string | null
    createdAt?: string
}

export interface AppendGenerationEventResult {
    appended: boolean
    run: GenerationRun
    event: GenerationEvent | null
}
