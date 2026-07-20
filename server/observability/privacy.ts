import type { FastifyRequest } from 'fastify'
import { config } from '../utils/config'

const maxErrorMessageLength = 500
const allowedContextKeys = new Set([
    'fileId',
    'size',
    'chunkCount',
    'deduplicated',
    'overwritten',
    'backend',
    'filesIndexed',
    'chunksIndexed',
    'skipped',
    'attempt',
    'batchSize',
    'safeField',
])

export function routeTemplateFromRequest(request: FastifyRequest): string {
    const route = request.routeOptions?.url
    if (route) return route.slice(0, 200)

    try {
        return new URL(request.url, 'http://localhost').pathname.slice(0, 200)
    } catch {
        return (request.url.split('?')[0] || '/').slice(0, 200)
    }
}

export function safeRemoteAddress(value?: string): string | null {
    if (!value || config.logRemoteAddress === 'none') return null
    if (config.logRemoteAddress === 'full') return value

    if (value.includes(':')) {
        const normalized = value.replace(/^::ffff:/, '')
        if (!normalized.includes(':')) return maskIpv4(normalized)

        const groups = normalized.split(':')
        return `${groups.slice(0, 4).join(':')}::`
    }

    return maskIpv4(value)
}

export function safeErrorMessage(err: unknown, fallback = '系统内部错误'): string {
    const raw = err instanceof Error ? err.message : String(err || fallback)
    return redactSecrets(raw).slice(0, maxErrorMessageLength) || fallback
}

export function safeErrorForLog(err: unknown): { type: string; message: string; stack: string } {
    const error = err instanceof Error ? err : new Error(String(err || 'Unknown error'))
    return {
        type: error.name || 'Error',
        message: safeErrorMessage(error),
        stack: error.stack ? redactSecrets(error.stack).slice(0, 20_000) : '',
    }
}

export function safeContextJson(context?: Record<string, unknown>): string | null {
    if (!context) return null

    const safe: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(context)) {
        if (!allowedContextKeys.has(key)) continue
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
            safe[key] = typeof value === 'string' ? redactSecrets(value).slice(0, 500) : value as number | boolean | null
        }
    }

    const serialized = JSON.stringify(safe)
    if (serialized === '{}') return null
    return serialized.length <= config.logContextMaxChars
        ? serialized
        : JSON.stringify({ truncated: true })
}

function maskIpv4(value: string): string {
    const parts = value.split('.')
    if (parts.length !== 4) return '[masked]'
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`
}

function redactSecrets(value: string): string {
    return value
        .replace(/(authorization|x-api-key|api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
}
