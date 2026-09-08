import { config } from '../utils/config'
import type { ChatRequestBody, ChatRunRequestBody } from './types'

export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
const safeTokenPattern = '^[A-Za-z0-9_-]+$'
const modelNamePattern = '^[A-Za-z0-9._:/@+-]+$'
const chatMessageMaxCount = 50
const chatMessageContentMaxLength = 20000
const chatRoleValues = ['system', 'user', 'assistant'] as const

export function chatRequestBodySchema() {
    return {
        type: 'object',
        required: ['messages'],
        additionalProperties: false,
        properties: chatBodyProperties(),
    }
}

export function chatRunRequestBodySchema() {
    return {
        type: 'object',
        required: ['messages', 'conversationId', 'turnId', 'sourceUserMessageId', 'assistantMessageId'],
        additionalProperties: false,
        properties: {
            ...chatBodyProperties(),
            conversationId: {
                anyOf: [
                    { type: 'integer', minimum: 1 },
                    { type: 'string', minLength: 1, maxLength: 120, pattern: safeTokenPattern },
                ],
            },
            turnId: { type: 'string', pattern: uuidPattern },
            sourceUserMessageId: { type: 'string', pattern: uuidPattern },
            assistantMessageId: { type: 'string', pattern: uuidPattern },
            regeneratedFromRunId: { type: 'string', pattern: uuidPattern },
        },
    }
}

export function validateChatBody(body: ChatRequestBody): string | null {
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) return 'messages 不能为空'
    if (body.messages.length > chatMessageMaxCount) return `messages 最多支持 ${chatMessageMaxCount} 条`

    for (const [index, message] of body.messages.entries()) {
        if (!chatRoleValues.includes(message?.role as typeof chatRoleValues[number])) {
            return `messages[${index}].role 必须是 system、user 或 assistant`
        }
        if (typeof message.content !== 'string' || message.content.trim().length === 0) {
            return `messages[${index}].content 不能为空`
        }
        if (message.content.length > chatMessageContentMaxLength) {
            return `messages[${index}].content 不能超过 ${chatMessageContentMaxLength} 个字符`
        }
    }
    return null
}

export function validateChatRunBody(body: ChatRunRequestBody): string | null {
    const messageError = validateChatBody(body)
    if (messageError) return messageError
    if (!isValidUuid(body.turnId)) return 'turnId 必须是 UUID'
    if (!isValidUuid(body.sourceUserMessageId)) return 'sourceUserMessageId 必须是 UUID'
    if (!isValidUuid(body.assistantMessageId)) return 'assistantMessageId 必须是 UUID'
    if (body.regeneratedFromRunId && !isValidUuid(body.regeneratedFromRunId)) return 'regeneratedFromRunId 必须是 UUID'
    if (!isValidConversationId(body.conversationId)) return 'conversationId 格式不正确'
    return null
}

export function normalizeConversationId(value: string | number): string {
    return String(value)
}

function isValidUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isValidConversationId(value: string | number): boolean {
    if (typeof value === 'number') return Number.isInteger(value) && value > 0
    return /^[A-Za-z0-9_-]{1,120}$/.test(value)
}

function chatBodyProperties() {
    return {
        provider: { type: 'string', enum: ['ollama', 'openai', 'anthropic'], default: 'ollama' },
        model: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            pattern: modelNamePattern,
        },
        rag: {
            anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'true', 'false'] }],
            default: 'auto',
        },
        fileId: { type: 'string', pattern: uuidPattern },
        topK: { type: 'number', minimum: 1, maximum: 20, default: config.ragTopK },
        minScore: { type: 'number', minimum: 0, maximum: 1, default: config.ragMinScore },
        compareId: { type: 'string', minLength: 1, maxLength: 80, pattern: safeTokenPattern },
        messages: {
            type: 'array',
            minItems: 1,
            maxItems: chatMessageMaxCount,
            items: {
                type: 'object',
                required: ['role', 'content'],
                additionalProperties: false,
                properties: {
                    role: { type: 'string', enum: chatRoleValues },
                    content: { type: 'string', minLength: 1, maxLength: chatMessageContentMaxLength },
                },
            },
        },
    }
}
