# Node Fastify 本地 AI / RAG 后端

基于 TypeScript、Fastify 5、SQLite 和 Ollama 的知识库与多模型对话后端，面向个人及小团队的本地 AI 应用开发。本仓库包含后端和内置统计面板，不包含完整聊天前端。

## 核心能力

- 知识库：TXT、Markdown、PDF 和 PNG/JPG/JPEG/WebP 图片入库，支持内容去重。
- 图片解析：通过 Ollama 视觉模型生成 Markdown，再切块、向量化。
- 混合检索：Ollama Embedding、SQLite FTS5 关键词索引及向量相似度排序，可选 Qdrant 向量后端。
- RAG 对话：自动、开启、关闭三种模式，可预览命中片段、分数和注入提示词。
- 多模型代理：Ollama、OpenAI 兼容接口、Anthropic，统一流式聊天输出。
- 可恢复聊天：后台生成、幂等创建、答案快照、SSE 事件重放和主动取消。
- 可选 Agent：受控工具调用、模型白名单、独立鉴权、队列和超时控制。
- 可观测性：独立数据库记录请求、模型调用、RAG 命中、耗时和错误，提供 Dashboard。

## 快速启动

需要支持 `node:sqlite` 的 Node.js，建议 Node.js 22.13+ 或更新的 LTS。部分版本输出 SQLite experimental warning，不代表服务启动失败。

安装依赖并创建配置；已有 `.env` 时保留原文件：

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

启动 Ollama，拉取与配置一致的模型：

```powershell
ollama pull qwen3:8b
ollama pull nomic-embed-text
# 图片入库需要视觉模型
ollama pull qwen3-vl:2b
npm run dev:server
```

模板使用 `EMBEDDING_MODEL=nomic-embed-text`。中文知识库可改用 `bge-m3`，需要先拉取该模型并同步修改配置。

| 入口 | 地址 |
| --- | --- |
| 健康检查 | `http://localhost:3001/api/health` |
| Swagger UI | `http://localhost:3001/docs` |
| 统计面板 | `http://localhost:3001/api/metrics/dashboard`，需启用日志查询 |

端口默认 3001，以启动日志输出为准。仅使用已配置的云端模型并关闭 RAG 时，不依赖本地对话模型；知识库 Embedding 与图片解析仍依赖 Ollama。

## 配置

完整说明见 [`.env.example`](.env.example)，读取逻辑见 [config.ts](server/utils/config.ts)。修改配置后重启服务。

下表为当前模板值：

| 配置 | 模板值 / 用途 |
| --- | --- |
| `PORT` | `3001` |
| `OLLAMA_URL` | `http://localhost:11434` |
| `DEFAULT_MODEL` | `qwen3:8b` |
| `EMBEDDING_MODEL` | `nomic-embed-text` |
| `VISION_MODEL` | `qwen3-vl:2b` |
| `OLLAMA_THINKING_ENABLED` | `false` |
| `RAG_MODE` | `auto` |
| `RAG_SHOW_CITATIONS` | `true` |
| `RAG_TOP_K` / `RAG_MIN_SCORE` | `5` / `0.6` |
| `RAG_VECTOR_WEIGHT` / `RAG_KEYWORD_WEIGHT` | `0.8` / `0.2` |
| `CHUNK_MAX_LEN` / `CHUNK_OVERLAP` | `700` / `100`，单位为字符 |
| `EMBEDDING_BATCH_SIZE` | `16` |
| `VECTOR_BACKEND` | `sqlite`，也支持 `qdrant` |
| `BODY_LIMIT_BYTES` | `4194304`，JSON 请求体上限 |
| `OLLAMA_TIMEOUT_MS` | `600000` |

代码未配置时的回退值与模板并非完全一致：`RAG_MIN_SCORE` 回退为 `0.55`，`RAG_SHOW_CITATIONS` 回退为 `false`。历史评测中的参数也不代表当前运行值。

云端模型配置使用 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_DEFAULT_MODEL` 或对应 `ANTHROPIC_*` 项。客户端通过 `provider` 选择 `ollama`、`openai` 或 `anthropic`。

### 鉴权与功能开关

- 业务接口：设置 `API_KEY` 后，通过 `x-api-key` 或 `Authorization: Bearer ...` 访问受保护接口。
- 日志和 Dashboard：设置 `LOG_QUERY_ENABLED=true` 和 `LOG_QUERY_API_KEY`；数据请求通过上述密钥头传日志专用密钥。未满足启用条件时相关路由返回 404。旧 `API_KEY` 的迁移回退仍保留，建议显式配置专用密钥。
- Agent：设置 `AGENT_ENABLED=true`、`AGENT_ACCESS_MODE=api-key`、`AGENT_API_KEY`，请求使用 `x-agent-api-key`。
- CORS：`CORS_ORIGIN` 使用逗号分隔允许访问的前端地址。

Agent 的 loopback 模式只检查后端直接收到的本机连接，不能将前端代理转发视为可靠的用户身份校验。

## 知识库与 RAG

```text
文件上传 -> 文本提取 / 图片识别 -> 切块 -> Embedding -> 保存元数据及索引
用户问题 -> 向量与关键词检索 -> 混合排序 -> RAG 门控 -> 注入材料 -> 模型回答
```

### 上传与检索

上传使用 multipart，单文件限制为 10 MiB。解析文本和切块数量另受 `MAX_EXTRACTED_TEXT_CHARS`、`MAX_FILE_CHUNKS` 限制。

```powershell
curl.exe -F "file=@test.txt" http://localhost:3001/api/upload
curl.exe --get --data-urlencode "q=根据知识库说明项目架构" http://localhost:3001/api/search
```

启用鉴权时添加 `-H "x-api-key:你的密钥"`。图片源文件保存在 `UPLOAD_DIR`，不能假定其他格式也保留原始上传件。

上传进度接入顺序：

1. 前端生成 `progressId`。
2. 订阅 `GET /api/upload/progress/:id` 的 SSE。
3. 上传到 `POST /api/upload?progressId=...`。
4. 根据 receiving、parsing、chunking、embedding、storing、completed 或 failed 阶段更新状态。

默认重复内容会复用已有记录。只有需要重新解析时才使用 `overwrite=true`，避免重复执行视觉识别和 Embedding。

### 聊天示例

向 `POST /api/chat` 发送 JSON：

```json
{
  "provider": "ollama",
  "model": "qwen3:8b",
  "rag": "auto",
  "topK": 5,
  "minScore": 0.6,
  "messages": [
    { "role": "user", "content": "根据知识库列出项目的缓存策略" }
  ]
}
```

可使用 `fileId` 限定文件，使用 `compareId` 关联模型对比。响应为 `application/x-ndjson`：

```json
{"message":{"role":"assistant","content":"部分回答"},"done":false}
{"message":{"role":"assistant","content":""},"done":true}
```

客户端按换行解析 JSON 并累加 `message.content`；一次网络读取可能包含多行，也可能只包含半行。

| 模式 | 实际行为 |
| --- | --- |
| `false` | 跳过检索 |
| `true` | 执行检索，检索异常报错；空结果不注入材料 |
| `auto` | 检索异常回退普通聊天；有结果后按意图和分数判断 |

自动模式识别“知识库、根据、文档”等显式意图；没有显式意图时，最高命中的综合分需至少为 0.62，或其关键词分至少为 0.55。检索使用消息数组最后一条内容，当前不会自动结合历史改写追问。

将同一请求发送到 `POST /api/chat/context`，可获得 `enabled`、`prompt`、`results`，不调用对话模型。

### 回答风格

当前 [rag.ts](server/chat/rag.ts) 使用 `rag-fidelity-v1`，明确要求严格摘录、按原顺序输出，并限制合并、扩写和推断。回答偏向原文复述是当前提示词策略的结果。

需要分析和解释时，应调整提示词并评估回答依据与信息缺口。`RAG_SHOW_CITATIONS=false` 只影响引用展示，不关闭检索。Ollama 思考开关与摘录规则相互独立，开启思考不会自动解除提示词约束；原始思考内容不会返回前端。

## 可恢复聊天任务

适合页面刷新、断线后恢复答案展示：

1. `POST /api/chat/runs`：除聊天字段外，提供 `conversationId`、`turnId`、`sourceUserMessageId`、`assistantMessageId`；请求头 `Idempotency-Key` 必须等于 `turnId`。
2. 新建返回 202；相同幂等请求复用任务返回 200。客户端保存 `runId`。
3. `GET /api/chat/runs/:runId` 读取快照，`GET /api/chat/runs/:runId/events` 订阅 SSE。
4. 重连时用 `Last-Event-ID` 提交已收到的事件序号，重放后续事件。
5. `DELETE /api/chat/runs/:runId` 主动取消生成。

关闭页面或 SSE 只停止订阅，不取消后台生成。恢复展示不等于服务重启后继续推理：启动时遗留的活跃任务会被标记失败。模板默认保留终态任务 7 天，输出字符数和事件数也有上限。

## Agent

Agent 通过独立的 `POST /api/agent` 提供受控工具调用，不等同于 RAG 聊天。

- 配置 `AGENT_OLLAMA_MODELS`、`AGENT_OPENAI_MODELS`、`AGENT_ANTHROPIC_MODELS` 白名单。
- 模板 Ollama Agent 模型为 `qwen2.5:7b`，需要另行拉取。
- 云端 Agent 白名单默认为空，不开放相应模型。
- 超时、队列、工具结果长度、默认时区和调试结果开关见 `.env.example`。

Agent 使用 NDJSON 事件流。具体请求字段和校验规则以运行中的 Swagger 为准。

## 接口索引

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `POST /api/upload` | 入库 |
| `GET /api/upload/progress/:id` | 进度 SSE |
| `GET /api/files`、`GET /api/files/:id` | 文件列表和详情 |
| `DELETE /api/files/:id` | 删除指定文件 |
| `GET /api/search` | 检索调试 |
| `GET /api/vector-store/status` | 规模及兼容状态 |
| `POST /api/vector-store/reindex` | 重建 Qdrant 索引 |
| `POST /api/vector-store/reset` | 清空知识库 |
| `POST /api/chat/context`、`POST /api/chat` | RAG 预览和聊天 |
| `POST /api/chat/runs` | 创建生成任务 |
| `GET /api/chat/runs/:runId`、`GET /api/chat/runs/:runId/events` | 快照和事件 |
| `DELETE /api/chat/runs/:runId` | 取消生成 |
| `GET /api/providers`、`GET /api/tags` | 厂商及模型查询 |
| `POST /api/agent` | 可选 Agent |
| `GET /api/metrics/summary`、`GET /api/metrics/providers`、`GET /api/metrics/requests` | 调用指标 |
| `GET /api/metrics/compare/:compareId` | 调用对比 |
| `GET /api/metrics/dashboard` | 统计面板 |
| `GET /api/logs/summary`、`GET /api/logs/requests`、`GET /api/logs/errors` | 结构化日志 |
| `GET /api/logs/requests/:requestId` | 请求关联详情 |
| `GET /api/http-logs` | HTTP 日志兼容入口 |

重置接口要求 JSON `{"confirm":"RESET_VECTOR_STORE"}`，会清空知识库。完整字段和响应结构见 `/docs`。

## 存储与 Qdrant

| 模板路径 | 数据 |
| --- | --- |
| `server/data/vector-store.sqlite` | 文件、切块、向量和全文索引 |
| `server/data/observability.sqlite` | 请求、调用与应用事件 |
| `server/data/generation.sqlite` | 生成任务、答案与事件 |
| `server/data/uploads` | 原始上传图片 |

三类数据库必须使用不同路径。日志默认不保存问题预览或 IP；生成库会持久化答案，不应与日志脱敏策略混淆。

切换 Qdrant 时设置 `VECTOR_BACKEND=qdrant`、`QDRANT_URL` 及必要的密钥和集合配置，再通过 reindex 接口导入已有向量。SQLite 仍保存元数据和全文索引。SQLite 后端执行 reindex 会跳过。

更换 Embedding 模型后先检查 status 接口。Qdrant reindex 只重新写入已有向量，不会用新模型重新计算；模型或维度不兼容时需要重新入库。租户、项目和用户字段是预留配置，不代表已实现完整多用户权限隔离。

## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `npm run dev:server` | tsx watch 开发启动 |
| `npm run typecheck` | 静态检查 |
| `npm run verify` | 切块、去重、向量库和混合检索 |
| `npm run verify:http` | HTTP 接口 |
| `npm run verify:agent`、`npm run verify:agent:http` | Agent 逻辑和 HTTP |
| `npm run verify:generation` | 任务存储 |
| `npm run verify:generation:maintenance` | 恢复与清理 |
| `npm run verify:generation:service` | 后台生成服务 |
| `npm run verify:chat:runs`、`npm run verify:chat:sse` | 聊天任务与 SSE |
| `npm run verify:provider:abort` | 模型请求中止 |
| `npm run verify:observability` | 日志、迁移、查询与脱敏 |

`npm test` 仍是占位脚本，会失败。尚未提供生产 `build` 或 `start` 脚本。`verify` 使用临时目录中的独立 SQLite 库，无需默认停止业务服务。

自动验证不代替真实模型质量评估，RAG 应使用实际资料和固定问题做端到端检查。

## 目录结构

```text
server/
  index.ts              启动入口
  app.ts                路由、鉴权、CORS、Swagger 与生命周期
  router/               上传、聊天、任务、Agent、指标及日志接口
  chat/                 RAG、请求校验和任务执行
  generation/           持久化生成任务、SSE 和维护
  knowledge/            Qdrant 索引及知识库类型
  llm/                  模型适配与流式协议
  agent/                Agent 执行器、工具、会话与队列
  observability/        日志采集、脱敏、存储和查询
  utils/                配置、切块、Embedding、视觉与向量库
  scripts/              验证脚本
  dashboard.html        统计面板
  data/                 运行数据
docs/
  RAG_TEST_REPORT.md    历史评测
```

## 常见问题

- **回答只摘抄**：检查 context 接口的提示词，当前严格摘录策略限制了分析和扩写。
- **RAG 未启用**：检查 Embedding 服务、检索结果、分数阈值及自动门控；强制模式空结果也不注入材料。
- **响应慢**：区分检索与生成耗时，再检查硬件、模型大小、思考开关和超时。
- **日志或 Agent 返回 404**：检查功能开关及对应鉴权是否满足注册条件。
- **Ollama 连接失败**：确认服务已启动且模型存在；localhost 存在 IPv4/IPv6 差异时改为 `http://127.0.0.1:11434`。
- **端口占用**：用 `Get-NetTCPConnection -LocalPort 3001` 检查，或修改 `PORT` 后重启。
- **中文乱码**：PowerShell 读取文件时使用 `Get-Content -Encoding UTF8`，不要把错误解码的内容再次写回。

相关资料：[RAG 测试报告](docs/RAG_TEST_REPORT.md)、[图片知识库与前端对接说明](VISION_RAG_FRONTEND_DESIGN.md)。
