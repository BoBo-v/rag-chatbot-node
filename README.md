# Node Fastify RAG

Fastify backend for local knowledge-base RAG with Ollama. It supports uploading `txt`, `md`, and `pdf` files, chunking text, generating embeddings, storing chunks in SQLite, hybrid retrieval, and RAG chat proxying.

## Requirements

- Node.js with `node:sqlite` support
- Ollama running locally
- Required Ollama models:
  - chat model: `qwen2.5:7b` by default
  - embedding model: `nomic-embed-text` by default

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
- `verify:http`: interface-level check for auth, Swagger, upload, search, chat context, and delete.

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
- `GET /api/tags`

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
