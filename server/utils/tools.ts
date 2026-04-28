// 工具定义（给模型看的）
interface ToolDefinition {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: object
    }
}
// 工具执行器（后端真正干活的）
type ToolExecutor = (args: Record<string, any>) => Promise<string>

// 注册表：name → { definition, executor }
const toolRegistry = new Map<string, {
    definition: ToolDefinition
    executor: ToolExecutor
}>()

// 注册一个工具
export function registerTool(def: ToolDefinition, executor: ToolExecutor): void {
    toolRegistry.set(def.function.name, { definition: def, executor })
}

// 拿到所有工具定义（传给模型）
export function getAllDefinitions(): ToolDefinition[] {
    //TODo
}

// 执行某个工具
export function executeTool(name: string, args: Record<string, any>): Promise<string> {
    //TODo
}