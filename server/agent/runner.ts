import { randomUUID } from 'node:crypto'
import { AgentError, isAgentError } from './errors'
import type {
    AgentLimits,
    AgentMessage,
    AgentModelClient,
    AgentModelScheduler,
    AgentRequestMessage,
    AgentRunResult,
    AgentRunnerEventSink,
    AgentToolCall,
    AgentToolDefinition,
    AgentToolExecutor,
    AgentToolExecutionResult,
    AgentUsage,
} from './types'

export interface AgentRunnerOptions {
    modelClient: AgentModelClient
    modelScheduler?: AgentModelScheduler
    tools: AgentToolDefinition[]
    executeTool: AgentToolExecutor
    limits: AgentLimits
}

export interface RunAgentInput {
    model: string
    systemPrompt: string
    messages: AgentRequestMessage[]
    signal: AbortSignal
    emit?: AgentRunnerEventSink
}

export class AgentRunner {
    constructor(private readonly options: AgentRunnerOptions) {}

    async run(input: RunAgentInput): Promise<AgentRunResult> {
        const messages: AgentMessage[] = [
            { role: 'system', content: input.systemPrompt },
            ...input.messages.map(cloneInputMessage),
        ]
        let toolCallCount = 0
        let totalInputTokens = 0
        let totalOutputTokens = 0
        let hasUsage = false

        for (let step = 1; step <= this.options.limits.maxModelTurns; step += 1) {
            throwIfAborted(input.signal)
            const aiInvocationId = randomUUID()
            await input.emit?.({
                type: 'model_started',
                step,
                data: { aiInvocationId, model: input.model },
            })

            const turn = await this.runModelTurn(input.model, messages, input.signal, step, input.emit)
            validateTurnResult(turn.message.content, turn.message.toolCalls, turn.finishReason)
            const usage = accumulateUsage(turn.usage)
            if (usage) {
                hasUsage = true
                totalInputTokens += usage.inputTokens
                totalOutputTokens += usage.outputTokens
            }

            await input.emit?.({
                type: 'model_completed',
                step,
                data: {
                    aiInvocationId,
                    finishReason: turn.finishReason,
                    toolCallCount: turn.message.toolCalls.length,
                    usage: turn.usage ?? null,
                },
            })
            messages.push(cloneAssistantMessage(turn.message))

            if (turn.message.toolCalls.length === 0) {
                await input.emit?.({
                    type: 'assistant_message',
                    step,
                    data: { content: turn.message.content, finishReason: turn.finishReason },
                })
                return {
                    message: cloneAssistantMessage(turn.message),
                    messages,
                    finishReason: turn.finishReason,
                    modelTurns: step,
                    toolCallCount,
                    usage: hasUsage ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } : undefined,
                }
            }

            if (step >= this.options.limits.maxModelTurns) {
                throw new AgentError(
                    'AGENT_LIMIT_EXCEEDED',
                    `Agent 已达到最大模型调用次数 ${this.options.limits.maxModelTurns}，不再执行新的工具调用。`,
                    409
                )
            }
            if (toolCallCount + turn.message.toolCalls.length > this.options.limits.maxToolCalls) {
                throw new AgentError(
                    'AGENT_LIMIT_EXCEEDED',
                    `Agent 工具调用总数不能超过 ${this.options.limits.maxToolCalls}。`,
                    409
                )
            }

            const toolMessages: Array<Extract<AgentMessage, { role: 'tool' }>> = []
            for (const call of turn.message.toolCalls) {
                throwIfAborted(input.signal)
                toolCallCount += 1
                const toolInvocationId = randomUUID()
                await input.emit?.({
                    type: 'tool_started',
                    step,
                    data: {
                        toolInvocationId,
                        toolCallId: call.id,
                        name: call.name,
                        ordinal: toolCallCount,
                    },
                })

                const startedAt = performance.now()
                const result = await this.runTool(call, input.signal)
                const content = truncateToolResult(result.content, this.options.limits.toolResultMaxChars)
                toolMessages.push({
                    role: 'tool',
                    toolCallId: call.id,
                    name: call.name,
                    content,
                    isError: result.isError,
                })
                await input.emit?.({
                    type: 'tool_completed',
                    step,
                    data: {
                        toolInvocationId,
                        toolCallId: call.id,
                        name: call.name,
                        isError: result.isError,
                        resultChars: content.length,
                        durationMs: Math.round(performance.now() - startedAt),
                    },
                })
            }

            messages.push(...toolMessages)
        }

        throw new AgentError('AGENT_LIMIT_EXCEEDED', 'Agent 已达到运行限制。', 409)
    }

    private async runModelTurn(
        model: string,
        messages: AgentMessage[],
        signal: AbortSignal,
        step: number,
        emit?: AgentRunnerEventSink
    ) {
        try {
            const invoke = () => this.options.modelClient.runTurn({
                    model,
                    messages: messages.map(cloneMessage),
                    tools: this.options.tools,
                }, signal)
            if (!this.options.modelScheduler) return await invoke()

            let queuedEvent: Promise<void> | undefined
            const result = this.options.modelScheduler.run(invoke, signal, position => {
                queuedEvent = Promise.resolve(emit?.({
                    type: 'agent_queued',
                    step,
                    data: { position, model },
                }))
            })
            await queuedEvent
            return await result
        } catch (error) {
            throwIfAborted(signal)
            if (isAgentError(error)) throw error
            throw new AgentError('MODEL_PROVIDER_FAILED', '模型调用失败。', 502, { cause: error })
        }
    }

    private async runTool(call: AgentToolCall, signal: AbortSignal): Promise<AgentToolExecutionResult> {
        const timeoutController = new AbortController()
        const timeout = setTimeout(() => {
            timeoutController.abort(new AgentError(
                'TOOL_TIMEOUT',
                `工具 ${call.name} 执行超时。`,
                504
            ))
        }, this.options.limits.toolTimeoutMs)
        const combinedSignal = AbortSignal.any([signal, timeoutController.signal])
        try {
            return await this.options.executeTool(cloneToolCall(call), combinedSignal)
        } catch (error) {
            throwIfAborted(combinedSignal)
            if (isAgentError(error)) throw error
            throw new AgentError('TOOL_EXECUTION_FAILED', `工具 ${call.name} 执行失败。`, 500, { cause: error })
        } finally {
            clearTimeout(timeout)
        }
    }
}

function validateTurnResult(content: string, toolCalls: AgentToolCall[], finishReason: string): void {
    if (typeof content !== 'string' || !Array.isArray(toolCalls)) {
        throw new AgentError('MODEL_RESPONSE_INVALID', '模型返回的 assistant 消息格式不正确。', 502)
    }
    if (!['stop', 'tool_calls', 'length', 'content_filter', 'unknown'].includes(finishReason)) {
        throw new AgentError('MODEL_RESPONSE_INVALID', '模型返回了未知的结束原因。', 502)
    }
    if (finishReason === 'tool_calls' && toolCalls.length === 0) {
        throw new AgentError('MODEL_RESPONSE_INVALID', '模型声明需要调用工具，但没有返回 Tool Call。', 502)
    }
    if (toolCalls.length > 0 && finishReason !== 'tool_calls') {
        throw new AgentError('MODEL_RESPONSE_INVALID', '模型返回了 Tool Call，但结束原因不是 tool_calls。', 502)
    }

    const ids = new Set<string>()
    for (const call of toolCalls) {
        if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 128) {
            throw new AgentError('MODEL_RESPONSE_INVALID', '模型返回了非法的 Tool Call ID。', 502)
        }
        if (ids.has(call.id)) {
            throw new AgentError('MODEL_RESPONSE_INVALID', '模型在同一轮返回了重复的 Tool Call ID。', 502)
        }
        if (typeof call.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(call.name)) {
            throw new AgentError('MODEL_RESPONSE_INVALID', '模型返回了非法的工具名称。', 502)
        }
        if (!isPlainObject(call.arguments)) {
            throw new AgentError('MODEL_RESPONSE_INVALID', '模型返回的工具参数必须是 JSON 对象。', 502)
        }
        ids.add(call.id)
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return
    if (isAgentError(signal.reason)) throw signal.reason
    throw new AgentError('CLIENT_ABORTED', 'Agent 请求已由客户端取消。', 499)
}

function accumulateUsage(usage?: AgentUsage): { inputTokens: number; outputTokens: number } | null {
    if (!usage) return null
    return {
        inputTokens: finiteNonNegative(usage.inputTokens),
        outputTokens: finiteNonNegative(usage.outputTokens),
    }
}

function finiteNonNegative(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function truncateToolResult(content: string, maxChars: number): string {
    const value = typeof content === 'string' ? content : String(content)
    if (value.length <= maxChars) return value
    const marker = '\n[工具结果已截断]'
    return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`
}

function cloneInputMessage(message: AgentRequestMessage): AgentMessage {
    if (message.role === 'assistant') return { role: 'assistant', content: message.content, toolCalls: [] }
    return { role: 'user', content: message.content }
}

function cloneMessage(message: AgentMessage): AgentMessage {
    if (message.role === 'assistant') return cloneAssistantMessage(message)
    if (message.role === 'tool') return { ...message }
    return { ...message }
}

function cloneAssistantMessage(message: Extract<AgentMessage, { role: 'assistant' }>): Extract<AgentMessage, { role: 'assistant' }> {
    return {
        role: 'assistant',
        content: message.content,
        toolCalls: message.toolCalls.map(cloneToolCall),
    }
}

function cloneToolCall(call: AgentToolCall): AgentToolCall {
    return {
        id: call.id,
        name: call.name,
        arguments: { ...call.arguments },
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}
