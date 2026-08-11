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
        reply.headers({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Request-Id': request.id,
            'X-Agent-Run-Id': agentRunId,
        })

        void streamAgentRun({
            output,
            requestId: request.id,
            agentRunId,
            body,
            ...prepared,
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
    const controller = new AbortController()
    try {
        await writer.emit('agent_started', 0, {
            agentProfile: input.profile.id,
            provider: input.body.provider,
            model: input.body.model,
        })
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
        })
        const result = await runner.run({
            model: input.body.model,
            systemPrompt: input.profile.systemPrompt,
            messages: input.body.messages,
            signal: controller.signal,
            emit: event => writer.emit(event.type, event.step, event.data).then(() => undefined),
        })
        await writer.emit('agent_completed', result.modelTurns, {
            finishReason: result.finishReason,
            modelTurns: result.modelTurns,
            toolCallCount: result.toolCallCount,
            usage: result.usage ?? null,
        })
    } catch (error) {
        const agentError = toAgentError(error)
        const terminalType = agentError.code === 'CLIENT_ABORTED' ? 'agent_cancelled' : 'agent_failed'
        try {
            await writer.emit(terminalType, 0, {
                code: agentError.code,
                message: agentError.message,
            })
        } catch {
            // The client may already have closed the stream.
        }
    } finally {
        input.output.end()
    }
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
