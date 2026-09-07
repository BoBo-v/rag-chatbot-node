import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../utils/config'

let db: DatabaseSync | null = null

export function getGenerationDb(): DatabaseSync {
    if (db) return db

    const dbPath = path.resolve(process.cwd(), config.generationDbPath)
    assertDedicatedPath(dbPath, path.resolve(process.cwd(), config.vectorStorePath), 'VECTOR_STORE_PATH')
    assertDedicatedPath(dbPath, path.resolve(process.cwd(), config.observabilityDbPath), 'OBSERVABILITY_DB_PATH')

    mkdirSync(path.dirname(dbPath), { recursive: true })
    const database = new DatabaseSync(dbPath)
    try {
        database.exec('PRAGMA journal_mode = WAL')
        database.exec('PRAGMA busy_timeout = 5000')
        database.exec('PRAGMA foreign_keys = ON')
        initGenerationSchema(database)
        db = database
        return database
    } catch (error) {
        try { database.close() } catch { /* Ignore close failure after initialization error. */ }
        throw error
    }
}

export function closeGenerationDb(): void {
    if (!db) return
    db.close()
    db = null
}

export function initGenerationSchema(database: DatabaseSync): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS generation_runs (
            run_id TEXT PRIMARY KEY,
            run_type TEXT NOT NULL CHECK (run_type IN ('chat', 'agent')),
            conversation_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            source_user_message_id TEXT NOT NULL,
            assistant_message_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            regenerated_from_run_id TEXT,
            output_text TEXT NOT NULL DEFAULT '',
            last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
            error_code TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            cancel_requested_at TEXT,
            UNIQUE (owner_id, run_type, idempotency_key),
            FOREIGN KEY (regenerated_from_run_id) REFERENCES generation_runs(run_id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS generation_events (
            run_id TEXT NOT NULL,
            sequence INTEGER NOT NULL CHECK (sequence > 0),
            event_type TEXT NOT NULL,
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, sequence),
            FOREIGN KEY (run_id) REFERENCES generation_runs(run_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_generation_runs_status_created
            ON generation_runs(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_generation_runs_conversation_created
            ON generation_runs(owner_id, conversation_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_generation_runs_assistant_message
            ON generation_runs(owner_id, assistant_message_id);
        CREATE INDEX IF NOT EXISTS idx_generation_runs_finished
            ON generation_runs(finished_at);
        CREATE INDEX IF NOT EXISTS idx_generation_events_run_sequence
            ON generation_events(run_id, sequence);
    `)
}

function assertDedicatedPath(generationPath: string, otherPath: string, otherName: string): void {
    const samePath = process.platform === 'win32'
        ? generationPath.toLowerCase() === otherPath.toLowerCase()
        : generationPath === otherPath
    if (samePath) {
        throw new Error(`GENERATION_DB_PATH 不能与 ${otherName} 相同`)
    }
}
