import { config } from '../utils/config'
import { GenerationRepository } from './repository'
import { getGenerationDb } from './store'

export interface GenerationMaintenanceOptions {
    retentionDays?: number
    intervalMs?: number
    onError?: (error: unknown) => void
}

export interface GenerationMaintenanceResult {
    recoveredRuns: number
    eventlessRuns: number
    deletedRuns: number
}

export class GenerationMaintenance {
    private readonly retentionDays: number
    private readonly intervalMs: number
    private readonly onError: (error: unknown) => void
    private timer: ReturnType<typeof setInterval> | null = null

    constructor(
        private readonly repository: GenerationRepository,
        options: GenerationMaintenanceOptions = {},
    ) {
        this.retentionDays = options.retentionDays ?? config.generationRetentionDays
        this.intervalMs = options.intervalMs ?? config.generationCleanupIntervalMs
        this.onError = options.onError ?? ((error) => console.error('[generation] maintenance failed', error))
    }

    start(): void {
        if (this.timer) return
        this.runSafely()
        this.timer = setInterval(() => this.runSafely(), this.intervalMs)
        this.timer.unref?.()
    }

    stop(): void {
        if (!this.timer) return
        clearInterval(this.timer)
        this.timer = null
    }

    runOnce(now = new Date()): GenerationMaintenanceResult {
        const finishedAt = now.toISOString()
        const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString()
        const recovered = this.repository.failActiveRuns(
            'SERVER_RESTARTED',
            '服务重启时未完成的生成任务已终止。',
            finishedAt,
        )
        const deletedRuns = this.repository.deleteExpiredTerminalRuns(cutoff)
        return { ...recovered, deletedRuns }
    }

    private runSafely(): void {
        try {
            this.runOnce()
        } catch (error) {
            this.onError(error)
        }
    }
}

export function createGenerationMaintenance(options: GenerationMaintenanceOptions = {}): GenerationMaintenance {
    return new GenerationMaintenance(new GenerationRepository(getGenerationDb()), options)
}
