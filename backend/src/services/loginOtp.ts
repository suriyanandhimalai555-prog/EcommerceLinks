/**
 * loginOtp.ts — Redis-backed OTP generation and verification for login.
 *
 * OTPs live in Redis with a 5-minute TTL (authoritative), not in the DB.
 * Losing Redis before a code is used is intentional — the member tries again.
 *
 * Brute-force guard: max 5 attempts per OTP; exceeded attempts delete the code
 * and require the member to restart the login flow.
 */

import { redis } from "../lib/redis.js";

const OTP_TTL_SECONDS = 300; // 5 minutes
const MAX_ATTEMPTS = 5;

function otpKey(memberId: string | number): string {
	return `login_otp:${memberId}`;
}

function attemptsKey(memberId: string | number): string {
	return `login_otp_attempts:${memberId}`;
}

/** Generate a random 6-digit code, store it in Redis, return the code. */
export async function generateAndStoreOtp(
	memberId: string | number,
): Promise<string> {
	const code = String(Math.floor(100000 + Math.random() * 900000));
	const r = redis();
	// Store the code and reset any prior attempt counter in parallel.
	await Promise.all([
		r.setex(otpKey(memberId), OTP_TTL_SECONDS, code),
		r.del(attemptsKey(memberId)),
	]);
	return code;
}

export type OtpVerifyResult =
	| { ok: true }
	| { ok: false; reason: "invalid" | "expired" | "locked" };

/**
 * Verify a submitted code against what is stored in Redis.
 * Returns { ok: true } on success (and clears the key).
 * Returns { ok: false, reason } on failure — callers map to 401/429.
 */
export async function verifyOtp(
	memberId: string | number,
	submitted: string,
): Promise<OtpVerifyResult> {
	const r = redis();
	const stored = await r.get(otpKey(memberId));

	if (!stored) {
		return { ok: false, reason: "expired" };
	}

	// Increment attempt counter first (before comparing) to prevent timing attacks.
	const attempts = await r.incr(attemptsKey(memberId));
	// Keep the attempts key alive at least as long as the OTP key.
	await r.expire(attemptsKey(memberId), OTP_TTL_SECONDS);

	if (attempts > MAX_ATTEMPTS) {
		// Locked out — delete the OTP so the user must restart.
		await r.del(otpKey(memberId));
		return { ok: false, reason: "locked" };
	}

	if (submitted !== stored) {
		return { ok: false, reason: "invalid" };
	}

	// Success — clean up both keys.
	await r.del(otpKey(memberId), attemptsKey(memberId));
	return { ok: true };
}
