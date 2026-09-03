import { AgentError, isAgentError } from '../agent/errors'

const maxAgentResponseChars = 2_000_000

export async function fetchAgentJson<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    providerName: string,
): Promise<T> {
    const callerSignal = init.signal
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
        timeoutController.abort(new AgentError(
            'MODEL_TIMEOUT',
            `${providerName} Agent model request timed out.`,
            504,
        ))
    }, timeoutMs)
    const signal = callerSignal
        ? AbortSignal.any([callerSignal, timeoutController.signal])
        : timeoutController.signal

    try {
        throwIfAborted(signal)
        const response = await fetch(url, { ...init, signal })
        const body = await response.text()

        if (!response.ok) {
            throw new AgentError(
                'MODEL_PROVIDER_FAILED',
                `${providerName} Agent model request failed (HTTP ${response.status}).`,
                502,
                { cause: new Error(`HTTP ${response.status}: ${body.slice(0, 1000)}`) },
            )
        }
        if (body.length > maxAgentResponseChars) {
            throw new AgentError(
                'MODEL_RESPONSE_INVALID',
                `${providerName} Agent response is too large.`,
                502,
            )
        }

        try {
            return JSON.parse(body) as T
        } catch (error) {
            throw new AgentError(
                'MODEL_RESPONSE_INVALID',
                `${providerName} Agent returned invalid JSON.`,
                502,
                { cause: error },
            )
        }
    } catch (error) {
        if (signal.aborted) throw abortReason(signal)
        if (isAgentError(error)) throw error
        throw new AgentError(
            'MODEL_PROVIDER_FAILED',
            `${providerName} Agent model request failed.`,
            502,
            { cause: error },
        )
    } finally {
        clearTimeout(timeout)
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): AgentError {
    if (isAgentError(signal.reason)) return signal.reason
    return new AgentError('CLIENT_ABORTED', 'Agent request was cancelled by the client.', 499)
}
