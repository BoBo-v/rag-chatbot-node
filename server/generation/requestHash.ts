import { createHash } from 'node:crypto'

export function createGenerationRequestHash(value: unknown): string {
    return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
        .sort()
        .filter(key => record[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    return `{${entries.join(',')}}`
}
