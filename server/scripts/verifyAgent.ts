import { AgentError } from '../agent/errors'
import { PassThrough } from 'node:stream'
import { AgentEventWriter } from '../agent/eventStream'
import { AgentRunner } from '../agent/runner'
import { AgentModelQueue } from '../agent/modelQueue'
import { calculatorTool } from '../agent/calculatorTool'
import { getAgentProfile } from '../agent/profiles'
import { ToolRegistry } from '../agent/toolRegistry'
import {
    ollamaAgentProvider,
    parseOllamaAgentResponse,
    toOllamaAgentMessages,
    toOllamaTool,
} from '../llm/ollamaAgentProvider'
import { isLoopbackAddress } from '../router/agent'
import type {
    AgentLimits,
    AgentMessage,
    AgentModelClient,
    AgentModelScheduler,
    AgentRunnerEvent,
    AgentToolCall,
    AgentTurnInput,
    AgentTurnResult,
} from '../agent/types'

const limits: AgentLimits = {
    maxModelTurns: 3,
    maxToolCalls: 3,
    maxParallelToolCalls: 1,
    toolTimeoutMs: 5000,
    toolResultMaxChars: 100,
    runTimeoutMs: 60_000,
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

class FakeModel implements AgentModelClient {
    readonly inputs: AgentTurnInput[] = []

    constructor(private readonly turns: AgentTurnResult[]) {}

    async runTurn(input: AgentTurnInput, signal: AbortSignal): Promise<AgentTurnResult> {
        if (signal.aborted) throw signal.reason
        this.inputs.push(input)
        const turn = this.turns.shift()
        if (!turn) throw new Error('Fake model has no remaining turn')
        return turn
    }
}

async function verifyDirectAnswer() {
    const model = new FakeModel([assistantTurn('直接答案')])
    const result = await runner(model).run(runInput())
    assert(result.message.content === '直接答案', `direct answer failed: ${JSON.stringify(result)}`)
    assert(result.modelTurns === 1 && result.toolCallCount === 0, `direct counters failed: ${JSON.stringify(result)}`)
}

async function verifyToolRoundTrip() {
    const call = toolCall('call-1', 12, 35)
    const model = new FakeModel([
        assistantTurn('', [call], 'tool_calls'),
        assistantTurn('一共 420 元'),
    ])
    const executed: string[] = []
    const events: AgentRunnerEvent[] = []
    const result = await runner(model, async current => {
        executed.push(current.id)
        return { content: '420', isError: false }
    }).run({ ...runInput(), emit: event => { events.push(event) } })

    assert(result.message.content === '一共 420 元', `tool answer failed: ${JSON.stringify(result)}`)
    assert(result.modelTurns === 2 && result.toolCallCount === 1, `tool counters failed: ${JSON.stringify(result)}`)
    assert(executed.join(',') === 'call-1', `tool execution failed: ${JSON.stringify(executed)}`)
    const secondMessages = model.inputs[1]?.messages ?? []
    assert(secondMessages.some(message => message.role === 'assistant' && message.toolCalls[0]?.id === 'call-1'), 'assistant tool call was not preserved')
    assert(secondMessages.some(message => message.role === 'tool' && message.toolCallId === 'call-1' && message.content === '420'), 'tool result was not appended')
    assert(events.map(event => event.type).join(',') === 'model_started,model_completed,tool_started,tool_completed,model_started,model_completed,assistant_message', `event order failed: ${JSON.stringify(events)}`)
}

async function verifyMultipleToolsAreSequential() {
    const calls = [toolCall('call-1', 1, 2), toolCall('call-2', 3, 4)]
    const model = new FakeModel([
        assistantTurn('', calls, 'tool_calls'),
        assistantTurn('完成'),
    ])
    const order: string[] = []
    let active = 0
    let maxActive = 0
    await runner(model, async call => {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push(call.id)
        await Promise.resolve()
        active -= 1
        return { content: call.id, isError: false }
    }).run(runInput())

    assert(order.join(',') === 'call-1,call-2', `multiple tools lost order: ${JSON.stringify(order)}`)
    assert(maxActive === 1, `tools should run sequentially: ${maxActive}`)
    const toolMessages = model.inputs[1]?.messages.filter(message => message.role === 'tool') ?? []
    assert(toolMessages.length === 2, `all tool results should be returned together: ${JSON.stringify(toolMessages)}`)
}

async function verifyToolLimit() {
    const calls = [1, 2, 3, 4].map(index => toolCall(`call-${index}`, index, index))
    const error = await captureAgentError(() => runner(new FakeModel([
        assistantTurn('', calls, 'tool_calls'),
    ])).run(runInput()))
    assert(error.code === 'AGENT_LIMIT_EXCEEDED', `expected tool limit error: ${error.code}`)
}

async function verifyLastTurnDoesNotExecuteTool() {
    const model = new FakeModel([
        assistantTurn('', [toolCall('call-1', 1, 1)], 'tool_calls'),
        assistantTurn('', [toolCall('call-2', 2, 2)], 'tool_calls'),
        assistantTurn('', [toolCall('call-3', 3, 3)], 'tool_calls'),
    ])
    const executed: string[] = []
    const error = await captureAgentError(() => runner(model, async call => {
        executed.push(call.id)
        return { content: 'ok', isError: false }
    }).run(runInput()))
    assert(error.code === 'AGENT_LIMIT_EXCEEDED', `expected turn limit error: ${error.code}`)
    assert(executed.join(',') === 'call-1,call-2', `last turn tool must not execute: ${JSON.stringify(executed)}`)
}

async function verifyProtocolValidation() {
    const missingCall = await captureAgentError(() => runner(new FakeModel([
        assistantTurn('', [], 'tool_calls'),
    ])).run(runInput()))
    assert(missingCall.code === 'MODEL_RESPONSE_INVALID', `missing call should fail: ${missingCall.code}`)

    const duplicateCall = toolCall('same-id', 1, 1)
    const duplicate = await captureAgentError(() => runner(new FakeModel([
        assistantTurn('', [duplicateCall, duplicateCall], 'tool_calls'),
    ])).run(runInput()))
    assert(duplicate.code === 'MODEL_RESPONSE_INVALID', `duplicate call should fail: ${duplicate.code}`)
}

async function verifyCancellation() {
    const controller = new AbortController()
    controller.abort()
    const error = await captureAgentError(() => runner(new FakeModel([assistantTurn('unused')])).run({
        ...runInput(),
        signal: controller.signal,
    }))
    assert(error.code === 'CLIENT_ABORTED', `cancel should be classified: ${error.code}`)
}

async function verifyModelQueueConcurrencyAndOrder() {
    const queue = new AgentModelQueue({ concurrency: 1, maxQueueSize: 3, queueTimeoutMs: 1000 })
    const first = deferred<void>()
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const task = (name: string, gate?: Promise<void>) => queue.run(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push(name)
        if (gate) await gate
        active -= 1
        return name
    }, new AbortController().signal)

    const one = task('one', first.promise)
    const two = task('two')
    const three = task('three')
    assert(queue.stats().active === 1 && queue.stats().queued === 2, `queue stats failed: ${JSON.stringify(queue.stats())}`)
    first.resolve()
    assert((await Promise.all([one, two, three])).join(',') === 'one,two,three', 'queue result order failed')
    assert(order.join(',') === 'one,two,three' && maxActive === 1, `queue concurrency failed: ${JSON.stringify({ order, maxActive })}`)
}

async function verifyQueueFullAndTimeout() {
    const fullQueue = new AgentModelQueue({ concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 1000 })
    const gate = deferred<void>()
    const active = fullQueue.run(async () => gate.promise, new AbortController().signal)
    const waiting = fullQueue.run(async () => undefined, new AbortController().signal)
    const fullError = await captureAgentError(async () => fullQueue.run(async () => undefined, new AbortController().signal))
    assert(fullError.code === 'AGENT_QUEUE_FULL', `queue full failed: ${fullError.code}`)
    gate.resolve()
    await Promise.all([active, waiting])

    const timeoutQueue = new AgentModelQueue({ concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 20 })
    const timeoutGate = deferred<void>()
    const timeoutActive = timeoutQueue.run(async () => timeoutGate.promise, new AbortController().signal)
    const timeoutError = await captureAgentError(() => timeoutQueue.run(async () => undefined, new AbortController().signal))
    assert(timeoutError.code === 'AGENT_QUEUE_TIMEOUT', `queue timeout failed: ${timeoutError.code}`)
    timeoutGate.resolve()
    await timeoutActive
}

async function verifyQueuedCancellationAndFailureRelease() {
    const queue = new AgentModelQueue({ concurrency: 1, maxQueueSize: 2, queueTimeoutMs: 1000 })
    const gate = deferred<void>()
    const active = queue.run(async () => gate.promise, new AbortController().signal)
    const controller = new AbortController()
    const cancelled = queue.run(async () => undefined, controller.signal)
    controller.abort()
    const cancelError = await captureAgentError(() => cancelled)
    assert(cancelError.code === 'CLIENT_ABORTED', `queued cancel failed: ${cancelError.code}`)
    assert(queue.stats().queued === 0, `cancelled entry should be removed: ${JSON.stringify(queue.stats())}`)
    gate.resolve()
    await active

    const failureQueue = new AgentModelQueue({ concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 1000 })
    const failed = failureQueue.run(async () => { throw new Error('expected') }, new AbortController().signal)
    const afterFailure = failureQueue.run(async () => 'released', new AbortController().signal)
    await failed.catch(() => undefined)
    assert(await afterFailure === 'released', 'queue slot should be released after task failure')
}

async function verifyRunnerUsesModelQueue() {
    const queue = new AgentModelQueue({ concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 1000 })
    const gate = deferred<void>()
    const blocker = queue.run(async () => gate.promise, new AbortController().signal)
    const events: AgentRunnerEvent[] = []
    const running = runner(new FakeModel([assistantTurn('queued answer')]), undefined, queue).run({
        ...runInput(),
        emit: event => { events.push(event) },
    })
    await Promise.resolve()
    const queuedStats = queue.stats()
    gate.resolve()
    await blocker
    const result = await running
    assert(queuedStats.queued === 1, `runner should wait in model queue: ${JSON.stringify(queuedStats)}`)
    assert(result.message.content === 'queued answer', 'queued runner should complete')
    assert(events.some(event => event.type === 'agent_queued' && event.data.position === 1), `runner queue event missing: ${JSON.stringify(events)}`)
}

async function verifyToolRegistryAndCalculator() {
    const profile = getAgentProfile('calculator-v0')
    const registry = new ToolRegistry([calculatorTool])
    const definitions = registry.definitionsFor(profile.toolNames)
    const execute = registry.executorFor(profile.toolNames)
    assert(definitions.length === 1 && definitions[0]?.name === 'calculator', `calculator definition missing: ${JSON.stringify(definitions)}`)

    const multiplied = await execute(toolCall('multiply', 12, 35), new AbortController().signal)
    assert(multiplied.content === '420' && !multiplied.isError, `calculator multiply failed: ${JSON.stringify(multiplied)}`)
    const divisionByZero = await execute({
        id: 'divide-zero',
        name: 'calculator',
        arguments: { operation: 'divide', left: 1, right: 0 },
    }, new AbortController().signal)
    assert(divisionByZero.isError && divisionByZero.content.includes('0'), `calculator divide-zero failed: ${JSON.stringify(divisionByZero)}`)

    const invalid = await captureAgentError(() => execute({
        id: 'invalid',
        name: 'calculator',
        arguments: { operation: 'multiply', left: '12', right: 35, extra: true },
    }, new AbortController().signal))
    assert(invalid.code === 'TOOL_ARGUMENTS_INVALID', `tool arguments should be rejected: ${invalid.code}`)

    const forbidden = await captureAgentError(() => execute({
        id: 'forbidden',
        name: 'unknown_tool',
        arguments: {},
    }, new AbortController().signal))
    assert(forbidden.code === 'TOOL_NOT_ALLOWED', `unknown tool should be rejected: ${forbidden.code}`)
}

async function verifyToolCancellationAndResultLimit() {
    const registry = new ToolRegistry([calculatorTool])
    const execute = registry.executorFor(['calculator'])
    const controller = new AbortController()
    controller.abort()
    const cancelled = await captureAgentError(() => execute(toolCall('cancelled', 1, 2), controller.signal))
    assert(cancelled.code === 'CLIENT_ABORTED', `tool cancel should be classified: ${cancelled.code}`)

    const model = new FakeModel([
        assistantTurn('', [toolCall('long-result', 1, 2)], 'tool_calls'),
        assistantTurn('done'),
    ])
    await runner(model, async () => ({ content: 'x'.repeat(200), isError: false })).run(runInput())
    const resultMessage = model.inputs[1]?.messages.find(message => message.role === 'tool')
    assert(resultMessage?.role === 'tool' && resultMessage.content.length === limits.toolResultMaxChars, `tool result should be truncated: ${JSON.stringify(resultMessage)}`)
    assert(resultMessage?.role === 'tool' && resultMessage.content.includes('已截断'), 'tool result truncation marker missing')
}

async function verifyOllamaAgentProtocol() {
    const callResult = parseOllamaAgentResponse({
        message: {
            role: 'assistant',
            content: '',
            tool_calls: [
                { function: { name: 'calculator', arguments: { operation: 'multiply', left: 12, right: 35 } } },
                { id: 'provided-id', function: { name: 'calculator', arguments: '{"operation":"add","left":1,"right":2}' } },
            ],
        },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 20,
        eval_count: 10,
    })
    assert(callResult.finishReason === 'tool_calls' && callResult.message.toolCalls.length === 2, `Ollama tool calls failed: ${JSON.stringify(callResult)}`)
    assert(callResult.message.toolCalls[0]?.id.startsWith('ollama-'), 'Ollama missing tool ID should be generated')
    assert(callResult.message.toolCalls[1]?.id === 'provided-id', 'Ollama provided tool ID should be preserved')
    assert(callResult.usage?.inputTokens === 20 && callResult.usage.outputTokens === 10, `Ollama usage failed: ${JSON.stringify(callResult.usage)}`)

    const messages = toOllamaAgentMessages([
        { role: 'system', content: 'system' },
        { role: 'assistant', content: '', toolCalls: callResult.message.toolCalls },
        { role: 'tool', toolCallId: callResult.message.toolCalls[0]!.id, name: 'calculator', content: '420', isError: false },
    ])
    assert(Array.isArray(messages[1]?.tool_calls) && messages[2]?.tool_name === 'calculator', `Ollama messages failed: ${JSON.stringify(messages)}`)

    const tool = toOllamaTool(calculatorTool.definition) as { function?: { parameters?: unknown } }
    assert(Boolean(tool.function?.parameters), `Ollama tool schema missing: ${JSON.stringify(tool)}`)

    const invalid = await captureAgentError(async () => parseOllamaAgentResponse({
        message: { role: 'assistant', tool_calls: [{ function: { name: 'calculator', arguments: 'not-json' } }] },
    }))
    assert(invalid.code === 'MODEL_RESPONSE_INVALID', `Ollama invalid arguments should fail: ${invalid.code}`)
}

async function verifyOllamaAgentPreCancellation() {
    const controller = new AbortController()
    controller.abort()
    const error = await captureAgentError(() => ollamaAgentProvider.runTurn({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: '不会实际请求' }],
        tools: [calculatorTool.definition],
    }, controller.signal))
    assert(error.code === 'CLIENT_ABORTED', `Ollama pre-cancel should not call network: ${error.code}`)
}

async function verifyOllamaAgentRequest() {
    const originalFetch = globalThis.fetch
    const captured: { body?: Record<string, unknown> } = {}
    globalThis.fetch = async (_input, init) => {
        captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({
            message: { role: 'assistant', content: 'mock answer' },
            done: true,
            done_reason: 'stop',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    try {
        const result = await ollamaAgentProvider.runTurn({
            model: 'qwen2.5:7b',
            messages: [{ role: 'user', content: 'mock request' }],
            tools: [calculatorTool.definition],
        }, new AbortController().signal)
        const requestBody = captured.body
        assert(requestBody, 'Ollama request body should be captured')
        assert(result.message.content === 'mock answer', `Ollama request result failed: ${JSON.stringify(result)}`)
        assert(requestBody.model === 'qwen2.5:7b', `Ollama request model failed: ${JSON.stringify(requestBody)}`)
        assert(requestBody.stream === false && requestBody.think === false, `Ollama Agent must use non-streaming without raw thinking: ${JSON.stringify(requestBody)}`)
        assert(Array.isArray(requestBody.tools) && requestBody.tools.length === 1, `Ollama request tools failed: ${JSON.stringify(requestBody)}`)
    } finally {
        globalThis.fetch = originalFetch
    }
}

async function verifyAgentEventContract() {
    const output = new PassThrough()
    let body = ''
    output.on('data', chunk => { body += chunk.toString() })
    const writer = new AgentEventWriter(output, {
        requestId: 'request-id',
        agentRunId: 'agent-run-id',
    })
    assert(await writer.emit('agent_started', 0, { model: 'fake' }), 'first event should be emitted')
    assert(await writer.emit('agent_completed', 1, { finishReason: 'stop' }), 'terminal event should be emitted')
    assert(!await writer.emit('agent_failed', 1, { code: 'unexpected' }), 'second terminal event must be rejected')
    output.end()
    const events = body.trim().split('\n').map(line => JSON.parse(line) as {
        version: number
        sequence: number
        requestId: string
        agentRunId: string
        type: string
    })
    assert(events.length === 2, `event count failed: ${body}`)
    assert(events[0]?.version === 1 && events[0].sequence === 1 && events[1]?.sequence === 2, `event sequence failed: ${body}`)
    assert(events.every(event => event.requestId === 'request-id' && event.agentRunId === 'agent-run-id'), `event IDs failed: ${body}`)
    assert(writer.hasTerminalEvent(), 'terminal state should be recorded')

    assert(isLoopbackAddress('127.0.0.1') && isLoopbackAddress('::1') && isLoopbackAddress('::ffff:127.0.0.1'), 'loopback addresses should be accepted')
    assert(!isLoopbackAddress('192.168.1.10'), 'LAN address must not be treated as loopback')
}

function runner(
    model: AgentModelClient,
    executeTool: ((call: AgentToolCall, signal: AbortSignal) => Promise<{ content: string; isError: boolean }>) | undefined = undefined,
    modelScheduler?: AgentModelScheduler
) {
    return new AgentRunner({
        modelClient: model,
        modelScheduler,
        tools: [{
            name: 'calculator',
            description: '测试计算器',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        }],
        executeTool: executeTool ?? (async call => ({ content: call.id, isError: false })),
        limits,
    })
}

function runInput() {
    return {
        model: 'fake-model',
        systemPrompt: 'test system prompt',
        messages: [{ role: 'user' as const, content: '计算' }],
        signal: new AbortController().signal,
    }
}

function assistantTurn(
    content: string,
    toolCalls: AgentToolCall[] = [],
    finishReason: AgentTurnResult['finishReason'] = 'stop'
): AgentTurnResult {
    return {
        message: { role: 'assistant', content, toolCalls },
        finishReason,
        usage: { inputTokens: 10, outputTokens: 5 },
    }
}

function toolCall(id: string, left: number, right: number): AgentToolCall {
    return {
        id,
        name: 'calculator',
        arguments: { operation: 'multiply', left, right },
    }
}

async function captureAgentError(action: () => Promise<unknown>): Promise<AgentError> {
    try {
        await action()
    } catch (error) {
        if (error instanceof AgentError) return error
        throw error
    }
    throw new Error('Expected AgentError')
}

async function main() {
    await verifyDirectAnswer()
    await verifyToolRoundTrip()
    await verifyMultipleToolsAreSequential()
    await verifyToolLimit()
    await verifyLastTurnDoesNotExecuteTool()
    await verifyProtocolValidation()
    await verifyCancellation()
    await verifyModelQueueConcurrencyAndOrder()
    await verifyQueueFullAndTimeout()
    await verifyQueuedCancellationAndFailureRelease()
    await verifyRunnerUsesModelQueue()
    await verifyToolRegistryAndCalculator()
    await verifyToolCancellationAndResultLimit()
    await verifyOllamaAgentProtocol()
    await verifyOllamaAgentPreCancellation()
    await verifyOllamaAgentRequest()
    await verifyAgentEventContract()
    console.log(JSON.stringify({
        ok: true,
        checks: ['direct-answer', 'tool-round-trip', 'multiple-tools-sequential', 'tool-limit', 'turn-limit', 'protocol-validation', 'cancellation', 'queue-concurrency', 'queue-full-timeout', 'queue-cancel-release', 'runner-model-queue', 'tool-registry-calculator', 'tool-cancel-result-limit', 'ollama-agent-protocol', 'ollama-agent-cancel', 'ollama-agent-request', 'event-terminal-sequence', 'loopback-access'],
    }))
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}
