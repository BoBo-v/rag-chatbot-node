import { randomUUID } from 'node:crypto'
import { AgentError, isAgentError } from '../agent/errors'
import type {
    AgentMessage,
    AgentModelClient,
    AgentToolCall,
    AgentToolDefinition,
    AgentTurnInput,
    AgentTurnResult,
} from '../agent/types'
import { config } from '../utils/config'

interface OllamaAgentResponse {
    message?: {
        role?: string
        content?: string
        tool_calls?: Array<{
            id?: string
            function?: {
                name?: string
                arguments?: unknown
            }
        }>
    }
    done?: boolean
    done_reason?: string
    prompt_eval_count?: number
    eval_count?: number
    error?: string
}

export const ollamaAgentProvider: AgentModelClient = {
    async runTurn(input: AgentTurnInput, signal: AbortSignal): Promise<AgentTurnResult> {
        throwIfAborted(signal)
        const timeoutController = new AbortController()
        const timeout = setTimeout(() => {
            timeoutController.abort(new AgentError(
                'MODEL_TIMEOUT',
                `Ollama Agent 单次模型调用超过 ${config.agentOllamaModelTimeoutMs} ms。`,
                504
            ))
        }, config.agentOllamaModelTimeoutMs)
        const combinedSignal = AbortSignal.any([signal, timeoutController.signal])

        try {
            const response = await fetch(`${config.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: input.model,
                    messages: toOllamaAgentMessages(input.messages),
                    tools: input.tools.map(toOllamaTool),
                    stream: false,
                    think: config.agentOllamaThinkingEnabled,
                }),
                signal: combinedSignal,
            })
            const text = await response.text()
            if (!response.ok) {
                throw new AgentError('MODEL_PROVIDER_FAILED', `Ollama Agent 调用失败，状态码 ${response.status}。`, 502, {
                    cause: new Error(`Ollama HTTP ${response.status}`),
                })
            }
            if (text.length > 2_000_000) {
                throw new AgentError('MODEL_RESPONSE_INVALID', 'Ollama Agent 响应体过大。', 502)
            }

            let data: OllamaAgentResponse
            try {
                data = JSON.parse(text) as OllamaAgentResponse
            } catch (error) {
                throw new AgentError('MODEL_RESPONSE_INVALID', 'Ollama Agent 返回了无效 JSON。', 502, { cause: error })
            }
            return parseOllamaAgentResponse(data)
        } catch (error) {
            if (combinedSignal.aborted) throw abortReason(combinedSignal)
            if (isAgentError(error)) throw error
            throw new AgentError('MODEL_PROVIDER_FAILED', 'Ollama Agent 模型调用失败。', 502, { cause: error })
        } finally {
            clearTimeout(timeout)
        }
    },
}

export function toOllamaAgentMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
    return messages.map(message => {
        if (message.role === 'assistant') {
            return {
                role: 'assistant',
                content: message.content,
                ...(message.toolCalls.length > 0 ? {
                    tool_calls: message.toolCalls.map(call => ({
                        function: {
                            name: call.name,
                            arguments: { ...call.arguments },
                        },
                    })),
                } : {}),
            }
        }
        if (message.role === 'tool') {
            return {
                role: 'tool',
                content: message.content,
                tool_name: message.name,
            }
        }
        return { role: message.role, content: message.content }
    })
}

export function toOllamaTool(tool: AgentToolDefinition): Record<string, unknown> {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }
}

export function parseOllamaAgentResponse(data: OllamaAgentResponse): AgentTurnResult {
    if (data.error) throw new AgentError('MODEL_PROVIDER_FAILED', 'Ollama Agent 返回模型错误。', 502)
    if (!data.message || (data.message.role && data.message.role !== 'assistant')) {
        throw new AgentError('MODEL_RESPONSE_INVALID', 'Ollama Agent 响应缺少 assistant 消息。', 502)
    }

    const toolCalls = (data.message.tool_calls ?? []).map((call, index) => parseToolCall(call, index))
    const finishReason = toolCalls.length > 0 ? 'tool_calls' : normalizeFinishReason(data.done_reason)
    return {
        message: {
            role: 'assistant',
            content: typeof data.message.content === 'string' ? data.message.content : '',
            toolCalls,
        },
        finishReason,
        usage: {
            inputTokens: finiteCount(data.prompt_eval_count),
            outputTokens: finiteCount(data.eval_count),
        },
    }
}

function parseToolCall(
    call: NonNullable<NonNullable<OllamaAgentResponse['message']>['tool_calls']>[number],
    index: number
): AgentToolCall {
    const name = call.function?.name
    if (typeof name !== 'string' || !name) {
        throw new AgentError('MODEL_RESPONSE_INVALID', `Ollama 第 ${index + 1} 个 Tool Call 缺少名称。`, 502)
    }
    return {
        id: typeof call.id === 'string' && call.id ? call.id : `ollama-${randomUUID()}`,
        name,
        arguments: parseToolArguments(call.function?.arguments, index),
    }
}

function parseToolArguments(value: unknown, index: number): Record<string, unknown> {
    let parsed = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value) as unknown
        } catch (error) {
            throw new AgentError('MODEL_RESPONSE_INVALID', `Ollama 第 ${index + 1} 个 Tool Call 参数不是有效 JSON。`, 502, { cause: error })
        }
    }
    if (!isPlainObject(parsed)) {
        throw new AgentError('MODEL_RESPONSE_INVALID', `Ollama 第 ${index + 1} 个 Tool Call 参数必须是对象。`, 502)
    }
    return { ...parsed }
}

function normalizeFinishReason(value?: string): AgentTurnResult['finishReason'] {
    if (!value || value === 'stop') return 'stop'
    if (value === 'length') return 'length'
    return 'unknown'
}

function finiteCount(value?: number): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): AgentError {
    if (isAgentError(signal.reason)) return signal.reason
    return new AgentError('CLIENT_ABORTED', 'Agent 请求已由客户端取消。', 499)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}
