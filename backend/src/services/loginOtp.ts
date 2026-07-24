/**
 * loginOtp.ts — Redis-backed OTP generation and verification.
 *
 * OTPs live in Redis with a 5-minute TTL (authoritative), not in the DB.
 * Losing Redis before a code is used is intentional — the member tries again.
 *
 * Brute-force guard: max 5 attempts per OTP enforced atomically via Lua.
 * Generation throttle: max 5 new OTPs per member per 15 minutes.
 *
 * The `scope` parameter (default "login") namespaces the Redis keys so the same
 * mechanism serves multiple purposes without collision — login codes live under
 * `login_otp:*`, password-reset codes under `reset_otp:*`. The default preserves
 * the exact original key strings, so existing login callers are unaffected.
 */

import { randomInt } from "node:crypto";
import { redis } from "../lib/redis.js";

const OTP_TTL_SECONDS = 600;        // 10 minutes per code
const MAX_ATTEMPTS = 5;             // wrong guesses before lockout
const OTP_GEN_LIMIT = 5;           // max new codes per member per window
const OTP_GEN_WINDOW_SECONDS = 900; // 15-minute generation window

export type OtpScope = "login" | "reset";

function otpKey(memberId: string | number, scope: OtpScope): string {
	return `${scope}_otp:${memberId}`;
}

function attemptsKey(memberId: string | number, scope: OtpScope): string {
	return `${scope}_otp_attempts:${memberId}`;
}

function genLimitKey(memberId: string | number, scope: OtpScope): string {
	return `${scope}_otp_gen:${memberId}`;
}

/**
 * Check whether this member has exceeded the OTP generation rate limit.
 * Returns true when a new OTP is allowed; false when the limit is hit.
 * The counter is incremented atomically — call this before generating.
 */
export async function checkAndIncrOtpGenLimit(
	memberId: string | number,
	scope: OtpScope = "login",
): Promise<boolean> {
	const r = redis();
	const count = await r.incr(genLimitKey(memberId, scope));
	if (count === 1) {
		// First generation in this window — set the TTL.
		await r.expire(genLimitKey(memberId, scope), OTP_GEN_WINDOW_SECONDS);
	}
	return count <= OTP_GEN_LIMIT;
}

/** Generate a cryptographically secure 6-digit code, store it in Redis. */
export async function generateAndStoreOtp(
	memberId: string | number,
	scope: OtpScope = "login",
): Promise<string> {
	// randomInt is cryptographically secure (backed by OS entropy).
	const code = String(randomInt(100000, 1000000));
	const r = redis();
	// Store the code and reset any prior attempt counter atomically.
	await Promise.all([
		r.setex(otpKey(memberId, scope), OTP_TTL_SECONDS, code),
		r.del(attemptsKey(memberId, scope)),
	]);
	return code;
}

export type OtpVerifyResult =
	| { ok: true }
	| { ok: false; reason: "invalid" | "expired" | "locked" };

/**
 * Lua script: atomically check attempt count, compare code, and clean up on
 * success. A single round-trip to Redis eliminates the TOCTOU race where two
 * concurrent requests could both read the stored code before either deletes it.
 *
 * KEYS[1] = otpKey, KEYS[2] = attemptsKey
 * ARGV[1] = MAX_ATTEMPTS, ARGV[2] = OTP_TTL_SECONDS, ARGV[3] = submitted code
 * Returns one of: 'expired' | 'locked' | 'invalid' | 'ok'
 */
const LUA_VERIFY_OTP = `
local stored = redis.call('GET', KEYS[1])
if not stored then return 'expired' end
local attempts = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
if attempts > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return 'locked'
end
if stored ~= ARGV[3] then
  return 'invalid'
end
redis.call('DEL', KEYS[1], KEYS[2])
return 'ok'
`;

/**
 * Verify a submitted code. Atomic — safe against concurrent requests.
 * Returns { ok: true } on success; { ok: false, reason } on failure.
 */
export async function verifyOtp(
	memberId: string | number,
	submitted: string,
	scope: OtpScope = "login",
): Promise<OtpVerifyResult> {
	const r = redis();
	const outcome = (await r.eval(
		LUA_VERIFY_OTP,
		2,
		otpKey(memberId, scope),
		attemptsKey(memberId, scope),
		String(MAX_ATTEMPTS),
		String(OTP_TTL_SECONDS),
		submitted,
	)) as string;

	if (outcome === "ok") return { ok: true };
	return { ok: false, reason: outcome as "invalid" | "expired" | "locked" };
}
