import { config } from '../utils/config'
import { getEmbeddings } from '../utils/embedding'
import { search, type SearchResult } from '../utils/vectorStore'

export const ragPromptVersion = 'rag-fidelity-v1'
export type RagMode = boolean | 'auto'

export interface RagChatInput {
    messages: Array<{ role: string; content: string }>
    rag?: RagMode | 'true' | 'false'
    fileId?: string
    topK?: number
    minScore?: number
}

export interface RagContext {
    enabled: boolean
    prompt: string
    results: SearchResult[]
    mode: string
    topK: number
    minScore: number
    bestScore: number | null
}

export async function buildRagContext(body: RagChatInput): Promise<RagContext> {
    const mode = normalizeRagMode(body.rag ?? config.ragMode)
    const modeLabel = ragModeLabel(mode)
    const topK = parseBoundedNumber(body.topK, config.ragTopK, 1, 20)
    const minScore = parseBoundedNumber(body.minScore, config.ragMinScore, 0, 1)

    if (mode === false) {
        return { enabled: false, prompt: '', results: [], mode: modeLabel, topK, minScore, bestScore: null }
    }

    const lastMessage = body.messages[body.messages.length - 1]
    const question = lastMessage.content
    const forceRag = mode === true
    let results: SearchResult[] = []
    try {
        const embeddings = await getEmbeddings([question])
        results = await search(embeddings[0], {
            topK,
            minScore,
            fileId: body.fileId,
            query: question,
        })
    } catch (error) {
        if (forceRag) throw error
        return { enabled: false, prompt: '', results: [], mode: modeLabel, topK, minScore, bestScore: null }
    }

    const shouldUseRag = forceRag ? results.length > 0 : shouldAutoUseRag(question, results)
    return {
        enabled: shouldUseRag,
        prompt: shouldUseRag && results.length > 0
            ? buildRagSystemPrompt(results, config.ragShowCitations)
            : '',
        results,
        mode: modeLabel,
        topK,
        minScore,
        bestScore: results[0]?.score ?? null,
    }
}

export function normalizeRagMode(value: unknown): RagMode {
    if (value === true || value === 'true') return true
    if (value === false || value === 'false') return false
    return 'auto'
}

export function ragModeLabel(mode: RagMode): string {
    if (mode === true) return 'true'
    if (mode === false) return 'false'
    return 'auto'
}

export function parseBoundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
}

export function toSearchResultResponse(result: SearchResult) {
    return {
        id: result.id,
        fileId: result.fileId,
        filename: result.filename,
        chunkIndex: result.chunkIndex,
        score: result.score,
        vectorScore: result.vectorScore,
        keywordScore: result.keywordScore,
        text: result.text,
        pageNumber: result.pageNumber,
    }
}

function shouldAutoUseRag(question: string, results: SearchResult[]): boolean {
    if (results.length === 0) return false
    const normalized = question.toLowerCase()
    const explicitKnowledgeIntent = [
        '知识库', '资料', '文档', '文件', '上传', '引用', '原文', 'pdf', 'md', 'txt',
        '根据', '基于', '这份', '这个文件', '材料', '上下文', '检索',
        'knowledge', 'document', 'file', 'context', 'source', 'according to',
    ].some(keyword => normalized.includes(keyword))
    if (explicitKnowledgeIntent) return true
    const best = results[0]
    return best.score >= 0.62 || best.keywordScore >= 0.55
}

function buildRagSystemPrompt(chunks: SearchResult[], showCitations: boolean): string {
    const context = chunks
        .map(chunk => {
            const page = chunk.pageNumber ? `, page=${chunk.pageNumber}` : ''
            return [
                `[source:${chunk.filename}, chunk=${chunk.chunkIndex}, score=${chunk.score.toFixed(4)}, vector=${chunk.vectorScore.toFixed(4)}, keyword=${chunk.keywordScore.toFixed(4)}${page}]`,
                chunk.text,
            ].join('\n')
        })
        .join('\n---\n')

    const citationRules = showCitations
        ? [
            '5. 每条主要结论后标注文件名和 chunk 编号，例如：[test.pdf chunk 2]。引用原文必须能直接证明该结论。',
            '6. 输出前检查每个引用，确保对应材料能直接支持紧邻的结论。',
        ]
        : [
            '5. 回答正文不要输出文件名、chunk 编号、source、引用列表或方括号引用标记。引用材料仍是事实依据，必须逐条核对后再回答。',
            '6. 输出前检查每条主要结论，确保引用材料能直接支持该结论，但不要把内部核对过程和来源标记展示给用户。',
        ]

    return [
        '你是一个严格的知识库摘录助手，不是常识问答助手。',
        '必须遵守以下规则：',
        '1. 将用户问题按每个疑问句和问号拆成独立子问题，逐项核对；不得静默跳过任何子问题。',
        '2. 材料没有直接回答的子问题，必须在“知识库未提供的信息”中写“知识库没有提供这部分信息”，并注明缺少的是哪部分。只要存在一个未回答子问题，就禁止在该部分写“无”。',
        '3. 询问“哪些风险、原因、影响或结论”时，材料必须明确列出对应风险、原因、影响或结论才算有答案。材料列出安全措施不等于列出了安全风险，禁止根据措施反推。',
        '4. 如果有标题直接匹配问题主题的专门小节，只使用该小节回答；该小节有几条并列项目，就按原顺序近似原文输出几条，不得遗漏、合并、扩写或混入其他小节内容。',
        ...citationRules,
        '7. 输出前删除材料中没有明确出现的风险名称、攻击类型、目的、效果和解释。',
        '',
        '回答格式：',
        '### 知识库未提供的信息',
        '未回答的子问题或“无”。',
        '### 知识库明确提供的信息',
        showCitations
            ? '按专门小节原有项目逐条摘录，并在每条后标注文件名和 chunk 编号。'
            : '按专门小节原有项目逐条摘录，不显示文件名、chunk 编号或其他引用标记。',
        '',
        '引用材料：',
        context,
    ].join('\n')
}
