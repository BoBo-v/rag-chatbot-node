import { config } from '../utils/config'
import { Agent } from 'undici'
import { chatDoneLine, chatErrorLine, chatTextLine, fetchWithTimeout } from './stream'
import type { ChatProviderClient, ChatProviderInfo, ChatStreamInput } from './types'

const ollamaDispatcher = new Agent({
    headersTimeout: config.ollamaTimeoutMs,
    bodyTimeout: config.ollamaTimeoutMs,
})

/** Error returned by Ollama before a response stream can be created. */
export class OllamaProviderError extends Error {
    readonly statusCode: number
    readonly responseBody: string

    constructor(statusCode: number, responseBody: string) {
        const detail = responseBody.trim() || 'empty response body'
        super(`Ollama HTTP ${statusCode}: ${detail}`)
        this.name = 'OllamaProviderError'
        this.statusCode = statusCode
        this.responseBody = detail
    }
}

export const ollamaProvider: ChatProviderClient = {
    info(): ChatProviderInfo {
        return {
            id: 'ollama',
            name: 'Ollama',
            defaultModel: config.defaultModel,
            configured: true,
        }
    },

    async streamChat(input: ChatStreamInput, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
        const response = await fetchWithTimeout(`${config.ollamaUrl}/api/chat`, {
            dispatcher: ollamaDispatcher,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: input.model || config.defaultModel,
                messages: input.messages,
                stream: true,
                think: config.ollamaThinkingEnabled,
                options: {
                    num_ctx: 8192
                }
            }),
        }, config.ollamaTimeoutMs, signal)

        if (!response.ok || !response.body) {
            const errText = await response.text()
            throw new OllamaProviderError(response.status, extractOllamaError(errText))
        }

        return ollamaNdjsonToUnifiedStream(response.body)
    },
}

function extractOllamaError(body: string): string {
    const trimmed = body.trim()
    if (!trimmed) return ''

    try {
        const parsed = JSON.parse(trimmed) as { error?: unknown }
        if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim().slice(0, 2_000)
    } catch {
        // Ollama may return plain text for proxy or service errors.
    }
    return trimmed.slice(0, 2_000)
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
                            error?: string
                        }

                        if (parsed.error) {
                            controller.enqueue(chatErrorLine(parsed.error))
                            sendDone(controller)
                            continue
                        }
                        const delta = parsed.message?.content
                        if (delta) controller.enqueue(chatTextLine(delta))
                        if (parsed.done) sendDone(controller)
                    }
                }

                if (buffer.trim()) {
                    const parsed = JSON.parse(buffer) as { message?: { content?: string }; done?: boolean; error?: string }
                    if (parsed.error) {
                        controller.enqueue(chatErrorLine(parsed.error))
                        sendDone(controller)
                    }
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
