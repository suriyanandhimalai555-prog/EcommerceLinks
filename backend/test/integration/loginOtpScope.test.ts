import { describe, it, expect, afterAll } from 'vitest'

/**
 * Guards the `scope` parameterization of loginOtp (added for password reset).
 *
 * Two properties matter:
 *   1. The default scope ("login") stores under the original `login_otp:*` keys,
 *      so the existing login flow is untouched.
 *   2. A "reset" scope is fully isolated — a reset code cannot be verified in the
 *      login scope and vice-versa. This is what keeps a password-reset code from
 *      ever being accepted as a login code.
 *
 * Needs Redis. We force a LOCAL Redis before config/dotenv resolves REDIS_URL
 * (dotenv does not override an already-set process.env var), keeping this test
 * off the shared Railway dev copy.
 */
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379'

const { generateAndStoreOtp, verifyOtp } = await import(
  '../../src/services/loginOtp.js'
)
const { redis } = await import('../../src/lib/redis.js')

const MEMBER = 'test-otp-scope-member'

describe('loginOtp scope isolation', () => {
  afterAll(async () => {
    const r = redis()
    await r.del(
      `login_otp:${MEMBER}`,
      `reset_otp:${MEMBER}`,
      `login_otp_attempts:${MEMBER}`,
      `reset_otp_attempts:${MEMBER}`,
    )
    await r.quit()
  })

  it('default scope stores under the original login_otp: key (backward compatible)', async () => {
    const code = await generateAndStoreOtp(MEMBER)
    expect(await redis().get(`login_otp:${MEMBER}`)).toBe(code)
  })

  it('a reset-scope code is invisible to the login scope, and verifies only under reset', async () => {
    await redis().del(`login_otp:${MEMBER}`, `reset_otp:${MEMBER}`)
    const resetCode = await generateAndStoreOtp(MEMBER, 'reset')

    // Stored under the isolated reset_otp: key, not login_otp:.
    expect(await redis().get(`reset_otp:${MEMBER}`)).toBe(resetCode)
    expect(await redis().get(`login_otp:${MEMBER}`)).toBeNull()

    // No login-scope code exists, so verifying the reset code against login fails.
    expect(await verifyOtp(MEMBER, resetCode, 'login')).toEqual({
      ok: false,
      reason: 'expired',
    })

    // The correct scope verifies and consumes the code.
    expect(await verifyOtp(MEMBER, resetCode, 'reset')).toEqual({ ok: true })

    // Consumed — a second verify sees nothing.
    expect(await verifyOtp(MEMBER, resetCode, 'reset')).toEqual({
      ok: false,
      reason: 'expired',
    })
  })
})
