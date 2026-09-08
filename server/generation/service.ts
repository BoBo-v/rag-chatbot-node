import type { GenerationRepository } from './repository'
import type {
    AppendGenerationEventInput,
    AppendGenerationEventResult,
    CreateGenerationRunInput,
    CreateGenerationRunResult,
    GenerationEvent,
    GenerationRun,
} from './types'

export type GenerationEventListener = (event: GenerationEvent) => void

export type GenerationExecutionAbortCode = 'CLIENT_ABORTED' | 'SERVER_SHUTDOWN'

export class GenerationExecutionAbort extends Error {
    readonly code: GenerationExecutionAbortCode

    constructor(code: GenerationExecutionAbortCode, message: string) {
        super(message)
        this.name = 'GenerationExecutionAbort'
        this.code = code
    }
}

interface GenerationSubscription {
    readonly runId: string
    readonly listener: GenerationEventListener
    replaying: boolean
    lastSequence: number
    buffered: GenerationEvent[]
}

export class GenerationRunService {
    private readonly subscriptions = new Map<string, Set<GenerationSubscription>>()
    private readonly executions = new Map<string, {
        controller: AbortController
        promise: Promise<void>
    }>()

    constructor(private readonly repository: GenerationRepository) {}

    create(input: CreateGenerationRunInput): CreateGenerationRunResult {
        return this.repository.create(input)
    }

    get(runId: string): GenerationRun | null {
        return this.repository.get(runId)
    }

    getOwned(runId: string, ownerId: string, runType?: GenerationRun['runType']): GenerationRun | null {
        return this.repository.getOwned(runId, ownerId, runType)
    }

    appendEvent(runId: string, input: AppendGenerationEventInput): AppendGenerationEventResult {
        const result = this.repository.appendEvent(runId, input)
        if (result.event) this.publish(result.event)
        return result
    }

    requestCancellation(runId: string): GenerationRun {
        return this.repository.requestCancellation(runId)
    }

    runInBackground(runId: string, task: (signal: AbortSignal) => Promise<void>): void {
        if (this.executions.has(runId)) return

        const controller = new AbortController()
        const promise = task(controller.signal).finally(() => {
            this.executions.delete(runId)
        })
        this.executions.set(runId, { controller, promise })
        void promise.catch(() => undefined)
    }

    cancel(runId: string): GenerationRun {
        const run = this.requestCancellation(runId)
        const execution = this.executions.get(runId)
        if (execution) {
            execution.controller.abort(new GenerationExecutionAbort(
                'CLIENT_ABORTED',
                '生成任务已由客户端取消。',
            ))
            return run
        }

        const result = this.appendEvent(runId, {
            eventType: 'run_cancelled',
            data: { code: 'CLIENT_ABORTED', message: '生成任务已由客户端取消。' },
            transitionTo: 'cancelled',
            errorCode: 'CLIENT_ABORTED',
            errorMessage: '生成任务已由客户端取消。',
        })
        return result.run
    }

    subscribe(
        runId: string,
        afterSequence: number,
        listener: GenerationEventListener,
    ): () => void {
        const subscription: GenerationSubscription = {
            runId,
            listener,
            replaying: true,
            lastSequence: Math.max(0, Math.floor(afterSequence)),
            buffered: [],
        }
        const runSubscriptions = this.subscriptions.get(runId) ?? new Set<GenerationSubscription>()
        runSubscriptions.add(subscription)
        this.subscriptions.set(runId, runSubscriptions)

        try {
            this.replay(runId, subscription)
            subscription.replaying = false
            this.flushBuffered(subscription)
        } catch (error) {
            this.unsubscribe(runId, subscription)
            throw error
        }

        return () => this.unsubscribe(runId, subscription)
    }

    async close(): Promise<void> {
        for (const execution of this.executions.values()) {
            execution.controller.abort(new GenerationExecutionAbort(
                'SERVER_SHUTDOWN',
                '服务正在关闭，生成任务已终止。',
            ))
        }
        await Promise.allSettled([...this.executions.values()].map(execution => execution.promise))
        this.subscriptions.clear()
    }

    private replay(runId: string, subscription: GenerationSubscription): void {
        let afterSequence = subscription.lastSequence
        while (true) {
            const events = this.repository.listEvents(runId, afterSequence, 1000)
            if (events.length === 0) return

            for (const event of events) {
                this.deliver(subscription, event)
                afterSequence = event.sequence
            }
            if (events.length < 1000) return
        }
    }

    private publish(event: GenerationEvent): void {
        const runSubscriptions = this.subscriptions.get(event.runId)
        if (!runSubscriptions) return

        for (const subscription of [...runSubscriptions]) {
            if (subscription.replaying) {
                if (event.sequence > subscription.lastSequence) subscription.buffered.push(event)
                continue
            }
            this.deliver(subscription, event)
        }
    }

    private flushBuffered(subscription: GenerationSubscription): void {
        subscription.buffered
            .sort((left, right) => left.sequence - right.sequence)
            .forEach(event => this.deliver(subscription, event))
        subscription.buffered = []
    }

    private deliver(subscription: GenerationSubscription, event: GenerationEvent): void {
        if (event.sequence <= subscription.lastSequence) return
        subscription.lastSequence = event.sequence
        try {
            subscription.listener(event)
        } catch {
            this.unsubscribe(subscription.runId, subscription)
        }
    }

    private unsubscribe(runId: string, subscription: GenerationSubscription): void {
        const runSubscriptions = this.subscriptions.get(runId)
        if (!runSubscriptions) return
        runSubscriptions.delete(subscription)
        if (runSubscriptions.size === 0) this.subscriptions.delete(runId)
    }
}
