import { randomUUID } from 'node:crypto'
import { config } from '../utils/config'
import { safeContextJson, safeErrorMessage } from './privacy'
import {
    cleanupObservability,
    closeObservabilityDb,
    getObservabilityDb,
    insertObservabilityBatch,
} from './store'
import type {
    AiRequestLogEntry,
    ApplicationEventEntry,
    HttpRequestLogEntry,
    ObservabilityQueueEntry,
    ObservabilityRuntimeStatus,
} from './types'

const flushThreshold = 50
const cleanupIntervalMs = 24 * 60 * 60 * 1000
const retryBaseDelayMs = 250

let queue: ObservabilityQueueEntry[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null
let retryAttempt = 0
let droppedLogCount = 0
let lastFlushError: string | null = null
let lastFlushAt: string | null = null
let lastCleanupAt: string | null = null
let started = false

export function startObservability(): void {
    if (started) return
    started = true
    try {
        getObservabilityDb()
    } catch (err) {
        lastFlushError = safeErrorMessage(err, '观测数据库初始化失败')
        console.error('[observability] initialization failed', { message: lastFlushError })
    }
    flushTimer = setInterval(() => flushQueue(), config.logFlushIntervalMs)
    cleanupTimer = setInterval(runCleanup, cleanupIntervalMs)
    flushTimer.unref?.()
    cleanupTimer.unref?.()
    if (!lastFlushError) runCleanup()
}

export function stopObservability(): void {
    if (flushTimer) clearInterval(flushTimer)
    if (retryTimer) clearTimeout(retryTimer)
    if (cleanupTimer) clearInterval(cleanupTimer)
    flushTimer = null
    retryTimer = null
    cleanupTimer = null
    flushQueue(true)
    closeObservabilityDb()
    started = false
}

export function recordHttpRequest(entry: HttpRequestLogEntry): void {
    enqueue({ kind: 'http', value: entry })
}

export function recordAiRequest(entry: AiRequestLogEntry): void {
    enqueue({ kind: 'ai', value: entry })
}

export function recordApplicationEvent(input: Omit<ApplicationEventEntry, 'id' | 'timestamp' | 'contextJson' | 'message'> & {
    message: unknown
    context?: Record<string, unknown>
}): void {
    enqueue({
        kind: 'event',
        value: {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            requestId: input.requestId,
            level: input.level,
            eventType: input.eventType,
            module: input.module,
            operation: input.operation,
            statusCode: input.statusCode,
            errorCode: input.errorCode,
            message: safeErrorMessage(input.message),
            contextJson: safeContextJson(input.context),
        },
    })
}

export function getObservabilityRuntimeStatus(): ObservabilityRuntimeStatus {
    return {
        queueSize: queue.length,
        droppedLogCount,
        lastFlushError,
        lastFlushAt,
        lastCleanupAt,
        dropPolicy: 'drop_oldest',
    }
}

export function flushObservabilityForTest(): void {
    flushQueue(true)
}

function enqueue(entry: ObservabilityQueueEntry): void {
    if (!started) startObservability()
    if (queue.length >= config.logQueueMaxSize) {
        queue.shift()
        droppedLogCount++
    }
    queue.push(entry)

    if (queue.length >= flushThreshold && !retryTimer) flushQueue()
}

function flushQueue(shuttingDown = false): void {
    if (queue.length === 0) return
    if (retryTimer && !shuttingDown) return

    const batch = queue.splice(0, flushThreshold)
    try {
        insertObservabilityBatch(getObservabilityDb(), batch)
        retryAttempt = 0
        lastFlushError = null
        lastFlushAt = new Date().toISOString()
        if (queue.length >= flushThreshold && !shuttingDown) setTimeout(() => flushQueue(), 0)
        if (shuttingDown && queue.length > 0) flushQueue(true)
    } catch (err) {
        lastFlushError = safeErrorMessage(err, '日志批量写入失败')
        const canRetry = !shuttingDown && retryAttempt < config.logWriteRetryCount
        if (canRetry) {
            retryAttempt++
            prependBatch(batch)
            const delay = retryBaseDelayMs * (2 ** (retryAttempt - 1))
            retryTimer = setTimeout(() => {
                retryTimer = null
                flushQueue()
            }, delay)
            retryTimer.unref?.()
        } else {
            droppedLogCount += batch.length
            retryAttempt = 0
            if (shuttingDown && queue.length > 0) {
                droppedLogCount += queue.length
                queue = []
            }
        }
        console.error('[observability] flush failed', {
            message: lastFlushError,
            batchSize: batch.length,
            willRetry: canRetry,
        })
    }
}

function prependBatch(batch: ObservabilityQueueEntry[]): void {
    queue = [...batch, ...queue]
    while (queue.length > config.logQueueMaxSize) {
        queue.shift()
        droppedLogCount++
    }
}

function runCleanup(): void {
    try {
        cleanupObservability(getObservabilityDb())
        lastCleanupAt = new Date().toISOString()
    } catch (err) {
        console.error('[observability] cleanup failed', {
            message: safeErrorMessage(err, '日志清理失败'),
        })
    }
}
