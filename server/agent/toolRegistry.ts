import Ajv, { type ValidateFunction } from 'ajv'
import { AgentError, isAgentError } from './errors'
import type {
    AgentTool,
    AgentToolCall,
    AgentToolDefinition,
    AgentToolExecutor,
    AgentToolExecutionResult,
} from './types'

interface RegisteredTool {
    tool: AgentTool
    validate: ValidateFunction
}

export class ToolRegistry {
    private readonly tools = new Map<string, RegisteredTool>()
    private readonly ajv = new Ajv({
        allErrors: true,
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
        strict: true,
    })

    constructor(tools: AgentTool[]) {
        for (const tool of tools) this.register(tool)
    }

    definitionsFor(allowedToolNames: readonly string[]): AgentToolDefinition[] {
        return allowedToolNames.map(name => {
            const registered = this.tools.get(name)
            if (!registered) throw new Error(`Agent profile references unknown tool: ${name}`)
            return cloneDefinition(registered.tool.definition)
        })
    }

    executorFor(allowedToolNames: readonly string[]): AgentToolExecutor {
        const allowed = new Set(allowedToolNames)
        for (const name of allowed) {
            if (!this.tools.has(name)) throw new Error(`Agent profile references unknown tool: ${name}`)
        }

        return (call, signal) => this.execute(call, allowed, signal)
    }

    private register(tool: AgentTool): void {
        const { name, description, inputSchema } = tool.definition
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
            throw new Error(`Invalid Agent tool name: ${name}`)
        }
        if (!description.trim()) throw new Error(`Agent tool description is required: ${name}`)
        if (this.tools.has(name)) throw new Error(`Duplicate Agent tool: ${name}`)
        assertSupportedSchema(inputSchema, name)
        this.tools.set(name, {
            tool,
            validate: this.ajv.compile(inputSchema),
        })
    }

    private async execute(
        call: AgentToolCall,
        allowed: ReadonlySet<string>,
        signal: AbortSignal
    ): Promise<AgentToolExecutionResult> {
        throwIfAborted(signal)
        const registered = this.tools.get(call.name)
        if (!registered || !allowed.has(call.name)) {
            throw new AgentError('TOOL_NOT_ALLOWED', `工具 ${call.name} 不在当前 Agent Profile 白名单中。`, 400)
        }
        if (!registered.validate(call.arguments)) {
            const detail = registered.validate.errors
                ?.map(error => `${error.instancePath || '/'} ${error.message || error.keyword}`)
                .join('; ')
            throw new AgentError(
                'TOOL_ARGUMENTS_INVALID',
                `工具 ${call.name} 参数格式不正确${detail ? `：${detail}` : '。'}`,
                400
            )
        }

        try {
            const result = await registered.tool.execute({ ...call.arguments }, signal)
            throwIfAborted(signal)
            if (!result || typeof result.content !== 'string' || typeof result.isError !== 'boolean') {
                throw new AgentError('TOOL_EXECUTION_FAILED', `工具 ${call.name} 返回格式不正确。`, 500)
            }
            return result
        } catch (error) {
            throwIfAborted(signal)
            if (isAgentError(error)) throw error
            throw new AgentError('TOOL_EXECUTION_FAILED', `工具 ${call.name} 执行失败。`, 500, { cause: error })
        }
    }
}

function assertSupportedSchema(schema: AgentToolDefinition['inputSchema'], toolName: string): void {
    if (schema.type !== 'object' || schema.additionalProperties !== false) {
        throw new Error(`Agent tool ${toolName} must use an object schema with additionalProperties=false`)
    }
    const propertyNames = new Set(Object.keys(schema.properties))
    for (const required of schema.required ?? []) {
        if (!propertyNames.has(required)) throw new Error(`Agent tool ${toolName} requires unknown property: ${required}`)
    }
    for (const [name, property] of Object.entries(schema.properties)) {
        if (!['string', 'number', 'integer', 'boolean'].includes(property.type)) {
            throw new Error(`Agent tool ${toolName} property ${name} uses an unsupported type`)
        }
        if (property.enum && property.enum.length === 0) {
            throw new Error(`Agent tool ${toolName} property ${name} has an empty enum`)
        }
    }
}

function cloneDefinition(definition: AgentToolDefinition): AgentToolDefinition {
    return {
        name: definition.name,
        description: definition.description,
        inputSchema: {
            ...definition.inputSchema,
            properties: Object.fromEntries(
                Object.entries(definition.inputSchema.properties).map(([name, property]) => [
                    name,
                    { ...property, enum: property.enum ? [...property.enum] : undefined },
                ])
            ),
            required: definition.inputSchema.required ? [...definition.inputSchema.required] : undefined,
        },
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return
    if (isAgentError(signal.reason)) throw signal.reason
    throw new AgentError('CLIENT_ABORTED', 'Agent 请求已由客户端取消。', 499)
}
