import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

interface RunSnapshot {
    run: {
        runId: string
        status: string
        outputText: string
    }
}

interface SseEvent {
    id: number
    type: string
    data: {
        version: number
        runId: string
        sequence: number
        type: string
        data: Record<string, unknown>
    }
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

async function main() {
    const appPort = 3243
    const ollamaPort = 3244
    const apiKey = 'verify-chat-sse-key'
    const tempDir = await mkdtemp(path.join(tmpdir(), 'node-fastify-chat-sse-'))
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

        const completedRunId = await createRun(apiKey, 'normal')
        const completedEvents = await readAllEvents(completedRunId, apiKey)
        assert(completedEvents.length >= 4, `completed stream should contain lifecycle events: ${JSON.stringify(completedEvents)}`)
        assertStrictSequences(completedEvents)
        assert(completedEvents.at(-1)?.type === 'run_completed', 'completed stream should end with terminal event')
        assert(completedEvents.every(event => event.data.version === 1), 'SSE event version mismatch')
        assert(completedEvents.every(event => event.data.runId === completedRunId), 'SSE runId mismatch')

        const resumeAfter = completedEvents.find(event => event.type === 'rag_context')!.id
        const resumedEvents = await readAllEvents(completedRunId, apiKey, resumeAfter)
        assert(resumedEvents.length > 0, 'reconnect should replay remaining events')
        assert(resumedEvents.every(event => event.id > resumeAfter), 'reconnect replayed acknowledged sequence')
        assertStrictSequences(resumedEvents)
        assert(resumedEvents.at(-1)?.type === 'run_completed', 'reconnect should include terminal event')

        const recoverRunId = await createRun(apiKey, 'recover')
        const response = await fetch(`${baseUrl()}/api/chat/runs/${recoverRunId}/events`, {
            headers: authHeaders(apiKey),
        })
        assert(response.ok && response.body, `live SSE should connect: ${response.status}`)
        const reader = response.body.getReader()
        const firstTextEvent = await readUntilEvent(reader, event => event.type === 'text_delta')
        assert(firstTextEvent.type === 'text_delta', 'live stream should receive text delta')
        await reader.cancel('simulate browser refresh')

        const recovered = await waitForTerminal(recoverRunId, apiKey)
        assert(recovered.run.status === 'completed', 'SSE disconnect must not cancel generation')
        assert(recovered.run.outputText === 'first second', `background output should complete: ${recovered.run.outputText}`)
        const afterRefresh = await readAllEvents(recoverRunId, apiKey, firstTextEvent.id)
        assert(afterRefresh.every(event => event.id > firstTextEvent.id), 'refresh replay should resume after saved event')
        assert(afterRefresh.at(-1)?.type === 'run_completed', 'refresh replay should reach completion')

        const unauthorized = await fetch(`${baseUrl()}/api/chat/runs/${completedRunId}/events`)
        assert(unauthorized.status === 401, `SSE should require authentication: ${unauthorized.status}`)
        const invalidLastEventId = await fetch(`${baseUrl()}/api/chat/runs/${completedRunId}/events`, {
            headers: { ...authHeaders(apiKey), 'Last-Event-ID': '-1' },
        })
        assert(invalidLastEventId.status === 400, `invalid Last-Event-ID should fail: ${invalidLastEventId.status}`)

        console.log(JSON.stringify({
            ok: true,
            checks: [
                'event-format', 'strict-sequence', 'terminal-close', 'last-event-id-replay',
                'disconnect-keeps-running', 'refresh-recovery', 'sse-auth', 'last-event-id-validation',
            ],
        }))
    } finally {
        if (app) await app.close()
        if (ollama) await closeServer(ollama)
        await rm(tempDir, { recursive: true, force: true })
    }
}

async function createRun(apiKey: string, content: string): Promise<string> {
    const turnId = randomUUID()
    const body = {
        conversationId: 1,
        turnId,
        sourceUserMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        provider: 'ollama',
        model: 'qwen3:8b',
        rag: false,
        messages: [{ role: 'user', content }],
    }
    const response = await fetch(`${baseUrl()}/api/chat/runs`, {
        method: 'POST',
        headers: {
            ...authHeaders(apiKey),
            'Content-Type': 'application/json',
            'Idempotency-Key': turnId,
        },
        body: JSON.stringify(body),
    })
    const text = await response.text()
    assert(response.status === 202, `run creation failed: ${response.status} ${text}`)
    return (JSON.parse(text) as RunSnapshot).run.runId
}

async function readAllEvents(runId: string, apiKey: string, afterSequence = 0): Promise<SseEvent[]> {
    const headers = authHeaders(apiKey)
    if (afterSequence > 0) headers['Last-Event-ID'] = String(afterSequence)
    const response = await fetch(`${baseUrl()}/api/chat/runs/${runId}/events`, { headers })
    const text = await response.text()
    assert(response.ok, `SSE request failed: ${response.status} ${text}`)
    return parseSseEvents(text)
}

async function readUntilEvent(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    predicate: (event: SseEvent) => boolean,
): Promise<SseEvent> {
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
        const { value, done } = await reader.read()
        if (done) throw new Error('SSE ended before expected event')
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
            const event = parseSseBlock(block)
            if (event && predicate(event)) return event
        }
    }
}

function parseSseEvents(text: string): SseEvent[] {
    return text.split(/\r?\n\r?\n/).map(parseSseBlock).filter((event): event is SseEvent => Boolean(event))
}

function parseSseBlock(block: string): SseEvent | null {
    if (!block.trim() || block.startsWith(':')) return null
    const lines = block.split(/\r?\n/)
    const id = Number(lines.find(line => line.startsWith('id:'))?.slice(3).trim())
    const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? ''
    const dataText = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!Number.isInteger(id) || !type || !dataText) throw new Error(`invalid SSE block: ${block}`)
    return { id, type, data: JSON.parse(dataText) as SseEvent['data'] }
}

function assertStrictSequences(events: SseEvent[]): void {
    for (let index = 1; index < events.length; index += 1) {
        assert(events[index].id > events[index - 1].id, `SSE sequence not strictly increasing: ${JSON.stringify(events)}`)
    }
    assert(new Set(events.map(event => event.id)).size === events.length, 'SSE contains duplicate sequence')
}

async function waitForTerminal(runId: string, apiKey: string): Promise<RunSnapshot> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await fetch(`${baseUrl()}/api/chat/runs/${runId}`, { headers: authHeaders(apiKey) })
        const snapshot = await response.json() as RunSnapshot
        if (['completed', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`run did not finish: ${runId}`)
}

function createFakeOllamaServer(): Server {
    return createServer((request, response) => {
        let requestBody = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { requestBody += chunk })
        request.on('end', () => {
            const parsed = JSON.parse(requestBody) as { messages: Array<{ content: string }> }
            const recover = parsed.messages.at(-1)?.content === 'recover'
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
            response.write(JSON.stringify({ message: { content: recover ? 'first' : 'hello ' }, done: false }) + '\n')
            const timer = setTimeout(() => {
                if (!response.destroyed) {
                    response.end(JSON.stringify({ message: { content: recover ? ' second' : 'world' }, done: true }) + '\n')
                }
            }, recover ? 300 : 10)
            response.on('close', () => clearTimeout(timer))
        })
    })
}

function authHeaders(apiKey: string): Record<string, string> {
    return { 'x-api-key': apiKey }
}

function baseUrl(): string {
    return 'http://127.0.0.1:3243'
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

void main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
