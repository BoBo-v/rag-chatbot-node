import { config } from '../utils/config'
import { chatDoneLine, chatErrorLine, chatTextLine, fetchWithTimeout } from './stream'
import type { ChatProviderClient, ChatProviderInfo, ChatStreamInput } from './types'

export const ollamaProvider: ChatProviderClient = {
    info(): ChatProviderInfo {
        return {
            id: 'ollama',
            name: 'Ollama',
            defaultModel: config.defaultModel,
            configured: true,
        }
    },

    async streamChat(input: ChatStreamInput): Promise<ReadableStream<Uint8Array>> {
        const response = await fetchWithTimeout(`${config.ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: input.model || config.defaultModel,
                messages: input.messages,
                stream: true,
            }),
        }, config.ollamaTimeoutMs)

        if (!response.ok || !response.body) {
            const errText = await response.text()
            throw new Error(errText || `Ollama chat failed: ${response.status}`)
        }

        return ollamaNdjsonToUnifiedStream(response.body)
    },
}

export function ollamaNdjsonToUnifiedStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let doneSent = false

    const sendDone = (controller: ReadableStreamDefaultController<Uint8Array>) => {
        if (doneSent) return
        doneSent = true
        controller.enqueue(chatDoneLine())
    }

    return new ReadableStream({
        async start(controller) {
            try {
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break

                    buffer += decoder.decode(value, { stream: true })
                    const lines = buffer.split('\n')
                    buffer = lines.pop() ?? ''

                    for (const line of lines) {
                        if (!line.trim()) continue
                        const parsed = JSON.parse(line) as {
                            message?: { content?: string }
                            done?: boolean
                        }

                        const delta = parsed.message?.content
                        if (delta) controller.enqueue(chatTextLine(delta))
                        if (parsed.done) sendDone(controller)
                    }
                }

                if (buffer.trim()) {
                    const parsed = JSON.parse(buffer) as { message?: { content?: string }; done?: boolean }
                    if (parsed.message?.content) controller.enqueue(chatTextLine(parsed.message.content))
                    if (parsed.done) sendDone(controller)
                }

                sendDone(controller)
                controller.close()
            } catch (err) {
                controller.enqueue(chatErrorLine(err instanceof Error ? err.message : 'Ollama stream failed'))
                controller.close()
            }
        },
    })
}
