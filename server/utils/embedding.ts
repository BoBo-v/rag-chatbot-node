import { config } from './config'

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const res = await fetch(`${config.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: config.embeddingModel,
            input: texts,
        }),
    })

    if (!res.ok) throw new Error(`Embedding failed: ${res.status}`)
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
            throw new Error(`Invalid embedding at index ${index}`)
        }
    }

    return embeddings
}
