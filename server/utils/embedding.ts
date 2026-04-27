const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434'

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
    // Ollama /api/embed 支持批量输入
    const res = await fetch(`${ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'nomic-embed-text',
            input: texts,
        }),
    })

    if (!res.ok) throw new Error(`Embedding 失败: ${res.status}`)
    const data = await res.json()
    return data.embeddings
}