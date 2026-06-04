export interface ErrorResponseBody {
    error: string
    code?: string
}

export class AppError extends Error {
    readonly statusCode: number
    readonly code: string

    constructor(statusCode: number, code: string, message: string) {
        super(message)
        this.name = 'AppError'
        this.statusCode = statusCode
        this.code = code
    }
}

export function toErrorResponse(err: unknown): {
    statusCode: number
    body: ErrorResponseBody
    shouldLog: boolean
} {
    if (err instanceof AppError) {
        return {
            statusCode: err.statusCode,
            body: { error: err.message, code: err.code },
            shouldLog: err.statusCode >= 500,
        }
    }

    if (isFastifyValidationError(err)) {
        return {
            statusCode: 400,
            body: { error: '请求参数格式不正确，请检查接口文档后重试。', code: 'VALIDATION_ERROR' },
            shouldLog: false,
        }
    }

    if (isMultipartLimitError(err)) {
        return {
            statusCode: 413,
            body: { error: '上传文件过大，当前接口最大支持 10 MB。', code: 'UPLOAD_FILE_TOO_LARGE' },
            shouldLog: false,
        }
    }

    if (isCorsOriginError(err)) {
        return {
            statusCode: 403,
            body: {
                error: '当前前端地址不在后端 CORS_ORIGIN 白名单中，请在 .env 的 CORS_ORIGIN 中加入该前端地址并重启服务。',
                code: 'CORS_ORIGIN_NOT_ALLOWED',
            },
            shouldLog: false,
        }
    }

    return {
        statusCode: 500,
        body: { error: '服务器内部错误，请查看后端日志定位原因。', code: 'INTERNAL_SERVER_ERROR' },
        shouldLog: true,
    }
}

export function classifyUploadError(err: unknown): AppError {
    if (err instanceof AppError) return err

    const message = err instanceof Error ? err.message : ''
    const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : ''

    if (isMultipartLimitError(err)) {
        return new AppError(413, 'UPLOAD_FILE_TOO_LARGE', '上传文件过大，当前接口最大支持 10 MB。')
    }

    if (message.includes('Invalid PDF structure') || message.includes('bad XRef entry') || message.includes('PDF')) {
        return new AppError(400, 'PDF_PARSE_FAILED', 'PDF 文件解析失败，请确认文件未损坏且包含可读取文本。')
    }

    if (
        code === 'ECONNREFUSED' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        message.includes('Embedding failed') ||
        message.includes('/api/embed') ||
        message.includes('fetch failed')
    ) {
        return new AppError(502, 'EMBEDDING_SERVICE_UNAVAILABLE', 'Embedding 服务调用失败，请确认 Ollama 已启动并已安装 embedding 模型。')
    }

    return new AppError(500, 'UPLOAD_STORE_FAILED', '文件解析、向量化或写入知识库失败，请查看后端日志定位原因。')
}

function isCorsOriginError(err: unknown): boolean {
    return err instanceof Error && err.message === 'CORS origin is not allowed'
}

function isFastifyValidationError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'validation' in err
}

function isMultipartLimitError(err: unknown): boolean {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : ''
    return ['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_PARTS_LIMIT'].includes(code)
}
