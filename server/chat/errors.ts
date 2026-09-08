import { AppError } from '../utils/errors'

export function classifyChatProviderError(error: unknown): AppError {
    const message = error instanceof Error ? error.message : ''

    if (message.includes('OPENAI_API_KEY is not configured')) {
        return new AppError(400, 'OPENAI_NOT_CONFIGURED', 'OpenAI 未配置，请先在后端 .env 设置 OPENAI_API_KEY。')
    }
    if (message.includes('ANTHROPIC_API_KEY is not configured')) {
        return new AppError(400, 'ANTHROPIC_NOT_CONFIGURED', 'Claude 未配置，请先在后端 .env 设置 ANTHROPIC_API_KEY。')
    }
    if (isChatProviderTimeout(error)) {
        return new AppError(502, 'MODEL_PROVIDER_TIMEOUT', '模型厂商响应超时，请稍后重试或调整模型超时配置。')
    }
    if (message.includes('fetch failed') || message.includes('aborted') || message.includes('Failed to fetch')) {
        return new AppError(502, 'MODEL_PROVIDER_UNAVAILABLE', '模型厂商服务调用失败，请检查厂商配置、网络连接或本地 Ollama 状态。')
    }
    return new AppError(502, 'MODEL_PROVIDER_FAILED', '模型厂商返回错误，请查看后端日志中的上游错误详情。')
}

export function isChatProviderTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(error.message)
}
