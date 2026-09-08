import type { ChatProviderId } from '../llm'
import type { RagMode } from './rag'

export interface ChatMessage {
    role: string
    content: string
}

export interface ChatRequestBody {
    messages: ChatMessage[]
    model?: string
    provider?: ChatProviderId
    rag?: RagMode | 'true' | 'false'
    fileId?: string
    topK?: number
    minScore?: number
    compareId?: string
}

export interface ChatRunRequestBody extends ChatRequestBody {
    conversationId: string | number
    turnId: string
    sourceUserMessageId: string
    assistantMessageId: string
    regeneratedFromRunId?: string
}
