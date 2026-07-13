import "dotenv/config";

function env(key: string, def: string): string {
	return process.env[key] ?? def;
}

const NODE_ENV = env("NODE_ENV", "development");
const JWT_SECRET = env("JWT_SECRET", "dev-secret-change-in-prod");
const WEBHOOK_SECRET = env("WEBHOOK_SECRET", "");
const DATABASE_URL = env(
	"DATABASE_URL",
	"postgresql://avg:avg@localhost:5432/avg",
);
const REDIS_URL = env("REDIS_URL", "redis://localhost:6379");

// Fail fast when insecure defaults are present in staging/production.
// development + test: local dev and vitest are exempt.
if (NODE_ENV !== "development" && NODE_ENV !== "test") {
	if (JWT_SECRET === "dev-secret-change-in-prod") {
		throw new Error(
			"[config] JWT_SECRET must be overridden in non-development environments — refusing to start",
		);
	}
	if (!WEBHOOK_SECRET) {
		throw new Error(
			"[config] WEBHOOK_SECRET must be set in non-development environments — refusing to start",
		);
	}
	if (!process.env.DATABASE_URL) {
		throw new Error(
			"[config] DATABASE_URL must be set in non-development environments — refusing to start",
		);
	}
	if (!process.env.REDIS_URL) {
		throw new Error(
			"[config] REDIS_URL must be set in non-development environments — refusing to start",
		);
	}
}

export const CFG = {
	PAIR_BONUS_PAISE: parseInt(env("PAIR_BONUS_PAISE", "100000"), 10),
	CUTOFF_CAP_PAISE: parseInt(env("CUTOFF_CAP_PAISE", "10000000"), 10),
	GST_PCT: parseInt(env("GST_PCT", "18"), 10),
	TDS_PCT: parseInt(env("TDS_PCT", "5"), 10),
	MIN_PAYOUT_PAISE: parseInt(env("MIN_PAYOUT_PAISE", "50000"), 10),
	TZ: env("TZ", "Asia/Kolkata"),
	DATABASE_URL,
	JWT_SECRET,
	JWT_ACCESS_TTL: "15m",
	JWT_REFRESH_TTL: "30d",
	REDIS_URL,
	PORT: parseInt(env("PORT", "3000"), 10),
	NODE_ENV,
	WEBHOOK_SECRET,
	// G-9: CORS allowlist (space-separated origins). In dev, localhost is allowed.
	CORS_ORIGINS: env(
		"CORS_ORIGINS",
		"http://localhost:5173 http://localhost:3000 http://localhost:5174 http://localhost:5175 https://agilavetriglobal.com",
	),
} as const;
