import { config } from '../utils/config'
import { fetchWithTimeout, parseSseTextDeltas, textDeltaStream } from './stream'
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

        const response = await fetchWithTimeout(`${config.openaiBaseUrl}/responses`, {
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

        return textDeltaStream(parseSseTextDeltas(response.body, event => {
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                return event.delta
            }

            return ''
        }))
    },
}

function normalizeOpenAiRole(role: string): string {
    if (role === 'assistant' || role === 'system' || role === 'developer') return role
    return 'user'
}
