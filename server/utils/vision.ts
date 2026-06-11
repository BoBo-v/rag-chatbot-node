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

export async function parseImageWithVision(buffer: Buffer, mimeType: string): Promise<VisionParseResult> {
    if (!isSupportedImageMime(mimeType)) {
        throw new Error(`Unsupported image mime type: ${mimeType}`)
    }

    const response = await fetchWithTimeout(`${config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: config.visionModel,
            stream: false,
            think: false,
            keep_alive: 0,
            messages: [
                {
                    role: 'user',
                    content: visionPrompt,
                    images: [buffer.toString('base64')],
                },
            ],
        }),
    }, config.ollamaTimeoutMs)

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || `Vision model failed: ${response.status}`)
    }

    const data = await response.json() as {
        message?: { content?: string }
        response?: string
        error?: string
    }

    if (data.error) throw new Error(data.error)

    const rawText = data.message?.content || data.response || ''
    const markdown = rawText.trim()
    if (!markdown) throw new Error('Vision model returned empty text')

    return {
        model: config.visionModel,
        markdown,
        rawText,
    }
}

export function isSupportedImageMime(mimeType: string): boolean {
    return ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    return fetch(url, {
        ...init,
        signal: controller.signal,
    }).finally(() => clearTimeout(timeout))
}
