import type { ChatProviderId } from '../llm/types'

export const agentEventVersion = 1 as const
export const agentProfileIds = ['calculator-v0'] as const

export type AgentProfileId = typeof agentProfileIds[number]
export type AgentAccessMode = 'api-key' | 'loopback'

export interface AgentRequestMessage {
    role: 'user' | 'assistant'
    content: string
}

export interface AgentToolCall {
    id: string
    name: string
    arguments: Record<string, unknown>
}

export type AgentMessage =
    | { role: 'system' | 'user'; content: string }
    | { role: 'assistant'; content: string; toolCalls: AgentToolCall[] }
    | {
        role: 'tool'
        toolCallId: string
        name: string
        content: string
        isError: boolean
    }

export type AgentFinishReason =
    | 'stop'
    | 'tool_calls'
    | 'length'
    | 'content_filter'
    | 'unknown'

export interface AgentUsage {
    inputTokens?: number
    outputTokens?: number
}

export type AgentToolPropertySchema = {
    type: 'string' | 'number' | 'integer' | 'boolean'
    description?: string
    enum?: Array<string | number | boolean>
}

export interface AgentToolInputSchema {
    type: 'object'
    properties: Record<string, AgentToolPropertySchema>
    required?: string[]
    description?: string
    additionalProperties: false
}

export interface AgentToolDefinition {
    name: string
    description: string
    inputSchema: AgentToolInputSchema
}

export interface AgentTool {
    definition: AgentToolDefinition
    execute(argumentsValue: Record<string, unknown>, signal: AbortSignal): Promise<AgentToolExecutionResult>
}

export interface AgentTurnInput {
    model: string
    messages: AgentMessage[]
    tools: AgentToolDefinition[]
}

export interface AgentTurnResult {
    message: Extract<AgentMessage, { role: 'assistant' }>
    finishReason: AgentFinishReason
    usage?: AgentUsage
}

export interface AgentModelClient {
    runTurn(input: AgentTurnInput, signal: AbortSignal): Promise<AgentTurnResult>
}

export interface AgentModelScheduler {
    run<T>(
        task: () => Promise<T>,
        signal: AbortSignal,
        onQueued?: (position: number) => void
    ): Promise<T>
}

export interface AgentToolExecutionResult {
    content: string
    isError: boolean
}

export type AgentToolExecutor = (
    call: AgentToolCall,
    signal: AbortSignal
) => Promise<AgentToolExecutionResult>

export interface AgentRunnerEvent {
    type: Exclude<AgentEventType, 'agent_started' | 'heartbeat' | 'agent_completed' | 'agent_failed' | 'agent_cancelled'>
    step: number
    data: Record<string, unknown>
}

export type AgentRunnerEventSink = (event: AgentRunnerEvent) => void | Promise<void>

export interface AgentRunResult {
    message: Extract<AgentMessage, { role: 'assistant' }>
    messages: AgentMessage[]
    finishReason: AgentFinishReason
    modelTurns: number
    toolCallCount: number
    usage?: AgentUsage
}

export interface AgentModelInvocationRecord {
    id: string
    step: number
    model: string
    status: 'success' | 'failed'
    startedAt: string
    endedAt: string
    latencyMs: number
    finishReason: AgentFinishReason | null
    toolCallCount: number
    inputChars: number
    outputChars: number | null
    usage?: AgentUsage
    errorCode: string | null
    errorMessage: string | null
    isTimeout: boolean
}

export type AgentModelInvocationSink = (
    record: AgentModelInvocationRecord
) => void | Promise<void>

export interface AgentRunRequest {
    agentProfile: AgentProfileId
    provider: ChatProviderId
    model: string
    messages: AgentRequestMessage[]
}

export type AgentEventType =
    | 'agent_started'
    | 'agent_queued'
    | 'model_started'
    | 'model_completed'
    | 'tool_started'
    | 'tool_completed'
    | 'assistant_message'
    | 'heartbeat'
    | 'agent_completed'
    | 'agent_failed'
    | 'agent_cancelled'

export interface AgentEvent<TData extends Record<string, unknown> = Record<string, unknown>> {
    version: typeof agentEventVersion
    sequence: number
    requestId: string
    agentRunId: string
    step: number
    timestamp: string
    type: AgentEventType
    data: TData
}

export interface AgentLimits {
    maxModelTurns: number
    maxToolCalls: number
    maxParallelToolCalls: number
    toolTimeoutMs: number
    toolResultMaxChars: number
    runTimeoutMs: number
}
