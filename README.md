# Node Fastify 本地 RAG 后端

这是一个基于 Fastify 的本地 AI / RAG 后端，用来做知识库上传、文本切块、向量化、混合检索、图片识别入库和多模型对话代理。

当前项目的核心目标是：前端只需要调用统一接口，后端负责把文档、PDF、图片等资料整理成可检索知识库，再根据用户问题自动决定是否注入 RAG 上下文。

## 核心能力

- 知识库上传：支持 `txt`、`md`、`pdf`、`png`、`jpg`、`jpeg`、`webp`
- 图片入库：图片先由本地视觉模型识别/翻译成 Markdown，再进入 RAG 流程
- 向量化：通过 Ollama embedding 模型生成向量
- 检索：SQLite 存储 + FTS5 关键词索引 + 向量相似度混合排序
- 对话：统一代理 Ollama、OpenAI、Anthropic Claude
- RAG 自动模式：后端可根据问题和检索命中自动决定是否注入知识库
- 调用统计：记录模型请求、耗时、错误、估算 token 和成本
- 上传进度：通过 SSE 返回上传、解析、embedding、入库阶段状态

## 工程改进亮点

- 基于 28 条 RAG 检索测试用例对 `minScore` 做参数评估，覆盖精确问题、模糊问题、跨文件问题、无关问题和容易被大文件吸走的问题；将默认阈值从 `0.35` 调整为 `0.55`，在保持相关问题召回的同时，消除了本轮天气、闲聊、实时新闻等无关问题的误召回。

## 技术栈

- Node.js
- TypeScript
- Fastify
- SQLite / `node:sqlite`
- Ollama
- pdf-parse
- Fastify Swagger / Swagger UI

注意：`node:sqlite` 在当前 Node 版本中仍可能打印 experimental warning，这是 Node 自身提示，不代表项目启动失败。

## 目录结构

```text
server/
  app.ts                 Fastify 应用注册、鉴权、CORS、Swagger、全局日志
  index.ts               服务启动入口
  dashboard.html         内置运行统计面板
  router/
    upload.ts            知识库上传、文件管理、向量库状态、搜索
    chat.ts              聊天、RAG 上下文预览、厂商/模型查询
    metrics.ts           调用指标接口和 dashboard 页面
    logs.ts              结构化日志查询和 requestId 详情
    system.ts            健康检查
  observability/
    collector.ts         有界队列、批量写入、重试和每日清理
    store.ts             独立观测数据库和旧指标迁移
    queries.ts           日志筛选、游标分页和聚合查询
    privacy.ts           路由、IP、错误和上下文脱敏
  llm/
    ollamaProvider.ts    Ollama 对话流
    openaiProvider.ts    OpenAI 兼容接口
    anthropicProvider.ts Anthropic Claude 兼容接口
    stream.ts            统一流式输出格式
  utils/
    config.ts            环境变量配置
    vision.ts            图片识别调用 Ollama VL 模型
    embedding.ts         embedding 调用和重试
    chunker.ts           文本切块
    vectorStore.ts       SQLite 向量库、FTS、检索
    metricsStore.ts      AI 调用指标兼容查询
    errors.ts            错误分类
```

## 环境要求

- Node.js 22 或更高版本，需支持 `node:sqlite`
- Ollama 已启动
- 本地模型建议：
  - 对话模型：`qwen3:8b`
  - 视觉模型：`qwen3-vl:2b`
  - embedding 模型：中文知识库建议 `bge-m3`

安装模型示例：

```powershell
ollama pull qwen3:8b
ollama pull qwen3-vl:2b
ollama pull bge-m3
```

查看本地模型：

```powershell
ollama list
```

如果 `ollama list` 异常，也可以直接查 API：

```powershell
curl http://127.0.0.1:11434/api/tags
```

## 安装和启动

```powershell
npm install
copy .env.example .env
npm run dev:server
```

默认后端地址：

```text
http://127.0.0.1:3001
```

健康检查：

```text
GET /api/health
```

Swagger UI：

```text
http://127.0.0.1:3001/docs
```

运行统计面板：

```text
http://127.0.0.1:3001/api/metrics/dashboard
```

需要先设置 `LOG_QUERY_ENABLED=true` 并提供有效的日志查询密钥。优先使用 `LOG_QUERY_API_KEY`；迁移期间可暂时回退到旧 `API_KEY`。

## 常用脚本

```powershell
npm run dev:server
npm run typecheck
npm run verify
npm run verify:http
npm run verify:observability
npm run verify:agent
npm run verify:agent:http
```

- `dev:server`：启动后端开发服务，使用 `tsx watch`
- `typecheck`：TypeScript 静态检查
- `verify`：本地逻辑验证，包括 chunker、向量库、去重、混合检索、中文 FTS 等
- `verify:http`：HTTP 接口级验证
- `verify:observability`：独立观测库、旧指标迁移、游标分页和脱敏验证
- `verify:agent`：AgentRunner、模型队列、工具校验、超时和 Ollama 协议验证
- `verify:agent:http`：Agent 专用鉴权、NDJSON、取消、模型超时和日志关联验证

如果 `npm run verify` 报 SQLite 文件 `EBUSY`，通常是后端进程正在占用 `server/data/vector-store.sqlite`。先停止后端再跑验证。

## 端口占用处理

如果启动时报：

```text
EADDRINUSE: address already in use ::1:3001
```

说明 3001 已经被旧进程占用。PowerShell 中执行：

```powershell
netstat -ano | Select-String ':3001'
```

找到最后一列 PID，然后停止：

```powershell
Stop-Process -Id <PID> -Force
```

## 环境变量

`.env.example` 提供了完整配置模板。常用配置如下：

```env
OLLAMA_URL=http://127.0.0.1:11434
DEFAULT_MODEL=qwen3:8b
PORT=3001
BODY_LIMIT_BYTES=4194304

API_KEY=
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173

EMBEDDING_MODEL=bge-m3
VISION_MODEL=qwen3-vl:2b
OLLAMA_TIMEOUT_MS=600000
UPLOAD_DIR=server/data/uploads
VECTOR_STORE_PATH=server/data/vector-store.sqlite
OBSERVABILITY_DB_PATH=server/data/observability.sqlite

RAG_MODE=auto
RAG_TOP_K=5
RAG_MIN_SCORE=0.55
RAG_VECTOR_WEIGHT=0.8
RAG_KEYWORD_WEIGHT=0.2

CHUNK_MAX_LEN=700
CHUNK_OVERLAP=100
MAX_EXTRACTED_TEXT_CHARS=2000000
MAX_FILE_CHUNKS=2000
EMBEDDING_BATCH_SIZE=16
RAG_VECTOR_CANDIDATE_LIMIT=1000

VECTOR_BACKEND=sqlite
QDRANT_URL=http://127.0.0.1:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=knowledge_chunks
QDRANT_DISTANCE=Cosine
DEFAULT_TENANT_ID=default
DEFAULT_PROJECT_ID=default
DEFAULT_OWNER_USER_ID=local

LOG_LEVEL=info
LOG_QUERY_ENABLED=false
LOG_QUERY_API_KEY=
LOG_QUESTION_PREVIEW=false
LOG_REMOTE_ADDRESS=none
LOG_QUEUE_MAX_SIZE=5000
LOG_FLUSH_INTERVAL_MS=5000
LOG_WRITE_RETRY_COUNT=3
LOG_HTTP_RETENTION_DAYS=30
LOG_AI_RETENTION_DAYS=90
LOG_EVENT_RETENTION_DAYS=90

AGENT_ENABLED=false
AGENT_ACCESS_MODE=api-key
AGENT_API_KEY=
AGENT_OLLAMA_MODELS=qwen2.5:7b
AGENT_QUEUE_MAX_SIZE=5
AGENT_QUEUE_TIMEOUT_MS=30000
AGENT_OLLAMA_MODEL_TIMEOUT_MS=600000
AGENT_RUN_TIMEOUT_MS=1200000
AGENT_TOOL_TIMEOUT_MS=5000
```

说明：

- `OLLAMA_URL` 建议用 `http://127.0.0.1:11434`，避免 Windows 下 `localhost` 的 IPv4/IPv6 差异
- `OLLAMA_TIMEOUT_MS=600000` 是 600 秒，本地 Ollama 普通调用最多等待 10 分钟
- `EMBEDDING_MODEL` 建议中文知识库使用 `bge-m3`
- `VISION_MODEL` 用于图片识别入库
- `LOG_QUERY_ENABLED=true` 且存在有效日志查询密钥时才会注册日志查询接口和 Dashboard
- `LOG_QUERY_API_KEY` 只保护日志查询；`API_KEY` 非空时会保护所有非公开业务接口
- 兼容迁移：开启日志但尚未设置 `LOG_QUERY_API_KEY` 时，旧 `API_KEY` 暂时只作为日志密钥使用；建议尽快将其移动到 `LOG_QUERY_API_KEY` 并清空 `API_KEY`
- HTTP 日志只保存路由模板，不保存带查询参数的完整 URL
- 问题预览和访问 IP 默认不记录；错误堆栈只输出到经过脱敏的 Pino 日志
- Agent 默认关闭；启用后使用独立 `AGENT_API_KEY`，不会让普通聊天和知识库接口同时要求该 Key
- 当前安装的 `qwen3:8b` 没有声明 tools 能力，Agent V0 默认使用已验证支持工具调用的 `qwen2.5:7b`
- `.env` 修改后必须重启后端才生效

## Qdrant 向量后端

默认 `VECTOR_BACKEND=sqlite`，保持单进程 SQLite + FTS + 本地向量比对，前端接口不需要变化。

如果知识库 chunk 数量较大，可以切到 Qdrant：

```env
VECTOR_BACKEND=qdrant
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=knowledge_chunks
```

切换后：
- SQLite 向量库仍保存 files/chunks 文本、FTS 和业务元数据
- AI 指标和 HTTP 日志保存在独立的 `OBSERVABILITY_DB_PATH`
- Qdrant 保存 chunk 向量和 payload，用于向量召回
- `/api/search`、`/api/chat/context`、`/api/chat` 的前端调用方式不变
- 如已有 SQLite 知识库，需要调用 `POST /api/vector-store/reindex` 重建 Qdrant 索引

Qdrant payload 预留了 `tenantId`、`projectId`、`ownerUserId`，后续接用户、项目和权限系统时可以用于检索阶段过滤。

## 鉴权

`API_KEY` 为空时，接口默认开放，适合本地开发。

如果设置了 `API_KEY`，非公开接口需要携带：

```text
x-api-key: your-api-key
```

或：

```text
Authorization: Bearer your-api-key
```

公开接口：

- `GET /api/health`
- `/docs`
- `GET /api/upload/progress/:id`
- `GET /api/metrics/dashboard` 仅在日志查询已启用且配置 API Key 时注册；页面本身公开，数据接口仍需 API Key

## 图片知识库流程

当前后端图片入库流程如下：

```text
前端上传图片
  -> 后端保存原图到 UPLOAD_DIR
  -> 调用 Ollama /api/generate + VISION_MODEL
  -> 视觉模型输出 Markdown
  -> 清理外层 markdown 代码块
  -> 切块
  -> 调用 EMBEDDING_MODEL 生成向量
  -> 写入 SQLite files / chunks / FTS 索引
  -> 后续聊天通过 RAG 检索使用
```

重点：

- 前端不需要直接调用视觉模型
- 前端只需要把图片当普通文件传给 `/api/upload`
- 图片识别可能很慢，必须接上传进度
- 重复上传时不要默认 `overwrite=true`
- 不覆盖时，后端会根据 SHA-256 内容 hash 直接复用已有入库记录

## 知识库上传接口

```http
POST /api/upload
Content-Type: multipart/form-data
```

表单字段：

```text
file: File
```

query 参数：

```text
progressId=前端生成的 UUID，可选
overwrite=true | false，可选，默认 false
```

支持文件：

- `.txt`
- `.md`
- `.pdf`
- `.png`
- `.jpg`
- `.jpeg`
- `.webp`

返回示例：

```json
{
  "file": {
    "id": "file-id",
    "filename": "demo.png",
    "mimeType": "image/png",
    "size": 121212,
    "charCount": 585,
    "chunkCount": 2,
    "createdAt": "2026-06-12T02:15:39.978Z",
    "contentHash": "sha256",
    "embeddingModel": "bge-m3",
    "embeddingDim": 1024,
    "chunkerVersion": 2
  },
  "chunks": [
    {
      "text": "识别后的知识库文本",
      "chunkIndex": 0
    }
  ],
  "deduplicated": false,
  "overwritten": false
}
```

字段含义：

- `deduplicated=true`：内容已存在，复用旧记录，没有重新跑视觉模型和 embedding
- `overwritten=true`：传了 `overwrite=true`，重新解析并替换旧记录
- `chunks`：本次入库的文本分块，前端可以用来预览图片识别结果

## 上传进度 SSE

```http
GET /api/upload/progress/:progressId
```

前端推荐流程：

1. 生成 `progressId`
2. 先打开 `/api/upload/progress/:progressId`
3. 再上传 `/api/upload?progressId=...`

进度事件格式：

```text
event: progress
data: {"phase":"parsing","percent":68,"message":"正在使用视觉模型 qwen3-vl:2b 识别图片。","done":false}
```

`phase` 取值：

- `receiving`：接收上传文件
- `parsing`：解析文本/PDF 或调用视觉模型识别图片
- `chunking`：切块
- `embedding`：生成向量
- `storing`：写入知识库
- `completed`：完成
- `failed`：失败

图片上传时最慢的阶段通常是 `parsing` 和 `embedding`。

## 文件管理接口

```http
GET /api/files
GET /api/files/:id
DELETE /api/files/:id
```

文件详情会返回 chunk 文本，但不会返回完整 embedding 数组，只返回 embedding 维度信息。

前端建议展示：

- 文件名
- 文件类型
- 文件大小
- 字符数
- chunk 数
- embedding 模型和维度
- 创建时间
- chunk 文本预览

## 向量库状态

```http
GET /api/vector-store/status
```

用于检查当前知识库是否和当前 `EMBEDDING_MODEL` 兼容。

关键字段：

- `fileCount`
- `chunkCount`
- `currentEmbeddingModel`
- `compatibleChunkCount`
- `incompatibleChunkCount`
- `embeddingDistributions`
- `needsReindex`

如果 `needsReindex=true`，说明当前库里有旧模型/旧维度的向量，建议清空并重新上传知识库。

重置接口：

```http
POST /api/vector-store/reset
Content-Type: application/json
```

重建向量索引接口：

```http
POST /api/vector-store/reindex
Content-Type: application/json
```

请求体可选：

```json
{
  "fileId": "file-id"
}
```

`VECTOR_BACKEND=sqlite` 时该接口会返回 `skipped=true`；`VECTOR_BACKEND=qdrant` 时会从 SQLite chunks 重新 upsert 到 Qdrant。

请求体：

```json
{
  "confirm": "RESET_VECTOR_STORE"
}
```

## RAG 检索调试

```http
GET /api/search?q=问题&topK=5&minScore=0.2
```

返回每个命中 chunk：

- `filename`
- `chunkIndex`
- `score`
- `vectorScore`
- `keywordScore`
- `text`

这个接口用于前端调试“为什么模型有没有引用知识库”。

## 聊天接口

```http
POST /api/chat
Content-Type: application/json
```

请求示例：

```json
{
  "provider": "ollama",
  "model": "qwen3:8b",
  "rag": "auto",
  "messages": [
    {
      "role": "user",
      "content": "根据知识库回答这张图片里的题目内容"
    }
  ]
}
```

参数说明：

- `provider`：`ollama`、`openai`、`anthropic`
- `model`：模型名称；不传时使用厂商默认模型
- `rag`：
  - `"auto"`：后端根据问题和检索命中自动判断
  - `true`：强制检索知识库
  - `false`：不检索，直接调用模型
- `fileId`：可选，只检索某个文件
- `topK`：可选，覆盖本次检索数量
- `minScore`：可选，覆盖本次最低分数
- `compareId`：可选，用于多模型对比统计

响应是统一 NDJSON 流：

```json
{"message":{"role":"assistant","content":"部分回答"},"done":false}
{"message":{"role":"assistant","content":""},"done":true}
```

前端需要逐行解析 JSON，累加 `message.content`。

## RAG 上下文预览

```http
POST /api/chat/context
Content-Type: application/json
```

请求体和 `/api/chat` 类似，但不会调用模型，只返回本次会不会启用 RAG、命中的 chunk 和将要注入的 system prompt。

这个接口适合做调试面板。

## 模型厂商接口

查询后端支持的模型厂商：

```http
GET /api/providers
```

返回示例：

```json
{
  "providers": [
    {
      "id": "ollama",
      "name": "Ollama",
      "defaultModel": "qwen3:8b",
      "configured": true,
      "capabilities": {
        "chatStream": true,
        "agentTools": false
      },
      "agentModels": []
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "defaultModel": "gpt-4o",
      "configured": false
    },
    {
      "id": "anthropic",
      "name": "Anthropic Claude",
      "defaultModel": "claude-sonnet-4-5",
      "configured": false
    }
  ]
}
```

查询本地 Ollama 模型：

```http
GET /api/tags
```

## Agent V0

Agent V0 是独立于 `/api/chat` 的受控运行环境，当前支持后端 Ollama、兼容旧请求的 `calculator-v0`，以及包含计算器和日期时间工具的 `tools-v0`。Agent 关闭时路由不会注册。

```env
AGENT_ENABLED=true
AGENT_ACCESS_MODE=api-key
AGENT_API_KEY=replace-with-a-random-secret
AGENT_OLLAMA_MODELS=qwen2.5:7b
AGENT_DEBUG_TOOL_RESULTS=false
```

请求示例：

```http
POST /api/agent
Content-Type: application/json
x-agent-api-key: replace-with-a-random-secret

{
  "agentProfile": "tools-v0",
  "provider": "ollama",
  "model": "qwen2.5:7b",
  "messages": [
    { "role": "user", "content": "请计算 12 乘以 35" }
  ]
}
```

`tools-v0` 只允许后端注册的两个无副作用工具：

- `calculator`：两个有限数字的加、减、乘、除
- `datetime`：当前时间、IANA 时区转换、日期加减、时间差、日期属性分析和 Unix 时间戳转换

`datetime` 使用 ISO 8601 时间和 IANA 时区（例如 `Asia/Shanghai`）。不带 `Z` 或 UTC offset 的本地时间必须提供时区；`CST` 等有歧义的缩写会被拒绝。日期加减区分“日历日”和“固定小时”，并按真实夏令时规则计算。

响应类型为 `application/x-ndjson`。每个事件都包含 `version`、`sequence`、`requestId`、`agentRunId`、`step` 和 `timestamp`。一次运行只允许一个终态：`agent_completed`、`agent_failed` 或 `agent_cancelled`。

前端不能提交 System Prompt、工具列表、Tool Call、Tool Result 或模型厂商 API Key。默认执行过程只展示模型阶段和脱敏工具状态，不返回原始思维链、完整工具参数或内部错误。

本地调试可设置 `AGENT_DEBUG_TOOL_RESULTS=true`，此时 `tool_completed.data.result` 会返回经过敏感字段脱敏和长度限制的工具结果，前端执行过程会直接展示。该开关不影响工具结果继续返回给模型，生产环境应保持关闭。显示长度由 `AGENT_DEBUG_TOOL_RESULT_MAX_CHARS` 控制。

## 指标和日志接口

以下接口仅在 `LOG_QUERY_ENABLED=true` 且存在有效日志查询密钥时注册。优先使用 `LOG_QUERY_API_KEY`；列表接口未指定时间时默认查询最近 24 小时。

结构化日志：

```http
GET /api/logs/summary
GET /api/logs/requests
GET /api/logs/errors
GET /api/logs/requests/:requestId
```

`/api/logs/requests` 和 `/api/logs/errors` 使用不透明游标分页，响应中的 `nextCursor` 原样传给下一页即可。错误接口只返回脱敏错误，不返回 stack 或 rawError。

AI 运行统计兼容接口：

```http
GET /api/metrics/summary
GET /api/metrics/providers
GET /api/metrics/requests
GET /api/metrics/compare/:compareId
GET /api/metrics/dashboard
```

最近 HTTP 访问日志兼容接口：

```http
GET /api/http-logs?limit=30
```

这些接口用于排查：

- 模型调用是否成功
- 是否流式错误
- 是否超时
- RAG 是否启用
- 命中了多少知识库上下文
- 哪个接口慢
- 同一个 `requestId` 对应的 HTTP 请求、AI 调用和应用事件

所有响应都会返回 `X-Request-Id`。用户反馈问题时可提供该值进行精确查询。旧 AI 指标迁移到独立观测库时，`request_id` 保持 `NULL`，不会伪造关联，也不会迁移旧问题预览和原始错误。

## 前端接入建议

知识库上传页面至少需要：

- 文件选择
- 上传按钮
- 是否覆盖开关，默认关闭
- SSE 上传进度
- 上传结果展示
- chunk 文本预览
- 文件列表和删除

图片上传时建议展示：

```text
正在识别图片，可能需要 1 到 8 分钟，请不要重复提交。
```

重复文件建议：

- 默认不传 `overwrite=true`
- 如果返回 `deduplicated=true`，展示“已存在，复用知识库”
- 只有用户点击“重新解析”时才传 `overwrite=true`

聊天页面至少需要：

- provider 选择
- model 输入/选择
- RAG 模式：自动、强制、关闭
- 流式输出
- 错误展示
- 可解释信息：是否启用 RAG、命中文件、chunk 分数

## 常见问题

### 1. 图片上传很慢

本地 `qwen3-vl:2b` 识别图片可能需要几分钟。需要接 SSE 进度，不要让前端自己短超时。

### 2. 返回 `VISION_MODEL_UNAVAILABLE`

检查：

```powershell
ollama list
curl http://127.0.0.1:11434/api/tags
```

确认 `VISION_MODEL` 配置的模型存在，例如：

```env
VISION_MODEL=qwen3-vl:2b
```

### 3. 返回 `EMBEDDING_SERVICE_UNAVAILABLE`

检查：

```env
EMBEDDING_MODEL=bge-m3
OLLAMA_URL=http://127.0.0.1:11434
```

确认模型存在：

```powershell
ollama pull bge-m3
```

如果库里已经有同一张图，但前端仍报错，可能是重复上传时传了 `overwrite=true`，导致后端重新跑视觉识别和 embedding。默认不要覆盖。

### 4. 修改 `.env` 后没有效果

`.env` 只在后端启动时读取。修改后必须重启：

```powershell
npm run dev:server
```

### 5. CORS 报错

把前端地址加入：

```env
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
```

然后重启后端。

### 6. verify 报 SQLite EBUSY

说明后端还在占用 SQLite 文件。先停掉后端进程，再运行：

```powershell
npm run verify
```

## 当前限制

- 上传文件会读入内存，Fastify multipart 限制为 10 MB
- 向量相似度仍在 JavaScript 中遍历计算，适合小型/本地知识库
- 图片识别依赖本地 VL 模型，速度取决于硬件
- 图片识别结果当前以 chunk 形式入库，尚未单独建 parsed document 表
- 批量图片入库建议后续改成后台任务队列

## 推荐后续演进

- 上传任务化：返回 `taskId`，后台处理图片识别和 embedding
- 单独保存图片识别 Markdown，方便重新 embedding 和模型升级对比
- 批量入库队列：支持取消、重试、失败列表
- 前端增加 RAG 命中解释面板
- 向量检索迁移到专用向量索引或向量数据库
