import type { Me } from '../types/api'

/**
 * Single source of truth for role semantics.
 *   `management`  — off-tree master account; full admin control.
 *   `payout`      — off-tree withdrawal-marking account; withdrawals only.
 *   `admin`       — member-staff appointed by management.
 *   `member`      — regular tree member.
 */
export const isManagement = (me?: Me | null): boolean => me?.role === 'management'

/** True for the dedicated payout account (withdrawal-marking only). */
export const isPayout = (me?: Me | null): boolean => me?.role === 'payout'

/** True for any account that should have access to the admin console. */
export const isStaff = (me?: Me | null): boolean =>
  me?.role === 'admin' || me?.role === 'management' || me?.role === 'payout'

/** Where an account lands after login (staff have no use for the member dashboard). */
export const homeFor = (role?: Me['role']): string =>
  role === 'admin' || role === 'management' || role === 'payout' ? '/admin' : '/'
