import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { GenerationRepository } from '../generation/repository'
import { GenerationRunService } from '../generation/service'
import { initGenerationSchema } from '../generation/store'

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

function createInput(overrides: Partial<Parameters<GenerationRepository['create']>[0]> = {}) {
    return {
        runId: randomUUID(),
        runType: 'chat' as const,
        conversationId: 'conversation-service',
        turnId: randomUUID(),
        sourceUserMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        ownerId: 'local',
        provider: 'ollama',
        model: 'qwen3:8b',
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        ...overrides,
    }
}

function main() {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    initGenerationSchema(database)
    const repository = new GenerationRepository(database)
    const service = new GenerationRunService(repository)

    try {
        const created = service.create(createInput())
        const liveEvents: number[] = []
        const unsubscribe = service.subscribe(created.run.runId, 0, event => liveEvents.push(event.sequence))

        service.appendEvent(created.run.runId, {
            eventType: 'run_started',
            transitionTo: 'running',
        })
        service.appendEvent(created.run.runId, {
            eventType: 'text_delta',
            data: { content: 'hello' },
            outputDelta: 'hello',
        })
        assert(liveEvents.join(',') === '1,2', 'live event publication failed')

        const replayedEvents: number[] = []
        const unsubscribeReplay = service.subscribe(created.run.runId, 1, event => replayedEvents.push(event.sequence))
        assert(replayedEvents.join(',') === '2', 'historical event replay failed')

        service.appendEvent(created.run.runId, {
            eventType: 'run_completed',
            transitionTo: 'completed',
        })
        assert(liveEvents.join(',') === '1,2,3', 'live subscription missed event')
        assert(replayedEvents.join(',') === '2,3', 'replay subscription missed event')

        unsubscribe()
        unsubscribeReplay()
        service.close()

        console.log(JSON.stringify({
            ok: true,
            checks: ['create', 'live-publication', 'sequence-replay', 'multiple-subscribers', 'close'],
        }))
    } finally {
        database.close()
    }
}

try {
    main()
} catch (error) {
    console.error(error)
    process.exitCode = 1
}
