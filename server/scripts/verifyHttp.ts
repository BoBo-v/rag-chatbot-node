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

        const deleted = await fetchJson<{ ok: boolean }>(`http://127.0.0.1:${port}/api/files/${upload.file.id}`, {
            method: 'DELETE',
            headers: authHeaders(apiKey),
        })
        assert(deleted.ok === true, `delete failed: ${JSON.stringify(deleted)}`)

        console.log(JSON.stringify({
            ok: true,
            checks: ['auth', 'swagger', 'providers', 'upload', 'search', 'chat-context', 'delete'],
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
