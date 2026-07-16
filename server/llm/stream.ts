const encoder = new TextEncoder()

export function ndjsonLine(value: unknown): Uint8Array {
    return encoder.encode(`${JSON.stringify(value)}\n`)
}

export function chatTextLine(content: string): Uint8Array {
    return ndjsonLine({
        message: { role: 'assistant', content },
        done: false,
    })
}

export function chatDoneLine(): Uint8Array {
    return ndjsonLine({
        message: { role: 'assistant', content: '' },
        done: true,
    })
}

export function chatErrorLine(error: string): Uint8Array {
    return ndjsonLine({
        error,
        done: true,
    })
}

export function hideRagCitationsInUnifiedStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const citationFilter = new RagCitationFilter()
    let buffer = ''

    return new ReadableStream({
        async start(controller) {
            const emitFilteredText = (text: string) => {
                const filtered = citationFilter.push(text)
                if (filtered) controller.enqueue(chatTextLine(filtered))
            }

            const flushCitationFilter = () => {
                const remaining = citationFilter.flush()
                if (remaining) controller.enqueue(chatTextLine(remaining))
            }

            const handleLine = (line: string) => {
                if (!line.trim()) return

                const parsed = JSON.parse(line) as {
                    message?: { content?: string }
                    done?: boolean
                    error?: string
                }

                if (parsed.message?.content) emitFilteredText(parsed.message.content)
                if (parsed.error) controller.enqueue(chatErrorLine(parsed.error))
                if (parsed.done) {
                    flushCitationFilter()
                    controller.enqueue(chatDoneLine())
                }
            }

            try {
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break

                    buffer += decoder.decode(value, { stream: true })
                    const lines = buffer.split('\n')
                    buffer = lines.pop() ?? ''

                    for (const line of lines) handleLine(line)
                }

                buffer += decoder.decode()
                if (buffer.trim()) handleLine(buffer)
                flushCitationFilter()
                controller.close()
            } catch (err) {
                controller.enqueue(chatErrorLine(err instanceof Error ? err.message : 'Citation filter failed'))
                controller.close()
            } finally {
                reader.releaseLock()
            }
        },
    })
}

class RagCitationFilter {
    private pendingBracket = ''

    push(text: string): string {
        let output = ''

        for (const char of text) {
            if (!this.pendingBracket) {
                if (char === '[') {
                    this.pendingBracket = char
                } else {
                    output += char
                }
                continue
            }

            this.pendingBracket += char

            const headingIndex = this.findMarkdownHeadingIndex()
            if (headingIndex >= 0) {
                output += this.pendingBracket.slice(headingIndex)
                this.pendingBracket = ''
                continue
            }

            if (char === ']') {
                if (!this.isCitationMarker(this.pendingBracket)) output += this.pendingBracket
                this.pendingBracket = ''
                continue
            }

            if (char === '\n') {
                if (this.isCitationMarker(this.pendingBracket)) {
                    output += '\n'
                } else {
                    output += this.pendingBracket
                }
                this.pendingBracket = ''
                continue
            }

            if (this.pendingBracket.length > 500) {
                output += this.pendingBracket
                this.pendingBracket = ''
            }
        }

        return output
    }

    flush(): string {
        const remaining = this.isCitationMarker(this.pendingBracket) ? '' : this.pendingBracket
        this.pendingBracket = ''
        return remaining
    }

    private isCitationMarker(value: string): boolean {
        return /(?:\.md\b|\bchunk\s*(?:[=,:]\s*)?\d+\b|\bsource\s*:)/i.test(value)
    }

    private findMarkdownHeadingIndex(): number {
        if (!this.isCitationMarker(this.pendingBracket)) return -1

        const match = /#{2,6}\s/.exec(this.pendingBracket)
        return match?.index ?? -1
    }
}

export function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    return fetch(url, {
        ...init,
        signal: controller.signal,
    }).finally(() => clearTimeout(timeout))
}

export function textDeltaStream(source: AsyncIterable<string>): ReadableStream<Uint8Array> {
    return new ReadableStream({
        async start(controller) {
            try {
                for await (const delta of source) {
                    if (delta) controller.enqueue(chatTextLine(delta))
                }

                controller.enqueue(chatDoneLine())
                controller.close()
            } catch (err) {
                controller.enqueue(chatErrorLine(err instanceof Error ? err.message : 'LLM stream failed'))
                controller.close()
            }
        },
    })
}

export interface SseJsonStreamHandlers {
    extractDelta(event: Record<string, unknown>): string
    isDone?(event: Record<string, unknown>): boolean
    extractError?(event: Record<string, unknown>): string | undefined
}

export function sseJsonToUnifiedStream(
    stream: ReadableStream<Uint8Array>,
    handlers: SseJsonStreamHandlers,
    fallbackError = 'LLM stream failed'
): ReadableStream<Uint8Array> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let doneSent = false

    const sendDone = (controller: ReadableStreamDefaultController<Uint8Array>) => {
        if (doneSent) return
        doneSent = true
        controller.enqueue(chatDoneLine())
    }

    const handleEventBlock = (block: string, controller: ReadableStreamDefaultController<Uint8Array>) => {
        const dataLines = block
            .split('\n')
            .map(line => line.replace(/\r$/, ''))
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice('data:'.length).trimStart())

        if (dataLines.length === 0) return

        const data = dataLines.join('\n').trim()
        if (!data) return

        if (data === '[DONE]') {
            sendDone(controller)
            return
        }

        const parsed = JSON.parse(data) as Record<string, unknown>
        const error = handlers.extractError?.(parsed)
        if (error) {
            controller.enqueue(chatErrorLine(error))
            return
        }

        const delta = handlers.extractDelta(parsed)
        if (delta) controller.enqueue(chatTextLine(delta))
        if (handlers.isDone?.(parsed)) sendDone(controller)
    }

    return new ReadableStream({
        async start(controller) {
            try {
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break

                    buffer += decoder.decode(value, { stream: true })
                    const parts = buffer.split(/\r?\n\r?\n/)
                    buffer = parts.pop() ?? ''

                    for (const part of parts) {
                        handleEventBlock(part, controller)
                    }
                }

                buffer += decoder.decode()
                if (buffer.trim()) handleEventBlock(buffer, controller)

                sendDone(controller)
                controller.close()
            } catch (err) {
                controller.enqueue(chatErrorLine(err instanceof Error ? err.message : fallbackError))
                controller.close()
            } finally {
                reader.releaseLock()
            }
        },
    })
}

export async function* parseSseTextDeltas(
    stream: ReadableStream<Uint8Array>,
    extract: (event: Record<string, unknown>) => string
): AsyncIterable<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const parseEventBlock = function* (part: string): Iterable<string> {
        const dataLines = part
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice('data:'.length).trim())

        for (const data of dataLines) {
            if (!data || data === '[DONE]') continue
            const parsed = JSON.parse(data) as Record<string, unknown>
            const delta = extract(parsed)
            if (delta) yield delta
        }
    }

    while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
            yield* parseEventBlock(part)
        }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
        yield* parseEventBlock(buffer)
    }
}
