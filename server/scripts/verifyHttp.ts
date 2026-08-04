import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

async function main() {
    const port = Number(process.env.HTTP_VERIFY_PORT || 3230)
    const apiKey = 'verify-api-key'
    const logQueryApiKey = 'verify-log-query-api-key'
    const tempDir = await mkdtemp(path.join(tmpdir(), 'node-fastify-http-'))
    const uploadPath = path.join(tempDir, 'verify.txt')
    let app: FastifyInstance | null = null

    process.env.PORT = String(port)
    process.env.API_KEY = apiKey
    process.env.LOG_QUERY_API_KEY = logQueryApiKey
    process.env.VECTOR_STORE_PATH = path.join(tempDir, 'vector-store.sqlite')
    process.env.OBSERVABILITY_DB_PATH = path.join(tempDir, 'observability.sqlite')
    process.env.LOG_QUERY_ENABLED = 'true'
    process.env.LOG_QUESTION_PREVIEW = 'false'
    process.env.LOG_REMOTE_ADDRESS = 'none'
    process.env.EMBEDDING_BATCH_SIZE = '1'
    process.env.OPENAI_API_KEY = ''
    process.env.ANTHROPIC_API_KEY = ''

    try {
        await writeFile(path.join(tempDir, 'vector-store.json'), JSON.stringify({
            files: [{
                id: 'legacy-file',
                filename: 'legacy.txt',
                mimeType: 'text/plain',
                size: 12,
                charCount: 12,
                chunkCount: 1,
                createdAt: '2026-01-01T00:00:00.000Z',
            }],
            chunks: [{
                id: 'legacy-chunk',
                fileId: 'legacy-file',
                filename: 'legacy.txt',
                chunkIndex: 0,
                text: 'legacy contract fixture',
                embedding: [1, 0],
                createdAt: '2026-01-01T00:00:00.000Z',
            }],
        }), 'utf-8')

        const { buildApp } = await import('../app.js')
        const instance = buildApp({ logger: false })
        app = instance
        await instance.listen({ port })

        await writeFile(uploadPath, 'HTTP 自动验证。http-verify-9527 用于测试上传、检索和鉴权。', 'utf-8')

        const unauthorized = await fetch(`http://127.0.0.1:${port}/api/files`)
        assert(unauthorized.status === 401, `expected 401 without api key, got ${unauthorized.status}`)
        const unauthorizedBody = await unauthorized.json() as { code?: string }
        assert(unauthorizedBody.code === 'UNAUTHORIZED', `unauthorized should include code: ${JSON.stringify(unauthorizedBody)}`)

        const unauthorizedLogs = await fetch(`http://127.0.0.1:${port}/api/logs/summary`)
        assert(unauthorizedLogs.status === 401, `logs should require api key, got ${unauthorizedLogs.status}`)
        const businessKeyOnLogs = await fetch(`http://127.0.0.1:${port}/api/logs/summary`, {
            headers: authHeaders(apiKey),
        })
        assert(businessKeyOnLogs.status === 401, `business API key must not authorize log queries: ${businessKeyOnLogs.status}`)

        const corsRejected = await fetch(`http://127.0.0.1:${port}/api/files`, {
            headers: { Origin: 'http://localhost:5999', ...authHeaders(apiKey) },
        })
        assert(corsRejected.status === 403, `expected 403 for disallowed CORS origin, got ${corsRejected.status}`)
        const corsBody = await corsRejected.json() as { code?: string; error?: string }
        assert(corsBody.code === 'CORS_ORIGIN_NOT_ALLOWED', `cors rejection should include code: ${JSON.stringify(corsBody)}`)
        assert(Boolean(corsBody.error), 'cors rejection should include user-facing error')

        const legacyFiles = await fetchJson<{ files: Array<{ id: string; filename: string }> }>(
            `http://127.0.0.1:${port}/api/files`,
            { headers: authHeaders(apiKey) }
        )
        const legacyFile = legacyFiles.files.find(file => file.filename === 'legacy.txt')
        assert(Boolean(legacyFile), `legacy file should be listed: ${JSON.stringify(legacyFiles)}`)
        assert(isUuid(legacyFile?.id ?? null), `listed legacy file should expose a UUID: ${JSON.stringify(legacyFile)}`)
        const legacyDetail = await fetchJson<{ file: { id: string; chunks: Array<{ id: string; fileId: string }> } }>(
            `http://127.0.0.1:${port}/api/files/${encodeURIComponent(legacyFile!.id)}`,
            { headers: authHeaders(apiKey) }
        )
        assert(legacyDetail.file.id === legacyFile!.id, `listed file ID should resolve detail: ${JSON.stringify(legacyDetail)}`)
        assert(isUuid(legacyDetail.file.chunks[0]?.id ?? null), `legacy chunk ID should be normalized: ${JSON.stringify(legacyDetail)}`)
        assert(legacyDetail.file.chunks[0]?.fileId === legacyFile!.id, `legacy chunk should reference normalized file ID: ${JSON.stringify(legacyDetail)}`)
        const legacyDelete = await fetchJson<{ ok: boolean }>(
            `http://127.0.0.1:${port}/api/files/${encodeURIComponent(legacyFile!.id)}`,
            { method: 'DELETE', headers: authHeaders(apiKey) }
        )
        assert(legacyDelete.ok, `normalized legacy file should be deletable: ${JSON.stringify(legacyDelete)}`)

        const notFound = await fetchJsonError(`http://127.0.0.1:${port}/api/not-exists`, {
            headers: authHeaders(apiKey),
        })
        assert(notFound.status === 404, `expected 404 for missing route, got ${notFound.status}`)
        assert(notFound.body.code === 'NOT_FOUND', `not found should include code: ${JSON.stringify(notFound.body)}`)

        const badSearch = await fetchJsonError(`http://127.0.0.1:${port}/api/search`, {
            headers: authHeaders(apiKey),
        })
        assert(badSearch.status === 400, `expected 400 for missing search q, got ${badSearch.status}`)
        assert(badSearch.body.code === 'VALIDATION_ERROR', `search validation should include code: ${JSON.stringify(badSearch.body)}`)

        const chatMissingProviderConfig = await fetchJsonError(`http://127.0.0.1:${port}/api/chat`, {
            method: 'POST',
            headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: 'openai',
                rag: false,
                messages: [{ role: 'user', content: 'hello' }],
            }),
        })
        assert(chatMissingProviderConfig.status === 400, `expected 400 for unconfigured OpenAI, got ${chatMissingProviderConfig.status}`)
        assert(
            chatMissingProviderConfig.body.code === 'OPENAI_NOT_CONFIGURED',
            `chat provider config error should include code: ${JSON.stringify(chatMissingProviderConfig.body)}`
        )
        assert(isUuid(chatMissingProviderConfig.requestId), `chat should return X-Request-Id: ${chatMissingProviderConfig.requestId}`)

        const swagger = await fetchJson<{ info?: { title?: string } }>(`http://127.0.0.1:${port}/docs/json`)
        assert(swagger.info?.title, 'swagger json should be public and valid')

        const providers = await fetchJson<{
            providers: Array<{ id: string; defaultModel: string; configured: boolean }>
        }>(`http://127.0.0.1:${port}/api/providers`, { headers: authHeaders(apiKey) })
        const ollama = providers.providers.find(provider => provider.id === 'ollama')
        const openai = providers.providers.find(provider => provider.id === 'openai')
        const anthropic = providers.providers.find(provider => provider.id === 'anthropic')
        assert(ollama, `ollama provider should exist: ${JSON.stringify(providers)}`)
        assert(ollama.configured === true, `ollama provider should be configured: ${JSON.stringify(providers)}`)
        assert(Boolean(ollama.defaultModel), 'ollama provider should expose defaultModel')
        assert(openai?.configured === false, `openai provider should require API key: ${JSON.stringify(providers)}`)
        assert(anthropic?.configured === false, `anthropic provider should require API key: ${JSON.stringify(providers)}`)

        const formData = new FormData()
        formData.append('file', await fileBlob(uploadPath), 'verify.txt')

        const upload = await fetchJson<{
            file: { id: string; filename: string; contentHash?: string }
            deduplicated: boolean
        }>(`http://127.0.0.1:${port}/api/upload`, {
            method: 'POST',
            headers: authHeaders(apiKey),
            body: formData,
        })
        assert(upload.file.filename === 'verify.txt', `upload failed: ${JSON.stringify(upload)}`)
        assert(Boolean(upload.file.contentHash), 'upload should return contentHash')
        assert(upload.deduplicated === false, 'first upload should not be deduplicated')

        const search = await fetchJson<{ results: unknown[] }>(
            `http://127.0.0.1:${port}/api/search?q=http-verify-9527&topK=3&minScore=0`,
            { headers: authHeaders(apiKey) }
        )
        assert(search.results.length >= 1, `search should return results: ${JSON.stringify(search)}`)

        const requestProbe = await fetch(`http://127.0.0.1:${port}/api/search?q=http-verify-9527&topK=3&minScore=0`, {
            headers: authHeaders(apiKey),
        })
        assert(requestProbe.ok, `request probe failed: ${requestProbe.status}`)
        const requestProbeId = requestProbe.headers.get('x-request-id')
        assert(isUuid(requestProbeId), `regular response should return X-Request-Id: ${requestProbeId}`)
        await requestProbe.text()

        const { flushObservabilityForTest } = await import('../observability/collector.js')
        flushObservabilityForTest()

        const logSummary = await fetchJson<{
            http: { totalRequests: number }
            ai: { totalRequests: number }
            collector: { droppedLogCount: number; lastFlushError: string | null }
        }>(`http://127.0.0.1:${port}/api/logs/summary`, { headers: logAuthHeaders(logQueryApiKey) })
        assert(logSummary.http.totalRequests >= 1, `log summary should include HTTP requests: ${JSON.stringify(logSummary)}`)
        assert(logSummary.ai.totalRequests >= 1, `log summary should include AI requests: ${JSON.stringify(logSummary)}`)
        assert(logSummary.collector.droppedLogCount === 0, `logs should not be dropped: ${JSON.stringify(logSummary)}`)

        const requestLogs = await fetchJson<{
            rows: Array<{ id: string; route: string; remote_address: string | null }>
            nextCursor: string | null
        }>(`http://127.0.0.1:${port}/api/logs/requests?limit=100`, { headers: logAuthHeaders(logQueryApiKey) })
        const searchLog = requestLogs.rows.find(row => row.id === requestProbeId)
        assert(searchLog?.route === '/api/search', `HTTP log should store route template: ${JSON.stringify(searchLog)}`)
        assert(searchLog.remote_address === null, `remote address should be disabled: ${JSON.stringify(searchLog)}`)

        const badCursor = await fetchJsonError(`http://127.0.0.1:${port}/api/logs/requests?cursor=invalid`, {
            headers: logAuthHeaders(logQueryApiKey),
        })
        assert(badCursor.status === 400, `invalid log cursor should return 400: ${JSON.stringify(badCursor)}`)
        assert(badCursor.body.code === 'INVALID_LOG_QUERY', `invalid cursor should include code: ${JSON.stringify(badCursor)}`)

        const requestDetail = await fetchJson<{
            request: { id: string } | null
            aiInvocations: Array<Record<string, unknown>>
            events: Array<Record<string, unknown>>
        }>(`http://127.0.0.1:${port}/api/logs/requests/${chatMissingProviderConfig.requestId}`, {
            headers: logAuthHeaders(logQueryApiKey),
        })
        assert(requestDetail.request?.id === chatMissingProviderConfig.requestId, `request detail should include HTTP request: ${JSON.stringify(requestDetail)}`)
        assert(requestDetail.aiInvocations.length === 1, `request detail should link AI invocation: ${JSON.stringify(requestDetail)}`)
        assert(requestDetail.aiInvocations[0].question_preview === null, 'question preview should be disabled')
        assert(!('raw_error' in requestDetail.aiInvocations[0]), 'request detail must not expose raw_error')

        const errors = await fetchJson<{ rows: Array<Record<string, unknown>> }>(
            `http://127.0.0.1:${port}/api/logs/errors?limit=100`,
            { headers: logAuthHeaders(logQueryApiKey) }
        )
        assert(errors.rows.length >= 1, `error query should return sanitized errors: ${JSON.stringify(errors)}`)
        assert(errors.rows.every(row => !('raw_error' in row) && !('stack' in row)), 'errors must not expose raw_error or stack')

        const dashboard = await fetch(`http://127.0.0.1:${port}/api/metrics/dashboard`)
        assert(dashboard.status === 200, `dashboard should be available when log query is enabled: ${dashboard.status}`)

        const statusBeforeReset = await fetchJson<{
            currentEmbeddingModel: string
            fileCount: number
            chunkCount: number
            compatibleChunkCount: number
            incompatibleChunkCount: number
            needsReindex: boolean
        }>(`http://127.0.0.1:${port}/api/vector-store/status`, { headers: authHeaders(apiKey) })
        assert(statusBeforeReset.fileCount === 1, `status should count uploaded file: ${JSON.stringify(statusBeforeReset)}`)
        assert(statusBeforeReset.chunkCount >= 1, `status should count uploaded chunks: ${JSON.stringify(statusBeforeReset)}`)
        assert(statusBeforeReset.compatibleChunkCount === statusBeforeReset.chunkCount, `uploaded chunks should be compatible: ${JSON.stringify(statusBeforeReset)}`)
        assert(statusBeforeReset.incompatibleChunkCount === 0, `new upload should not need reindex: ${JSON.stringify(statusBeforeReset)}`)
        assert(statusBeforeReset.needsReindex === false, `new upload should not need reindex: ${JSON.stringify(statusBeforeReset)}`)

        const context = await fetchJson<{ prompt: string; results: unknown[] }>(`http://127.0.0.1:${port}/api/chat/context`, {
            method: 'POST',
            headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'http-verify-9527 是什么' }],
                rag: true,
                topK: 3,
                minScore: 0,
            }),
        })
        assert(context.results.length >= 1, `context should return results: ${JSON.stringify(context)}`)
        assert(context.prompt.includes('引用材料'), 'context prompt should use Chinese RAG instructions')

        const reindex = await fetchJson<{ backend: string; skipped: boolean; chunksIndexed: number }>(
            `http://127.0.0.1:${port}/api/vector-store/reindex`,
            {
                method: 'POST',
                headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileId: upload.file.id }),
            }
        )
        assert(reindex.backend === 'sqlite', `sqlite reindex should identify backend: ${JSON.stringify(reindex)}`)
        assert(reindex.skipped === true, `sqlite reindex should be skipped: ${JSON.stringify(reindex)}`)

        const badReset = await fetchJsonError(`http://127.0.0.1:${port}/api/vector-store/reset`, {
            method: 'POST',
            headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: 'WRONG' }),
        })
        assert(badReset.status === 400, `expected 400 for reset without confirmation, got ${badReset.status}`)
        assert(
            badReset.body.code === 'VECTOR_STORE_RESET_CONFIRM_REQUIRED',
            `reset confirmation error should include code: ${JSON.stringify(badReset.body)}`
        )

        const reset = await fetchJson<{ ok: boolean; filesDeleted: number; chunksDeleted: number }>(
            `http://127.0.0.1:${port}/api/vector-store/reset`,
            {
                method: 'POST',
                headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: 'RESET_VECTOR_STORE' }),
            }
        )
        assert(reset.ok === true, `reset failed: ${JSON.stringify(reset)}`)
        assert(reset.filesDeleted >= 1, `reset should delete uploaded file: ${JSON.stringify(reset)}`)
        assert(reset.chunksDeleted >= 1, `reset should delete uploaded chunks: ${JSON.stringify(reset)}`)

        const filesAfterReset = await fetchJson<{ files: unknown[] }>(`http://127.0.0.1:${port}/api/files`, {
            headers: authHeaders(apiKey),
        })
        assert(filesAfterReset.files.length === 0, `reset should clear files: ${JSON.stringify(filesAfterReset)}`)

        const statusAfterReset = await fetchJson<{ fileCount: number; chunkCount: number; needsReindex: boolean }>(
            `http://127.0.0.1:${port}/api/vector-store/status`,
            { headers: authHeaders(apiKey) }
        )
        assert(statusAfterReset.fileCount === 0, `status should clear files after reset: ${JSON.stringify(statusAfterReset)}`)
        assert(statusAfterReset.chunkCount === 0, `status should clear chunks after reset: ${JSON.stringify(statusAfterReset)}`)
        assert(statusAfterReset.needsReindex === false, `empty store should not need reindex: ${JSON.stringify(statusAfterReset)}`)

        const searchAfterReset = await fetchJson<{ results: unknown[] }>(
            `http://127.0.0.1:${port}/api/search?q=http-verify-9527&topK=3&minScore=0`,
            { headers: authHeaders(apiKey) }
        )
        assert(searchAfterReset.results.length === 0, `reset should clear search results: ${JSON.stringify(searchAfterReset)}`)

        const deleted = await fetchJsonError(`http://127.0.0.1:${port}/api/files/${upload.file.id}`, {
            method: 'DELETE',
            headers: authHeaders(apiKey),
        })
        assert(deleted.status === 404, `deleted file should not exist after reset: ${JSON.stringify(deleted)}`)

        console.log(JSON.stringify({
            ok: true,
            checks: ['auth', 'cors-error', 'legacy-id-normalization', 'not-found', 'search-validation', 'provider-error', 'request-id', 'log-auth', 'log-summary', 'log-route-template', 'log-cursor-validation', 'log-request-detail', 'log-error-redaction', 'dashboard', 'swagger', 'providers', 'upload', 'search', 'vector-store-status', 'chat-context', 'vector-store-reindex', 'vector-store-reset'],
        }))
    } finally {
        if (app) await app.close()
        await rm(tempDir, { recursive: true, force: true })
    }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init)
    const text = await res.text()
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}: ${text}`)
    }

    return JSON.parse(text) as T
}

async function fetchJsonError(url: string, init?: RequestInit): Promise<{
    status: number
    body: { error?: string; code?: string }
    requestId: string | null
}> {
    const res = await fetch(url, init)
    return {
        status: res.status,
        body: await res.json() as { error?: string; code?: string },
        requestId: res.headers.get('x-request-id'),
    }
}

function authHeaders(apiKey: string): Record<string, string> {
    return { 'x-api-key': apiKey }
}

function logAuthHeaders(logQueryApiKey: string): Record<string, string> {
    return { 'x-api-key': logQueryApiKey }
}

function isUuid(value: string | null): value is string {
    return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
}

async function fileBlob(filePath: string): Promise<Blob> {
    const { readFile } = await import('node:fs/promises')
    const buffer = await readFile(filePath)
    return new Blob([buffer], { type: 'text/plain' })
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
