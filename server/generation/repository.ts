import type { DatabaseSync } from 'node:sqlite'
import { config } from '../utils/config'
import { GenerationError } from './errors'
import type {
    AppendGenerationEventInput,
    AppendGenerationEventResult,
    CreateGenerationRunInput,
    CreateGenerationRunResult,
    GenerationEvent,
    GenerationRun,
    GenerationRunStatus,
} from './types'

interface GenerationRepositoryOptions {
    maxOutputChars?: number
    maxEventsPerRun?: number
    maxEventDataChars?: number
}

interface GenerationRunRow {
    run_id: string
    run_type: GenerationRun['runType']
    conversation_id: string
    turn_id: string
    source_user_message_id: string
    assistant_message_id: string
    owner_id: string
    status: GenerationRunStatus
    provider: string
    model: string
    idempotency_key: string
    request_hash: string
    regenerated_from_run_id: string | null
    output_text: string
    last_sequence: number
    error_code: string | null
    error_message: string | null
    created_at: string
    started_at: string | null
    finished_at: string | null
    cancel_requested_at: string | null
}

interface GenerationEventRow {
    run_id: string
    sequence: number
    event_type: string
    data_json: string
    created_at: string
}

const terminalStatuses = new Set<GenerationRunStatus>(['completed', 'failed', 'cancelled'])
const allowedTransitions: Record<GenerationRunStatus, ReadonlySet<GenerationRunStatus>> = {
    queued: new Set(['running', 'failed', 'cancelled']),
    running: new Set(['completed', 'failed', 'cancelled']),
    completed: new Set(),
    failed: new Set(),
    cancelled: new Set(),
}

export class GenerationRepository {
    private readonly maxOutputChars: number
    private readonly maxEventsPerRun: number
    private readonly maxEventDataChars: number

    constructor(
        private readonly database: DatabaseSync,
        options: GenerationRepositoryOptions = {},
    ) {
        this.maxOutputChars = options.maxOutputChars ?? config.generationMaxOutputChars
        this.maxEventsPerRun = options.maxEventsPerRun ?? config.generationMaxEventsPerRun
        this.maxEventDataChars = options.maxEventDataChars ?? 100_000
    }

    create(input: CreateGenerationRunInput): CreateGenerationRunResult {
        const createdAt = input.createdAt ?? new Date().toISOString()
        this.database.exec('BEGIN IMMEDIATE')
        try {
            const idempotent = this.findByIdempotencyKey(input.ownerId, input.runType, input.idempotencyKey)
            if (idempotent) {
                if (idempotent.requestHash !== input.requestHash) {
                    throw new GenerationError(
                        'GENERATION_IDEMPOTENCY_CONFLICT',
                        '相同幂等键已用于不同的生成请求。',
                        409,
                    )
                }
                this.database.exec('COMMIT')
                return { created: false, run: idempotent }
            }

            const messageRun = this.findByAssistantMessageId(input.ownerId, input.assistantMessageId)
            if (messageRun) {
                throw new GenerationError(
                    'GENERATION_MESSAGE_CONFLICT',
                    '当前回答消息已经关联其他生成任务。',
                    409,
                )
            }

            this.database.prepare(`
                INSERT INTO generation_runs (
                    run_id, run_type, conversation_id, turn_id, source_user_message_id,
                    assistant_message_id, owner_id, status, provider, model,
                    idempotency_key, request_hash, regenerated_from_run_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
            `).run(
                input.runId,
                input.runType,
                input.conversationId,
                input.turnId,
                input.sourceUserMessageId,
                input.assistantMessageId,
                input.ownerId,
                input.provider,
                input.model,
                input.idempotencyKey,
                input.requestHash,
                input.regeneratedFromRunId ?? null,
                createdAt,
            )
            const run = this.require(input.runId)
            this.database.exec('COMMIT')
            return { created: true, run }
        } catch (error) {
            this.database.exec('ROLLBACK')
            throw error
        }
    }

    get(runId: string): GenerationRun | null {
        const row = this.database.prepare('SELECT * FROM generation_runs WHERE run_id = ?')
            .get(runId) as unknown as GenerationRunRow | undefined
        return row ? toGenerationRun(row) : null
    }

    getOwned(runId: string, ownerId: string, runType?: GenerationRun['runType']): GenerationRun | null {
        const row = runType
            ? this.database.prepare('SELECT * FROM generation_runs WHERE run_id = ? AND owner_id = ? AND run_type = ?')
                .get(runId, ownerId, runType)
            : this.database.prepare('SELECT * FROM generation_runs WHERE run_id = ? AND owner_id = ?')
                .get(runId, ownerId)
        return row ? toGenerationRun(row as unknown as GenerationRunRow) : null
    }

    listEvents(runId: string, afterSequence = 0, limit = 1000): GenerationEvent[] {
        const boundedLimit = Math.min(5000, Math.max(1, Math.floor(limit)))
        const rows = this.database.prepare(`
            SELECT run_id, sequence, event_type, data_json, created_at
            FROM generation_events
            WHERE run_id = ? AND sequence > ?
            ORDER BY sequence ASC
            LIMIT ?
        `).all(runId, Math.max(0, Math.floor(afterSequence)), boundedLimit) as unknown as GenerationEventRow[]
        return rows.map(toGenerationEvent)
    }

    appendEvent(runId: string, input: AppendGenerationEventInput): AppendGenerationEventResult {
        const createdAt = input.createdAt ?? new Date().toISOString()
        const dataJson = serializeEventData(input.data ?? {})
        if (dataJson.length > this.maxEventDataChars) {
            throw new GenerationError('GENERATION_EVENT_INVALID', '生成事件数据超过长度限制。', 500)
        }

        this.database.exec('BEGIN IMMEDIATE')
        try {
            const current = this.require(runId)
            if (terminalStatuses.has(current.status)) {
                this.database.exec('COMMIT')
                return { appended: false, run: current, event: null }
            }

            const targetStatus = input.transitionTo ?? current.status
            validateTransition(current.status, targetStatus)
            if (current.lastSequence >= this.maxEventsPerRun) {
                throw new GenerationError(
                    'GENERATION_EVENT_LIMIT_EXCEEDED',
                    '生成任务事件数量超过限制。',
                    409,
                )
            }

            const outputDelta = input.outputDelta ?? ''
            const outputText = current.outputText + outputDelta
            if (outputText.length > this.maxOutputChars) {
                throw new GenerationError(
                    'GENERATION_OUTPUT_LIMIT_EXCEEDED',
                    '模型回答超过生成任务保存上限。',
                    409,
                )
            }

            const sequence = current.lastSequence + 1
            this.database.prepare(`
                INSERT INTO generation_events (run_id, sequence, event_type, data_json, created_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(runId, sequence, input.eventType, dataJson, createdAt)

            const startedAt = targetStatus === 'running' && !current.startedAt ? createdAt : current.startedAt
            const finishedAt = terminalStatuses.has(targetStatus) ? createdAt : current.finishedAt
            this.database.prepare(`
                UPDATE generation_runs
                SET status = ?, output_text = ?, last_sequence = ?,
                    error_code = ?, error_message = ?, started_at = ?, finished_at = ?
                WHERE run_id = ?
            `).run(
                targetStatus,
                outputText,
                sequence,
                input.errorCode ?? current.errorCode,
                input.errorMessage ?? current.errorMessage,
                startedAt,
                finishedAt,
                runId,
            )

            const run = this.require(runId)
            const event: GenerationEvent = {
                runId,
                sequence,
                eventType: input.eventType,
                data: input.data ?? {},
                createdAt,
            }
            this.database.exec('COMMIT')
            return { appended: true, run, event }
        } catch (error) {
            this.database.exec('ROLLBACK')
            throw error
        }
    }

    requestCancellation(runId: string, requestedAt = new Date().toISOString()): GenerationRun {
        this.database.prepare(`
            UPDATE generation_runs
            SET cancel_requested_at = COALESCE(cancel_requested_at, ?)
            WHERE run_id = ? AND status IN ('queued', 'running')
        `).run(requestedAt, runId)
        return this.require(runId)
    }

    deleteTerminal(runId: string, ownerId: string): boolean {
        const result = this.database.prepare(`
            DELETE FROM generation_runs
            WHERE run_id = ? AND owner_id = ? AND status IN ('completed', 'failed', 'cancelled')
        `).run(runId, ownerId)
        return Number(result.changes) > 0
    }

    private require(runId: string): GenerationRun {
        const run = this.get(runId)
        if (!run) {
            throw new GenerationError('GENERATION_RUN_NOT_FOUND', '生成任务不存在。', 404)
        }
        return run
    }

    private findByIdempotencyKey(
        ownerId: string,
        runType: GenerationRun['runType'],
        idempotencyKey: string,
    ): GenerationRun | null {
        const row = this.database.prepare(`
            SELECT * FROM generation_runs
            WHERE owner_id = ? AND run_type = ? AND idempotency_key = ?
        `).get(ownerId, runType, idempotencyKey) as unknown as GenerationRunRow | undefined
        return row ? toGenerationRun(row) : null
    }

    private findByAssistantMessageId(ownerId: string, assistantMessageId: string): GenerationRun | null {
        const row = this.database.prepare(`
            SELECT * FROM generation_runs
            WHERE owner_id = ? AND assistant_message_id = ?
            LIMIT 1
        `).get(ownerId, assistantMessageId) as unknown as GenerationRunRow | undefined
        return row ? toGenerationRun(row) : null
    }
}

function validateTransition(current: GenerationRunStatus, target: GenerationRunStatus): void {
    if (current === target) return
    if (allowedTransitions[current].has(target)) return
    throw new GenerationError(
        'GENERATION_STATE_CONFLICT',
        `生成任务不能从 ${current} 转换为 ${target}。`,
        409,
    )
}

function serializeEventData(data: Record<string, unknown>): string {
    try {
        return JSON.stringify(data)
    } catch (error) {
        throw new GenerationError('GENERATION_EVENT_INVALID', '生成事件数据无法序列化。', 500, { cause: error })
    }
}

function toGenerationRun(row: GenerationRunRow): GenerationRun {
    return {
        runId: row.run_id,
        runType: row.run_type,
        conversationId: row.conversation_id,
        turnId: row.turn_id,
        sourceUserMessageId: row.source_user_message_id,
        assistantMessageId: row.assistant_message_id,
        ownerId: row.owner_id,
        status: row.status,
        provider: row.provider,
        model: row.model,
        idempotencyKey: row.idempotency_key,
        requestHash: row.request_hash,
        regeneratedFromRunId: row.regenerated_from_run_id,
        outputText: row.output_text,
        lastSequence: Number(row.last_sequence),
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        cancelRequestedAt: row.cancel_requested_at,
    }
}

function toGenerationEvent(row: GenerationEventRow): GenerationEvent {
    let data: unknown
    try {
        data = JSON.parse(row.data_json)
    } catch (error) {
        throw new GenerationError('GENERATION_EVENT_INVALID', '数据库中的生成事件不是有效 JSON。', 500, { cause: error })
    }
    if (!isRecord(data)) {
        throw new GenerationError('GENERATION_EVENT_INVALID', '数据库中的生成事件 data 必须是对象。', 500)
    }
    return {
        runId: row.run_id,
        sequence: Number(row.sequence),
        eventType: row.event_type,
        data,
        createdAt: row.created_at,
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
