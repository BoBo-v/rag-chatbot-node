/**
 * Estimate token count from text. This is a lightweight heuristic, not a
 * provider tokenizer:
 * - CJK characters: roughly 0.7 tokens per char
 * - Other characters: roughly 4 chars per token
 */
export function estimateTokens(text: string): number {
    if (!text) return 0

    const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length
    const other = text.length - cjk
    return Math.ceil(cjk * 0.7 + other / 4)
}
