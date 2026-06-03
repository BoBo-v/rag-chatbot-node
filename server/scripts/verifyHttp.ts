import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message)
}

async function main() {
    const port = Number(process.env.HTTP_VERIFY_PORT || 3230)
    const apiKey = 'verify-api-key'
    const tempDir = await mkdtemp(path.join(tmpdir(), 'node-fastify-http-'))
    const vectorStorePath = path.join(tempDir, 'vector-store.sqlite')
    const uploadPath = path.join(tempDir, 'verify.txt')
    let server: ChildProcessWithoutNullStreams | null = null
    let serverOutput = ''

    try {
        await writeFile(uploadPath, 'HTTP 自动验证。http-verify-9527 用于测试上传、检索和鉴权。', 'utf-8')
        server = startServer(port, vectorStorePath, apiKey)
        server.stdout.on('data', chunk => {
            serverOutput += chunk.toString()
        })
        server.stderr.on('data', chunk => {
            serverOutput += chunk.toString()
        })
        await waitForHealth(port)

        const unauthorized = await fetch(`http://127.0.0.1:${port}/api/files`)
        assert(unauthorized.status === 401, `expected 401 without api key, got ${unauthorized.status}`)

        const swagger = await fetchJson<{ info?: { title?: string } }>(`http://127.0.0.1:${port}/docs/json`)
        assert(swagger.info?.title, 'swagger json should be public and valid')

        const formData = new FormData()
        const file = new File([await BunlessFileBlob(uploadPath)], 'verify.txt', { type: 'text/plain' })
        formData.append('file', file)

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
            checks: ['auth', 'swagger', 'upload', 'search', 'chat-context', 'delete'],
        }))
    } catch (err) {
        if (serverOutput) process.stderr.write(serverOutput)
        throw err
    } finally {
        if (server && !server.killed) {
            server.kill()
            await waitForExit(server)
        }
        await rm(tempDir, { recursive: true, force: true })
    }
}

function startServer(port: number, vectorStorePath: string, apiKey: string): ChildProcessWithoutNullStreams {
    const child = spawn(
        process.execPath,
        ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PORT: String(port),
                VECTOR_STORE_PATH: vectorStorePath,
                API_KEY: apiKey,
                EMBEDDING_BATCH_SIZE: '1',
            },
        }
    )

    return child
}

async function waitForHealth(port: number): Promise<void> {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`)
            if (res.ok) return
        } catch {
            // Wait for the server to start.
        }

        await new Promise(resolve => setTimeout(resolve, 500))
    }

    throw new Error('server did not become healthy in time')
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise(resolve => {
        if (child.exitCode !== null) {
            resolve()
            return
        }

        child.once('exit', () => resolve())
        setTimeout(resolve, 3000)
    })
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

async function BunlessFileBlob(filePath: string): Promise<Blob> {
    const { readFile } = await import('node:fs/promises')
    const buffer = await readFile(filePath)
    return new Blob([buffer], { type: 'text/plain' })
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
