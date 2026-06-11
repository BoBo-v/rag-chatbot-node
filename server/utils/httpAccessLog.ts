export interface HttpAccessLogEntry {
    id: string
    timestamp: string
    method: string
    url: string
    host: string | null
    remoteAddress: string | null
    statusCode: number
    responseTimeMs: number
}

const MAX_LOGS = 100
const logs: HttpAccessLogEntry[] = []

export function recordHttpAccessLog(entry: HttpAccessLogEntry): void {
    logs.unshift(entry)
    if (logs.length > MAX_LOGS) {
        logs.length = MAX_LOGS
    }
}

export function queryHttpAccessLogs(limit = 30): HttpAccessLogEntry[] {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), MAX_LOGS)
    return logs.slice(0, safeLimit)
}
