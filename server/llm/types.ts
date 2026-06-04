export type ChatProviderId = 'ollama' | 'openai' | 'anthropic'

export interface ChatMessage {
    role: string
    content: string
}

export interface ChatStreamInput {
    model?: string
    messages: ChatMessage[]
}

export interface ChatProviderInfo {
    id: ChatProviderId
    name: string
    defaultModel: string
    configured: boolean
}

export interface ChatProviderClient {
    info(): ChatProviderInfo
    streamChat(input: ChatStreamInput): Promise<ReadableStream<Uint8Array>>
}
