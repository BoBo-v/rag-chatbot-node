import { anthropicProvider } from './anthropicProvider'
import { ollamaProvider } from './ollamaProvider'
import { openaiProvider } from './openaiProvider'
import type { ChatProviderClient, ChatProviderId } from './types'

const providers = new Map<ChatProviderId, ChatProviderClient>([
    ['ollama', ollamaProvider],
    ['openai', openaiProvider],
    ['anthropic', anthropicProvider],
])

export function getChatProvider(provider: ChatProviderId | undefined): ChatProviderClient {
    return providers.get(provider || 'ollama') ?? ollamaProvider
}

export function listChatProviders() {
    return Array.from(providers.values()).map(provider => provider.info())
}

export type { ChatProviderId } from './types'
