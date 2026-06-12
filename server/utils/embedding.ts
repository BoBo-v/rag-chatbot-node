import { config } from './config'

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const batchSize = Math.max(1, Math.floor(config.embeddingBatchSize))
    const embeddings: number[][] = []

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize)
        embeddings.push(...await getEmbeddingBatch(batch, i))
    }

    return embeddings
}

const embeddingRetryDelaysMs = [0, 3000, 10000]

async function getEmbeddingBatch(texts: string[], offset: number): Promise<number[][]> {
    let lastError: unknown = null

    for (const delayMs of embeddingRetryDelaysMs) {
        if (delayMs > 0) await sleep(delayMs)

        try {
            return await requestEmbeddingBatch(texts, offset)
        } catch (err) {
            lastError = err
        }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`Embedding failed after ${embeddingRetryDelaysMs.length} attempts: ${message}`)
}

async function requestEmbeddingBatch(texts: string[], offset: number): Promise<number[][]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.ollamaTimeoutMs)

    try {
        const res = await fetch(`${config.ollamaUrl}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model: config.embeddingModel,
                input: texts,
            }),
        })

        if (!res.ok) {
            const errorText = await res.text()
            throw new Error(`Embedding failed: ${res.status}${errorText ? ` ${errorText}` : ''}`)
        }
        const data = await res.json()
        const embeddings = data.embeddings

        if (!Array.isArray(embeddings)) {
            throw new Error('Embedding response missing embeddings array')
        }

        if (embeddings.length !== texts.length) {
            throw new Error(`Embedding count mismatch: expected ${texts.length}, got ${embeddings.length}`)
        }

        for (const [index, embedding] of embeddings.entries()) {
            if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some(value => typeof value !== 'number')) {
                throw new Error(`Invalid embedding at index ${offset + index}`)
            }
        }

        return embeddings
    } finally {
        clearTimeout(timeout)
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
