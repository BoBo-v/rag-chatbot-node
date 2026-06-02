interface ToolDefinition {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: {
            type: 'object'
            properties: Record<string, unknown>
            required?: string[]
        }
    }
}

type ToolExecutor = (args: Record<string, unknown>) => Promise<string>

const toolRegistry = new Map<string, {
    definition: ToolDefinition
    executor: ToolExecutor
}>()

export function registerTool(definition: ToolDefinition, executor: ToolExecutor): void {
    toolRegistry.set(definition.function.name, { definition, executor })
}

export function getAllDefinitions(): ToolDefinition[] {
    ensureDefaultTools()
    return Array.from(toolRegistry.values()).map(item => item.definition)
}

export function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = toolRegistry.get(name)
    if (!tool) throw new Error(`Tool not found: ${name}`)
    return tool.executor(args)
}

function ensureDefaultTools(): void {
    if (toolRegistry.has(timeTool.function.name)) return

    registerTool(timeTool, async () => {
        const date = new Date()
        return date.toISOString()
    })

    registerTool(calculatorTool, async args => {
        const expression = String(args.expression ?? '')
        if (!/^[\d+\-*/().\s]+$/.test(expression)) {
            throw new Error('Only basic numeric expressions are supported')
        }

        return String(new Function(`return (${expression})`)())
    })
}

const timeTool: ToolDefinition = {
    type: 'function',
    function: {
        name: 'time',
        description: 'Get the current time as an ISO timestamp.',
        parameters: {
            type: 'object',
            properties: {},
        },
    },
}

const calculatorTool: ToolDefinition = {
    type: 'function',
    function: {
        name: 'calculator',
        description: 'Calculate a basic arithmetic expression. Supports +, -, *, / and parentheses.',
        parameters: {
            type: 'object',
            properties: {
                expression: {
                    type: 'string',
                    description: 'Arithmetic expression to calculate.',
                },
            },
            required: ['expression'],
        },
    },
}
