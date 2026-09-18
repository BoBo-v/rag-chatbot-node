import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../utils/config'
import { getChatProvider, type ChatProviderId } from '../llm'
import { hideRagCitationsInUnifiedStream } from '../llm/stream'
import { computeCost, parsePricingFromEnv } from '../utils/pricing'
import { estimateTokens } from '../utils/tokenEstimator'
import { recordAiRequest, recordApplicationEvent } from '../observability/collector'
import { safeErrorMessage } from '../observability/privacy'
import { GenerationExecutionAbort, type GenerationRunService } from '../generation/service'
import { buildRagContext, ragPromptVersion, toSearchResultResponse } from './rag'
import { classifyChatProviderError, isChatProviderTimeout } from './errors'
import type { ChatRunRequestBody } from './types'

const pricingTable = parsePricingFromEnv(process.env.PRICING_TABLE || '')

export interface ExecuteChatRunInput {
    runId: string
    requestId: string
    body: ChatRunRequestBody
    providerId: ChatProviderId
    model: string
    generationRuns: GenerationRunService
    logger: FastifyBaseLogger
}

export async function executeChatRun(input: ExecuteChatRunInput, signal: AbortSignal): Promise<void> {
    const startedAt = new Date().toISOString()
    const requestStart = performance.now()
    const aiInvocationId = randomUUID()
    let messages = [...input.body.messages]
    let ragEnabled = false
    let ragMode = 'auto'
    let ragTopK = config.ragTopK
    let ragMinScore = config.ragMinScore
    let ragHitCount = 0
    let ragBestScore: number | null = null
    let ragPromptChars = 0
    let outputChars = 0
    let inputChars: number | null = null

    try {
        input.generationRuns.appendEvent(input.runId, {
            eventType: 'run_started',
            data: { provider: input.providerId, model: input.model },
            transitionTo: 'running',
        })

        const context = await buildRagContext(input.body)
        signal.throwIfAborted()
        ragEnabled = context.enabled
        ragMode = context.mode
        ragTopK = context.topK
        ragMinScore = context.minScore
        ragHitCount = context.results.length
        ragBestScore = context.bestScore
        ragPromptChars = context.prompt.length

        input.generationRuns.appendEvent(input.runId, {
            eventType: 'rag_context',
            data: {
                enabled: context.enabled,
                mode: context.mode,
                topK: context.topK,
                minScore: context.minScore,
                citations: context.results.map(toSearchResultResponse),
            },
        })

        if (context.prompt) {
            messages = [{ role: 'system', content: context.prompt }, ...messages]
        }
        inputChars = messages.reduce((sum, message) => sum + message.content.length, 0)

        const provider = getChatProvider(input.providerId)
        const providerStream = await provider.streamChat({ model: input.model, messages }, signal)
        const stream = ragEnabled && !config.ragShowCitations
            ? hideRagCitationsInUnifiedStream(providerStream)
            : providerStream
        outputChars = await persistUnifiedChatStream(input.runId, stream, input.generationRuns)
        signal.throwIfAborted()

        input.generationRuns.appendEvent(input.runId, {
            eventType: 'run_completed',
            data: { finishReason: 'stop' },
            transitionTo: 'completed',
        })
        recordRunMetric(input, {
            aiInvocationId,
            startedAt,
            requestStart,
            messages,
            inputChars,
            outputChars,
            status: 'success',
            errorCode: null,
            errorMessage: null,
            isTimeout: false,
            ragEnabled,
            ragMode,
            ragTopK,
            ragMinScore,
            ragHitCount,
            ragBestScore,
            ragPromptChars,
        })
    } catch (error) {
        const aborted = signal.aborted && signal.reason instanceof GenerationExecutionAbort
            ? signal.reason
            : null
        const providerError = aborted
            ? { code: aborted.code, message: aborted.message, statusCode: aborted.code === 'CLIENT_ABORTED' ? 499 : 503 }
            : classifyChatProviderError(error)
        const cancelled = aborted?.code === 'CLIENT_ABORTED'

        input.generationRuns.appendEvent(input.runId, {
            eventType: cancelled ? 'run_cancelled' : 'run_failed',
            data: { code: providerError.code, message: providerError.message },
            transitionTo: cancelled ? 'cancelled' : 'failed',
            errorCode: providerError.code,
            errorMessage: providerError.message,
        })
        const logContext = {
            err: error,
            event: 'chat.run.failed',
            errorCode: providerError.code,
            runId: input.runId,
            requestId: input.requestId,
            upstreamError: safeErrorMessage(error),
        }
        if (cancelled) input.logger.warn(logContext)
        else input.logger.error(logContext)
        recordApplicationEvent({
            requestId: input.requestId,
            level: cancelled ? 'warn' : 'error',
            eventType: cancelled ? 'chat.run.cancelled' : 'chat.run.failed',
            module: 'chat',
            operation: 'generation_run',
            statusCode: providerError.statusCode,
            errorCode: providerError.code,
            message: providerError.message,
            context: {
                runId: input.runId,
                provider: input.providerId,
                model: input.model,
                upstreamError: safeErrorMessage(error),
            },
        })
        recordRunMetric(input, {
            aiInvocationId,
            startedAt,
            requestStart,
            messages,
            inputChars,
            outputChars,
            status: cancelled ? 'client_aborted' : 'failed',
            errorCode: providerError.code,
            errorMessage: providerError.message,
            isTimeout: isChatProviderTimeout(error),
            ragEnabled,
            ragMode,
            ragTopK,
            ragMinScore,
            ragHitCount,
            ragBestScore,
            ragPromptChars,
        })
    }
}

async function persistUnifiedChatStream(
    runId: string,
    stream: ReadableStream<Uint8Array>,
    generationRuns: GenerationRunService,
): Promise<number> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let lineBuffer = ''
    let outputChars = 0
    let pendingText = ''

    const flush = () => {
        if (!pendingText) return
        const content = pendingText
        pendingText = ''
        generationRuns.appendEvent(runId, {
            eventType: 'text_delta',
            data: { content },
            outputDelta: content,
        })
    }
    const handleLine = (line: string) => {
        if (!line.trim()) return
        const parsed = JSON.parse(line) as {
            message?: { content?: string }
            error?: string
        }
        if (parsed.error) throw new Error(parsed.error)
        const content = parsed.message?.content
        if (!content) return
        pendingText += content
        outputChars += content.length
        if (pendingText.length >= config.generationDeltaFlushChars) flush()
    }

    let flushError: unknown = null
    const flushTimer = setInterval(() => {
        try {
            flush()
        } catch (error) {
            flushError = error
            void reader.cancel(error).catch(() => undefined)
        }
    }, config.generationDeltaFlushIntervalMs)
    flushTimer.unref?.()
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) {
                lineBuffer += decoder.decode(value, { stream: true })
                const lines = lineBuffer.split('\n')
                lineBuffer = lines.pop() ?? ''
                for (const line of lines) handleLine(line)
            }
        }
        lineBuffer += decoder.decode()
        if (lineBuffer.trim()) handleLine(lineBuffer)
        if (flushError) throw flushError
        flush()
        return outputChars
    } finally {
        clearInterval(flushTimer)
        reader.releaseLock()
    }
}

function recordRunMetric(
    input: ExecuteChatRunInput,
    metric: {
        aiInvocationId: string
        startedAt: string
        requestStart: number
        messages: Array<{ role: string; content: string }>
        inputChars: number | null
        outputChars: number
        status: 'success' | 'failed' | 'client_aborted'
        errorCode: string | null
        errorMessage: string | null
        isTimeout: boolean
        ragEnabled: boolean
        ragMode: string
        ragTopK: number
        ragMinScore: number
        ragHitCount: number
        ragBestScore: number | null
        ragPromptChars: number
    },
): void {
    const endedAt = new Date().toISOString()
    const estInputTokens = metric.inputChars === null
        ? null
        : estimateTokens(metric.messages.map(message => message.content).join(' '))
    const estOutputTokens = estimateTokens('x'.repeat(metric.outputChars))
    recordAiRequest({
        id: metric.aiInvocationId,
        requestId: input.requestId,
        compareId: input.body.compareId ?? null,
        timestamp: metric.startedAt,
        endpoint: '/api/chat/runs',
        provider: input.providerId,
        model: input.model,
        status: metric.status,
        statusCode: metric.status === 'client_aborted' ? null : metric.status === 'success' ? 200 : 502,
        errorCode: metric.errorCode,
        errorMessage: metric.errorMessage,
        startedAt: metric.startedAt,
        endedAt,
        latencyMs: Math.round(performance.now() - metric.requestStart),
        ragEnabled: metric.ragEnabled,
        ragMode: metric.ragMode,
        ragTopK: metric.ragTopK,
        ragMinScore: metric.ragMinScore,
        ragHitCount: metric.ragHitCount,
        ragBestScore: metric.ragBestScore,
        ragPromptChars: metric.ragPromptChars,
        embeddingModel: config.embeddingModel,
        promptVersion: ragPromptVersion,
        inputChars: metric.inputChars,
        outputChars: metric.outputChars,
        estInputTokens,
        estOutputTokens,
        estCostUsd: computeCost(
            input.providerId,
            input.model,
            estInputTokens ?? 0,
            estOutputTokens,
            pricingTable,
        ),
        questionPreview: config.logQuestionPreview
            ? input.body.messages.at(-1)?.content.slice(0, 200) ?? null
            : null,
        isTimeout: metric.isTimeout,
    })
}
