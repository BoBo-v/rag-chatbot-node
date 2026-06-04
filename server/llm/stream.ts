const encoder = new TextEncoder()

export function ndjsonLine(value: unknown): Uint8Array {
    return encoder.encode(`${JSON.stringify(value)}\n`)
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
                    if (delta) controller.enqueue(ndjsonLine({ type: 'text', delta }))
                }

                controller.enqueue(ndjsonLine({ type: 'done' }))
                controller.close()
            } catch (err) {
                controller.enqueue(ndjsonLine({
                    type: 'error',
                    error: err instanceof Error ? err.message : 'LLM stream failed',
                }))
                controller.close()
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
