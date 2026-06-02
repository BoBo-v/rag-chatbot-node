import { config } from './config'

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
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
    return data.embeddings
}
