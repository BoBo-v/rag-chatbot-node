import 'dotenv/config'
import { buildApp } from './app'
import { config } from './utils/config'

const app = buildApp()

app.listen({ port: config.port }, (err, address) => {
    if (err) throw err
    console.log(`Server running at ${address}`)
})
