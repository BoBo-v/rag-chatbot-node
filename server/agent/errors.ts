export type AgentErrorCode =
    | 'AGENT_DISABLED'
    | 'AGENT_UNAUTHORIZED'
    | 'AGENT_LOOPBACK_REQUIRED'
    | 'AGENT_INVALID_REQUEST'
    | 'AGENT_PROFILE_UNSUPPORTED'
    | 'AGENT_PROVIDER_UNSUPPORTED'
    | 'AGENT_MODEL_NOT_ALLOWED'
    | 'AGENT_MODEL_UNSUPPORTED'
    | 'AGENT_LIMIT_EXCEEDED'
    | 'AGENT_QUEUE_FULL'
    | 'AGENT_QUEUE_TIMEOUT'
    | 'AGENT_TIMEOUT'
    | 'MODEL_TIMEOUT'
    | 'TOOL_TIMEOUT'
    | 'CLIENT_ABORTED'
    | 'MODEL_PROVIDER_FAILED'
    | 'MODEL_RESPONSE_INVALID'
    | 'TOOL_NOT_ALLOWED'
    | 'TOOL_ARGUMENTS_INVALID'
    | 'TOOL_EXECUTION_FAILED'

export class AgentError extends Error {
    readonly code: AgentErrorCode
    readonly statusCode: number

    constructor(code: AgentErrorCode, message: string, statusCode = 500, options?: ErrorOptions) {
        super(message, options)
        this.name = 'AgentError'
        this.code = code
        this.statusCode = statusCode
    }
}

export function isAgentError(error: unknown): error is AgentError {
    return error instanceof AgentError
}
