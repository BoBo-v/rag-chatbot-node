import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { GenerationMaintenance } from '../generation/maintenance'
import { GenerationRepository } from '../generation/repository'
import { initGenerationSchema } from '../generation/store'

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

function createInput(overrides: Partial<Parameters<GenerationRepository['create']>[0]> = {}) {
    return {
        runId: randomUUID(),
        runType: 'chat' as const,
        conversationId: 'conversation-maintenance',
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

function complete(repository: GenerationRepository, createdAt: string) {
    const created = repository.create(createInput({ createdAt }))
    repository.appendEvent(created.run.runId, {
        eventType: 'run_started',
        transitionTo: 'running',
        createdAt,
    })
    repository.appendEvent(created.run.runId, {
        eventType: 'run_completed',
        transitionTo: 'completed',
        createdAt,
    })
    return created.run.runId
}

function main() {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    initGenerationSchema(database)
    const repository = new GenerationRepository(database)
    const maintenance = new GenerationMaintenance(repository, {
        retentionDays: 7,
        intervalMs: 60_000,
    })

    try {
        const now = new Date('2026-09-07T12:00:00.000Z')
        const oldTerminalRunId = complete(repository, '2026-08-01T12:00:00.000Z')
        const recentTerminalRunId = complete(repository, '2026-09-06T12:00:00.000Z')
        const active = repository.create(createInput({ createdAt: '2026-09-07T11:00:00.000Z' }))
        repository.appendEvent(active.run.runId, {
            eventType: 'run_started',
            transitionTo: 'running',
            createdAt: '2026-09-07T11:00:01.000Z',
        })

        const firstRun = maintenance.runOnce(now)
        assert(firstRun.recoveredRuns === 1, 'active run should be recovered')
        assert(firstRun.eventlessRuns === 0, 'normal recovery should write terminal event')
        assert(firstRun.deletedRuns === 1, 'only expired terminal run should be deleted')
        assert(repository.get(active.run.runId)?.status === 'failed', 'active run should become failed')
        assert(repository.get(active.run.runId)?.errorCode === 'SERVER_RESTARTED', 'restart error code missing')
        assert(repository.listEvents(active.run.runId).at(-1)?.eventType === 'run_failed', 'restart terminal event missing')
        assert(repository.get(oldTerminalRunId) === null, 'expired run should be removed')
        assert(repository.listEvents(oldTerminalRunId).length === 0, 'expired events should cascade delete')
        assert(repository.get(recentTerminalRunId)?.status === 'completed', 'recent run should be retained')

        const secondRun = maintenance.runOnce(now)
        assert(secondRun.recoveredRuns === 0 && secondRun.deletedRuns === 0, 'maintenance rerun should be idempotent')
        assert(repository.listEvents(active.run.runId).length === 2, 'terminal event must not be duplicated')

        console.log(JSON.stringify({
            ok: true,
            checks: [
                'restart-recovery', 'terminal-event', 'retention-delete',
                'cascade-delete', 'recent-retention', 'idempotent-rerun',
            ],
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
