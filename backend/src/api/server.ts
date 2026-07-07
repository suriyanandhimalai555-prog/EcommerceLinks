import Fastify, { FastifyRequest, FastifyReply } from 'fastify'
import fjwt from '@fastify/jwt'
import cors from '@fastify/cors'
import { CFG } from '../config.js'
import { authRoutes } from './auth.js'
import { orderRoutes } from './orders.js'
import { networkRoutes } from './network.js'
import { walletRoutes } from './wallet.js'
import { reportRoutes } from './reports.js'
import { adminRoutes } from './admin.js'

export const app = Fastify({
  logger: { level: CFG.NODE_ENV === 'development' ? 'info' : 'warn' },
})

await app.register(cors, { origin: true })

await app.register(fjwt, { secret: CFG.JWT_SECRET })

// Decorator: verifies JWT and attaches payload to request.user
app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify()
  } catch {
    reply.status(401).send({ error: 'Unauthorized' })
  }
})

await app.register(authRoutes, { prefix: '/auth' })
await app.register(orderRoutes)
await app.register(networkRoutes)
await app.register(walletRoutes)
await app.register(reportRoutes)
await app.register(adminRoutes, { prefix: '/admin' })

app.get('/health', async () => ({ status: 'ok' }))

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  await app.listen({ port: CFG.PORT, host: '0.0.0.0' })
  console.log(`AVG API listening on port ${CFG.PORT}`)
}
