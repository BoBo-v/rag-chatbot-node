import { config } from '../utils/config'
import { fetchWithTimeout, sseJsonToUnifiedStream } from './stream'
import type { ChatMessage, ChatProviderClient, ChatProviderInfo, ChatStreamInput } from './types'

export const anthropicProvider: ChatProviderClient = {
    info(): ChatProviderInfo {
        return {
            id: 'anthropic',
            name: 'Anthropic Claude',
            defaultModel: config.anthropicDefaultModel,
            configured: Boolean(config.anthropicApiKey),
        }
    },

    async streamChat(input: ChatStreamInput): Promise<ReadableStream<Uint8Array>> {
        if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured')

        const { system, messages } = splitSystemMessages(input.messages)
        const response = await fetchWithTimeout(anthropicMessagesUrl(config.anthropicBaseUrl), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.anthropicApiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: input.model || config.anthropicDefaultModel,
                max_tokens: 4096,
                system: system || undefined,
                messages,
                stream: true,
            }),
        }, config.ollamaTimeoutMs)

        if (!response.ok || !response.body) {
            const errText = await response.text()
            throw new Error(errText || `Anthropic response failed: ${response.status}`)
        }

        return sseJsonToUnifiedStream(response.body, {
            extractDelta(event) {
                const delta = event.delta as { type?: string; text?: string } | undefined
                if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
                    return delta.text
                }

                return ''
            },
            isDone(event) {
                return event.type === 'message_stop'
            },
            extractError(event) {
                if (event.type !== 'error') return undefined

                const error = event.error as { message?: string } | undefined
                return error?.message || 'Anthropic stream failed'
            },
        }, 'Anthropic stream failed')
    },
}

function anthropicMessagesUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/$/, '')
    return normalized.endsWith('/messages') ? normalized : `${normalized}/v1/messages`
}

function splitSystemMessages(messages: ChatMessage[]): {
    system: string
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
} {
    const system: string[] = []
    const result: Array<{ role: 'user' | 'assistant'; content: string }> = []

    for (const message of messages) {
        if (message.role === 'system') {
            system.push(message.content)
            continue
        }

        result.push({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: message.content,
        })
    }

    return {
        system: system.join('\n\n'),
        messages: result,
    }
}
