import type { FastifyInstance } from 'fastify'
import argon2 from 'argon2'
import { z } from 'zod'
import { registerMember, findMemberByPhone } from '../services/placement.js'
import { pool } from '../lib/db.js'
import { CFG } from '../config.js'
import { buildMe } from './frontend.js'

const RegisterBody = z.object({
  sponsorCode:  z.string().min(1),
  preferredLeg: z.enum(['L', 'R']),
  name:         z.string().min(1),
  phone:        z.string().min(10),
  email:        z.string().email().optional(),
  password:     z.string().min(8),
})

const LoginBody = z.object({
  phone:    z.string(),
  password: z.string(),
})

const RefreshBody = z.object({
  refreshToken: z.string(),
})

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', async (req, reply) => {
    const body = RegisterBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

    try {
      const { memberId, memberCode } = await registerMember(body.data)
      return reply.status(201).send({ memberId: String(memberId), memberCode })
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string }
      if (e.statusCode === 404) return reply.status(404).send({ error: e.message })
      if (e.statusCode === 409) return reply.status(409).send({ error: e.message })
      throw err
    }
  })

  app.post('/login', async (req, reply) => {
    const body = LoginBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

    const member = await findMemberByPhone(body.data.phone)
    if (!member) return reply.status(401).send({ error: 'Invalid credentials' })

    const valid = await argon2.verify(member.password_hash, body.data.password)
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials' })

    const payload = { sub: member.id, code: member.member_code, name: member.name }
    const accessToken  = app.jwt.sign(payload, { expiresIn: CFG.JWT_ACCESS_TTL })
    const refreshToken = app.jwt.sign({ sub: member.id, type: 'refresh' }, { expiresIn: CFG.JWT_REFRESH_TTL })

    const me = await buildMe(String(member.id))
    return { accessToken, refreshToken, memberCode: member.member_code, member: me }
  })

  app.post('/refresh', async (req, reply) => {
    const body = RefreshBody.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

    let payload: { sub: string; type?: string }
    try {
      payload = app.jwt.verify<{ sub: string; type?: string }>(body.data.refreshToken)
    } catch {
      return reply.status(401).send({ error: 'Invalid refresh token' })
    }
    if (payload.type !== 'refresh') return reply.status(401).send({ error: 'Not a refresh token' })

    const { rows } = await pool().query<{ member_code: string; name: string }>(
      'SELECT member_code, name FROM members WHERE id = $1',
      [payload.sub]
    )
    if (!rows[0]) return reply.status(401).send({ error: 'Member not found' })

    const newPayload = { sub: payload.sub, code: rows[0].member_code, name: rows[0].name }
    const accessToken  = app.jwt.sign(newPayload, { expiresIn: CFG.JWT_ACCESS_TTL })
    const refreshToken = app.jwt.sign({ sub: payload.sub, type: 'refresh' }, { expiresIn: CFG.JWT_REFRESH_TTL })

    return { accessToken, refreshToken }
  })

  app.get('/me', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const user = req.user as { sub: string; code: string; name: string }
    const { rows } = await pool().query<{
      id: string; member_code: string; name: string; phone: string; email: string | null
      kyc_status: string; bank_status: string; is_active: boolean; is_qualified: boolean
      created_at: string
    }>(
      `SELECT id, member_code, name, phone, email, kyc_status, bank_status,
              is_active, is_qualified, created_at
       FROM members WHERE id = $1`,
      [user.sub]
    )
    if (!rows[0]) return { error: 'Not found' }
    const m = rows[0]
    return {
      id: m.id, memberCode: m.member_code, name: m.name, phone: m.phone,
      email: m.email, kycStatus: m.kyc_status, bankStatus: m.bank_status,
      isActive: m.is_active, isQualified: m.is_qualified, createdAt: m.created_at,
    }
  })
}
