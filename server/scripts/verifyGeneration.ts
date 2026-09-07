import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { GenerationError } from '../generation/errors'
import { GenerationRepository } from '../generation/repository'
import { initGenerationSchema } from '../generation/store'

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

function input(overrides: Partial<Parameters<GenerationRepository['create']>[0]> = {}) {
    return {
        runId: randomUUID(),
        runType: 'chat' as const,
        conversationId: 'conversation-1',
        turnId: randomUUID(),
        sourceUserMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        ownerId: 'local',
        provider: 'ollama',
        model: 'qwen3:8b',
        idempotencyKey: randomUUID(),
        requestHash: 'hash-1',
        ...overrides,
    }
}

async function main() {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    initGenerationSchema(database)
    const repository = new GenerationRepository(database, {
        maxOutputChars: 20,
        maxEventsPerRun: 10,
    })

    try {
        const createInput = input()
        const created = repository.create(createInput)
        assert(created.created && created.run.status === 'queued', 'run creation failed')

        const reused = repository.create({ ...createInput, runId: randomUUID() })
        assert(!reused.created && reused.run.runId === created.run.runId, 'idempotent create should reuse run')

        const idempotencyError = captureGenerationError(() => repository.create({
            ...createInput,
            runId: randomUUID(),
            requestHash: 'different-hash',
        }))
        assert(idempotencyError.code === 'GENERATION_IDEMPOTENCY_CONFLICT', 'idempotency conflict code failed')

        const messageError = captureGenerationError(() => repository.create(input({
            assistantMessageId: createInput.assistantMessageId,
        })))
        assert(messageError.code === 'GENERATION_MESSAGE_CONFLICT', 'assistant message conflict code failed')

        const started = repository.appendEvent(created.run.runId, {
            eventType: 'run_started',
            data: { provider: 'ollama' },
            transitionTo: 'running',
        })
        assert(started.appended && started.event?.sequence === 1 && started.run.status === 'running', 'start event failed')

        const firstDelta = repository.appendEvent(created.run.runId, {
            eventType: 'text_delta',
            data: { content: '你好' },
            outputDelta: '你好',
        })
        const secondDelta = repository.appendEvent(created.run.runId, {
            eventType: 'text_delta',
            data: { content: '，世界' },
            outputDelta: '，世界',
        })
        assert(firstDelta.event?.sequence === 2 && secondDelta.run.outputText === '你好，世界', 'delta transaction failed')

        const completed = repository.appendEvent(created.run.runId, {
            eventType: 'run_completed',
            data: { finishReason: 'stop' },
            transitionTo: 'completed',
        })
        assert(completed.event?.sequence === 4 && completed.run.status === 'completed', 'completion failed')

        const duplicateTerminal = repository.appendEvent(created.run.runId, {
            eventType: 'run_cancelled',
            transitionTo: 'cancelled',
        })
        assert(!duplicateTerminal.appended && duplicateTerminal.run.status === 'completed', 'terminal state must be idempotent')

        const events = repository.listEvents(created.run.runId, 1)
        assert(events.map(event => event.sequence).join(',') === '2,3,4', 'event replay order failed')
        assert(repository.deleteTerminal(created.run.runId, 'local'), 'terminal delete failed')
        assert(repository.listEvents(created.run.runId).length === 0, 'event cascade delete failed')

        const limited = repository.create(input())
        repository.appendEvent(limited.run.runId, { eventType: 'run_started', transitionTo: 'running' })
        const outputError = captureGenerationError(() => repository.appendEvent(limited.run.runId, {
            eventType: 'text_delta',
            data: { content: 'x'.repeat(21) },
            outputDelta: 'x'.repeat(21),
        }))
        assert(outputError.code === 'GENERATION_OUTPUT_LIMIT_EXCEEDED', 'output limit failed')

        console.log(JSON.stringify({
            ok: true,
            checks: [
                'schema', 'idempotent-create', 'idempotency-conflict', 'message-conflict',
                'atomic-sequence-output', 'event-replay', 'terminal-idempotency',
                'cascade-delete', 'output-limit',
            ],
        }))
    } finally {
        database.close()
    }
}

function captureGenerationError(action: () => unknown): GenerationError {
    try {
        action()
    } catch (error) {
        if (error instanceof GenerationError) return error
        throw error
    }
    throw new Error('Expected GenerationError')
}

void main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
