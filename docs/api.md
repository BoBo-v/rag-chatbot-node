# API Documentation

Base URL:

```text
http://127.0.0.1:3001
```

The port is configured by `PORT` in `.env`.

## Health

### `GET /api/health`

Checks whether the Fastify service is running.

Response:

```json
{
  "status": "ok"
}
```

## Models

### `GET /api/tags`

Proxies Ollama `GET /api/tags` and returns the available local models.

Error response:

```json
{
  "error": "Failed to connect to Ollama service"
}
```

## Upload Knowledge File

### `POST /api/upload`

Uploads a knowledge file, extracts text, splits it into chunks, generates embeddings, and stores the file/chunk metadata in the local vector store.

Supported file types:

```text
txt
pdf
```

Content type:

```text
multipart/form-data
```

Form field:

```text
file
```

Example:

```bash
curl -X POST http://127.0.0.1:3001/api/upload \
  -F "file=@test.txt"
```

Success response:

```json
{
  "file": {
    "id": "file-id",
    "filename": "test.txt",
    "mimeType": "text/plain",
    "size": 1234,
    "charCount": 1000,
    "chunkCount": 3,
    "createdAt": "2026-06-02T00:00:00.000Z"
  },
  "chunks": [
    {
      "text": "chunk text",
      "chunkIndex": 0
    }
  ]
}
```

Error responses:

```json
{
  "error": "Please upload a file"
}
```

```json
{
  "error": "Unsupported file type. Only txt and pdf are supported."
}
```

```json
{
  "error": "No readable text found in this file"
}
```

```json
{
  "error": "Failed to parse, embed, or store uploaded file"
}
```

## Files

### `GET /api/files`

Lists uploaded files.

Response:

```json
{
  "files": [
    {
      "id": "file-id",
      "filename": "test.txt",
      "mimeType": "text/plain",
      "size": 1234,
      "charCount": 1000,
      "chunkCount": 3,
      "createdAt": "2026-06-02T00:00:00.000Z"
    }
  ]
}
```

### `GET /api/files/:id`

Returns file metadata and chunk details. Raw embedding arrays are not returned; only `embeddingSize` is exposed.

Response:

```json
{
  "file": {
    "id": "file-id",
    "filename": "test.txt",
    "mimeType": "text/plain",
    "size": 1234,
    "charCount": 1000,
    "chunkCount": 3,
    "createdAt": "2026-06-02T00:00:00.000Z",
    "chunks": [
      {
        "id": "chunk-id",
        "fileId": "file-id",
        "filename": "test.txt",
        "chunkIndex": 0,
        "text": "chunk text",
        "createdAt": "2026-06-02T00:00:00.000Z",
        "embeddingSize": 768
      }
    ]
  }
}
```

Not found:

```json
{
  "error": "File not found"
}
```

### `DELETE /api/files/:id`

Deletes a file and all of its chunks from the local vector store.

Response:

```json
{
  "ok": true
}
```

Not found:

```json
{
  "error": "File not found"
}
```

## Search

### `GET /api/search`

Runs RAG retrieval directly for debugging. This endpoint generates an embedding for `q`, then searches stored chunks using hybrid scoring.

Query parameters:

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `q` | yes | - | Search query. |
| `topK` | no | `RAG_TOP_K` | Number of chunks to return. Clamped to `1-20`. |
| `minScore` | no | `RAG_MIN_SCORE` | Minimum hybrid score. Clamped to `0-1`. |
| `fileId` | no | - | Restrict search to one uploaded file. |

Hybrid score:

```text
score = vectorScore * RAG_VECTOR_WEIGHT + keywordScore * RAG_KEYWORD_WEIGHT
```

The code normalizes by total weight, so the score remains comparable when weights change.

Example:

```bash
curl "http://127.0.0.1:3001/api/search?q=ticket-9527&topK=5&minScore=0.35"
```

Response:

```json
{
  "query": "ticket-9527",
  "topK": 5,
  "minScore": 0.35,
  "results": [
    {
      "id": "chunk-id",
      "fileId": "file-id",
      "filename": "test.txt",
      "chunkIndex": 0,
      "score": 0.92,
      "vectorScore": 0.9,
      "keywordScore": 1,
      "text": "chunk text"
    }
  ]
}
```

Missing query:

```json
{
  "error": "q is required"
}
```

## Chat

### `POST /api/chat`

Sends messages to Ollama chat. Before calling Ollama, the service embeds the latest message, retrieves relevant chunks, and prepends a system message containing the RAG references when matches are found.

Content type:

```text
application/json
```

Request:

```json
{
  "model": "qwen2.5:7b",
  "messages": [
    {
      "role": "user",
      "content": "What does the uploaded document say about ticket-9527?"
    }
  ]
}
```

`model` is optional. If omitted, `DEFAULT_MODEL` from `.env` is used.

Response:

The endpoint streams Ollama's response body directly.

Content type:

```text
application/x-ndjson
```

Validation errors:

```json
{
  "error": "messages cannot be empty"
}
```

```json
{
  "error": "last message content cannot be empty"
}
```

Service error:

```json
{
  "error": "Failed to call Ollama or retrieve RAG context"
}
```

## Configuration

Configured through `.env`:

| Name | Default | Description |
| --- | --- | --- |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama service URL. |
| `DEFAULT_MODEL` | `qwen2.5:7b` | Default chat model. |
| `PORT` | `3001` | Fastify server port. |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model. |
| `RAG_TOP_K` | `5` | Default retrieval result count. |
| `RAG_MIN_SCORE` | `0.35` | Default retrieval threshold. |
| `RAG_VECTOR_WEIGHT` | `0.8` | Vector score weight. |
| `RAG_KEYWORD_WEIGHT` | `0.2` | Keyword score weight. |
| `CHUNK_MAX_LEN` | `700` | Maximum chunk length. |
| `CHUNK_OVERLAP` | `100` | Chunk overlap target length. |
| `VECTOR_STORE_PATH` | `server/data/vector-store.json` | Local JSON vector store path. |
