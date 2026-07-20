import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

async function main() {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'node-fastify-observability-'))
    const vectorPath = path.join(tempDir, 'vector-store.sqlite')
    const observabilityPath = path.join(tempDir, 'observability.sqlite')

    process.env.VECTOR_STORE_PATH = vectorPath
    process.env.OBSERVABILITY_DB_PATH = observabilityPath
    process.env.LOG_QUERY_ENABLED = 'true'
    process.env.LOG_QUESTION_PREVIEW = 'false'
    process.env.LOG_REMOTE_ADDRESS = 'none'
    process.env.LOG_QUEUE_MAX_SIZE = '100'
    process.env.LOG_FLUSH_INTERVAL_MS = '60000'
    process.env.LOG_WRITE_RETRY_COUNT = '3'

    createLegacyMetricsDb(vectorPath)

    try {
        const { getObservabilityDb } = await import('../observability/store.js')
        const {
            flushObservabilityForTest,
            getObservabilityRuntimeStatus,
            recordAiRequest,
            recordApplicationEvent,
            recordHttpRequest,
            startObservability,
            stopObservability,
        } = await import('../observability/collector.js')
        const {
            queryErrors,
            queryHttpRequests,
            queryRequestDetail,
        } = await import('../observability/queries.js')

        startObservability()
        const db = getObservabilityDb()
        const migrated = db.prepare('SELECT * FROM ai_request_logs WHERE id = ?').get('legacy-ai-1') as Record<string, unknown>
        assert(migrated.request_id === null, `legacy request_id should be NULL: ${JSON.stringify(migrated)}`)
        assert(migrated.question_preview === null, `legacy question preview should not migrate: ${JSON.stringify(migrated)}`)
        const columns = db.prepare('PRAGMA table_info(ai_request_logs)').all() as Array<{ name: string }>
        assert(!columns.some(column => column.name === 'raw_error'), 'new AI table must not contain raw_error')

        const requestId = randomUUID()
        const secondRequestId = randomUUID()
        const now = new Date()
        const earlier = new Date(now.getTime() - 1000).toISOString()
        recordHttpRequest({
            id: secondRequestId,
            timestamp: earlier,
            method: 'GET',
            route: '/api/files/:id',
            statusCode: 200,
            responseTimeMs: 8,
            remoteAddress: null,
        })
        recordHttpRequest({
            id: requestId,
            timestamp: now.toISOString(),
            method: 'POST',
            route: '/api/chat',
            statusCode: 502,
            responseTimeMs: 1200,
            remoteAddress: null,
        })
        recordAiRequest({
            id: randomUUID(),
            requestId,
            compareId: null,
            timestamp: now.toISOString(),
            endpoint: '/api/chat',
            provider: 'ollama',
            model: 'qwen3:8b',
            status: 'failed',
            statusCode: 502,
            errorCode: 'MODEL_PROVIDER_UNAVAILABLE',
            errorMessage: '模型服务不可用',
            startedAt: now.toISOString(),
            endedAt: now.toISOString(),
            latencyMs: 1200,
            ragEnabled: true,
            ragMode: 'auto',
            ragTopK: 5,
            ragMinScore: 0.6,
            ragHitCount: 2,
            ragBestScore: 0.75,
            ragPromptChars: 1000,
            embeddingModel: 'bge-m3',
            promptVersion: 'rag-fidelity-v1',
            inputChars: 100,
            outputChars: null,
            estInputTokens: 50,
            estOutputTokens: null,
            estCostUsd: 0,
            questionPreview: null,
            isTimeout: false,
        })
        recordApplicationEvent({
            requestId,
            level: 'error',
            eventType: 'test.failed',
            module: 'verify',
            operation: 'verify_observability',
            statusCode: 500,
            errorCode: 'TEST_FAILED',
            message: 'token=secret-value should be hidden',
            context: { safeField: 'ok', authorization: 'Bearer secret-value' },
        })
        flushObservabilityForTest()

        const from = new Date(now.getTime() - 60000).toISOString()
        const to = new Date(now.getTime() + 60000).toISOString()
        const firstPage = queryHttpRequests(db, { from, to, limit: 1 })
        assert(firstPage.rows.length === 1 && firstPage.nextCursor, `first page should have cursor: ${JSON.stringify(firstPage)}`)
        const secondPage = queryHttpRequests(db, { from, to, limit: 1, cursor: firstPage.nextCursor })
        assert(secondPage.rows.length === 1, `second page should return next request: ${JSON.stringify(secondPage)}`)
        assert(secondPage.rows[0].id !== firstPage.rows[0].id, 'cursor pages must not overlap')

        const detail = queryRequestDetail(db, requestId)
        assert(detail?.aiInvocations.length === 1, `request detail should link AI log: ${JSON.stringify(detail)}`)
        assert(detail?.events.length === 1, `request detail should link event: ${JSON.stringify(detail)}`)
        const event = detail?.events[0] as { message?: string; context_json?: string }
        assert(!event.message?.includes('secret-value'), `event message should be redacted: ${JSON.stringify(event)}`)
        assert(!event.context_json?.includes('secret-value'), `event context should be redacted: ${JSON.stringify(event)}`)

        const errors = queryErrors(db, { from, to, limit: 20 })
        assert(errors.rows.some(row => row.request_id === requestId), `errors should include request: ${JSON.stringify(errors)}`)
        assert(errors.rows.every(row => !('raw_error' in row) && !('stack' in row)), 'errors must not expose raw fields')
        const filteredErrors = queryErrors(db, { from, to, limit: 20, errorCode: 'MODEL_PROVIDER_UNAVAILABLE' })
        assert(filteredErrors.rows.length === 1, `errorCode filter should exclude other sources: ${JSON.stringify(filteredErrors)}`)
        assert(filteredErrors.rows[0].error_code === 'MODEL_PROVIDER_UNAVAILABLE', `errorCode filter mismatch: ${JSON.stringify(filteredErrors)}`)
        const status = getObservabilityRuntimeStatus()
        assert(status.droppedLogCount === 0, `unexpected dropped logs: ${JSON.stringify(status)}`)

        db.exec('PRAGMA busy_timeout = 1')
        const lockDb = new DatabaseSync(observabilityPath)
        try {
            lockDb.exec('PRAGMA busy_timeout = 1')
            lockDb.exec('BEGIN IMMEDIATE')
            for (let index = 0; index < 50; index++) {
                recordHttpRequest(testHttpEntry(`/retry-initial/${index}`))
            }
            const failedStatus = getObservabilityRuntimeStatus()
            assert(failedStatus.queueSize === 50, `failed batch should be queued for delayed retry: ${JSON.stringify(failedStatus)}`)
            assert(Boolean(failedStatus.lastFlushError), `flush failure should be visible: ${JSON.stringify(failedStatus)}`)

            for (let index = 0; index < 100; index++) {
                recordHttpRequest(testHttpEntry(`/retry-new/${index}`))
            }
            const cappedStatus = getObservabilityRuntimeStatus()
            assert(cappedStatus.queueSize === 100, `queue should be capped: ${JSON.stringify(cappedStatus)}`)
            assert(cappedStatus.droppedLogCount === 50, `queue should drop the oldest batch: ${JSON.stringify(cappedStatus)}`)
            lockDb.exec('ROLLBACK')
        } finally {
            try { lockDb.exec('ROLLBACK') } catch { /* transaction may already be closed */ }
            lockDb.close()
        }

        await new Promise(resolve => setTimeout(resolve, 600))
        const recoveredStatus = getObservabilityRuntimeStatus()
        assert(recoveredStatus.queueSize === 0, `delayed retry should drain queue: ${JSON.stringify(recoveredStatus)}`)
        assert(recoveredStatus.lastFlushError === null, `successful retry should clear flush error: ${JSON.stringify(recoveredStatus)}`)
        assert(recoveredStatus.droppedLogCount === 50, `dropped count should remain observable: ${JSON.stringify(recoveredStatus)}`)
        const initialRetryRows = db.prepare("SELECT COUNT(*) AS count FROM http_request_logs WHERE route LIKE '/retry-initial/%'").get() as { count: number }
        const newRetryRows = db.prepare("SELECT COUNT(*) AS count FROM http_request_logs WHERE route LIKE '/retry-new/%'").get() as { count: number }
        assert(initialRetryRows.count === 0, `drop_oldest should discard initial batch: ${JSON.stringify(initialRetryRows)}`)
        assert(newRetryRows.count === 100, `delayed retry should persist retained records: ${JSON.stringify(newRetryRows)}`)

        stopObservability()
        console.log(JSON.stringify({
            ok: true,
            checks: ['legacy-migration', 'sensitive-field-drop', 'cursor-pagination', 'request-linking', 'event-redaction', 'error-redaction', 'error-code-filter', 'delayed-retry', 'drop-oldest-policy'],
        }))
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }
}

function testHttpEntry(route: string) {
    return {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        method: 'GET',
        route,
        statusCode: 200,
        responseTimeMs: 1,
        remoteAddress: null,
    }
}

function createLegacyMetricsDb(filePath: string): void {
    const db = new DatabaseSync(filePath)
    db.exec(`
        CREATE TABLE ai_request_logs (
            id TEXT PRIMARY KEY,
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
            rag_hit_count INTEGER NOT NULL DEFAULT 0,
            rag_prompt_chars INTEGER NOT NULL DEFAULT 0,
            input_chars INTEGER,
            output_chars INTEGER,
            est_input_tokens INTEGER,
            est_output_tokens INTEGER,
            est_cost_usd REAL NOT NULL DEFAULT 0,
            question_preview TEXT,
            is_timeout INTEGER NOT NULL DEFAULT 0,
            raw_error TEXT
        );
    `)
    db.prepare(`
        INSERT INTO ai_request_logs VALUES (
            ?, NULL, ?, '/api/chat', 'ollama', 'qwen3:8b', 'failed', 502,
            'LEGACY_ERROR', 'legacy error', ?, ?, 10, 1, 2, 100,
            10, 0, 5, 0, 0, 'sensitive legacy question', 0, 'sensitive stack'
        )
    `).run('legacy-ai-1', new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
    db.close()
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
