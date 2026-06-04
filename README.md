# Node Fastify RAG

Fastify backend for local knowledge-base RAG. It supports uploading `txt`, `md`, and `pdf` files, chunking text, generating embeddings with Ollama, storing chunks in SQLite, hybrid retrieval, and chat streaming through Ollama, OpenAI, or Anthropic Claude.

## Requirements

- Node.js with `node:sqlite` support
- Ollama running locally
- Required Ollama models:
  - chat model: `qwen2.5:7b` by default when using `provider: "ollama"`
  - embedding model: `nomic-embed-text` by default
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
DEFAULT_MODEL=qwen2.5:7b
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_DEFAULT_MODEL=gpt-4o
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_DEFAULT_MODEL=claude-sonnet-4-5
OLLAMA_TIMEOUT_MS=120000
```

Query provider availability:

```http
GET /api/providers
```

Example response:

```json
{
  "providers": [
    { "id": "ollama", "name": "Ollama", "defaultModel": "qwen2.5:7b", "configured": true },
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
  "rag": true,
  "messages": [
    { "role": "user", "content": "根据知识库回答这个问题" }
  ]
}
```

The response stream is unified NDJSON for all providers:

```json
{"type":"text","delta":"partial answer"}
{"type":"done"}
```

## Upload Behavior

Supported file types:

- `.txt`
- `.md`
- `.pdf`

Uploaded files are hashed with SHA-256.

- Same content upload returns the existing file with `deduplicated: true`.
- `POST /api/upload?overwrite=true` replaces the existing file with the same content hash.

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
