import { config } from '../utils/config'
import { fetchWithTimeout, parseSseTextDeltas, textDeltaStream } from './stream'
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
        const response = await fetchWithTimeout(`${config.anthropicBaseUrl}/v1/messages`, {
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

        return textDeltaStream(parseSseTextDeltas(response.body, event => {
            const delta = event.delta as { type?: string; text?: string } | undefined
            if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
                return delta.text
            }

            return ''
        }))
    },
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
