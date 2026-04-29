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
    registerTool(timeTool,{ function: timeTool.function})
    return Array.from(toolRegistry.values()).map(item => item.definition)
}

// 执行某个工具
export function executeTool(name: string, args: Record<string, any>): Promise<string> {
    if(!toolRegistry.has(name)){
        throw new Error('工具不存在')
    }else{
        return toolRegistry.get(name)!.executor(args)
    }
}
const timeTool: ToolDefinition = {
    type: 'function',
    function: {
        name: 'time',
        description: '获取当前时间',
        parameters:async (input) => {
            let time = Date.now()//
            //格式化yyyy-MM-dd HH:mm:ss
            let date = new Date(time)
            let yyyy = date.getFullYear()
            let MM = date.getMonth() + 1
            let dd = date.getDate()
            let HH = date.getHours()

            return `${yyyy}-${MM}-${dd} ${HH}:${date.getMinutes()}:${date.getSeconds()}`
        }
    }
}

const calculator: ToolDefinition = {
    type: 'function',
    function:{
        name: 'calculator',
        description: '计算数学表达式，支持加减乘除',
        parameters:async (input) => {
            const expr = input.expression as string
            const result = new Function(`return ${expr}`)()


            return String(result)
        }
    }
}