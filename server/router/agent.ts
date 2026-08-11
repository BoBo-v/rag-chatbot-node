import { timingSafeEqual, randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AgentError, isAgentError } from '../agent/errors'
import { AgentEventWriter } from '../agent/eventStream'
import { AgentModelQueue } from '../agent/modelQueue'
import { getAgentProfile } from '../agent/profiles'
import { AgentRunner } from '../agent/runner'
import { calculatorTool } from '../agent/calculatorTool'
import { ToolRegistry } from '../agent/toolRegistry'
import { agentProfileIds, type AgentRunRequest } from '../agent/types'
import { getAgentProvider } from '../llm'
import { config } from '../utils/config'
import { AppError } from '../utils/errors'
import { estimateTokens } from '../utils/tokenEstimator'
import { recordAgentModelInvocation, recordApplicationEvent } from '../observability/collector'

const modelNamePattern = '^[A-Za-z0-9._:/@+-]+$'
const toolRegistry = new ToolRegistry([calculatorTool])
const modelQueue = new AgentModelQueue({
    concurrency: config.agentModelConcurrency,
    maxQueueSize: config.agentQueueMaxSize,
    queueTimeoutMs: config.agentQueueTimeoutMs,
})

export async function agentRoutes(app: FastifyInstance) {
    app.post('/api/agent', {
        preHandler: authorizeAgentRequest,
        schema: {
            tags: ['Agent'],
            summary: '运行受控 Agent V0',
            description: '使用后端固定 Profile、模型白名单和工具白名单运行 Agent，以版本化 NDJSON 返回执行事件。',
            headers: {
                type: 'object',
                properties: {
                    'x-agent-api-key': { type: 'string', maxLength: 512 },
                },
            },
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['agentProfile', 'provider', 'model', 'messages'],
                properties: {
                    agentProfile: { type: 'string', enum: [...agentProfileIds] },
                    provider: { type: 'string', enum: ['ollama'] },
                    model: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 120,
                        pattern: modelNamePattern,
                    },
                    messages: {
                        type: 'array',
                        minItems: 1,
                        maxItems: config.agentMessageMaxCount,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['role', 'content'],
                            properties: {
                                role: { type: 'string', enum: ['user', 'assistant'] },
                                content: {
                                    type: 'string',
                                    minLength: 1,
                                    maxLength: config.agentMessageContentMaxLength,
                                },
                            },
                        },
                    },
                },
            },
            response: {
                400: { $ref: 'ErrorResponse#' },
                401: { $ref: 'ErrorResponse#' },
                404: { $ref: 'ErrorResponse#' },
            },
        },
    }, async (request, reply) => {
        const body = request.body as AgentRunRequest
        const prepared = prepareAgentRun(body)
        const agentRunId = randomUUID()
        const output = new PassThrough()
        const runController = new AbortController()
        const abortForClient = () => abortController(runController, new AgentError(
            'CLIENT_ABORTED',
            'Agent 请求已由客户端取消。',
            499
        ))
        const onReplyClose = () => {
            if (!reply.raw.writableEnded) abortForClient()
        }
        request.raw.once('aborted', abortForClient)
        reply.raw.once('close', onReplyClose)
        output.once('error', abortForClient)
        reply.headers({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Request-Id': request.id,
            'X-Agent-Run-Id': agentRunId,
        })

        void streamAgentRun({
            output,
            signal: runController.signal,
            requestId: request.id,
            agentRunId,
            body,
            ...prepared,
        }).finally(() => {
            request.raw.removeListener('aborted', abortForClient)
            reply.raw.removeListener('close', onReplyClose)
            output.removeListener('error', abortForClient)
        })
        return reply.send(output)
    })
}

function prepareAgentRun(body: AgentRunRequest) {
    const totalChars = body.messages.reduce((sum, message) => sum + message.content.length, 0)
    if (totalChars > config.agentMessageTotalMaxChars) {
        throw new AppError(400, 'AGENT_INVALID_REQUEST', `Agent 消息总字符数不能超过 ${config.agentMessageTotalMaxChars}。`)
    }
    const estimatedTokens = estimateTokens(body.messages.map(message => message.content).join('\n'))
    if (estimatedTokens > config.agentEstimatedInputMaxTokens) {
        throw new AppError(400, 'AGENT_INVALID_REQUEST', `Agent 估算输入 Token 不能超过 ${config.agentEstimatedInputMaxTokens}。`)
    }

    const profile = getAgentProfile(body.agentProfile)
    const provider = getAgentProvider(body.provider)
    if (!provider) throw toAppError(new AgentError('AGENT_PROVIDER_UNSUPPORTED', '当前 Provider 不支持 Agent Tool Calling。', 400))
    if (!provider.allowedModels.includes(body.model)) {
        throw toAppError(new AgentError('AGENT_MODEL_NOT_ALLOWED', '当前模型不在 Agent 白名单中。', 400))
    }
    return { profile, provider }
}

async function streamAgentRun(input: {
    output: PassThrough
    signal: AbortSignal
    requestId: string
    agentRunId: string
    body: AgentRunRequest
    profile: ReturnType<typeof getAgentProfile>
    provider: NonNullable<ReturnType<typeof getAgentProvider>>
}) {
    const writer = new AgentEventWriter(input.output, {
        requestId: input.requestId,
        agentRunId: input.agentRunId,
    })
    const runTimeoutController = new AbortController()
    const runTimeout = setTimeout(() => {
        runTimeoutController.abort(new AgentError(
            'AGENT_TIMEOUT',
            `Agent 整次运行超过 ${config.agentRunTimeoutMs} ms。`,
            504
        ))
    }, config.agentRunTimeoutMs)
    const signal = AbortSignal.any([input.signal, runTimeoutController.signal])
    let currentStep = 0
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
        await writer.emit('agent_started', 0, {
            agentProfile: input.profile.id,
            provider: input.body.provider,
            model: input.body.model,
        })
        recordApplicationEvent({
            requestId: input.requestId,
            level: 'info',
            eventType: 'agent.run.started',
            module: 'agent',
            operation: input.profile.id,
            statusCode: 200,
            errorCode: null,
            message: 'Agent 运行开始',
            context: {
                agentRunId: input.agentRunId,
                provider: input.body.provider,
                model: input.body.model,
            },
        })
        heartbeat = setInterval(() => {
            void writer.emit('heartbeat', currentStep, { phase: 'running' }).catch(() => undefined)
        }, config.agentHeartbeatIntervalMs)
        const runner = new AgentRunner({
            modelClient: input.provider.client,
            modelScheduler: modelQueue,
            tools: toolRegistry.definitionsFor(input.profile.toolNames),
            executeTool: toolRegistry.executorFor(input.profile.toolNames),
            limits: {
                maxModelTurns: config.agentMaxModelTurns,
                maxToolCalls: config.agentMaxToolCalls,
                maxParallelToolCalls: config.agentMaxParallelToolCalls,
                toolTimeoutMs: config.agentToolTimeoutMs,
                toolResultMaxChars: config.agentToolResultMaxChars,
                runTimeoutMs: config.agentRunTimeoutMs,
            },
            recordModelInvocation: invocation => recordAgentModelInvocation({
                ...invocation,
                requestId: input.requestId,
                agentRunId: input.agentRunId,
                provider: input.body.provider,
                inputTokens: invocation.usage?.inputTokens,
                outputTokens: invocation.usage?.outputTokens,
            }),
        })
        const result = await runner.run({
            model: input.body.model,
            systemPrompt: input.profile.systemPrompt,
            messages: input.body.messages,
            signal,
            emit: event => {
                currentStep = event.step
                recordToolEvent(input.requestId, input.agentRunId, event)
                return writer.emit(event.type, event.step, event.data).then(() => undefined)
            },
        })
        await writer.emit('agent_completed', result.modelTurns, {
            finishReason: result.finishReason,
            modelTurns: result.modelTurns,
            toolCallCount: result.toolCallCount,
            usage: result.usage ?? null,
        })
        recordApplicationEvent({
            requestId: input.requestId,
            level: 'info',
            eventType: 'agent.run.completed',
            module: 'agent',
            operation: input.profile.id,
            statusCode: 200,
            errorCode: null,
            message: 'Agent 运行完成',
            context: {
                agentRunId: input.agentRunId,
                modelTurns: result.modelTurns,
                toolCallCount: result.toolCallCount,
                finishReason: result.finishReason,
            },
        })
    } catch (error) {
        const agentError = toAgentError(error)
        const terminalType = agentError.code === 'CLIENT_ABORTED' ? 'agent_cancelled' : 'agent_failed'
        try {
            await writer.emit(terminalType, currentStep, {
                code: agentError.code,
                message: agentError.message,
            })
        } catch {
            // The client may already have closed the stream.
        }
        recordApplicationEvent({
            requestId: input.requestId,
            level: agentError.code === 'CLIENT_ABORTED' ? 'warn' : 'error',
            eventType: agentError.code === 'CLIENT_ABORTED' ? 'agent.run.cancelled' : 'agent.run.failed',
            module: 'agent',
            operation: input.profile.id,
            statusCode: agentError.statusCode,
            errorCode: agentError.code,
            message: agentError.message,
            context: {
                agentRunId: input.agentRunId,
                step: currentStep,
                provider: input.body.provider,
                model: input.body.model,
            },
        })
    } finally {
        clearTimeout(runTimeout)
        if (heartbeat) clearInterval(heartbeat)
        if (!input.output.destroyed && !input.output.writableEnded) input.output.end()
    }
}

function recordToolEvent(
    requestId: string,
    agentRunId: string,
    event: { type: string; step: number; data: Record<string, unknown> }
): void {
    if (event.type !== 'tool_started' && event.type !== 'tool_completed') return
    recordApplicationEvent({
        requestId,
        level: event.type === 'tool_completed' && event.data.isError ? 'warn' : 'info',
        eventType: event.type === 'tool_started' ? 'agent.tool.started' : 'agent.tool.completed',
        module: 'agent',
        operation: typeof event.data.name === 'string' ? event.data.name : 'tool',
        statusCode: null,
        errorCode: null,
        message: event.type === 'tool_started' ? 'Agent 工具开始执行' : 'Agent 工具执行完成',
        context: {
            agentRunId,
            toolInvocationId: event.data.toolInvocationId,
            toolCallId: event.data.toolCallId,
            step: event.step,
            name: event.data.name,
            isError: event.data.isError,
            durationMs: event.data.durationMs,
            resultChars: event.data.resultChars,
        },
    })
}

function abortController(controller: AbortController, reason: AgentError): void {
    if (!controller.signal.aborted) controller.abort(reason)
}

async function authorizeAgentRequest(request: FastifyRequest): Promise<void> {
    if (config.agentAccessMode === 'loopback') {
        if (isLoopbackAddress(request.ip)) return
        throw new AppError(401, 'AGENT_LOOPBACK_REQUIRED', 'Agent 当前只允许本机访问。')
    }

    const header = request.headers['x-agent-api-key']
    const provided = Array.isArray(header) ? header[0] : header
    if (provided && safeEqual(provided, config.agentApiKey)) return
    throw new AppError(401, 'AGENT_UNAUTHORIZED', 'Agent 未授权，请提供正确的 x-agent-api-key。')
}

export function isLoopbackAddress(address: string): boolean {
    const normalized = address.trim().toLowerCase()
    return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
}

function safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left)
    const rightBuffer = Buffer.from(right)
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function toAgentError(error: unknown): AgentError {
    if (isAgentError(error)) return error
    return new AgentError('MODEL_PROVIDER_FAILED', 'Agent 运行失败。', 500, { cause: error })
}

function toAppError(error: AgentError): AppError {
    return new AppError(error.statusCode, error.code, error.message)
}
