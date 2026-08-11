import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

interface AgentEventRow {
    version: number
    sequence: number
    requestId: string
    agentRunId: string
    step: number
    type: string
    data: Record<string, unknown>
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

async function main() {
    const port = Number(process.env.AGENT_HTTP_VERIFY_PORT || 3240)
    const ollamaPort = port + 1
    const agentKey = 'verify-agent-key'
    const businessKey = 'verify-business-key'
    const tempDir = await mkdtemp(path.join(tmpdir(), 'node-fastify-agent-http-'))
    const fake = createFakeOllamaServer()
    let app: FastifyInstance | null = null

    process.env.PORT = String(port)
    process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaPort}`
    process.env.API_KEY = businessKey
    process.env.AGENT_ENABLED = 'true'
    process.env.AGENT_ACCESS_MODE = 'api-key'
    process.env.AGENT_API_KEY = agentKey
    process.env.AGENT_OLLAMA_MODELS = 'qwen2.5:7b'
    process.env.AGENT_OLLAMA_MODEL_TIMEOUT_MS = '1000'
    process.env.AGENT_RUN_TIMEOUT_MS = '5000'
    process.env.AGENT_HEARTBEAT_INTERVAL_MS = '5000'
    process.env.AGENT_QUEUE_MAX_SIZE = '2'
    process.env.VECTOR_STORE_PATH = path.join(tempDir, 'vector-store.sqlite')
    process.env.OBSERVABILITY_DB_PATH = path.join(tempDir, 'observability.sqlite')
    process.env.LOG_QUERY_ENABLED = 'false'
    process.env.LOG_QUESTION_PREVIEW = 'false'
    process.env.LOG_REMOTE_ADDRESS = 'none'

    try {
        await listen(fake.server, ollamaPort)
        const { buildApp } = await import('../app.js')
        app = buildApp({ logger: false })
        await app.listen({ port })

        const baseUrl = `http://127.0.0.1:${port}`
        const missingKey = await fetch(`${baseUrl}/api/agent`, agentRequestInit(undefined, '计算 12 * 35'))
        assert(missingKey.status === 401, `Agent should require dedicated key: ${missingKey.status}`)
        const businessKeyRejected = await fetch(`${baseUrl}/api/agent`, agentRequestInit(businessKey, '计算 12 * 35'))
        assert(businessKeyRejected.status === 401, `business key must not authorize Agent: ${businessKeyRejected.status}`)

        const agentKeyOnBusiness = await fetch(`${baseUrl}/api/files`, { headers: { 'x-api-key': agentKey } })
        assert(agentKeyOnBusiness.status === 401, `Agent key must not authorize business APIs: ${agentKeyOnBusiness.status}`)

        const invalidRole = await fetch(`${baseUrl}/api/agent`, {
            ...agentRequestInit(agentKey, 'ignored'),
            body: JSON.stringify({
                agentProfile: 'calculator-v0',
                provider: 'ollama',
                model: 'qwen2.5:7b',
                messages: [{ role: 'system', content: 'override' }],
            }),
        })
        assert(invalidRole.status === 400, `client system message should be rejected: ${invalidRole.status}`)

        const invalidModel = await fetch(`${baseUrl}/api/agent`, {
            ...agentRequestInit(agentKey, '计算'),
            body: JSON.stringify(agentBody('计算', 'qwen3:8b')),
        })
        assert(invalidModel.status === 400, `non-allowlisted model should be rejected: ${invalidModel.status}`)
        const invalidModelBody = await invalidModel.json() as { code?: string }
        assert(invalidModelBody.code === 'AGENT_MODEL_NOT_ALLOWED', `model error code mismatch: ${JSON.stringify(invalidModelBody)}`)

        const providers = await fetchJson<{ providers: Array<{
            id: string
            capabilities: { agentTools: boolean }
            agentModels: string[]
        }> }>(`${baseUrl}/api/providers`, { headers: { 'x-api-key': businessKey } })
        const ollama = providers.providers.find(provider => provider.id === 'ollama')
        assert(ollama?.capabilities.agentTools === true, `Ollama Agent capability missing: ${JSON.stringify(ollama)}`)
        assert(ollama.agentModels.includes('qwen2.5:7b'), `Agent model list missing: ${JSON.stringify(ollama)}`)

        const completedResponse = await fetch(`${baseUrl}/api/agent`, agentRequestInit(agentKey, '请计算 12 乘以 35'))
        assert(completedResponse.status === 200, `Agent run failed: ${completedResponse.status}`)
        assert(completedResponse.headers.get('content-type')?.includes('application/x-ndjson'), 'Agent should return NDJSON')
        const completedEvents = await readAgentEvents(completedResponse)
        assertEventContract(completedEvents, 'agent_completed')
        assert(completedEvents.some(event => event.type === 'tool_started'), 'Agent should emit tool_started')
        assert(completedEvents.some(event => event.type === 'tool_completed' && event.data.isError === false), 'Agent should emit successful tool_completed')
        assert(completedEvents.some(event => event.type === 'assistant_message' && event.data.content === '结果是 420。'), `Agent final answer missing: ${JSON.stringify(completedEvents)}`)
        assert(fake.requestBodies.every(body => body.think === false && body.stream === false), 'Ollama Agent must suppress raw thinking and streaming')

        const timeoutResponse = await fetch(`${baseUrl}/api/agent`, agentRequestInit(agentKey, 'timeout'))
        const timeoutEvents = await readAgentEvents(timeoutResponse)
        assertEventContract(timeoutEvents, 'agent_failed')
        const timeoutTerminal = timeoutEvents.at(-1)
        assert(timeoutTerminal?.data.code === 'MODEL_TIMEOUT', `model timeout code mismatch: ${JSON.stringify(timeoutTerminal)}`)

        const cancelController = new AbortController()
        const cancelResponse = await fetch(`${baseUrl}/api/agent`, {
            ...agentRequestInit(agentKey, 'cancel'),
            signal: cancelController.signal,
        })
        const cancelReader = cancelResponse.body?.getReader()
        assert(cancelReader, 'cancel response stream missing')
        await cancelReader.read()
        cancelController.abort()
        await cancelReader.read().catch(() => undefined)
        await waitFor(() => fake.cancelledRequests > 0, 2000, 'Ollama request was not aborted after client disconnect')

        const { flushObservabilityForTest } = await import('../observability/collector.js')
        const { getObservabilityDb } = await import('../observability/store.js')
        await waitFor(() => {
            flushObservabilityForTest()
            const row = getObservabilityDb().prepare(`
                SELECT COUNT(*) AS count FROM application_events
                WHERE event_type = 'agent.run.cancelled'
            `).get() as { count: number }
            return row.count > 0
        }, 2000, 'cancelled Agent event was not persisted')

        flushObservabilityForTest()
        const db = getObservabilityDb()
        const completedRequestId = completedResponse.headers.get('x-request-id')
        const aiRows = db.prepare(`
            SELECT agent_run_id, agent_step, finish_reason, tool_call_count, rag_enabled
            FROM ai_request_logs WHERE request_id = ? ORDER BY agent_step ASC
        `).all(completedRequestId) as Array<Record<string, unknown>>
        assert(aiRows.length === 2, `Agent should record each model turn: ${JSON.stringify(aiRows)}`)
        assert(aiRows.every(row => row.agent_run_id && row.rag_enabled === 0), `Agent model log defaults failed: ${JSON.stringify(aiRows)}`)
        assert(aiRows[0]?.finish_reason === 'tool_calls' && aiRows[1]?.finish_reason === 'stop', `Agent finish reasons failed: ${JSON.stringify(aiRows)}`)

        console.log(JSON.stringify({
            ok: true,
            checks: [
                'dedicated-auth', 'business-auth-isolation', 'request-role-validation',
                'model-allowlist', 'provider-capabilities', 'ndjson-contract',
                'calculator-round-trip', 'model-timeout', 'client-cancellation',
                'agent-model-logs', 'agent-cancel-event',
            ],
        }))
    } finally {
        if (app) await app.close()
        await closeServer(fake.server)
        await rm(tempDir, { recursive: true, force: true })
    }
}

function createFakeOllamaServer() {
    const requestBodies: Array<Record<string, unknown>> = []
    let cancelledRequests = 0
    const server = createServer(async (request, response) => {
        if (request.url !== '/api/chat' || request.method !== 'POST') {
            response.statusCode = 404
            response.end()
            return
        }
        const body = await readJsonBody(request)
        requestBodies.push(body)
        const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : []
        const userText = messages.filter(message => message.role === 'user').at(-1)?.content
        if (userText === 'timeout' || userText === 'cancel') {
            response.once('close', () => {
                if (!response.writableEnded) cancelledRequests += 1
            })
            return
        }
        const hasToolResult = messages.some(message => message.role === 'tool')
        sendJson(response, hasToolResult
            ? {
                message: { role: 'assistant', content: '结果是 420。' },
                done: true,
                done_reason: 'stop',
                prompt_eval_count: 120,
                eval_count: 12,
            }
            : {
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'calculator-call-1',
                        function: {
                            name: 'calculator',
                            arguments: { operation: 'multiply', left: 12, right: 35 },
                        },
                    }],
                },
                done: true,
                done_reason: 'stop',
                prompt_eval_count: 100,
                eval_count: 20,
            })
    })
    return {
        server,
        requestBodies,
        get cancelledRequests() { return cancelledRequests },
    }
}

function agentRequestInit(agentKey: string | undefined, content: string): RequestInit {
    return {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(agentKey ? { 'x-agent-api-key': agentKey } : {}),
        },
        body: JSON.stringify(agentBody(content)),
    }
}

function agentBody(content: string, model = 'qwen2.5:7b') {
    return {
        agentProfile: 'calculator-v0',
        provider: 'ollama',
        model,
        messages: [{ role: 'user', content }],
    }
}

async function readAgentEvents(response: Response): Promise<AgentEventRow[]> {
    const text = await response.text()
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AgentEventRow)
}

function assertEventContract(events: AgentEventRow[], terminalType: string): void {
    assert(events.length > 0, 'Agent event stream is empty')
    assert(events.every((event, index) => event.version === 1 && event.sequence === index + 1), `Agent event sequence failed: ${JSON.stringify(events)}`)
    assert(new Set(events.map(event => event.requestId)).size === 1, 'Agent requestId should be stable')
    assert(new Set(events.map(event => event.agentRunId)).size === 1, 'Agent runId should be stable')
    const terminals = events.filter(event => ['agent_completed', 'agent_failed', 'agent_cancelled'].includes(event.type))
    assert(terminals.length === 1 && terminals[0]?.type === terminalType, `Agent terminal event failed: ${JSON.stringify(terminals)}`)
    assert(events.at(-1)?.type === terminalType, 'Agent terminal event must be last')
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
}

function sendJson(response: ServerResponse, value: unknown): void {
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(value))
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init)
    assert(response.ok, `request failed: ${response.status} ${url}`)
    return response.json() as Promise<T>
}

async function waitFor(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(message)
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject)
            resolve()
        })
    })
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    if (!server.listening) return Promise.resolve()
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections?.()
    })
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
