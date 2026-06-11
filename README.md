# Node Fastify RAG

Fastify backend for local knowledge-base RAG. It supports uploading `txt`, `md`, `pdf`, and image files, parsing images with a local vision model, chunking text, generating embeddings with Ollama, storing chunks in SQLite, hybrid retrieval, and chat streaming through Ollama, OpenAI, or Anthropic Claude.

## Requirements

- Node.js with `node:sqlite` support
- Ollama running locally
- Required Ollama models:
  - chat model: `qwen3:8b` by default when using `provider: "ollama"`
  - embedding model: `nomic-embed-text` by default
  - vision model: `qwen3-vl:2b` by default when uploading images
- Optional OpenAI API key when using `provider: "openai"`
- Optional Anthropic API key when using `provider: "anthropic"`

## Setup

```bash
npm install
copy .env.example .env
npm run dev:server
```

Default service URL:

```text
http://127.0.0.1:3001
```

Swagger UI:

```text
http://127.0.0.1:3001/docs
```

OpenAPI JSON:

```text
http://127.0.0.1:3001/docs/json
```

## Scripts

```bash
npm run typecheck
npm run verify
npm run verify:http
npm run dev:server
```

- `typecheck`: TypeScript static check.
- `verify`: logic-level checks for chunking, migration, vector store, dedupe, hybrid retrieval, and Chinese FTS ngrams.
- `verify:http`: interface-level check for auth, Swagger, providers, upload, search, chat context, and delete.

## Authentication

Authentication is optional.

If `API_KEY` is empty, APIs are open for local development.

If `API_KEY` is set, all non-public APIs require either:

```text
x-api-key: your-api-key
```

or:

```text
Authorization: Bearer your-api-key
```

Public routes:

- `GET /api/health`
- `/docs`
- `/docs/json`

## Main APIs

- `GET /api/health`
- `POST /api/upload`
- `GET /api/files`
- `GET /api/files/:id`
- `DELETE /api/files/:id`
- `GET /api/vector-store/status`
- `POST /api/vector-store/reset`
- `GET /api/search?q=...`
- `POST /api/chat/context`
- `POST /api/chat`
- `GET /api/providers`
- `GET /api/tags`

## Model Providers

Frontend clients should send only `provider` and `model`. API keys stay on the backend in `.env`.

Supported providers:

- `ollama`: local Ollama chat, always marked as configured.
- `openai`: OpenAI Responses API, requires `OPENAI_API_KEY`.
- `anthropic`: Anthropic Claude Messages API, requires `ANTHROPIC_API_KEY`.

Provider config:

```text
OLLAMA_URL=http://localhost:11434
DEFAULT_MODEL=qwen3:8b
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_DEFAULT_MODEL=gpt-4o
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_DEFAULT_MODEL=claude-sonnet-4-5
OLLAMA_TIMEOUT_MS=120000
VISION_MODEL=qwen3-vl:2b
UPLOAD_DIR=server/data/uploads
```

Query provider availability:

```http
GET /api/providers
```

Example response:

```json
{
  "providers": [
    { "id": "ollama", "name": "Ollama", "defaultModel": "qwen3:8b", "configured": true },
    { "id": "openai", "name": "OpenAI", "defaultModel": "gpt-4o", "configured": false },
    { "id": "anthropic", "name": "Anthropic Claude", "defaultModel": "claude-sonnet-4-5", "configured": false }
  ]
}
```

Chat request:

```http
POST /api/chat
Content-Type: application/json
```

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "rag": "auto",
  "messages": [
    { "role": "user", "content": "根据知识库回答这个问题" }
  ]
}
```

RAG defaults to automatic routing. When `rag` is omitted or set to `"auto"`, the backend decides whether to inject knowledge-base context based on the user question and retrieval scores.

Use `"rag": false` to call the model directly without retrieval, or `"rag": true` to force knowledge-base retrieval for a single request.

The response stream uses Ollama-compatible NDJSON for all providers:

```json
{"message":{"role":"assistant","content":"partial answer"},"done":false}
{"message":{"role":"assistant","content":""},"done":true}
```

## Upload Behavior

Supported file types:

- `.txt`
- `.md`
- `.pdf`
- `.png`
- `.jpg`
- `.jpeg`
- `.webp`

Uploaded files are hashed with SHA-256.

- Same content upload returns the existing file with `deduplicated: true`.
- `POST /api/upload?overwrite=true` replaces the existing file with the same content hash.

Image uploads are saved under `UPLOAD_DIR`, parsed by `VISION_MODEL` through Ollama, converted to Markdown, then chunked and embedded like ordinary text files. The generated Markdown includes the original local file path and vision model name for traceability.

Reset the whole local vector store when changing embedding models or when rebuilding the knowledge base:

```bash
curl -X POST http://127.0.0.1:3001/api/vector-store/reset \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d "{\"confirm\":\"RESET_VECTOR_STORE\"}"
```

The reset endpoint clears all stored files, chunks, and the FTS index. It keeps the SQLite database file and schema in place.

Check whether the stored chunks match the current `EMBEDDING_MODEL` before searching or after changing embedding models:

```bash
curl http://127.0.0.1:3001/api/vector-store/status \
  -H "x-api-key: your-api-key"
```

The response includes `compatibleChunkCount`, `incompatibleChunkCount`, `embeddingDistributions`, and `needsReindex`. If `needsReindex` is `true`, reset the vector store and upload the knowledge files again.

Upload progress is available through Server-Sent Events. Frontend adapters can keep the same callback style as chat streaming:

```ts
export interface UploadRuntimeConfig {
  baseUrl?: string
  apiKey?: string
}

export interface UploadProgress {
  id: string
  phase: 'receiving' | 'parsing' | 'chunking' | 'embedding' | 'storing' | 'completed' | 'failed'
  percent: number
  message: string
  loaded?: number
  total?: number
  done: boolean
  error?: string
  updatedAt: string
}

export async function uploadKnowledgeFile(
  file: File,
  runtime: UploadRuntimeConfig,
  onProgress: (progress: UploadProgress) => void,
  onDone: () => void,
  signal?: AbortSignal,
  overwrite = false
): Promise<unknown> {
  const baseUrl = (runtime.baseUrl ?? 'http://127.0.0.1:3001').replace(/\/$/, '')
  const progressId = crypto.randomUUID()
  const headers = runtime.apiKey ? { 'x-api-key': runtime.apiKey } : undefined
  let isDone = false

  const progressTask = readUploadProgress(
    `${baseUrl}/api/upload/progress/${progressId}`,
    headers,
    progress => {
      onProgress(progress)
      if (progress.done && !isDone) {
        isDone = true
        onDone()
      }
    },
    signal
  )

  const formData = new FormData()
  formData.append('file', file)

  const url = new URL(`${baseUrl}/api/upload`)
  url.searchParams.set('progressId', progressId)
  if (overwrite) url.searchParams.set('overwrite', 'true')

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      signal,
    })

    if (!res.ok) throw new Error(`Upload error ${res.status}: ${await res.text()}`)
    return await res.json()
  } finally {
    await progressTask.catch(() => undefined)
    if (!isDone) onDone()
  }
}

async function readUploadProgress(
  url: string,
  headers: Record<string, string> | undefined,
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(url, { headers, signal })
  if (!res.ok) throw new Error(`Upload progress error ${res.status}: ${await res.text()}`)

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let dataLines: string[] = []
  let aborted = false

  signal?.addEventListener('abort', () => {
    aborted = true
    reader.cancel()
  })

  const dispatch = () => {
    if (!dataLines.length) return
    const progress = JSON.parse(dataLines.join('\n')) as UploadProgress
    onProgress(progress)
    dataLines = []
  }

  try {
    let buffer = ''
    while (true) {
      if (aborted) break
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const text = line.replace(/\r$/, '')
        if (!text) {
          dispatch()
        } else if (text.startsWith('data:')) {
          dataLines.push(text.slice('data:'.length).trimStart())
        }
      }
    }

    if (buffer.trim().startsWith('data:')) {
      dataLines.push(buffer.trim().slice('data:'.length).trimStart())
    }
    dispatch()
  } catch (err: any) {
    if (err.name !== 'AbortError') throw err
  } finally {
    reader.releaseLock()
  }
}
```

## RAG Retrieval

The retrieval pipeline uses:

- SQLite chunk storage
- SQLite FTS5 keyword index
- Chinese bigram/trigram expansion for better Chinese recall
- vector cosine similarity
- keyword score and vector score weighted merge
- near-duplicate chunk filtering

Important config:

```text
RAG_MODE=auto
RAG_TOP_K=5
RAG_MIN_SCORE=0.35
RAG_VECTOR_WEIGHT=0.8
RAG_KEYWORD_WEIGHT=0.2
CHUNK_MAX_LEN=700
CHUNK_OVERLAP=100
```

## Current Production Notes

- `node:sqlite` is still experimental in Node and may print a runtime warning.
- Vector similarity is still computed in JavaScript over stored chunks. This is fine for small knowledge bases, but large datasets should move to a vector index or vector database.
- Uploads currently read the file into memory. The Fastify multipart limit is 10 MB.
