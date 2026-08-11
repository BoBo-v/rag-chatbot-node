import { AgentError } from '../agent/errors'
import { AgentRunner } from '../agent/runner'
import type {
    AgentLimits,
    AgentMessage,
    AgentModelClient,
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

function runner(
    model: AgentModelClient,
    executeTool: (call: AgentToolCall, signal: AbortSignal) => Promise<{ content: string; isError: boolean }> = async call => ({ content: call.id, isError: false })
) {
    return new AgentRunner({
        modelClient: model,
        tools: [{
            name: 'calculator',
            description: '测试计算器',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        }],
        executeTool,
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
    console.log(JSON.stringify({
        ok: true,
        checks: ['direct-answer', 'tool-round-trip', 'multiple-tools-sequential', 'tool-limit', 'turn-limit', 'protocol-validation', 'cancellation'],
    }))
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
