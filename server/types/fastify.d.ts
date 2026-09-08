import type { GenerationRunService } from '../generation/service'

declare module 'fastify' {
    interface FastifyInstance {
        generationRuns: GenerationRunService
    }
}
