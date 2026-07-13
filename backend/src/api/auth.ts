import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CFG } from "../config.js";
import { pool } from "../lib/db.js";
import { findMemberByEmail, registerMember } from "../services/placement.js";
import { buildMe } from "./frontend.js";

const RegisterBody = z.object({
	sponsorCode: z.string().min(1),
	name: z.string().min(1),
	phone: z.string().min(10),
	email: z.string().email(),
	password: z.string().min(8),
});

const LoginBody = z.object({
	email: z.string().email(),
	password: z.string(),
});

const RefreshBody = z.object({
	refreshToken: z.string(),
});

const LogoutBody = z.object({
	refreshToken: z.string(),
});

/** Parse the 30d TTL string into milliseconds for DB expires_at calculation */
function refreshTtlMs(): number {
	const match = CFG.JWT_REFRESH_TTL.match(/^(\d+)d$/);
	const days = match ? parseInt(match[1], 10) : 30;
	return days * 24 * 60 * 60 * 1000;
}

/** Issue a new refresh token jti, store it in DB, return signed JWT. */
async function issueRefreshToken(memberId: string): Promise<string> {
	const jti = randomUUID();
	const expiresAt = new Date(Date.now() + refreshTtlMs());
	await pool().query(
		`INSERT INTO refresh_tokens (jti, member_id, expires_at) VALUES ($1, $2, $3)`,
		[jti, memberId, expiresAt],
	);
	return app_instance.jwt.sign(
		{ sub: memberId, type: "refresh", jti },
		{ expiresIn: CFG.JWT_REFRESH_TTL },
	);
}

// Module-level reference so issueRefreshToken can use app.jwt after registration.
let app_instance: FastifyInstance;

export async function authRoutes(app: FastifyInstance) {
	app_instance = app;

	app.post(
		"/register",
		{
			config: {
				rateLimit: {
					max: 20,
					timeWindow: "1 minute",
				},
			},
		},
		async (req, reply) => {
			const body = RegisterBody.safeParse(req.body);
			if (!body.success)
				return reply.status(400).send({ error: body.error.flatten() });

			// Management-sponsor rejection (409) is enforced inside registerMember,
			// so every caller of the service shares the guard.
			try {
				const { memberId, memberCode } = await registerMember(body.data);
				return reply
					.status(201)
					.send({ memberId: String(memberId), memberCode });
			} catch (err: unknown) {
				const e = err as { statusCode?: number; message?: string };
				if (e.statusCode === 404)
					return reply.status(404).send({ error: e.message });
				if (e.statusCode === 409)
					return reply.status(409).send({ error: e.message });
				throw err;
			}
		},
	);

	// G-9: 10 login attempts per minute per IP
	app.post(
		"/login",
		{
			config: {
				rateLimit: {
					max: 10,
					timeWindow: "1 minute",
				},
			},
		},
		async (req, reply) => {
			const body = LoginBody.safeParse(req.body);
			if (!body.success)
				return reply.status(400).send({ error: body.error.flatten() });

			const member = await findMemberByEmail(body.data.email);
			if (!member)
				return reply.status(401).send({ error: "Invalid credentials" });

			const valid = await argon2.verify(
				member.password_hash,
				body.data.password,
			);
			if (!valid)
				return reply.status(401).send({ error: "Invalid credentials" });

			// buildMe carries the blocked flag, so the suspend check costs no
			// extra round trip (findMemberByEmail stays untouched — placement.ts
			// is money-critical).
			const me = await buildMe(String(member.id));
			if (!me) return reply.status(401).send({ error: "Invalid credentials" });
			if (me.blocked)
				return reply.status(403).send({
					error: {
						code: "ACCOUNT_BLOCKED",
						message: "Account is blocked. Contact support.",
					},
				});

			const payload = {
				sub: member.id,
				code: member.member_code,
				name: member.name,
			};
			const accessToken = app.jwt.sign(payload, {
				expiresIn: CFG.JWT_ACCESS_TTL,
			});
			const refreshToken = await issueRefreshToken(String(member.id));

			return {
				accessToken,
				refreshToken,
				memberCode: member.member_code,
				member: me,
			};
		},
	);

	app.post("/refresh", async (req, reply) => {
		const body = RefreshBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		let payload: { sub: string; type?: string; jti?: string };
		try {
			payload = app.jwt.verify<{ sub: string; type?: string; jti?: string }>(
				body.data.refreshToken,
			);
		} catch {
			return reply.status(401).send({ error: "Invalid refresh token" });
		}
		if (payload.type !== "refresh")
			return reply.status(401).send({ error: "Not a refresh token" });

		// G-9: validate jti and atomically revoke it in one UPDATE … RETURNING.
		// A separate SELECT-then-UPDATE is non-atomic: two concurrent requests with the
		// same token could both pass the SELECT before either UPDATE commits, letting
		// both produce valid new tokens from one rotation. The single UPDATE gate
		// prevents that — only one request finds a revokable row; the other gets 0 rows
		// and returns 401.
		const jti = payload.jti;
		if (!jti) return reply.status(401).send({ error: "Missing token id" });

		const { rows: revokeRows } = await pool().query<{ jti: string }>(
			`UPDATE refresh_tokens SET revoked_at = now()
       WHERE jti = $1 AND member_id = $2 AND revoked_at IS NULL AND expires_at > now()
       RETURNING jti`,
			[jti, payload.sub],
		);
		if (!revokeRows[0])
			return reply.status(401).send({ error: "Token revoked or expired" });

		const { rows } = await pool().query<{
			member_code: string;
			name: string;
			blocked: boolean;
		}>("SELECT member_code, name, blocked FROM members WHERE id = $1", [
			payload.sub,
		]);
		if (!rows[0]) return reply.status(401).send({ error: "Member not found" });
		if (rows[0].blocked)
			return reply.status(403).send({
				error: {
					code: "ACCOUNT_BLOCKED",
					message: "Account is blocked. Contact support.",
				},
			});

		// Old jti is now revoked; issue a new refresh token.
		const newPayload = {
			sub: payload.sub,
			code: rows[0].member_code,
			name: rows[0].name,
		};
		const accessToken = app.jwt.sign(newPayload, {
			expiresIn: CFG.JWT_ACCESS_TTL,
		});
		const refreshToken = await issueRefreshToken(payload.sub);

		return { accessToken, refreshToken };
	});

	// G-9: logout — revoke the presented refresh token's jti
	app.post("/logout", async (req, reply) => {
		const body = LogoutBody.safeParse(req.body);
		if (!body.success)
			return reply.status(400).send({ error: body.error.flatten() });

		let payload: { sub?: string; type?: string; jti?: string };
		try {
			payload = app.jwt.verify<{ sub?: string; type?: string; jti?: string }>(
				body.data.refreshToken,
			);
		} catch {
			// Token already expired or invalid — treat as already logged out
			return reply.send({ ok: true });
		}

		if (payload.jti) {
			await pool().query(
				`UPDATE refresh_tokens SET revoked_at = now() WHERE jti = $1 AND revoked_at IS NULL`,
				[payload.jti],
			);
		}
		return reply.send({ ok: true });
	});

	app.get(
		"/me",
		{
			preHandler: [app.authenticate],
		},
		async (req) => {
			const user = req.user as { sub: string; code: string; name: string };
			const { rows } = await pool().query<{
				id: string;
				member_code: string;
				name: string;
				phone: string;
				email: string | null;
				kyc_status: string;
				bank_status: string;
				is_active: boolean;
				is_qualified: boolean;
				created_at: string;
				role: string;
			}>(
				`SELECT id, member_code, name, phone, email, kyc_status, bank_status,
              is_active, is_qualified, created_at, role
       FROM members WHERE id = $1`,
				[user.sub],
			);
			if (!rows[0]) return { error: "Not found" };
			const m = rows[0];
			return {
				id: m.id,
				memberCode: m.member_code,
				name: m.name,
				phone: m.phone,
				email: m.email,
				kycStatus: m.kyc_status,
				bankStatus: m.bank_status,
				isActive: m.is_active,
				isQualified: m.is_qualified,
				createdAt: m.created_at,
				role: m.role,
			};
		},
	);
}
