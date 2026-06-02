import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config'

export interface StoredFile {
    id: string
    filename: string
    mimeType: string
    size: number
    charCount: number
    chunkCount: number
    createdAt: string
}

export interface StoredChunk {
    id: string
    fileId: string
    filename: string
    chunkIndex: number
    text: string
    embedding: number[]
    createdAt: string
    pageNumber?: number
}

export interface SearchResult extends StoredChunk {
    score: number
}

interface VectorStoreData {
    files: StoredFile[]
    chunks: StoredChunk[]
}

interface AddFileInput {
    filename: string
    mimeType: string
    size: number
    charCount: number
    chunks: Array<{
        text: string
        embedding: number[]
        chunkIndex: number
        pageNumber?: number
    }>
}

const storePath = path.resolve(process.cwd(), config.vectorStorePath)
const store: VectorStoreData = { files: [], chunks: [] }
let loaded = false

export async function addFileWithChunks(input: AddFileInput): Promise<StoredFile> {
    await loadStore()

    const now = new Date().toISOString()
    const file: StoredFile = {
        id: randomUUID(),
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.size,
        charCount: input.charCount,
        chunkCount: input.chunks.length,
        createdAt: now,
    }

    const chunks: StoredChunk[] = input.chunks.map(chunk => ({
        id: randomUUID(),
        fileId: file.id,
        filename: file.filename,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        embedding: chunk.embedding,
        createdAt: now,
        pageNumber: chunk.pageNumber,
    }))

    store.files.push(file)
    store.chunks.push(...chunks)
    await saveStore()

    return file
}

export async function search(
    queryEmbedding: number[],
    options: { topK?: number; minScore?: number } = {}
): Promise<SearchResult[]> {
    await loadStore()

    const topK = options.topK ?? config.ragTopK
    const minScore = options.minScore ?? config.ragMinScore
    const scored = store.chunks.map(chunk => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))

    return scored
        .filter(chunk => chunk.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
}

export async function listFiles(): Promise<StoredFile[]> {
    await loadStore()
    return [...store.files]
}

async function loadStore(): Promise<void> {
    if (loaded) return

    try {
        const raw = await readFile(storePath, 'utf-8')
        const data = JSON.parse(raw) as Partial<VectorStoreData>
        store.files = Array.isArray(data.files) ? data.files : []
        store.chunks = Array.isArray(data.chunks) ? data.chunks : []
    } catch (err) {
        const code = (err as { code?: string }).code
        if (code !== 'ENOENT') throw err
    }

    loaded = true
}

async function saveStore(): Promise<void> {
    await mkdir(path.dirname(storePath), { recursive: true })
    await writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8')
}

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0

    let dot = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    }

    if (normA === 0 || normB === 0) return 0
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
