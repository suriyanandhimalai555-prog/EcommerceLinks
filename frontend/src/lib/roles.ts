import type { Me } from '../types/api'

/**
 * Single source of truth for role semantics. `management` is the off-tree
 * master account; `admin` is member-staff it appoints; everyone else is a
 * plain member.
 */
export const isManagement = (me?: Me | null): boolean => me?.role === 'management'

export const isStaff = (me?: Me | null): boolean =>
  me?.role === 'admin' || me?.role === 'management'

/** Where an account lands after login (staff have no use for the member dashboard). */
export const homeFor = (role?: Me['role']): string =>
  role === 'admin' || role === 'management' ? '/admin' : '/'
