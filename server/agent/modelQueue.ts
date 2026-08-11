import { AgentError, isAgentError } from './errors'
import type { AgentModelScheduler } from './types'

interface QueueEntry {
    signal: AbortSignal
    start: () => void
    reject: (error: AgentError) => void
    timeout: ReturnType<typeof setTimeout>
    abortHandler: () => void
    settled: boolean
}

export interface AgentModelQueueOptions {
    concurrency: number
    maxQueueSize: number
    queueTimeoutMs: number
}

export class AgentModelQueue implements AgentModelScheduler {
    private readonly waiting: QueueEntry[] = []
    private activeCount = 0

    constructor(private readonly options: AgentModelQueueOptions) {
        if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
            throw new Error('Agent model concurrency must be a positive integer')
        }
        if (!Number.isInteger(options.maxQueueSize) || options.maxQueueSize < 0) {
            throw new Error('Agent model max queue size must be a non-negative integer')
        }
        if (!Number.isFinite(options.queueTimeoutMs) || options.queueTimeoutMs < 1) {
            throw new Error('Agent model queue timeout must be positive')
        }
    }

    run<T>(task: () => Promise<T>, signal: AbortSignal, onQueued?: (position: number) => void): Promise<T> {
        throwIfAborted(signal)
        if (this.activeCount < this.options.concurrency) return this.execute(task)
        if (this.waiting.length >= this.options.maxQueueSize) {
            throw new AgentError('AGENT_QUEUE_FULL', 'Agent 模型等待队列已满，请稍后重试。', 429)
        }

        return new Promise<T>((resolve, reject) => {
            const entry = {} as QueueEntry
            const fail = (error: AgentError) => {
                if (entry.settled) return
                entry.settled = true
                this.remove(entry)
                cleanup(entry)
                reject(error)
            }
            entry.signal = signal
            entry.settled = false
            entry.reject = fail
            entry.abortHandler = () => fail(abortError(signal))
            entry.timeout = setTimeout(() => {
                fail(new AgentError('AGENT_QUEUE_TIMEOUT', '等待 Agent 模型执行位置超时。', 503))
            }, this.options.queueTimeoutMs)
            entry.start = () => {
                if (entry.settled) return
                entry.settled = true
                cleanup(entry)
                this.execute(task).then(resolve, reject)
            }

            signal.addEventListener('abort', entry.abortHandler, { once: true })
            this.waiting.push(entry)
            onQueued?.(this.waiting.length)
        })
    }

    stats(): { active: number; queued: number } {
        return { active: this.activeCount, queued: this.waiting.length }
    }

    private async execute<T>(task: () => Promise<T>): Promise<T> {
        this.activeCount += 1
        try {
            return await task()
        } finally {
            this.activeCount -= 1
            this.drain()
        }
    }

    private drain(): void {
        while (this.activeCount < this.options.concurrency && this.waiting.length > 0) {
            const entry = this.waiting.shift()
            if (!entry || entry.settled) continue
            if (entry.signal.aborted) {
                entry.reject(abortError(entry.signal))
                continue
            }
            entry.start()
        }
    }

    private remove(entry: QueueEntry): void {
        const index = this.waiting.indexOf(entry)
        if (index >= 0) this.waiting.splice(index, 1)
    }
}

function cleanup(entry: QueueEntry): void {
    clearTimeout(entry.timeout)
    entry.signal.removeEventListener('abort', entry.abortHandler)
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return
    throw abortError(signal)
}

function abortError(signal: AbortSignal): AgentError {
    if (isAgentError(signal.reason)) return signal.reason
    return new AgentError('CLIENT_ABORTED', 'Agent 请求已由客户端取消。', 499)
}
