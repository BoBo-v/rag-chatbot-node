import { config } from './config'

export interface VisionParseResult {
    model: string
    markdown: string
    rawText: string
}

const visionPrompt = [
    '你是本地知识库的图片解析器。',
    '请读取图片中的文字、表格、代码、标题、图注和关键信息。',
    '输出可用于 RAG 检索的 Markdown。',
    '要求：',
    '1. 保留原始关键信息，不要编造图片中不存在的内容。',
    '2. 如果图片包含英文或其他语言，请翻译成中文，并保留重要英文术语。',
    '3. 表格尽量输出 Markdown 表格。',
    '4. 代码截图保持代码块格式。',
    '5. 看不清或无法确认的内容标注为“无法确认”。',
].join('\n')

const visionRetryPrompt = [
    '请识别图片中的可见文字和关键信息。',
    '只输出最终 Markdown 文本，不要解释过程。',
    '如果没有可识别内容，输出：无法确认。',
].join('\n')

interface OllamaVisionResponse {
    message?: { content?: string }
    response?: string
    thinking?: string
    error?: string
}

export async function parseImageWithVision(buffer: Buffer, mimeType: string): Promise<VisionParseResult> {
    if (!isSupportedImageMime(mimeType)) {
        throw new Error(`Unsupported image mime type: ${mimeType}`)
    }

    const primary = await callVisionGenerate(buffer, visionPrompt)
    const primaryText = extractVisionText(primary)
    const retry = primaryText ? null : await callVisionGenerate(buffer, visionRetryPrompt)
    const rawText = primaryText || extractVisionText(retry)
    const markdown = rawText.trim()

    if (!markdown) {
        throw new Error(`Vision model returned empty text; response=${summarizeVisionResponse(retry ?? primary)}`)
    }

    return {
        model: config.visionModel,
        markdown,
        rawText,
    }
}

export function isSupportedImageMime(mimeType: string): boolean {
    return ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
}

async function callVisionGenerate(buffer: Buffer, prompt: string): Promise<OllamaVisionResponse> {
    const response = await fetchWithTimeout(`${config.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: config.visionModel,
            stream: false,
            think: false,
            keep_alive: '0s',
            prompt,
            images: [buffer.toString('base64')],
        }),
    }, config.ollamaTimeoutMs)

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || `Vision model failed: ${response.status}`)
    }

    const data = await response.json() as OllamaVisionResponse

    if (data.error) throw new Error(data.error)
    return data
}

function extractVisionText(data: OllamaVisionResponse | null): string {
    return (data?.response || data?.message?.content || '').trim()
}

function summarizeVisionResponse(data: OllamaVisionResponse): string {
    return JSON.stringify({
        responseLength: data.response?.length ?? 0,
        messageContentLength: data.message?.content?.length ?? 0,
        thinkingLength: data.thinking?.length ?? 0,
        thinkingPreview: data.thinking?.trim().slice(0, 160),
    })
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    return fetch(url, {
        ...init,
        signal: controller.signal,
    }).finally(() => clearTimeout(timeout))
}
