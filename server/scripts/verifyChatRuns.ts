import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

interface RunResponse {
    created?: boolean
    run: {
        runId: string
        assistantMessageId: string
        status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
        outputText: string
        lastSequence: number
        regeneratedFromRunId: string | null
        errorCode: string | null
    }
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

async function main() {
    const appPort = 3241
    const ollamaPort = 3242
    const apiKey = 'verify-chat-runs-key'
    const tempDir = await mkdtemp(path.join(tmpdir(), 'node-fastify-chat-runs-'))
    let app: FastifyInstance | null = null
    let ollama: Server | null = null

    process.env.PORT = String(appPort)
    process.env.API_KEY = apiKey
    process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaPort}`
    process.env.VECTOR_STORE_PATH = path.join(tempDir, 'vector.sqlite')
    process.env.OBSERVABILITY_DB_PATH = path.join(tempDir, 'observability.sqlite')
    process.env.GENERATION_DB_PATH = path.join(tempDir, 'generation.sqlite')
    process.env.LOG_QUERY_ENABLED = 'false'
    process.env.AGENT_ENABLED = 'false'
    process.env.GENERATION_DELTA_FLUSH_INTERVAL_MS = '50'

    try {
        ollama = createFakeOllamaServer()
        await listen(ollama, ollamaPort)
        const { buildApp } = await import('../app.js')
        app = buildApp({ logger: false })
        await app.listen({ port: appPort })

        const body = runBody('normal')
        const missingKey = await request('/api/chat/runs', {
            method: 'POST',
            headers: authHeaders(apiKey),
            body: JSON.stringify(body),
        })
        assert(missingKey.status === 400, `missing idempotency key should be 400: ${missingKey.status}`)

        const createdResponse = await request('/api/chat/runs', requestInit(apiKey, body))
        const created = await readJson<RunResponse>(createdResponse)
        assert(createdResponse.status === 202 && created.created, `run should be accepted: ${JSON.stringify(created)}`)

        const reusedResponse = await request('/api/chat/runs', requestInit(apiKey, body))
        const reused = await readJson<RunResponse>(reusedResponse)
        assert(reusedResponse.status === 200 && !reused.created, `retry should reuse run: ${JSON.stringify(reused)}`)
        assert(reused.run.runId === created.run.runId, 'idempotent retry returned a different run')

        const conflictBody = { ...body, messages: [{ role: 'user', content: 'changed' }] }
        const conflict = await request('/api/chat/runs', requestInit(apiKey, conflictBody))
        assert(conflict.status === 409, `changed idempotent request should conflict: ${conflict.status}`)

        const completed = await waitForTerminal(created.run.runId, apiKey)
        assert(completed.run.status === 'completed', `run should complete: ${JSON.stringify(completed)}`)
        assert(completed.run.outputText === 'hello world', `output snapshot mismatch: ${completed.run.outputText}`)
        assert(completed.run.lastSequence >= 4, `sequence should include lifecycle events: ${completed.run.lastSequence}`)

        const regeneratedBody = runBody('normal', { regeneratedFromRunId: created.run.runId })
        const regeneratedResponse = await request('/api/chat/runs', requestInit(apiKey, regeneratedBody))
        const regenerated = await readJson<RunResponse>(regeneratedResponse)
        assert(regeneratedResponse.status === 202, `regeneration should create a run: ${regeneratedResponse.status}`)
        assert(regenerated.run.runId !== created.run.runId, 'regeneration must use a new runId')
        assert(regenerated.run.assistantMessageId !== created.run.assistantMessageId, 'regeneration must use a new assistantMessageId')
        assert(regenerated.run.regeneratedFromRunId === created.run.runId, 'regeneration relation missing')
        await waitForTerminal(regenerated.run.runId, apiKey)

        const messageConflictBody = runBody('normal', { assistantMessageId: body.assistantMessageId })
        const messageConflict = await request('/api/chat/runs', requestInit(apiKey, messageConflictBody))
        assert(messageConflict.status === 409, `assistant message reuse should conflict: ${messageConflict.status}`)

        const slowBody = runBody('slow')
        const slowResponse = await request('/api/chat/runs', requestInit(apiKey, slowBody))
        const slow = await readJson<RunResponse>(slowResponse)
        const cancelResponse = await request(`/api/chat/runs/${slow.run.runId}`, {
            method: 'DELETE',
            headers: authHeaders(apiKey),
        })
        assert([200, 202].includes(cancelResponse.status), `cancel should be accepted: ${cancelResponse.status}`)
        const cancelled = await waitForTerminal(slow.run.runId, apiKey)
        assert(cancelled.run.status === 'cancelled', `run should be cancelled: ${JSON.stringify(cancelled)}`)
        assert(cancelled.run.errorCode === 'CLIENT_ABORTED', 'cancel error code mismatch')
        const repeatedCancel = await request(`/api/chat/runs/${slow.run.runId}`, {
            method: 'DELETE',
            headers: authHeaders(apiKey),
        })
        assert(repeatedCancel.status === 200, `terminal cancel should be idempotent: ${repeatedCancel.status}`)

        console.log(JSON.stringify({
            ok: true,
            checks: [
                'idempotency-required', 'create', 'idempotent-retry', 'request-hash-conflict',
                'background-completion', 'output-snapshot', 'regeneration', 'message-conflict',
                'explicit-cancel', 'terminal-cancel-idempotency',
            ],
        }))
    } finally {
        if (app) await app.close()
        if (ollama) await closeServer(ollama)
        await rm(tempDir, { recursive: true, force: true })
    }
}

function runBody(content: string, overrides: Record<string, unknown> = {}) {
    const turnId = randomUUID()
    return {
        conversationId: 1,
        turnId,
        sourceUserMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        provider: 'ollama',
        model: 'qwen3:8b',
        rag: false,
        messages: [{ role: 'user', content }],
        ...overrides,
    }
}

function requestInit(apiKey: string, body: ReturnType<typeof runBody>): RequestInit {
    return {
        method: 'POST',
        headers: {
            ...authHeaders(apiKey),
            'Content-Type': 'application/json',
            'Idempotency-Key': body.turnId,
        },
        body: JSON.stringify(body),
    }
}

async function waitForTerminal(runId: string, apiKey: string): Promise<RunResponse> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await request(`/api/chat/runs/${runId}`, { headers: authHeaders(apiKey) })
        const snapshot = await readJson<RunResponse>(response)
        if (['completed', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot
        await delay(20)
    }
    throw new Error(`run did not reach terminal state: ${runId}`)
}

function createFakeOllamaServer(): Server {
    return createServer((request, response) => {
        if (request.url !== '/api/chat' || request.method !== 'POST') {
            response.writeHead(404).end()
            return
        }
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
            const parsed = JSON.parse(body) as { messages: Array<{ content: string }> }
            const slow = parsed.messages.at(-1)?.content === 'slow'
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
            response.write(JSON.stringify({ message: { content: slow ? 'partial' : 'hello ' }, done: false }) + '\n')
            const timer = setTimeout(() => {
                if (response.destroyed) return
                response.end(JSON.stringify({ message: { content: slow ? ' late' : 'world' }, done: true }) + '\n')
            }, slow ? 5000 : 10)
            response.on('close', () => clearTimeout(timer))
        })
    })
}

function request(pathname: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:3241${pathname}`, init)
}

function authHeaders(apiKey: string): Record<string, string> {
    return { 'x-api-key': apiKey }
}

async function readJson<T>(response: Response): Promise<T> {
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
    return JSON.parse(text) as T
}

function listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
    })
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

void main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
