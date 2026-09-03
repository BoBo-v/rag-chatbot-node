import { AgentError } from './errors'
import type { AgentProfileId } from './types'
import { config } from '../utils/config'

export interface AgentProfile {
    id: AgentProfileId
    systemPrompt: string
    toolNames: readonly string[]
}

const profiles: Record<AgentProfileId, AgentProfile> = {
    'calculator-v0': {
        id: 'calculator-v0',
        systemPrompt: [
            '你是一个受控计算助手。',
            '需要进行算术运算时必须调用 calculator，不得心算或编造计算结果。',
            'calculator 每次只处理两个数字；复杂计算应拆成多个有依赖关系的步骤。',
            '工具返回错误时应明确说明，禁止绕过工具限制。',
            '完成计算后，用简洁中文回答用户。',
        ].join('\n'),
        toolNames: ['calculator'],
    },
    'tools-v0': {
        id: 'tools-v0',
        systemPrompt: [
            '你是一个受控的计算与日期时间助手。',
            '需要进行算术运算时必须调用 calculator，不得心算或编造计算结果。',
            '涉及当前时间、时区转换、日期加减、时间差、星期、闰年或 Unix 时间戳时必须调用 datetime。',
            `后端默认时区为 ${config.agentDefaultTimeZone}。用户未提供时区时必须直接使用该默认时区调用 datetime，不要追问用户时区。`,
            '用户明确提供 IANA 时区时优先使用用户时区，最终回答必须说明实际使用的时区。',
            '计算当前时间到今天、明天或昨天某个时刻的差值时，必须一次调用 datetime 的 difference_from_now，不得拆成多次查询或自行计算。',
            'calculator 每次只处理两个数字；复杂计算应拆成多个有依赖关系的步骤。',
            'datetime 只接受 ISO 8601 时间和 IANA 时区，不得使用 CST 等有歧义的缩写。',
            '工具返回错误时应明确说明，禁止绕过工具限制或根据常识伪造结果。',
            '完成工具调用后，用简洁中文回答用户，并明确关键时间所使用的时区。',
        ].join('\n'),
        toolNames: ['calculator', 'datetime'],
    },
}

export function getAgentProfile(id: string): AgentProfile {
    const profile = profiles[id as AgentProfileId]
    if (!profile) throw new AgentError('AGENT_PROFILE_UNSUPPORTED', '不支持当前 Agent Profile。', 400)
    return profile
}
