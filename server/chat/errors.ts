import { safeErrorMessage } from '../observability/privacy'
import { AppError } from '../utils/errors'

export function classifyChatProviderError(error: unknown): AppError {
    const message = error instanceof Error ? error.message : ''
    const detail = safeErrorMessage(error)

    if (message.includes('OPENAI_API_KEY is not configured')) {
        return new AppError(400, 'OPENAI_NOT_CONFIGURED', 'OpenAI 未配置，请先在后端 .env 设置 OPENAI_API_KEY。')
    }
    if (message.includes('ANTHROPIC_API_KEY is not configured')) {
        return new AppError(400, 'ANTHROPIC_NOT_CONFIGURED', 'Claude 未配置，请先在后端 .env 设置 ANTHROPIC_API_KEY。')
    }
    if (isChatProviderTimeout(error)) {
        return new AppError(502, 'MODEL_PROVIDER_TIMEOUT', `模型厂商响应超时：${detail}`)
    }
    if (message.includes('fetch failed') || message.includes('aborted') || message.includes('Failed to fetch')) {
        return new AppError(502, 'MODEL_PROVIDER_UNAVAILABLE', `模型厂商服务不可用：${detail}`)
    }
    return new AppError(502, 'MODEL_PROVIDER_FAILED', `模型厂商返回错误：${detail}`)
}

export function isChatProviderTimeout(error: unknown): boolean {
    return errorChainContainsTimeout(error)
}

function errorChainContainsTimeout(error: unknown, depth = 0): boolean {
    if (!(error instanceof Error) || depth > 3) return false
    const typed = error as Error & { cause?: unknown; code?: unknown }
    return error.name === 'TimeoutError'
        || (typeof typed.code === 'string' && /TIMEOUT/i.test(typed.code))
        || /timed?\s*out|timeout/i.test(error.message)
        || errorChainContainsTimeout(typed.cause, depth + 1)
}
