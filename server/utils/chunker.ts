export interface Chunk {
    text: string
    index: number
}

export function splitTextToChunks(
    text: string,
    maxLen: number = 700,
    overlap: number = 100
): Chunk[] {
    const normalized = text
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

    if (!normalized) return []

    const paragraphs = normalized.split(/\n\n+/)
    const chunks: Chunk[] = []
    let current = ''

    for (const para of paragraphs) {
        const parts = splitParagraph(para.trim(), maxLen)

        for (const part of parts) {
            const next = current ? `${current}\n${part}` : part

            if (next.length <= maxLen) {
                current = next
                continue
            }

            if (current) {
                chunks.push({ text: current, index: chunks.length })
            }

            const overlapText = current ? current.slice(-overlap) : ''
            current = overlapText ? `${overlapText}\n${part}` : part
        }
    }

    if (current) {
        chunks.push({ text: current, index: chunks.length })
    }

    return chunks
}

export function splitParagraph(para: string, maxLen: number): string[] {
    if (para.length <= maxLen) return [para]

    const sentences = para.match(/[^。！？.!?\n]+[。！？.!?]?|\n/g) || [para]
    const result: string[] = []
    let current = ''

    for (const sentence of sentences.map(s => s.trim()).filter(Boolean)) {
        if ((current + sentence).length <= maxLen) {
            current += sentence
            continue
        }

        if (current) result.push(current)

        if (sentence.length > maxLen) {
            for (let i = 0; i < sentence.length; i += maxLen) {
                result.push(sentence.slice(i, i + maxLen))
            }
            current = ''
        } else {
            current = sentence
        }
    }

    if (current) result.push(current)
    return result
}
