import cors from "@fastify/cors";
import fjwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { CFG } from "../config.js";
import { pool } from "../lib/db.js";
import { adminRoutes } from "./admin.js";
import { authRoutes } from "./auth.js";
import { frontendRoutes } from "./frontend.js";

export const app = Fastify({
	logger: { level: CFG.NODE_ENV === "development" ? "info" : "warn" },
});

// G-9: CORS allowlist from env (space-separated origins); allow all in dev
const allowedOrigins = CFG.CORS_ORIGINS.split(" ")
	.map((s) => s.trim())
	.filter(Boolean);
await app.register(cors, {
	origin: (origin, cb) => {
		if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
		cb(new Error("Not allowed by CORS"), false);
	},
});

// G-9: global rate limit (generous baseline); login route tightened below
await app.register(rateLimit, {
	global: false, // opt-in per-route; avoids breaking unit tests that inject many requests
	// Integration tests inject dozens of logins per minute from 127.0.0.1; the
	// 10/min login cap would 429 the later ones. Never true outside NODE_ENV=test.
	allowList: () => CFG.NODE_ENV === "test",
});

await app.register(fjwt, { secret: CFG.JWT_SECRET });

// Decorator: verifies JWT and attaches payload to request.user
app.decorate(
	"authenticate",
	async (request: FastifyRequest, reply: FastifyReply) => {
		try {
			await request.jwtVerify();
		} catch {
			reply.status(401).send({ error: "Unauthorized" });
		}
	},
);

// Decorator: verifies JWT and checks staff role in DB (DB lookup avoids stale JWT claims).
// 'management' is the master account role; 'admin' is staff it appoints.
app.decorate(
	"requireAdmin",
	async (request: FastifyRequest, reply: FastifyReply) => {
		try {
			await request.jwtVerify();
		} catch {
			reply.status(401).send({ error: "Unauthorized" });
			return;
		}
		const user = request.user as { sub: string };
		const { rows } = await pool().query<{ role: string }>(
			"SELECT role FROM members WHERE id = $1",
			[user.sub],
		);
		if (!rows[0] || !["admin", "management"].includes(rows[0].role)) {
			reply.status(403).send({ error: "Forbidden" });
		}
	},
);

await app.register(authRoutes, { prefix: "/auth" });
await app.register(frontendRoutes);
await app.register(adminRoutes, { prefix: "/admin" });

app.get("/health", async () => ({ status: "ok" }));

if (
	process.argv[1]?.endsWith("server.ts") ||
	process.argv[1]?.endsWith("server.js")
) {
	await app.listen({ port: CFG.PORT, host: "0.0.0.0" });
	console.log(`AVG API listening on port ${CFG.PORT}`);
}
