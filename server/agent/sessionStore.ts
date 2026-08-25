import type { AgentContextMessage, AgentMessage, AgentRequestMessage, AgentToolCall } from './types'

const maxSessions = 100
const maxContextMessages = 160
const maxContextChars = 120_000

interface StoredAgentSession {
    messages: AgentContextMessage[]
    lastTurnId?: string
    updatedAt: number
}

/**
 * 保存当前 Node 进程内的完整 Agent 消息链路。
 * 工具调用和工具结果不从浏览器恢复，避免客户端伪造内部执行证据。
 */
export class AgentSessionStore {
    private readonly sessions = new Map<string, StoredAgentSession>()

    get(sessionId: string): AgentContextMessage[] | null {
        const entry = this.sessions.get(sessionId)
        if (!entry) return null
        entry.updatedAt = Date.now()
        return entry.messages.map(cloneContextMessage)
    }

    save(sessionId: string, messages: AgentMessage[], turnId?: string): void {
        const context = messages
            .filter((message): message is AgentContextMessage => message.role !== 'system')
            .map(cloneContextMessage)
        const entry: StoredAgentSession = {
            messages: trimContext(context),
            lastTurnId: turnId,
            updatedAt: Date.now(),
        }

        if (!this.sessions.has(sessionId) && this.sessions.size >= maxSessions) {
            const oldest = [...this.sessions.entries()]
                .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)[0]?.[0]
            if (oldest) this.sessions.delete(oldest)
        }
        this.sessions.set(sessionId, entry)
    }

    resolveMessages(
        sessionId: string | undefined,
        fallback: AgentRequestMessage[],
        turnId?: string,
    ): AgentContextMessage[] {
        if (!sessionId) return fallback.map(cloneContextMessage)

        const stored = this.get(sessionId)
        if (!stored) return fallback.map(cloneContextMessage)

        const latestUser = [...fallback].reverse().find(message => message.role === 'user')
        if (!latestUser) return stored

        const lastUserIndex = findLastUserIndex(stored)
        const lastUser = lastUserIndex >= 0 ? stored[lastUserIndex] : undefined
        if (storedEntryIsSameTurn(this.sessions.get(sessionId), turnId) && lastUser?.role === 'user') {
            // 同一轮重试：丢弃上一轮回答和工具链路，再重新运行。
            return [
                ...stored.slice(0, lastUserIndex),
                { role: 'user', content: latestUser.content },
            ]
        }

        return trimContext([...stored, { role: 'user', content: latestUser.content }])
    }
}

function storedEntryIsSameTurn(entry: StoredAgentSession | undefined, turnId: string | undefined): boolean {
    return Boolean(turnId && entry?.lastTurnId === turnId)
}

function findLastUserIndex(messages: AgentContextMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') return index
    }
    return -1
}

function trimContext(messages: AgentContextMessage[]): AgentContextMessage[] {
    let result = messages.slice(-maxContextMessages)
    while (result[0]?.role !== 'user' && result.length > 0) result.shift()

    while (messageChars(result) > maxContextChars && result.length > 1) {
        result.shift()
        while (result[0]?.role !== 'user' && result.length > 0) result.shift()
    }
    return result
}

function cloneContextMessage(message: AgentContextMessage | AgentRequestMessage): AgentContextMessage {
    if (message.role === 'assistant') {
        return {
            role: 'assistant',
            content: message.content,
            toolCalls: 'toolCalls' in message ? message.toolCalls.map(cloneToolCall) : [],
        }
    }
    if (message.role === 'tool') return {
        role: 'tool',
        toolCallId: message.toolCallId,
        name: message.name,
        content: message.content,
        isError: message.isError,
    }
    return { role: 'user', content: message.content }
}

function cloneToolCall(call: AgentToolCall): AgentToolCall {
    return { id: call.id, name: call.name, arguments: { ...call.arguments } }
}

function messageChars(messages: AgentContextMessage[]): number {
    return messages.reduce((total, message) => {
        if (message.role === 'assistant') {
            return total + message.content.length + message.toolCalls.reduce(
                (sum, call) => sum + call.name.length + JSON.stringify(call.arguments).length,
                0
            )
        }
        if (message.role === 'tool') return total + message.name.length + message.content.length
        return total + message.content.length
    }, 0)
}

export const agentSessionStore = new AgentSessionStore()
