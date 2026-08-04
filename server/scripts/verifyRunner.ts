import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function main() {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'node-fastify-verify-'))
    process.env.VECTOR_BACKEND = 'sqlite'
    process.env.VECTOR_STORE_PATH = path.join(tempDir, 'vector-store.sqlite')

    try {
        const { runVerification } = await import('./verify.js')
        await runVerification()
    } finally {
        const { closeVectorStore } = await import('../utils/vectorStore.js')
        closeVectorStore()
        await rm(tempDir, { recursive: true, force: true })
    }
}

main().catch(err => {
    console.error(err)
    process.exitCode = 1
})
