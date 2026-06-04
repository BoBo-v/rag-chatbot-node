import { config } from '../utils/config'
import { fetchWithTimeout, sseJsonToUnifiedStream } from './stream'
import type { ChatProviderClient, ChatProviderInfo, ChatStreamInput } from './types'

export const openaiProvider: ChatProviderClient = {
    info(): ChatProviderInfo {
        return {
            id: 'openai',
            name: 'OpenAI',
            defaultModel: config.openaiDefaultModel,
            configured: Boolean(config.openaiApiKey),
        }
    },

    async streamChat(input: ChatStreamInput): Promise<ReadableStream<Uint8Array>> {
        if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not configured')

        const response = await fetchWithTimeout(openAiResponsesUrl(config.openaiBaseUrl), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.openaiApiKey}`,
            },
            body: JSON.stringify({
                model: input.model || config.openaiDefaultModel,
                input: input.messages.map(message => ({
                    role: normalizeOpenAiRole(message.role),
                    content: message.content,
                })),
                stream: true,
            }),
        }, config.ollamaTimeoutMs)

        if (!response.ok || !response.body) {
            const errText = await response.text()
            throw new Error(errText || `OpenAI response failed: ${response.status}`)
        }

        return sseJsonToUnifiedStream(response.body, {
            extractDelta(event) {
                if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                    return event.delta
                }

                return ''
            },
            isDone(event) {
                return event.type === 'response.completed'
            },
            extractError(event) {
                if (event.type !== 'response.failed' && event.type !== 'error') return undefined

                const error = event.error as { message?: string } | undefined
                return error?.message || 'OpenAI stream failed'
            },
        }, 'OpenAI stream failed')
    },
}

function openAiResponsesUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/$/, '')
    return normalized.endsWith('/responses') ? normalized : `${normalized}/responses`
}

function normalizeOpenAiRole(role: string): string {
    if (role === 'assistant' || role === 'system' || role === 'developer') return role
    return 'user'
}
