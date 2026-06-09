export interface PricingEntry {
    provider: string
    model: string
    inputPer1k: number
    outputPer1k: number
}

const DEFAULT_PRICING: PricingEntry[] = [
    { provider: 'openai', model: 'gpt-4o-mini', inputPer1k: 0.00015, outputPer1k: 0.0006 },
    { provider: 'openai', model: 'gpt-4o', inputPer1k: 0.0025, outputPer1k: 0.01 },
    { provider: 'openai', model: '*', inputPer1k: 0.003, outputPer1k: 0.015 },
    { provider: 'anthropic', model: 'claude-haiku-3.5', inputPer1k: 0.0008, outputPer1k: 0.004 },
    { provider: 'anthropic', model: 'claude-sonnet-4-5', inputPer1k: 0.003, outputPer1k: 0.015 },
    { provider: 'anthropic', model: '*', inputPer1k: 0.003, outputPer1k: 0.015 },
    { provider: 'ollama', model: '*', inputPer1k: 0, outputPer1k: 0 },
]

export function parsePricingFromEnv(raw: string): PricingEntry[] {
    if (!raw) return []

    return raw
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => {
            const parts = item.split(':')
            if (parts.length !== 4) return null

            const [provider, model, inputStr, outputStr] = parts
            const inputPer1k = Number(inputStr)
            const outputPer1k = Number(outputStr)
            if (!provider || !model || !Number.isFinite(inputPer1k) || !Number.isFinite(outputPer1k)) return null

            return { provider, model, inputPer1k, outputPer1k }
        })
        .filter((entry): entry is PricingEntry => entry !== null)
}

export function computeCost(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    envTable?: PricingEntry[]
): number {
    const table = envTable && envTable.length > 0
        ? [...envTable, ...DEFAULT_PRICING]
        : DEFAULT_PRICING

    // Exact match on provider:model
    const exact = table.find(e => e.provider === provider && e.model === model)
    if (exact) {
        return (inputTokens / 1000) * exact.inputPer1k + (outputTokens / 1000) * exact.outputPer1k
    }

    // Prefix match on model name (e.g. "gpt-4o-2024-08-06" matches "gpt-4o")
    // Use longest prefix match to avoid "claude-3" matching "claude-3.5-sonnet"
    const prefixMatches = table.filter(e =>
        e.provider === provider && e.model !== '*' && model.startsWith(e.model)
    )
    if (prefixMatches.length > 0) {
        const best = prefixMatches.sort((a, b) => b.model.length - a.model.length)[0]
        return (inputTokens / 1000) * best.inputPer1k + (outputTokens / 1000) * best.outputPer1k
    }

    // Wildcard fallback for provider
    const wildcard = table.find(e => e.provider === provider && e.model === '*')
    if (wildcard) {
        return (inputTokens / 1000) * wildcard.inputPer1k + (outputTokens / 1000) * wildcard.outputPer1k
    }

    return 0
}
