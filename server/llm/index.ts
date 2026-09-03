import { anthropicProvider } from './anthropicProvider'
import { ollamaProvider } from './ollamaProvider'
import { openaiProvider } from './openaiProvider'
import { ollamaAgentProvider } from './ollamaAgentProvider'
import { openaiAgentProvider } from './openaiAgentProvider'
import { anthropicAgentProvider } from './anthropicAgentProvider'
import { config } from '../utils/config'
import type { AgentModelClient } from '../agent/types'
import type { ChatProviderClient, ChatProviderId, ModelProviderInfo } from './types'

interface ModelProviderRegistration {
    chat: ChatProviderClient
    agent?: AgentModelClient
    agentModels: readonly string[]
}

export interface AgentProviderRegistration {
    client: AgentModelClient
    allowedModels: readonly string[]
}

const providers = new Map<ChatProviderId, ModelProviderRegistration>([
    ['ollama', { chat: ollamaProvider, agent: ollamaAgentProvider, agentModels: config.agentOllamaModels }],
    ['openai', { chat: openaiProvider, agent: openaiAgentProvider, agentModels: config.agentOpenaiModels }],
    ['anthropic', { chat: anthropicProvider, agent: anthropicAgentProvider, agentModels: config.agentAnthropicModels }],
])

export function getChatProvider(provider: ChatProviderId | undefined): ChatProviderClient {
    return providers.get(provider || 'ollama')?.chat ?? ollamaProvider
}

export function getAgentProvider(provider: ChatProviderId): AgentProviderRegistration | null {
    const registration = providers.get(provider)
    if (!registration?.agent || !registration.chat.info().configured) return null
    return {
        client: registration.agent,
        allowedModels: registration.agentModels,
    }
}

export function listChatProviders(): ModelProviderInfo[] {
    return Array.from(providers.values()).map(registration => {
        const info = registration.chat.info()
        const agentTools = config.agentAvailable && info.configured && Boolean(registration.agent) && registration.agentModels.length > 0
        return {
            ...info,
            capabilities: {
                chatStream: true,
                agentTools,
            },
            agentModels: agentTools ? [...registration.agentModels] : [],
        }
    })
}

export type { ChatProviderId } from './types'
