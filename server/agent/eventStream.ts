import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { AgentError } from './errors'
import { agentEventVersion, type AgentEvent, type AgentEventType } from './types'

const terminalEventTypes = new Set<AgentEventType>([
    'agent_completed',
    'agent_failed',
    'agent_cancelled',
])

export interface AgentEventContext {
    requestId: string
    agentRunId: string
}

export class AgentEventWriter {
    private sequence = 0
    private terminalSent = false

    constructor(
        private readonly output: Writable,
        private readonly context: AgentEventContext
    ) {}

    async emit(
        type: AgentEventType,
        step: number,
        data: Record<string, unknown> = {}
    ): Promise<boolean> {
        if (this.terminalSent) return false
        if (terminalEventTypes.has(type)) this.terminalSent = true
        if (this.output.destroyed || this.output.writableEnded) {
            throw new AgentError('CLIENT_ABORTED', 'Agent 事件连接已关闭。', 499)
        }

        const event: AgentEvent = {
            version: agentEventVersion,
            sequence: ++this.sequence,
            requestId: this.context.requestId,
            agentRunId: this.context.agentRunId,
            step,
            timestamp: new Date().toISOString(),
            type,
            data,
        }
        if (!this.output.write(`${JSON.stringify(event)}\n`)) {
            await once(this.output, 'drain')
        }
        return true
    }

    hasTerminalEvent(): boolean {
        return this.terminalSent
    }
}
