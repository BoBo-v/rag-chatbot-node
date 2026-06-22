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

export interface AddFileInput {
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

export interface SearchOptions {
    topK?: number
    minScore?: number
    fileId?: string
    query?: string
}

export interface VectorIndexPoint {
    chunkId: string
    fileId: string
    filename: string
    chunkIndex: number
    embedding: number[]
    embeddingModel: string
    embeddingDim: number
    tenantId?: string
    projectId?: string
    ownerUserId?: string
    createdAt?: string
}

export interface VectorIndexSearchOptions {
    topK: number
    minScore?: number
    fileId?: string
    embeddingModel: string
    tenantId?: string
    projectId?: string
    ownerUserId?: string
}

export interface VectorIndexSearchResult {
    chunkId: string
    score: number
}

export interface VectorIndexStatus {
    backend: string
    ready: boolean
    collection?: string
    error?: string
}

export interface VectorIndex {
    ensureReady(vectorSize: number): Promise<void>
    upsert(points: VectorIndexPoint[]): Promise<void>
    deleteByFileId(fileId: string): Promise<void>
    reset(): Promise<void>
    search(queryEmbedding: number[], options: VectorIndexSearchOptions): Promise<VectorIndexSearchResult[]>
    status(): Promise<VectorIndexStatus>
}

export interface ResetVectorStoreResult {
    filesDeleted: number
    chunksDeleted: number
}

export interface KnowledgeStore {
    addFileWithChunks(input: AddFileInput): Promise<StoredFile>
    replaceFileWithChunks(input: AddFileInput): Promise<StoredFile>
    search(queryEmbedding: number[], options?: SearchOptions): Promise<SearchResult[]>
    listFiles(): Promise<StoredFile[]>
    getFileDetail(fileId: string): Promise<FileDetail | null>
    getFileByContentHash(contentHash: string): Promise<FileDetail | null>
    deleteFile(fileId: string): Promise<boolean>
    resetVectorStore(): Promise<ResetVectorStoreResult>
    getVectorStoreStatus(): Promise<VectorStoreStatus>
}
