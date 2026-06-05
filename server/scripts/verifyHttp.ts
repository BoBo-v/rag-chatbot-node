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
    const tempDir = await mkdtemp(path.join(tmpdir(), 'node-fastify-http-'))
    const uploadPath = path.join(tempDir, 'verify.txt')
    let app: FastifyInstance | null = null

    process.env.PORT = String(port)
    process.env.API_KEY = apiKey
    process.env.VECTOR_STORE_PATH = path.join(tempDir, 'vector-store.sqlite')
    process.env.EMBEDDING_BATCH_SIZE = '1'
    process.env.OPENAI_API_KEY = ''
    process.env.ANTHROPIC_API_KEY = ''

    try {
        const { buildApp } = await import('../app.js')
        const instance = buildApp({ logger: false })
        app = instance
        await instance.listen({ port })

        await writeFile(uploadPath, 'HTTP 自动验证。http-verify-9527 用于测试上传、检索和鉴权。', 'utf-8')

        const unauthorized = await fetch(`http://127.0.0.1:${port}/api/files`)
        assert(unauthorized.status === 401, `expected 401 without api key, got ${unauthorized.status}`)
        const unauthorizedBody = await unauthorized.json() as { code?: string }
        assert(unauthorizedBody.code === 'UNAUTHORIZED', `unauthorized should include code: ${JSON.stringify(unauthorizedBody)}`)

        const corsRejected = await fetch(`http://127.0.0.1:${port}/api/files`, {
            headers: { Origin: 'http://localhost:5999', ...authHeaders(apiKey) },
        })
        assert(corsRejected.status === 403, `expected 403 for disallowed CORS origin, got ${corsRejected.status}`)
        const corsBody = await corsRejected.json() as { code?: string; error?: string }
        assert(corsBody.code === 'CORS_ORIGIN_NOT_ALLOWED', `cors rejection should include code: ${JSON.stringify(corsBody)}`)
        assert(Boolean(corsBody.error), 'cors rejection should include user-facing error')

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
            checks: ['auth', 'cors-error', 'not-found', 'search-validation', 'provider-error', 'swagger', 'providers', 'upload', 'search', 'chat-context', 'vector-store-reset'],
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
}> {
    const res = await fetch(url, init)
    return {
        status: res.status,
        body: await res.json() as { error?: string; code?: string },
    }
}

function authHeaders(apiKey: string): Record<string, string> {
    return { 'x-api-key': apiKey }
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
