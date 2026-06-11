# 图片知识库与前端对接思路

## 当前后端能力

后端现在的图片知识库流程是：

1. 前端上传 `txt`、`md`、`pdf`、`png`、`jpg`、`jpeg`、`webp`。
2. 普通文本/PDF 直接解析成文本。
3. 图片先保存原文件，再调用本地视觉模型 `VISION_MODEL`，默认 `qwen3-vl:2b`。
4. 视觉模型把图片内容识别、翻译、整理成 Markdown。
5. Markdown 进入现有 RAG 流程：切块、embedding、写入 SQLite 向量库和全文索引。
6. 聊天接口用 `rag: "auto" | true | false` 控制是否注入知识库资料。

也就是说，前端不用直接理解视觉模型，只需要按文件上传接口处理即可。

## 前端需要接的接口

### 1. 上传知识库文件

`POST /api/upload`

请求：

- `multipart/form-data`
- 字段：`file`
- query：
  - `overwrite=true | false`
  - `progressId=前端生成的ID`

返回：

- `file`：入库文件元数据
- `chunks`：解析后的文本分块
- `deduplicated`：是否命中重复文件
- `overwritten`：是否覆盖旧记录

图片上传时，接口耗时会明显变长，因为中间要跑 VL 模型。

### 2. 上传进度

`GET /api/upload/progress/:progressId`

这是 SSE。前端上传前先生成一个 `progressId`，同时打开 EventSource，再把同一个 `progressId` 传给 `/api/upload`。

进度字段：

- `phase`：`receiving | parsing | chunking | embedding | storing | completed | failed`
- `percent`：0-100
- `message`：中文状态信息
- `done`：是否结束
- `error`：失败码

图片入库时，重点展示 `parsing` 阶段，因为这里会等待视觉模型。

### 3. 文件列表和详情

- `GET /api/files`
- `GET /api/files/:id`
- `DELETE /api/files/:id`

前端建议展示：

- 文件名
- MIME 类型
- 大小
- 字符数
- chunk 数
- embedding 模型和维度
- 创建时间
- 详情里的 chunk 文本预览

### 4. 向量库状态

`GET /api/vector-store/status`

用于展示：

- 当前 embedding 模型
- 文件数量
- chunk 数量
- 是否需要重建索引：`needsReindex`
- 是否存在旧模型或旧维度的 chunk

如果 `needsReindex=true`，前端应该提示用户重新整理知识库。

### 5. RAG 检索调试

`GET /api/search?q=...&topK=5&minScore=0.2`

用于前端调试“这个问题会命中哪些资料”。

建议展示：

- 命中文件名
- chunkIndex
- 综合分 `score`
- 向量分 `vectorScore`
- 关键词分 `keywordScore`
- chunk 文本

这个页面对排查“为什么模型没有引用知识库”很关键。

### 6. 聊天接口

`POST /api/chat`

请求体示例：

```json
{
  "provider": "ollama",
  "model": "qwen3:8b",
  "rag": "auto",
  "messages": [
    { "role": "user", "content": "根据知识库回答这个问题" }
  ]
}
```

返回是按行输出的 JSON 流。前端需要逐行解析：

- `message.content`：增量文本
- `error`：流式错误
- `done`：结束

### 7. RAG 上下文预览

`POST /api/chat/context`

请求体和 `/api/chat` 类似，但不会调用模型，只返回后端准备注入的 RAG 上下文。

建议前端在调试模式里提供这个入口。

## 前端页面建议

如果你有独立前端项目，建议先做 4 个模块：

1. 知识库管理
   - 文件上传
   - 上传进度
   - 文件列表
   - 文件详情
   - 删除文件

2. 图片入库反馈
   - 上传图片后显示“正在识别图片”
   - 展示识别后的 Markdown/chunk 预览
   - 明确提示这一步可能很慢

3. 检索调试
   - 输入问题
   - 查看命中的资料
   - 展示分数和片段

4. 聊天调试
   - 选择 provider/model
   - RAG 模式：自动、强制、关闭
   - 流式回答
   - 错误展示
   - 可解释信息：是否启用 RAG、命中文件、chunk 分数

## 不建议返回完整思维链

前端不需要展示模型完整思维链。生产级更建议展示“可解释信息”：

- 本次是否启用 RAG
- 命中了哪些文件
- 每个 chunk 的分数
- 注入了多少字符上下文
- 模型、耗时、错误信息

这能解释系统行为，又不会把模型内部推理过程暴露出来。

## 后续功能方向

1. 图片伴随聊天提问
   - 前端聊天框支持图片。
   - 后端先用 VL 模型临时识别图片。
   - 再把“图片识别文本 + 用户问题”交给 8B 文本模型。
   - 这种图片不一定入库，适合一次性问答。

2. 后台任务化
   - 图片识别很慢，后续可以把上传入库改成任务队列。
   - 前端拿 `taskId` 轮询或 SSE 订阅。
   - 支持取消、重试、失败重跑。

3. 解析结果版本管理
   - 原图保留。
   - 视觉模型输出的 Markdown 单独保存。
   - 以后换模型后可以重新解析原图，不需要用户重新上传。

4. 批量入库
   - 适合大量截图、扫描件、说明书图片。
   - 前端展示队列、成功数、失败数、平均耗时。
