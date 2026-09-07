export type GenerationErrorCode =
    | 'GENERATION_RUN_NOT_FOUND'
    | 'GENERATION_IDEMPOTENCY_CONFLICT'
    | 'GENERATION_MESSAGE_CONFLICT'
    | 'GENERATION_STATE_CONFLICT'
    | 'GENERATION_OUTPUT_LIMIT_EXCEEDED'
    | 'GENERATION_EVENT_LIMIT_EXCEEDED'
    | 'GENERATION_EVENT_INVALID'

export class GenerationError extends Error {
    readonly code: GenerationErrorCode
    readonly statusCode: number

    constructor(code: GenerationErrorCode, message: string, statusCode: number, options?: ErrorOptions) {
        super(message, options)
        this.name = 'GenerationError'
        this.code = code
        this.statusCode = statusCode
    }
}

export function isGenerationError(error: unknown): error is GenerationError {
    return error instanceof GenerationError
}
