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

interface AnthropicResponse {
    content?: unknown[]
    stop_reason?: string | null
    usage?: {
        input_tokens?: number
        output_tokens?: number
    }
    error?: {
        message?: string
    }
}

interface AnthropicMessage {
    role: 'user' | 'assistant'
    content: Array<Record<string, unknown>>
}

export const anthropicAgentProvider: AgentModelClient = {
    async runTurn(input: AgentTurnInput, signal: AbortSignal): Promise<AgentTurnResult> {
        if (!config.anthropicApiKey) {
            throw new AgentError('MODEL_PROVIDER_FAILED', 'Anthropic Agent API key is not configured.', 503)
        }

        const { system, messages } = toAnthropicAgentMessages(input.messages)
        const response = await fetchAgentJson<AnthropicResponse>(
            anthropicMessagesAgentUrl(config.anthropicBaseUrl),
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.anthropicApiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: input.model,
                    max_tokens: 4096,
                    system: system || undefined,
                    messages,
                    tools: input.tools.map(toAnthropicTool),
                    stream: false,
                }),
                signal,
            },
            config.agentModelTimeoutMs,
            'Anthropic',
        )

        return parseAnthropicAgentResponse(response)
    },
}

export function toAnthropicAgentMessages(messages: AgentMessage[]): {
    system: string
    messages: AnthropicMessage[]
} {
    const system: string[] = []
    const result: AnthropicMessage[] = []

    for (const message of messages) {
        if (message.role === 'system') {
            system.push(message.content)
            continue
        }

        if (message.role === 'tool') {
            appendAnthropicMessage(result, 'user', [{
                type: 'tool_result',
                tool_use_id: message.toolCallId,
                content: message.content,
                ...(message.isError ? { is_error: true } : {}),
            }])
            continue
        }

        if (message.role === 'assistant') {
            const content: Array<Record<string, unknown>> = []
            if (message.content) content.push({ type: 'text', text: message.content })
            for (const toolCall of message.toolCalls) {
                content.push({
                    type: 'tool_use',
                    id: toolCall.id,
                    name: toolCall.name,
                    input: { ...toolCall.arguments },
                })
            }
            if (content.length === 0) content.push({ type: 'text', text: '' })
            appendAnthropicMessage(result, 'assistant', content)
            continue
        }

        appendAnthropicMessage(result, 'user', [{ type: 'text', text: message.content }])
    }

    return {
        system: system.join('\n\n'),
        messages: result,
    }
}

export function toAnthropicTool(tool: AgentToolDefinition): Record<string, unknown> {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
    }
}

export function parseAnthropicAgentResponse(data: AnthropicResponse): AgentTurnResult {
    if (data.error) {
        throw new AgentError('MODEL_PROVIDER_FAILED', 'Anthropic Agent returned a model error.', 502)
    }
    if (!Array.isArray(data.content)) {
        throw new AgentError('MODEL_RESPONSE_INVALID', 'Anthropic Agent response is missing content.', 502)
    }

    const toolCalls: AgentToolCall[] = []
    const textParts: string[] = []
    for (const block of data.content) {
        if (!isPlainObject(block)) continue
        if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text)
            continue
        }
        if (block.type === 'tool_use') {
            toolCalls.push(parseAnthropicToolCall(block, toolCalls.length))
        }
    }

    return {
        message: {
            role: 'assistant',
            content: textParts.join(''),
            toolCalls,
        },
        finishReason: toolCalls.length > 0
            ? 'tool_calls'
            : normalizeAnthropicFinishReason(data.stop_reason),
        usage: {
            inputTokens: finiteCount(data.usage?.input_tokens),
            outputTokens: finiteCount(data.usage?.output_tokens),
        },
    }
}

function parseAnthropicToolCall(value: Record<string, unknown>, index: number): AgentToolCall {
    const name = value.name
    if (typeof name !== 'string' || !name) {
        throw new AgentError('MODEL_RESPONSE_INVALID', `Anthropic Tool Use ${index + 1} is missing a name.`, 502)
    }

    const id = typeof value.id === 'string' && value.id ? value.id : `anthropic-${randomUUID()}`
    return {
        id,
        name,
        arguments: parseAnthropicToolArguments(value.input, index),
    }
}

function parseAnthropicToolArguments(value: unknown, index: number): Record<string, unknown> {
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value) as unknown
        } catch (error) {
            throw new AgentError(
                'MODEL_RESPONSE_INVALID',
                `Anthropic Tool Use ${index + 1} input is not valid JSON.`,
                502,
                { cause: error },
            )
        }
    }
    if (!isPlainObject(parsed)) {
        throw new AgentError('MODEL_RESPONSE_INVALID', `Anthropic Tool Use ${index + 1} input must be an object.`, 502)
    }
    return { ...parsed }
}

function normalizeAnthropicFinishReason(value: string | null | undefined): AgentTurnResult['finishReason'] {
    if (value === 'end_turn' || value === 'stop_sequence') return 'stop'
    if (value === 'max_tokens') return 'length'
    if (value === 'refusal') return 'content_filter'
    return 'unknown'
}

function appendAnthropicMessage(
    messages: AnthropicMessage[],
    role: AnthropicMessage['role'],
    content: Array<Record<string, unknown>>,
): void {
    const last = messages.at(-1)
    if (last?.role === role) {
        last.content.push(...content)
        return
    }
    messages.push({ role, content })
}

function finiteCount(value?: number): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function anthropicMessagesAgentUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/$/, '')
    return normalized.endsWith('/messages') ? normalized : `${normalized}/v1/messages`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}
