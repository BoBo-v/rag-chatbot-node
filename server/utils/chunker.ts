export interface Chunk {
    text: string
    index: number
}

interface TextBlock {
    text: string
    heading?: string
}

export function splitTextToChunks(
    text: string,
    maxLen: number = 700,
    overlap: number = 100
): Chunk[] {
    const normalized = normalizeText(text)
    if (!normalized) return []

    const blocks = extractBlocks(normalized)
    const chunks: Chunk[] = []
    let current = ''

    for (const block of blocks) {
        const parts = splitBlock(block, maxLen)

        for (const part of parts) {
            const next = current ? `${current}\n${part}` : part

            if (next.length <= maxLen) {
                current = next
                continue
            }

            if (current) {
                chunks.push({ text: current, index: chunks.length })
            }

            const overlapText = getOverlapText(current, overlap)
            current = overlapText ? `${overlapText}\n${part}` : part
        }
    }

    if (current) {
        chunks.push({ text: current, index: chunks.length })
    }

    return chunks
}

export function normalizeText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

export function splitParagraph(para: string, maxLen: number): string[] {
    if (para.length <= maxLen) return [para]
    return packSentences(splitSentences(para), maxLen)
}

function extractBlocks(text: string): TextBlock[] {
    const paragraphs = text.split(/\n\n+/).map(item => item.trim()).filter(Boolean)
    const blocks: TextBlock[] = []
    let currentHeading = ''

    for (const paragraph of paragraphs) {
        if (isHeading(paragraph)) {
            currentHeading = paragraph
            continue
        }

        blocks.push({
            heading: currentHeading || undefined,
            text: paragraph,
        })
    }

    return blocks.length > 0 ? blocks : [{ text }]
}

function splitBlock(block: TextBlock, maxLen: number): string[] {
    const prefix = block.heading ? `${block.heading}\n` : ''
    const budget = Math.max(100, maxLen - prefix.length)
    const parts = splitParagraph(block.text, budget)

    return parts.map(part => {
        const text = prefix ? `${prefix}${part}` : part
        return text.length <= maxLen ? text : text.slice(0, maxLen)
    })
}

function splitSentences(text: string): string[] {
    const sentencePattern = /[^\u3002\uff01\uff1f.!?\n]+[\u3002\uff01\uff1f.!?]?|\n/g
    return (text.match(sentencePattern) || [text])
        .map(sentence => sentence.trim())
        .filter(Boolean)
}

function packSentences(sentences: string[], maxLen: number): string[] {
    const result: string[] = []
    let current = ''

    for (const sentence of sentences) {
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

function getOverlapText(text: string, overlap: number): string {
    if (!text || overlap <= 0) return ''
    if (text.length <= overlap) return text

    const sentences = splitSentences(text)
    let current = ''

    for (let i = sentences.length - 1; i >= 0; i--) {
        const next = current ? `${sentences[i]}${current}` : sentences[i]
        if (next.length > overlap) break
        current = next
    }

    return current || text.slice(-overlap).trim()
}

function isHeading(text: string): boolean {
    if (text.length > 80) return false
    if (/^#{1,6}\s+\S+/.test(text)) return true
    if (/^\d+(\.\d+)*[.)、]\s*\S+/.test(text)) return true
    if (/^[一二三四五六七八九十]+[、.]\s*\S+/.test(text)) return true
    return /^[^\u3002\uff01\uff1f.!?]{2,40}$/.test(text)
}
