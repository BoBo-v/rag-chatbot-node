import { randomUUID } from 'node:crypto'
import { AgentError } from '../agent/errors'
import type {
    AgentMessage,
    AgentModelClient,
    AgentToolCall,
    AgentToolDefinition,
    AgentTurnInput,
    AgentTurnResult,
} from '../agent/types'
import { config } from '../utils/config'
import { fetchAgentJson } from './agentHttp'

interface OpenAiResponse {
    status?: string
    incomplete_details?: {
        reason?: string
    } | null
    output?: unknown[]
    output_text?: string
    usage?: {
        input_tokens?: number
        output_tokens?: number
    }
    error?: {
        message?: string
    }
}

export const openaiAgentProvider: AgentModelClient = {
    async runTurn(input: AgentTurnInput, signal: AbortSignal): Promise<AgentTurnResult> {
        if (!config.openaiApiKey) {
            throw new AgentError('MODEL_PROVIDER_FAILED', 'OpenAI Agent API key is not configured.', 503)
        }

        const response = await fetchAgentJson<OpenAiResponse>(
            openAiResponsesAgentUrl(config.openaiBaseUrl),
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.openaiApiKey}`,
                },
                body: JSON.stringify({
                    model: input.model,
                    input: toOpenAiAgentInput(input.messages),
                    tools: input.tools.map(toOpenAiTool),
                    max_output_tokens: 4096,
                    stream: false,
                }),
                signal,
            },
            config.agentModelTimeoutMs,
            'OpenAI',
        )

        return parseOpenAiAgentResponse(response)
    },
}

export function toOpenAiAgentInput(messages: AgentMessage[]): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = []

    for (const message of messages) {
        if (message.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: message.toolCallId,
                output: message.content,
            })
            continue
        }

        if (message.role === 'assistant') {
            if (message.content) {
                input.push({ role: 'assistant', content: message.content })
            }
            for (const toolCall of message.toolCalls) {
                input.push({
                    type: 'function_call',
                    call_id: toolCall.id,
                    name: toolCall.name,
                    arguments: JSON.stringify(toolCall.arguments),
                })
            }
            continue
        }

        input.push({ role: message.role, content: message.content })
    }

    return input
}

export function toOpenAiTool(tool: AgentToolDefinition): Record<string, unknown> {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: true,
    }
}

export function parseOpenAiAgentResponse(data: OpenAiResponse): AgentTurnResult {
    if (data.error || data.status === 'failed') {
        throw new AgentError('MODEL_PROVIDER_FAILED', 'OpenAI Agent returned a model error.', 502)
    }
    if (!Array.isArray(data.output)) {
        throw new AgentError('MODEL_RESPONSE_INVALID', 'OpenAI Agent response is missing output.', 502)
    }

    const toolCalls: AgentToolCall[] = []
    const textParts: string[] = []
    for (const item of data.output) {
        if (!isPlainObject(item)) continue

        if (item.type === 'function_call') {
            toolCalls.push(parseOpenAiToolCall(item, toolCalls.length))
            continue
        }

        if (item.type !== 'message' || item.role !== 'assistant') continue
        collectOpenAiText(item.content, textParts)
    }

    if (typeof data.output_text === 'string' && textParts.length === 0) {
        textParts.push(data.output_text)
    }

    return {
        message: {
            role: 'assistant',
            content: textParts.join(''),
            toolCalls,
        },
        finishReason: toolCalls.length > 0 ? 'tool_calls' : normalizeOpenAiFinishReason(data),
        usage: {
            inputTokens: finiteCount(data.usage?.input_tokens),
            outputTokens: finiteCount(data.usage?.output_tokens),
        },
    }
}

function parseOpenAiToolCall(value: Record<string, unknown>, index: number): AgentToolCall {
    const name = value.name
    if (typeof name !== 'string' || !name) {
        throw new AgentError('MODEL_RESPONSE_INVALID', `OpenAI Tool Call ${index + 1} is missing a name.`, 502)
    }

    const callId = typeof value.call_id === 'string' && value.call_id
        ? value.call_id
        : typeof value.id === 'string' && value.id
            ? value.id
            : `openai-${randomUUID()}`

    return {
        id: callId,
        name,
        arguments: parseOpenAiToolArguments(value.arguments, index),
    }
}

function parseOpenAiToolArguments(value: unknown, index: number): Record<string, unknown> {
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value) as unknown
        } catch (error) {
            throw new AgentError(
                'MODEL_RESPONSE_INVALID',
                `OpenAI Tool Call ${index + 1} arguments are not valid JSON.`,
                502,
                { cause: error },
            )
        }
    }
    if (!isPlainObject(parsed)) {
        throw new AgentError('MODEL_RESPONSE_INVALID', `OpenAI Tool Call ${index + 1} arguments must be an object.`, 502)
    }
    return { ...parsed }
}

function collectOpenAiText(value: unknown, target: string[]): void {
    if (typeof value === 'string') {
        target.push(value)
        return
    }
    if (!Array.isArray(value)) return

    for (const part of value) {
        if (!isPlainObject(part)) continue
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
            target.push(part.text)
        }
    }
}

function normalizeOpenAiFinishReason(data: OpenAiResponse): AgentTurnResult['finishReason'] {
    const reason = data.incomplete_details?.reason
    if (reason === 'max_output_tokens' || reason === 'max_tokens') return 'length'
    if (reason === 'content_filter') return 'content_filter'
    if (data.status === 'completed' || data.status === undefined) return 'stop'
    return 'unknown'
}

function finiteCount(value?: number): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function openAiResponsesAgentUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/$/, '')
    return normalized.endsWith('/responses') ? normalized : `${normalized}/responses`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}
