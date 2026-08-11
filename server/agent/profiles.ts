import { AgentError } from './errors'
import type { AgentProfileId } from './types'

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
}

export function getAgentProfile(id: string): AgentProfile {
    const profile = profiles[id as AgentProfileId]
    if (!profile) throw new AgentError('AGENT_PROFILE_UNSUPPORTED', '不支持当前 Agent Profile。', 400)
    return profile
}

export function listAgentProfiles(): AgentProfile[] {
    return Object.values(profiles).map(profile => ({
        ...profile,
        toolNames: [...profile.toolNames],
    }))
}
