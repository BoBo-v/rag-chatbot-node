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
    vectorScore: number
    keywordScore: number
}

export interface FileDetail extends StoredFile {
    chunks: Array<Omit<StoredChunk, 'embedding'> & { embeddingSize: number }>
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
let mutationQueue = Promise.resolve()

export async function addFileWithChunks(input: AddFileInput): Promise<StoredFile> {
    return enqueueMutation(async () => {
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
    })
}

export async function search(
    queryEmbedding: number[],
    options: { topK?: number; minScore?: number; fileId?: string; query?: string } = {}
): Promise<SearchResult[]> {
    await loadStore()

    const topK = options.topK ?? config.ragTopK
    const minScore = options.minScore ?? config.ragMinScore
    const queryTokens = tokenize(options.query ?? '')
    const chunks = options.fileId
        ? store.chunks.filter(chunk => chunk.fileId === options.fileId)
        : store.chunks
    const scored = chunks.map(chunk => {
        const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding)
        const keywordScore = keywordSimilarity(queryTokens, chunk.text)
        const score = combineScores(vectorScore, keywordScore)

        return {
            ...chunk,
            score,
            vectorScore,
            keywordScore,
        }
    })

    return scored
        .filter(chunk => chunk.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
}

export async function listFiles(): Promise<StoredFile[]> {
    await loadStore()
    return [...store.files]
}

export async function getFileDetail(fileId: string): Promise<FileDetail | null> {
    await loadStore()

    const file = store.files.find(item => item.id === fileId)
    if (!file) return null

    const chunks = store.chunks
        .filter(chunk => chunk.fileId === fileId)
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map(chunk => {
            const { embedding, ...rest } = chunk
            return {
                ...rest,
                embeddingSize: embedding.length,
            }
        })

    return { ...file, chunks }
}

export async function deleteFile(fileId: string): Promise<boolean> {
    return enqueueMutation(async () => {
        await loadStore()

        const fileIndex = store.files.findIndex(item => item.id === fileId)
        if (fileIndex === -1) return false

        store.files.splice(fileIndex, 1)
        store.chunks = store.chunks.filter(chunk => chunk.fileId !== fileId)
        await saveStore()

        return true
    })
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

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutationQueue.then(operation, operation)
    mutationQueue = next.then(() => undefined, () => undefined)
    return next
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

function combineScores(vectorScore: number, keywordScore: number): number {
    const vectorWeight = Math.max(0, config.ragVectorWeight)
    const keywordWeight = Math.max(0, config.ragKeywordWeight)
    const totalWeight = vectorWeight + keywordWeight

    if (totalWeight === 0) return vectorScore
    return ((vectorScore * vectorWeight) + (keywordScore * keywordWeight)) / totalWeight
}

function keywordSimilarity(queryTokens: string[], text: string): number {
    if (queryTokens.length === 0) return 0

    const normalizedText = normalizeForKeyword(text)
    let matchedWeight = 0
    let totalWeight = 0

    for (const token of queryTokens) {
        const weight = token.length >= 4 ? 2 : 1
        totalWeight += weight

        if (normalizedText.includes(token)) {
            matchedWeight += weight
        }
    }

    return totalWeight === 0 ? 0 : matchedWeight / totalWeight
}

function tokenize(text: string): string[] {
    const normalized = normalizeForKeyword(text)
    const tokens = normalized.match(/[a-z0-9_./:-]+|[\u4e00-\u9fa5]{2,}/g) || []
    return Array.from(new Set(tokens.filter(token => token.length >= 2)))
}

function normalizeForKeyword(text: string): string {
    return text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}
