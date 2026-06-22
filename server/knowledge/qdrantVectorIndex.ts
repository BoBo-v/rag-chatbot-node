import { config } from '../utils/config'
import type {
    VectorIndex,
    VectorIndexPoint,
    VectorIndexSearchOptions,
    VectorIndexSearchResult,
    VectorIndexStatus,
} from './types'

type QdrantFilter = {
    must?: Array<Record<string, unknown>>
}

type QdrantPoint = {
    id: string
    vector: number[]
    payload: Record<string, unknown>
}

export class QdrantVectorIndex implements VectorIndex {
    private readyVectorSize: number | null = null

    async ensureReady(vectorSize: number): Promise<void> {
        if (this.readyVectorSize === vectorSize) return

        const existing = await this.request(`/collections/${collectionName()}`, { method: 'GET' })
        if (existing.status === 404) {
            await this.request(`/collections/${collectionName()}`, {
                method: 'PUT',
                body: JSON.stringify({
                    vectors: {
                        size: vectorSize,
                        distance: config.qdrantDistance,
                    },
                }),
            })
            this.readyVectorSize = vectorSize
            return
        }

        if (!existing.ok) {
            throw new Error(`Qdrant collection check failed: ${existing.status} ${await existing.text()}`)
        }

        this.readyVectorSize = vectorSize
    }

    async upsert(points: VectorIndexPoint[]): Promise<void> {
        if (points.length === 0) return
        await this.ensureReady(points[0].embedding.length)

        const response = await this.request(`/collections/${collectionName()}/points?wait=true`, {
            method: 'PUT',
            body: JSON.stringify({
                points: points.map(toQdrantPoint),
            }),
        })

        if (!response.ok) {
            throw new Error(`Qdrant upsert failed: ${response.status} ${await response.text()}`)
        }
    }

    async deleteByFileId(fileId: string): Promise<void> {
        const response = await this.request(`/collections/${collectionName()}/points/delete?wait=true`, {
            method: 'POST',
            body: JSON.stringify({
                filter: {
                    must: [matchValue('fileId', fileId)],
                },
            }),
        })

        if (!response.ok && response.status !== 404) {
            throw new Error(`Qdrant delete failed: ${response.status} ${await response.text()}`)
        }
    }

    async reset(): Promise<void> {
        const response = await this.request(`/collections/${collectionName()}`, { method: 'DELETE' })
        if (!response.ok && response.status !== 404) {
            throw new Error(`Qdrant reset failed: ${response.status} ${await response.text()}`)
        }
        this.readyVectorSize = null
    }

    async search(queryEmbedding: number[], options: VectorIndexSearchOptions): Promise<VectorIndexSearchResult[]> {
        await this.ensureReady(queryEmbedding.length)

        const response = await this.request(`/collections/${collectionName()}/points/search`, {
            method: 'POST',
            body: JSON.stringify({
                vector: queryEmbedding,
                limit: options.topK,
                score_threshold: options.minScore,
                with_payload: false,
                filter: buildSearchFilter(options),
            }),
        })

        if (!response.ok) {
            throw new Error(`Qdrant search failed: ${response.status} ${await response.text()}`)
        }

        const data = await response.json() as { result?: Array<{ id: string | number; score: number }> }
        return (data.result ?? []).map(item => ({
            chunkId: String(item.id),
            score: item.score,
        }))
    }

    async status(): Promise<VectorIndexStatus> {
        try {
            const response = await this.request(`/collections/${collectionName()}`, { method: 'GET' })
            if (response.status === 404) {
                return { backend: 'qdrant', ready: false, collection: collectionName(), error: 'COLLECTION_NOT_FOUND' }
            }
            if (!response.ok) {
                return { backend: 'qdrant', ready: false, collection: collectionName(), error: `${response.status} ${await response.text()}` }
            }

            return { backend: 'qdrant', ready: true, collection: collectionName() }
        } catch (err) {
            return {
                backend: 'qdrant',
                ready: false,
                collection: collectionName(),
                error: err instanceof Error ? err.message : String(err),
            }
        }
    }

    private request(pathname: string, init: RequestInit): Promise<Response> {
        return qdrantRequest(pathname, init)
    }
}

export const qdrantVectorIndex = new QdrantVectorIndex()

export function qdrantRequest(pathname: string, init: RequestInit): Promise<Response> {
    const baseUrl = config.qdrantUrl.replace(/\/$/, '')
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
    }
    if (config.qdrantApiKey) headers['api-key'] = config.qdrantApiKey

    return fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers,
    })
}

export function toQdrantPoint(point: VectorIndexPoint): QdrantPoint {
    return {
        id: point.chunkId,
        vector: point.embedding,
        payload: {
            chunkId: point.chunkId,
            fileId: point.fileId,
            filename: point.filename,
            chunkIndex: point.chunkIndex,
            embeddingModel: point.embeddingModel,
            embeddingDim: point.embeddingDim,
            tenantId: point.tenantId ?? config.defaultTenantId,
            projectId: point.projectId ?? config.defaultProjectId,
            ownerUserId: point.ownerUserId ?? config.defaultOwnerUserId,
            createdAt: point.createdAt,
        },
    }
}

export function buildSearchFilter(options: VectorIndexSearchOptions): QdrantFilter {
    const must = [
        matchValue('embeddingModel', options.embeddingModel),
        matchValue('tenantId', options.tenantId ?? config.defaultTenantId),
        matchValue('projectId', options.projectId ?? config.defaultProjectId),
        matchValue('ownerUserId', options.ownerUserId ?? config.defaultOwnerUserId),
    ]

    if (options.fileId) must.push(matchValue('fileId', options.fileId))

    return { must }
}

function matchValue(key: string, value: string | number): Record<string, unknown> {
    return {
        key,
        match: { value },
    }
}

function collectionName(): string {
    return encodeURIComponent(config.qdrantCollection)
}
