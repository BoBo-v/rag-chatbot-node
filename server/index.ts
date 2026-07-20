import 'dotenv/config'
import { buildApp } from './app'
import { config } from './utils/config'

const app = buildApp()

let shuttingDown = false

async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, '正在关闭服务')
    try {
        await app.close()
        process.exitCode = 0
    } catch (err) {
        app.log.error({ err, signal }, '服务关闭失败')
        process.exitCode = 1
    }
}

async function main() {
    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.once('SIGTERM', () => void shutdown('SIGTERM'))

    try {
        const address = await app.listen({ port: config.port })
        app.log.info({ address }, '服务已启动')
    } catch (err) {
        app.log.fatal({ err }, '服务启动失败')
        process.exitCode = 1
    }
}

void main()
