import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

interface ChunkRow {
    id: string
    file_id: string
    filename: string
    chunk_index: number
    text: string
    embedding: string
    created_at: string
    page_number: number | null
}

interface FileRow {
    id: string
    filename: string
    mime_type: string
    size: number
    char_count: number
    chunk_count: number
    created_at: string
}

interface LegacyVectorStoreData {
    files?: Array<{
        id?: string
        filename?: string
        mimeType?: string
        size?: number
        charCount?: number
        chunkCount?: number
        createdAt?: string
    }>
    chunks?: Array<{
        id?: string
        fileId?: string
        filename?: string
        chunkIndex?: number
        text?: string
        embedding?: number[]
        createdAt?: string
        pageNumber?: number
    }>
}

const dbPath = path.resolve(process.cwd(), config.vectorStorePath)
let db: DatabaseSync | null = null
let mutationQueue = Promise.resolve()

export async function addFileWithChunks(input: AddFileInput): Promise<StoredFile> {
    return enqueueMutation(async () => {
        const database = getDb()
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

        database.exec('BEGIN')
        try {
            database.prepare(`
                INSERT INTO files (id, filename, mime_type, size, char_count, chunk_count, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(file.id, file.filename, file.mimeType, file.size, file.charCount, file.chunkCount, file.createdAt)

            const insertChunk = database.prepare(`
                INSERT INTO chunks (id, file_id, filename, chunk_index, text, embedding, created_at, page_number)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `)

            for (const chunk of input.chunks) {
                insertChunk.run(
                    randomUUID(),
                    file.id,
                    file.filename,
                    chunk.chunkIndex,
                    chunk.text,
                    JSON.stringify(chunk.embedding),
                    now,
                    chunk.pageNumber ?? null
                )
            }

            database.exec('COMMIT')
            return file
        } catch (err) {
            database.exec('ROLLBACK')
            throw err
        }
    })
}

export async function search(
    queryEmbedding: number[],
    options: { topK?: number; minScore?: number; fileId?: string; query?: string } = {}
): Promise<SearchResult[]> {
    const topK = options.topK ?? config.ragTopK
    const minScore = options.minScore ?? config.ragMinScore
    const queryTokens = tokenize(options.query ?? '')
    const rows = selectChunkRows(options.fileId)
    const scored = rows.map(row => {
        const chunk = rowToChunk(row)
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
    const rows = getDb().prepare(`
        SELECT id, filename, mime_type, size, char_count, chunk_count, created_at
        FROM files
        ORDER BY created_at DESC
    `).all() as FileRow[]

    return rows.map(rowToFile)
}

export async function getFileDetail(fileId: string): Promise<FileDetail | null> {
    const fileRow = getDb().prepare(`
        SELECT id, filename, mime_type, size, char_count, chunk_count, created_at
        FROM files
        WHERE id = ?
    `).get(fileId) as FileRow | undefined

    if (!fileRow) return null

    const chunks = selectChunkRows(fileId)
        .sort((a, b) => a.chunk_index - b.chunk_index)
        .map(row => {
            const chunk = rowToChunk(row)
            const { embedding, ...rest } = chunk
            return {
                ...rest,
                embeddingSize: embedding.length,
            }
        })

    return { ...rowToFile(fileRow), chunks }
}

export async function deleteFile(fileId: string): Promise<boolean> {
    return enqueueMutation(async () => {
        const database = getDb()
        const existing = database.prepare('SELECT id FROM files WHERE id = ?').get(fileId)
        if (!existing) return false

        database.exec('BEGIN')
        try {
            database.prepare('DELETE FROM files WHERE id = ?').run(fileId)
            database.exec('COMMIT')
            return true
        } catch (err) {
            database.exec('ROLLBACK')
            throw err
        }
    })
}

function getDb(): DatabaseSync {
    if (db) return db

    mkdirSync(path.dirname(dbPath), { recursive: true })
    const firstOpen = !existsSync(dbPath)
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            char_count INTEGER NOT NULL,
            chunk_count INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            file_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            text TEXT NOT NULL,
            embedding TEXT NOT NULL,
            created_at TEXT NOT NULL,
            page_number INTEGER,
            FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
    `)

    if (firstOpen) {
        db.exec('PRAGMA user_version = 1')
    }

    migrateLegacyJsonStore(db)

    return db
}

function migrateLegacyJsonStore(database: DatabaseSync): void {
    const countRow = database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }
    if (countRow.count > 0) return

    const legacyPath = legacyJsonPath()
    if (!existsSync(legacyPath)) return

    const data = JSON.parse(readFileSync(legacyPath, 'utf-8')) as LegacyVectorStoreData
    const files = Array.isArray(data.files) ? data.files : []
    const chunks = Array.isArray(data.chunks) ? data.chunks : []
    if (files.length === 0 && chunks.length === 0) return

    database.exec('BEGIN')
    try {
        const insertFile = database.prepare(`
            INSERT OR IGNORE INTO files (id, filename, mime_type, size, char_count, chunk_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        const insertChunk = database.prepare(`
            INSERT OR IGNORE INTO chunks (id, file_id, filename, chunk_index, text, embedding, created_at, page_number)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const file of files) {
            if (!file.id || !file.filename) continue
            insertFile.run(
                file.id,
                file.filename,
                file.mimeType ?? 'application/octet-stream',
                file.size ?? 0,
                file.charCount ?? 0,
                file.chunkCount ?? chunks.filter(chunk => chunk.fileId === file.id).length,
                file.createdAt ?? new Date().toISOString()
            )
        }

        const migratedFileIds = new Set(
            (database.prepare('SELECT id FROM files').all() as Array<{ id: string }>).map(file => file.id)
        )

        for (const chunk of chunks) {
            if (!chunk.fileId || !chunk.text || !Array.isArray(chunk.embedding)) continue
            if (!migratedFileIds.has(chunk.fileId)) continue
            insertChunk.run(
                chunk.id ?? randomUUID(),
                chunk.fileId,
                chunk.filename ?? '',
                chunk.chunkIndex ?? 0,
                chunk.text,
                JSON.stringify(chunk.embedding),
                chunk.createdAt ?? new Date().toISOString(),
                chunk.pageNumber ?? null
            )
        }

        database.exec('COMMIT')
    } catch (err) {
        database.exec('ROLLBACK')
        throw err
    }
}

function legacyJsonPath(): string {
    if (dbPath.endsWith('.sqlite')) {
        return dbPath.replace(/\.sqlite$/, '.json')
    }

    return `${dbPath}.json`
}

function selectChunkRows(fileId?: string): ChunkRow[] {
    if (fileId) {
        return getDb().prepare(`
            SELECT id, file_id, filename, chunk_index, text, embedding, created_at, page_number
            FROM chunks
            WHERE file_id = ?
            ORDER BY chunk_index ASC
        `).all(fileId) as ChunkRow[]
    }

    return getDb().prepare(`
        SELECT id, file_id, filename, chunk_index, text, embedding, created_at, page_number
        FROM chunks
        ORDER BY created_at DESC, chunk_index ASC
    `).all() as ChunkRow[]
}

function rowToFile(row: FileRow): StoredFile {
    return {
        id: row.id,
        filename: row.filename,
        mimeType: row.mime_type,
        size: row.size,
        charCount: row.char_count,
        chunkCount: row.chunk_count,
        createdAt: row.created_at,
    }
}

function rowToChunk(row: ChunkRow): StoredChunk {
    return {
        id: row.id,
        fileId: row.file_id,
        filename: row.filename,
        chunkIndex: row.chunk_index,
        text: row.text,
        embedding: JSON.parse(row.embedding) as number[],
        createdAt: row.created_at,
        pageNumber: row.page_number ?? undefined,
    }
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
