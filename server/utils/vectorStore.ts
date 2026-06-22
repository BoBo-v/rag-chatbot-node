import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config'
import { initMetricsTable } from './metricsStore'

export interface StoredFile {
    id: string
    filename: string
    mimeType: string
    size: number
    charCount: number
    chunkCount: number
    createdAt: string
    contentHash?: string
    embeddingModel?: string
    embeddingDim?: number
    chunkerVersion?: number
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
    embeddingModel?: string
    embeddingDim?: number
}

export interface SearchResult extends StoredChunk {
    score: number
    vectorScore: number
    keywordScore: number
}

export interface FileDetail extends StoredFile {
    chunks: Array<Omit<StoredChunk, 'embedding'> & { embeddingSize: number }>
}

export interface VectorStoreStatus {
    currentEmbeddingModel: string
    fileCount: number
    chunkCount: number
    compatibleChunkCount: number
    incompatibleChunkCount: number
    needsReindex: boolean
    embeddingDistributions: Array<{
        embeddingModel: string
        embeddingDim: number | null
        chunkCount: number
    }>
}

interface AddFileInput {
    filename: string
    mimeType: string
    size: number
    charCount: number
    contentHash?: string
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
    embedding_model: string | null
    embedding_dim: number | null
}

interface FtsChunkRow extends ChunkRow {
    fts_rank: number | null
    fts_position?: number
}

interface FileRow {
    id: string
    filename: string
    mime_type: string
    size: number
    char_count: number
    chunk_count: number
    created_at: string
    content_hash: string | null
    embedding_model: string | null
    embedding_dim: number | null
    chunker_version: number | null
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
        contentHash?: string
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
const ftsIndexVersion = 2
const embeddingCacheLimit = 5000
let db: DatabaseSync | null = null
let mutationQueue = Promise.resolve()
let onDbReady: ((db: DatabaseSync) => void) | null = null
const embeddingCache = new Map<string, { raw: string; embedding: number[] }>()

export function setDbReadyCallback(cb: (db: DatabaseSync) => void): void {
    onDbReady = cb
    // If db already initialized, call immediately
    if (db) cb(db)
}

export async function addFileWithChunks(input: AddFileInput): Promise<StoredFile> {
    return enqueueMutation(async () => {
        const database = getDb()
        database.exec('BEGIN')
        try {
            const file = insertFileWithChunks(database, input)
            database.exec('COMMIT')
            return file
        } catch (err) {
            database.exec('ROLLBACK')
            throw err
        }
    })
}

export async function replaceFileWithChunks(input: AddFileInput): Promise<StoredFile> {
    return enqueueMutation(async () => {
        const database = getDb()
        database.exec('BEGIN')
        try {
            if (input.contentHash) {
                database.prepare('DELETE FROM files WHERE content_hash = ?').run(input.contentHash)
            }

            const file = insertFileWithChunks(database, input)
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
    const rows = selectSearchCandidateRows(options.fileId, options.query)
    const scored = rows.flatMap(row => {
        const chunk = rowToChunk(row)
        if (!isCompatibleChunk(chunk, queryEmbedding.length)) return []

        const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding)
        const lexicalScore = normalizeFtsRank(row.fts_rank, row.fts_position)
        const keywordScore = Math.max(lexicalScore, keywordSimilarity(queryTokens, chunk.text))
        const score = combineScores(vectorScore, keywordScore)

        return [{
            ...chunk,
            score,
            vectorScore,
            keywordScore,
        }]
    })

    return scored
        .filter(chunk => chunk.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .reduce<SearchResult[]>((selected, candidate) => {
            if (selected.length >= topK) return selected
            if (selected.some(item => isNearDuplicate(item.text, candidate.text))) return selected
            selected.push(candidate)
            return selected
        }, [])
}

export async function listFiles(): Promise<StoredFile[]> {
    const rows = getDb().prepare(`
        SELECT id, filename, mime_type, size, char_count, chunk_count, created_at, content_hash, embedding_model, embedding_dim, chunker_version
        FROM files
        ORDER BY created_at DESC
    `).all() as unknown as FileRow[]

    return rows.map(rowToFile)
}

export async function getFileDetail(fileId: string): Promise<FileDetail | null> {
    const fileRow = getDb().prepare(`
        SELECT id, filename, mime_type, size, char_count, chunk_count, created_at, content_hash, embedding_model, embedding_dim, chunker_version
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

export async function getFileByContentHash(contentHash: string): Promise<FileDetail | null> {
    const fileRow = getDb().prepare(`
        SELECT id, filename, mime_type, size, char_count, chunk_count, created_at, content_hash, embedding_model, embedding_dim, chunker_version
        FROM files
        WHERE content_hash = ?
    `).get(contentHash) as FileRow | undefined

    if (!fileRow) return null
    return getFileDetail(fileRow.id)
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

export async function resetVectorStore(): Promise<{ filesDeleted: number; chunksDeleted: number }> {
    return enqueueMutation(async () => {
        const database = getDb()
        const fileCount = (database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count
        const chunkCount = (database.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number }).count

        database.exec('BEGIN')
        try {
            database.prepare('DELETE FROM files').run()
            database.prepare('DELETE FROM chunks_fts').run()
            database.exec('COMMIT')
            return {
                filesDeleted: fileCount,
                chunksDeleted: chunkCount,
            }
        } catch (err) {
            database.exec('ROLLBACK')
            throw err
        }
    })
}

export async function getVectorStoreStatus(): Promise<VectorStoreStatus> {
    const database = getDb()
    const fileCount = (database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count
    const chunkCount = (database.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number }).count
    const distributions = database.prepare(`
        SELECT
            COALESCE(embedding_model, 'unknown') AS embeddingModel,
            embedding_dim AS embeddingDim,
            COUNT(*) AS chunkCount
        FROM chunks
        GROUP BY COALESCE(embedding_model, 'unknown'), embedding_dim
        ORDER BY chunkCount DESC
    `).all() as Array<{ embeddingModel: string; embeddingDim: number | null; chunkCount: number }>
    const compatibleChunkCount = distributions
        .filter(item => item.embeddingModel === config.embeddingModel)
        .reduce((sum, item) => sum + item.chunkCount, 0)

    return {
        currentEmbeddingModel: config.embeddingModel,
        fileCount,
        chunkCount,
        compatibleChunkCount,
        incompatibleChunkCount: chunkCount - compatibleChunkCount,
        needsReindex: chunkCount > compatibleChunkCount,
        embeddingDistributions: distributions,
    }
}

export function closeVectorStore(): void {
    if (!db) return

    db.close()
    db = null
}

export function getMetricsDb(): DatabaseSync {
    return getDb()
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
            created_at TEXT NOT NULL,
            content_hash TEXT,
            embedding_model TEXT,
            embedding_dim INTEGER,
            chunker_version INTEGER
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
            embedding_model TEXT,
            embedding_dim INTEGER,
            FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
    `)
    ensureFileColumns(db)
    ensureChunkColumns(db)
    ensureFtsTable(db)
    initMetricsTable(db)

    if (firstOpen) {
        db.exec('PRAGMA user_version = 1')
    }

    migrateLegacyJsonStore(db)

    if (onDbReady) {
        onDbReady(db)
        onDbReady = null
    }

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
            INSERT OR IGNORE INTO files (
                id, filename, mime_type, size, char_count, chunk_count, created_at, content_hash,
                embedding_model, embedding_dim, chunker_version
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const insertChunk = database.prepare(`
            INSERT OR IGNORE INTO chunks (
                id, file_id, filename, chunk_index, text, embedding, created_at, page_number,
                embedding_model, embedding_dim
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                file.createdAt ?? new Date().toISOString(),
                file.contentHash ?? null,
                null,
                null,
                null
            )
        }

        const migratedFileIds = new Set(
            (database.prepare('SELECT id FROM files').all() as Array<{ id: string }>).map(file => file.id)
        )

        for (const chunk of chunks) {
            if (!chunk.fileId || !chunk.text || !Array.isArray(chunk.embedding)) continue
            if (!migratedFileIds.has(chunk.fileId)) continue
            const chunkId = chunk.id ?? randomUUID()
            insertChunk.run(
                chunkId,
                chunk.fileId,
                chunk.filename ?? '',
                chunk.chunkIndex ?? 0,
                chunk.text,
                JSON.stringify(chunk.embedding),
                chunk.createdAt ?? new Date().toISOString(),
                chunk.pageNumber ?? null,
                null,
                chunk.embedding.length
            )
            upsertFtsChunk(database, {
                id: chunkId,
                fileId: chunk.fileId,
                filename: chunk.filename ?? '',
                text: chunk.text,
            })
        }

        database.exec('COMMIT')
    } catch (err) {
        database.exec('ROLLBACK')
        throw err
    }
}

function ensureFileColumns(database: DatabaseSync): void {
    const columns = database.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'content_hash')) {
        database.exec('ALTER TABLE files ADD COLUMN content_hash TEXT')
    }
    if (!columns.some(column => column.name === 'embedding_model')) {
        database.exec('ALTER TABLE files ADD COLUMN embedding_model TEXT')
    }
    if (!columns.some(column => column.name === 'embedding_dim')) {
        database.exec('ALTER TABLE files ADD COLUMN embedding_dim INTEGER')
    }
    if (!columns.some(column => column.name === 'chunker_version')) {
        database.exec('ALTER TABLE files ADD COLUMN chunker_version INTEGER')
    }

    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash) WHERE content_hash IS NOT NULL')
}

function ensureChunkColumns(database: DatabaseSync): void {
    const columns = database.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'embedding_model')) {
        database.exec('ALTER TABLE chunks ADD COLUMN embedding_model TEXT')
    }
    if (!columns.some(column => column.name === 'embedding_dim')) {
        database.exec('ALTER TABLE chunks ADD COLUMN embedding_dim INTEGER')
    }
}

function insertFileWithChunks(database: DatabaseSync, input: AddFileInput): StoredFile {
    const now = new Date().toISOString()
    const embeddingDim = input.chunks[0]?.embedding.length ?? null
    const file: StoredFile = {
        id: randomUUID(),
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.size,
        charCount: input.charCount,
        chunkCount: input.chunks.length,
        createdAt: now,
        contentHash: input.contentHash,
        embeddingModel: config.embeddingModel,
        embeddingDim: embeddingDim ?? undefined,
        chunkerVersion: ftsIndexVersion,
    }

    database.prepare(`
        INSERT INTO files (
            id, filename, mime_type, size, char_count, chunk_count, created_at, content_hash,
            embedding_model, embedding_dim, chunker_version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        file.id,
        file.filename,
        file.mimeType,
        file.size,
        file.charCount,
        file.chunkCount,
        file.createdAt,
        file.contentHash ?? null,
        file.embeddingModel ?? null,
        file.embeddingDim ?? null,
        file.chunkerVersion ?? null
    )

    const insertChunk = database.prepare(`
        INSERT INTO chunks (
            id, file_id, filename, chunk_index, text, embedding, created_at, page_number,
            embedding_model, embedding_dim
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const chunk of input.chunks) {
        const chunkId = randomUUID()
        insertChunk.run(
            chunkId,
            file.id,
            file.filename,
            chunk.chunkIndex,
            chunk.text,
            JSON.stringify(chunk.embedding),
            now,
            chunk.pageNumber ?? null,
            config.embeddingModel,
            chunk.embedding.length
        )
        upsertFtsChunk(database, {
            id: chunkId,
            fileId: file.id,
            filename: file.filename,
            text: chunk.text,
        })
    }

    return file
}

function ensureFtsTable(database: DatabaseSync): void {
    database.exec(`
        DROP TRIGGER IF EXISTS chunks_ai;

        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            chunk_id UNINDEXED,
            file_id UNINDEXED,
            filename,
            text
        );

        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            DELETE FROM chunks_fts WHERE chunk_id = old.id;
        END;
    `)

    const versionRow = database.prepare('PRAGMA user_version').get() as { user_version: number }
    const countRow = database.prepare('SELECT COUNT(*) AS count FROM chunks_fts').get() as { count: number }
    if (countRow.count > 0 && versionRow.user_version >= ftsIndexVersion) return

    database.prepare('DELETE FROM chunks_fts').run()

    const rows = selectAllChunkRows(database)
    for (const row of rows) {
        upsertFtsChunk(database, {
            id: row.id,
            fileId: row.file_id,
            filename: row.filename,
            text: row.text,
        })
    }

    database.exec(`PRAGMA user_version = ${ftsIndexVersion}`)
}

function upsertFtsChunk(
    database: DatabaseSync,
    chunk: { id: string; fileId: string; filename: string; text: string }
): void {
    database.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(chunk.id)
    database.prepare(`
        INSERT INTO chunks_fts (chunk_id, file_id, filename, text)
        VALUES (?, ?, ?, ?)
    `).run(chunk.id, chunk.fileId, chunk.filename, buildSearchText(chunk.filename, chunk.text))
}

function legacyJsonPath(): string {
    if (dbPath.endsWith('.sqlite')) {
        return dbPath.replace(/\.sqlite$/, '.json')
    }

    return `${dbPath}.json`
}

function selectSearchCandidateRows(fileId?: string, query?: string): FtsChunkRow[] {
    const ftsRows = selectFtsChunkRows(fileId, query)
    const vectorRows = selectVectorCandidateRows(fileId)
    const rowsById = new Map<string, FtsChunkRow>()

    for (const row of vectorRows) {
        rowsById.set(row.id, { ...row, fts_rank: null })
    }

    for (const row of ftsRows) {
        rowsById.set(row.id, row)
    }

    return Array.from(rowsById.values())
}

function selectVectorCandidateRows(fileId?: string): ChunkRow[] {
    if (fileId) return selectChunkRows(fileId)

    return getDb().prepare(`
        SELECT id, file_id, filename, chunk_index, text, embedding, created_at, page_number, embedding_model, embedding_dim
        FROM chunks
        ORDER BY created_at DESC, chunk_index ASC
        LIMIT ?
    `).all(config.ragVectorCandidateLimit) as unknown as ChunkRow[]
}

function selectFtsChunkRows(fileId?: string, query?: string): FtsChunkRow[] {
    const ftsQuery = buildFtsQuery(query)
    if (!ftsQuery) return []

    const fileFilter = fileId ? 'AND c.file_id = ?' : ''
    const params = fileId ? [ftsQuery, fileId] : [ftsQuery]

    try {
        const rows = getDb().prepare(`
            SELECT
                c.id,
                c.file_id,
                c.filename,
                c.chunk_index,
                c.text,
                c.embedding,
                c.created_at,
                c.page_number,
                c.embedding_model,
                c.embedding_dim,
                bm25(chunks_fts) AS fts_rank
            FROM chunks_fts
            JOIN chunks c ON c.id = chunks_fts.chunk_id
            WHERE chunks_fts MATCH ? ${fileFilter}
            ORDER BY fts_rank ASC
            LIMIT 80
        `).all(...params) as unknown as FtsChunkRow[]

        return rows.map((row, index) => ({ ...row, fts_position: index }))
    } catch {
        return []
    }
}

function selectChunkRows(fileId?: string): ChunkRow[] {
    if (fileId) {
        return getDb().prepare(`
            SELECT id, file_id, filename, chunk_index, text, embedding, created_at, page_number, embedding_model, embedding_dim
            FROM chunks
            WHERE file_id = ?
            ORDER BY chunk_index ASC
        `).all(fileId) as unknown as ChunkRow[]
    }

    return getDb().prepare(`
        SELECT id, file_id, filename, chunk_index, text, embedding, created_at, page_number, embedding_model, embedding_dim
        FROM chunks
        ORDER BY created_at DESC, chunk_index ASC
    `).all() as unknown as ChunkRow[]
}

function selectAllChunkRows(database: DatabaseSync): ChunkRow[] {
    return database.prepare(`
        SELECT id, file_id, filename, chunk_index, text, embedding, created_at, page_number, embedding_model, embedding_dim
        FROM chunks
        ORDER BY created_at DESC, chunk_index ASC
    `).all() as unknown as ChunkRow[]
}

function buildFtsQuery(query?: string): string {
    const tokens = tokenizeForSearch(query ?? '')
    return tokens
        .map(token => `"${token.replace(/"/g, '""')}"`)
        .join(' OR ')
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
        contentHash: row.content_hash ?? undefined,
        embeddingModel: row.embedding_model ?? undefined,
        embeddingDim: row.embedding_dim ?? undefined,
        chunkerVersion: row.chunker_version ?? undefined,
    }
}

function rowToChunk(row: ChunkRow): StoredChunk {
    const embedding = parseCachedEmbedding(row.id, row.embedding)
    return {
        id: row.id,
        fileId: row.file_id,
        filename: row.filename,
        chunkIndex: row.chunk_index,
        text: row.text,
        embedding,
        createdAt: row.created_at,
        pageNumber: row.page_number ?? undefined,
        embeddingModel: row.embedding_model ?? undefined,
        embeddingDim: row.embedding_dim ?? embedding.length,
    }
}

function parseCachedEmbedding(chunkId: string, rawEmbedding: string): number[] {
    const cached = embeddingCache.get(chunkId)
    if (cached?.raw === rawEmbedding) {
        embeddingCache.delete(chunkId)
        embeddingCache.set(chunkId, cached)
        return cached.embedding
    }

    const embedding = JSON.parse(rawEmbedding) as number[]
    embeddingCache.set(chunkId, { raw: rawEmbedding, embedding })

    if (embeddingCache.size > embeddingCacheLimit) {
        const oldestKey = embeddingCache.keys().next().value
        if (oldestKey) embeddingCache.delete(oldestKey)
    }

    return embedding
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

function isCompatibleChunk(chunk: StoredChunk, queryEmbeddingDim: number): boolean {
    return chunk.embeddingModel === config.embeddingModel && chunk.embedding.length === queryEmbeddingDim
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

function normalizeFtsRank(rank: number | null | undefined, position?: number): number {
    if (typeof rank !== 'number' || !Number.isFinite(rank)) return 0
    if (typeof position === 'number') return Math.max(0.1, 1 - (position * 0.02))
    return 0.5
}

function isNearDuplicate(a: string, b: string): boolean {
    const aTokens = tokenize(a)
    const bTokens = tokenize(b)
    if (aTokens.length === 0 || bTokens.length === 0) return false

    const bSet = new Set(bTokens)
    const overlap = aTokens.filter(token => bSet.has(token)).length
    const ratio = overlap / Math.min(aTokens.length, bTokens.length)
    return ratio >= 0.9
}

function tokenize(text: string): string[] {
    const normalized = normalizeForKeyword(text)
    const tokens = normalized.match(/[a-z0-9_./:-]+|[\u4e00-\u9fa5]{2,}/g) || []
    return Array.from(new Set(tokens.filter(token => token.length >= 2)))
}

function tokenizeForSearch(text: string): string[] {
    const tokens = tokenize(text)
    const expanded: string[] = []

    for (const token of tokens) {
        expanded.push(token)
        if (/^[\u4e00-\u9fa5]+$/.test(token)) {
            expanded.push(...getNgrams(token, 2), ...getNgrams(token, 3))
        }
    }

    return Array.from(new Set(expanded))
}

function buildSearchText(filename: string, text: string): string {
    return [
        filename,
        text,
        tokenizeForSearch(`${filename}\n${text}`).join(' '),
    ].join('\n')
}

function getNgrams(text: string, size: number): string[] {
    if (text.length <= size) return [text]

    const result: string[] = []
    for (let i = 0; i <= text.length - size; i++) {
        result.push(text.slice(i, i + size))
    }
    return result
}

function normalizeForKeyword(text: string): string {
    return text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}
