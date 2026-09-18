import { fetchWithTimeout } from '../llm/stream'
import { isChatProviderTimeout } from '../chat/errors'

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
    try {
        await action()
    } catch (error) {
        return error
    }
    throw new Error('Expected operation to fail')
}

async function main() {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0

    try {
        globalThis.fetch = async (_input, init) => {
            fetchCalls += 1
            const signal = init?.signal
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
                },
            })
            return new Response(body, { status: 200 })
        }

        const preCancelled = new AbortController()
        preCancelled.abort(new DOMException('cancelled', 'AbortError'))
        const preCancelledError = await captureError(() => fetchWithTimeout(
            'http://provider.test/pre-cancelled',
            {},
            1000,
            preCancelled.signal,
        ))
        assert(preCancelledError === preCancelled.signal.reason, 'pre-cancel reason should be preserved')
        assert(fetchCalls === 0, 'pre-cancelled request should not call fetch')

        const inFlight = new AbortController()
        const inFlightResponse = await fetchWithTimeout(
            'http://provider.test/in-flight',
            {},
            1000,
            inFlight.signal,
        )
        const inFlightReader = inFlightResponse.body!.getReader()
        const inFlightRead = inFlightReader.read()
        inFlight.abort(new DOMException('cancelled', 'AbortError'))
        const inFlightError = await captureError(() => inFlightRead)
        assert(inFlightError === inFlight.signal.reason, 'in-flight cancel should abort response reader')

        const timeoutResponse = await fetchWithTimeout(
            'http://provider.test/timeout',
            {},
            20,
        )
        const timeoutError = await captureError(() => timeoutResponse.body!.getReader().read())
        assert(timeoutError instanceof DOMException && timeoutError.name === 'TimeoutError', 'timeout should cover stream reading')

        globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        const completedResponse = await fetchWithTimeout('http://provider.test/completed', {}, 1000)
        const completed = await completedResponse.arrayBuffer()
        assert(completed.byteLength === 3, 'completed response body should pass through')

        const headersTimeout = new TypeError('fetch failed', {
            cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
        })
        assert(isChatProviderTimeout(headersTimeout), 'nested Undici headers timeout should be classified as timeout')

        console.log(JSON.stringify({
            ok: true,
            checks: ['pre-cancel', 'in-flight-cancel', 'stream-timeout', 'normal-completion', 'headers-timeout-classification'],
        }))
    } finally {
        globalThis.fetch = originalFetch
    }
}

void main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
