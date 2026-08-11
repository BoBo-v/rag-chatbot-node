import type { AgentTool } from './types'

type CalculatorOperation = 'add' | 'subtract' | 'multiply' | 'divide'

interface CalculatorArguments {
    operation: CalculatorOperation
    left: number
    right: number
}

export const calculatorTool: AgentTool = {
    definition: {
        name: 'calculator',
        description: '对两个有限数字执行加、减、乘或除运算。必须使用结构化参数，不接受表达式字符串。',
        inputSchema: {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['add', 'subtract', 'multiply', 'divide'],
                    description: '运算类型：加、减、乘或除。',
                },
                left: { type: 'number', description: '左操作数。' },
                right: { type: 'number', description: '右操作数。' },
            },
            required: ['operation', 'left', 'right'],
            additionalProperties: false,
        },
    },

    async execute(argumentsValue, signal) {
        if (signal.aborted) throw signal.reason
        const input = argumentsValue as unknown as CalculatorArguments
        if (!Number.isFinite(input.left) || !Number.isFinite(input.right)) {
            return { content: '计算器只接受有限数字。', isError: true }
        }
        if (input.operation === 'divide' && input.right === 0) {
            return { content: '除数不能为 0。', isError: true }
        }

        const result = calculate(input.operation, input.left, input.right)
        if (!Number.isFinite(result)) {
            return { content: '计算结果超出有限数字范围。', isError: true }
        }
        return { content: String(Object.is(result, -0) ? 0 : result), isError: false }
    },
}

function calculate(operation: CalculatorOperation, left: number, right: number): number {
    if (operation === 'add') return left + right
    if (operation === 'subtract') return left - right
    if (operation === 'multiply') return left * right
    return left / right
}
