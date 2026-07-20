import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../utils/config'
import type { ObservabilityQueueEntry } from './types'

let db: DatabaseSync | null = null

export function getObservabilityDb(): DatabaseSync {
    if (db) return db

    const dbPath = path.resolve(process.cwd(), config.observabilityDbPath)
    const vectorPath = path.resolve(process.cwd(), config.vectorStorePath)
    const samePath = process.platform === 'win32'
        ? dbPath.toLowerCase() === vectorPath.toLowerCase()
        : dbPath === vectorPath
    if (samePath) {
        throw new Error('OBSERVABILITY_DB_PATH 不能与 VECTOR_STORE_PATH 相同')
    }

    mkdirSync(path.dirname(dbPath), { recursive: true })
    const database = new DatabaseSync(dbPath)
    try {
        database.exec('PRAGMA journal_mode = WAL')
        database.exec('PRAGMA busy_timeout = 5000')
        database.exec('PRAGMA foreign_keys = ON')
        initSchema(database)
        migrateLegacyAiMetrics(database, vectorPath)
        db = database
        return database
    } catch (err) {
        try { database.close() } catch { /* ignore close failure after initialization error */ }
        throw err
    }
}

export function closeObservabilityDb(): void {
    if (!db) return
    db.close()
    db = null
}

export function insertObservabilityBatch(database: DatabaseSync, batch: ObservabilityQueueEntry[]): void {
    if (batch.length === 0) return

    const httpStmt = database.prepare(`
        INSERT OR REPLACE INTO http_request_logs (
            id, timestamp, method, route, status_code, response_time_ms, remote_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const aiStmt = database.prepare(`
        INSERT OR REPLACE INTO ai_request_logs (
            id, request_id, compare_id, timestamp, endpoint, provider, model,
            status, status_code, error_code, error_message,
            started_at, ended_at, latency_ms,
            rag_enabled, rag_mode, rag_top_k, rag_min_score, rag_hit_count,
            rag_best_score, rag_prompt_chars, embedding_model, prompt_version,
            input_chars, output_chars, est_input_tokens, est_output_tokens,
            est_cost_usd, question_preview, is_timeout
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const eventStmt = database.prepare(`
        INSERT OR REPLACE INTO application_events (
            id, timestamp, request_id, level, event_type, module, operation,
            status_code, error_code, message, context_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    database.exec('BEGIN IMMEDIATE')
    try {
        for (const entry of batch) {
            if (entry.kind === 'http') {
                const value = entry.value
                httpStmt.run(
                    value.id, value.timestamp, value.method, value.route,
                    value.statusCode, value.responseTimeMs, value.remoteAddress
                )
                continue
            }

            if (entry.kind === 'ai') {
                const value = entry.value
                aiStmt.run(
                    value.id, value.requestId, value.compareId, value.timestamp, value.endpoint,
                    value.provider, value.model, value.status, value.statusCode, value.errorCode,
                    value.errorMessage, value.startedAt, value.endedAt, value.latencyMs,
                    value.ragEnabled ? 1 : 0, value.ragMode, value.ragTopK, value.ragMinScore,
                    value.ragHitCount, value.ragBestScore, value.ragPromptChars,
                    value.embeddingModel, value.promptVersion, value.inputChars, value.outputChars,
                    value.estInputTokens, value.estOutputTokens, value.estCostUsd,
                    value.questionPreview, value.isTimeout ? 1 : 0
                )
                continue
            }

            const value = entry.value
            eventStmt.run(
                value.id, value.timestamp, value.requestId, value.level, value.eventType,
                value.module, value.operation, value.statusCode, value.errorCode,
                value.message, value.contextJson
            )
        }
        database.exec('COMMIT')
    } catch (err) {
        database.exec('ROLLBACK')
        throw err
    }
}

export function cleanupObservability(database: DatabaseSync, now = Date.now()): void {
    cleanupTable(database, 'http_request_logs', config.logHttpRetentionDays, now)
    cleanupTable(database, 'ai_request_logs', config.logAiRetentionDays, now)
    cleanupTable(database, 'application_events', config.logEventRetentionDays, now)
}

function initSchema(database: DatabaseSync): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS observability_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS http_request_logs (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            method TEXT NOT NULL,
            route TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            response_time_ms REAL NOT NULL,
            remote_address TEXT
        );

        CREATE TABLE IF NOT EXISTS ai_request_logs (
            id TEXT PRIMARY KEY,
            request_id TEXT,
            compare_id TEXT,
            timestamp TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            status_code INTEGER,
            error_code TEXT,
            error_message TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT NOT NULL,
            latency_ms INTEGER NOT NULL,
            rag_enabled INTEGER NOT NULL DEFAULT 0,
            rag_mode TEXT NOT NULL DEFAULT 'false',
            rag_top_k INTEGER NOT NULL DEFAULT 0,
            rag_min_score REAL NOT NULL DEFAULT 0,
            rag_hit_count INTEGER NOT NULL DEFAULT 0,
            rag_best_score REAL,
            rag_prompt_chars INTEGER NOT NULL DEFAULT 0,
            embedding_model TEXT NOT NULL DEFAULT '',
            prompt_version TEXT NOT NULL DEFAULT '',
            input_chars INTEGER,
            output_chars INTEGER,
            est_input_tokens INTEGER,
            est_output_tokens INTEGER,
            est_cost_usd REAL NOT NULL DEFAULT 0,
            question_preview TEXT,
            is_timeout INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS application_events (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            request_id TEXT,
            level TEXT NOT NULL,
            event_type TEXT NOT NULL,
            module TEXT NOT NULL,
            operation TEXT NOT NULL,
            status_code INTEGER,
            error_code TEXT,
            message TEXT NOT NULL,
            context_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_http_timestamp_id ON http_request_logs(timestamp DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_http_route_status_time ON http_request_logs(route, status_code, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_timestamp_id ON ai_request_logs(timestamp DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_request_id ON ai_request_logs(request_id);
        CREATE INDEX IF NOT EXISTS idx_ai_provider_model_time ON ai_request_logs(provider, model, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_status_time ON ai_request_logs(status, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_compare_id ON ai_request_logs(compare_id);
        CREATE INDEX IF NOT EXISTS idx_event_timestamp_id ON application_events(timestamp DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_event_request_id ON application_events(request_id);
        CREATE INDEX IF NOT EXISTS idx_event_level_type_time ON application_events(level, event_type, timestamp DESC);
    `)
}

function migrateLegacyAiMetrics(database: DatabaseSync, vectorPath: string): void {
    const migrationKey = 'legacy_ai_metrics_v1'
    const migrated = database.prepare('SELECT value FROM observability_meta WHERE key = ?').get(migrationKey)
    if (migrated || !existsSync(vectorPath)) return

    let legacy: DatabaseSync | null = null
    let migrationCompleted = false
    try {
        legacy = new DatabaseSync(vectorPath, { readOnly: true })
        const table = legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_request_logs'").get()
        if (table) {
            const rows = legacy.prepare('SELECT * FROM ai_request_logs ORDER BY timestamp ASC').all() as Array<Record<string, unknown>>
            const stmt = database.prepare(`
                INSERT OR IGNORE INTO ai_request_logs (
                    id, request_id, compare_id, timestamp, endpoint, provider, model,
                    status, status_code, error_code, error_message, started_at, ended_at,
                    latency_ms, rag_enabled, rag_mode, rag_top_k, rag_min_score,
                    rag_hit_count, rag_best_score, rag_prompt_chars, embedding_model,
                    prompt_version, input_chars, output_chars, est_input_tokens,
                    est_output_tokens, est_cost_usd, question_preview, is_timeout
                ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
            `)

            database.exec('BEGIN')
            try {
                for (const row of rows) {
                    stmt.run(
                        String(row.id), nullableString(row.compare_id), String(row.timestamp),
                        String(row.endpoint ?? '/api/chat'), String(row.provider), String(row.model),
                        String(row.status), nullableNumber(row.status_code), nullableString(row.error_code),
                        nullableString(row.error_message), String(row.started_at ?? row.timestamp),
                        String(row.ended_at ?? row.timestamp), Number(row.latency_ms ?? 0),
                        Number(row.rag_enabled ?? 0), Number(row.rag_enabled ?? 0) ? 'legacy' : 'false',
                        0, 0, Number(row.rag_hit_count ?? 0), Number(row.rag_prompt_chars ?? 0),
                        '', 'legacy', nullableNumber(row.input_chars), nullableNumber(row.output_chars),
                        nullableNumber(row.est_input_tokens), nullableNumber(row.est_output_tokens),
                        Number(row.est_cost_usd ?? 0), Number(row.is_timeout ?? 0)
                    )
                }
                database.exec('COMMIT')
            } catch (err) {
                database.exec('ROLLBACK')
                throw err
            }
        }
        migrationCompleted = true
    } finally {
        legacy?.close()
    }

    if (migrationCompleted) {
        database.prepare('INSERT OR REPLACE INTO observability_meta (key, value) VALUES (?, ?)')
            .run(migrationKey, new Date().toISOString())
    }
}

function cleanupTable(database: DatabaseSync, table: string, retentionDays: number, now: number): void {
    const cutoff = new Date(now - retentionDays * 86400000).toISOString()
    database.prepare(`DELETE FROM ${table} WHERE timestamp < ?`).run(cutoff)
}

function nullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
    return typeof value === 'number' ? value : null
}
