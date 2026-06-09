import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config'
import { initMetricsTable, insertMetrics, cleanupOldMetrics, type MetricRow } from './metricsStore'

export interface MetricEntry {
    id: string
    compareId: string | null
    timestamp: string
    endpoint: string
    provider: string
    model: string
    status: 'success' | 'failed' | 'stream_error' | 'client_aborted'
    statusCode: number | null
    errorCode: string | null
    errorMessage: string | null
    startedAt: string
    endedAt: string
    latencyMs: number
    ragEnabled: boolean
    ragHitCount: number
    ragPromptChars: number
    inputChars: number | null
    outputChars: number | null
    estInputTokens: number | null
    estOutputTokens: number | null
    estCostUsd: number
    questionPreview: string | null
    isTimeout: boolean
    rawError: string | null
}

const FLUSH_INTERVAL_MS = 5000
const FLUSH_THRESHOLD = 50
const CLEANUP_EVERY_N_FLUSHES = 60

let db: DatabaseSync | null = null
let ownsDb = false
let buffer: MetricEntry[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null
let flushCount = 0

export function recordMetric(entry: MetricEntry): void {
    ensureDb()
    buffer.push(entry)
    if (buffer.length >= FLUSH_THRESHOLD) {
        flush()
    }
}

function ensureDb(): void {
    if (db) return

    const dbPath = path.resolve(process.cwd(), config.vectorStorePath)
    mkdirSync(path.dirname(dbPath), { recursive: true })
    db = new DatabaseSync(dbPath)
    ownsDb = true
    db.exec('PRAGMA journal_mode = WAL')
    initMetricsTable(db)

    if (!flushTimer) {
        flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)
    }
}

export function startMetricsCollector(database: DatabaseSync): void {
    // If we already lazily opened a DB, close it and use the shared one
    if (db && db !== database && ownsDb) {
        try { db.close() } catch { /* ignore */ }
    }
    db = database
    ownsDb = false
    initMetricsTable(db)
    if (!flushTimer) {
        flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)
    }
}

export function stopMetricsCollector(): void {
    if (flushTimer) {
        clearInterval(flushTimer)
        flushTimer = null
    }
    flush()
    if (db && ownsDb) {
        try { db.close() } catch { /* ignore */ }
    }
    db = null
    ownsDb = false
}

function flush(): void {
    if (buffer.length === 0 || !db) return

    const batch = buffer.splice(0)
    const rows: MetricRow[] = batch.map(entry => ({
        id: entry.id,
        compare_id: entry.compareId,
        timestamp: entry.timestamp,
        endpoint: entry.endpoint,
        provider: entry.provider,
        model: entry.model,
        status: entry.status,
        status_code: entry.statusCode,
        error_code: entry.errorCode,
        error_message: entry.errorMessage,
        started_at: entry.startedAt,
        ended_at: entry.endedAt,
        latency_ms: entry.latencyMs,
        rag_enabled: entry.ragEnabled ? 1 : 0,
        rag_hit_count: entry.ragHitCount,
        rag_prompt_chars: entry.ragPromptChars,
        input_chars: entry.inputChars,
        output_chars: entry.outputChars,
        est_input_tokens: entry.estInputTokens,
        est_output_tokens: entry.estOutputTokens,
        est_cost_usd: entry.estCostUsd,
        question_preview: entry.questionPreview,
        is_timeout: entry.isTimeout ? 1 : 0,
        raw_error: entry.rawError,
    }))

    try {
        insertMetrics(db, rows)
    } catch (err) {
        // Drop batch on error — don't crash the server
        console.error('[metrics] Failed to flush metrics:', err)
    }

    flushCount++
    if (flushCount % CLEANUP_EVERY_N_FLUSHES === 0) {
        try {
            cleanupOldMetrics(db, config.metricsRetentionDays)
        } catch (err) {
            console.error('[metrics] Failed to cleanup old metrics:', err)
        }
    }
}
