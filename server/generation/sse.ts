import type { GenerationEvent } from './types'

export const generationEventVersion = 1

export function serializeGenerationSseEvent(event: GenerationEvent): string {
    return [
        `id: ${event.sequence}`,
        `event: ${event.eventType}`,
        `data: ${JSON.stringify({
            version: generationEventVersion,
            runId: event.runId,
            sequence: event.sequence,
            type: event.eventType,
            timestamp: event.createdAt,
            data: event.data,
        })}`,
        '',
        '',
    ].join('\n')
}

export function isTerminalGenerationEvent(event: GenerationEvent): boolean {
    return event.eventType === 'run_completed' ||
        event.eventType === 'run_failed' ||
        event.eventType === 'run_cancelled'
}

export class GenerationSseQueue {
    private readonly chunks: string[] = []
    private waiting: (() => void) | null = null
    private ended = false

    push(chunk: string): void {
        if (this.ended) return
        this.chunks.push(chunk)
        this.wake()
    }

    end(): void {
        this.ended = true
        this.wake()
    }

    async shift(): Promise<string | null> {
        while (this.chunks.length === 0 && !this.ended) {
            await new Promise<void>(resolve => { this.waiting = resolve })
        }
        return this.chunks.shift() ?? null
    }

    private wake(): void {
        const waiting = this.waiting
        this.waiting = null
        waiting?.()
    }
}
