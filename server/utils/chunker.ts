interface Chunk {
  text: string
  index: number  // 第几块
}

export function splitTextToChunks(
    text: string,
    maxLen: number = 400,
    overlap: number = 50
): Chunk[] {
  const paragraphs = text.split(/\n\n+/)
  const chunks: Chunk[] = []
  let current = ''

  for (const para of paragraphs) {
    const subParas = splitParagraph(para, maxLen)

    for (const sub of subParas) {
      if ((current + '\n' + sub).length <= maxLen) {
        current = current ? current + '\n' + sub : sub
      } else {
        if (current) {
          chunks.push({ text: current, index: chunks.length })
        }
        const overlapText = current.slice(-overlap)
        current = overlapText + sub
      }
    }
  }
  if (current) {
    chunks.push({ text: current, index: chunks.length })
  }
  return chunks
}

export function splitParagraph(para: string, maxLen: number): string[] {
  if (para.length <= maxLen) return [para]

  // 按"。"拆成句子
  const sentences = para.split('。').filter(s => s.trim())
  const result: string[] = []
  let current = ''

  for (const s of sentences) {
    const sentence = s + '。'
    if ((current + sentence).length <= maxLen) {
      current += sentence
    } else {
      if (current) result.push(current)
      // 单个句子还超长，按字符硬切
      if (sentence.length > maxLen) {
        for (let i = 0; i < sentence.length; i += maxLen) {
          result.push(sentence.slice(i, i + maxLen))
        }
        current = ''
      } else {
        current = sentence
      }
    }
  }
  if (current) result.push(current)
  return result
}