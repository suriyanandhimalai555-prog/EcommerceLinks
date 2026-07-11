import { isAxiosError } from 'axios'
import type { TFunction } from 'i18next'

/**
 * Map an API failure to a human-readable message for auth/form pages:
 * the backend-provided message when there is one, otherwise the failure
 * category (network unreachable / rate limited / server error / validation).
 */
export function apiErrorMessage(err: unknown, t: TFunction, fallback: string): string {
  if (isAxiosError(err)) {
    if (!err.response) return t('errors.network')
    const { status, data } = err.response
    const serverError = (data as { error?: unknown } | undefined)?.error

    if (typeof serverError === 'string' && serverError) return serverError

    // Zod safeParse failures arrive as error.flatten():
    // { formErrors: string[], fieldErrors: Record<string, string[]> }
    if (serverError && typeof serverError === 'object') {
      const flat = serverError as { formErrors?: string[]; fieldErrors?: Record<string, string[]> }
      const details = [
        ...(flat.formErrors ?? []),
        ...Object.entries(flat.fieldErrors ?? {}).map(([field, msgs]) => `${field}: ${msgs.join(', ')}`),
      ]
      if (details.length) return `${t('errors.validation')} — ${details.join('; ')}`
    }

    if (status === 429) return t('errors.tooMany')
    if (status >= 500) return t('errors.server')
  }
  return fallback
}
