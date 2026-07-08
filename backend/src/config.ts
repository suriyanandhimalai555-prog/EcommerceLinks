import 'dotenv/config'

function env(key: string, def: string): string {
  return process.env[key] ?? def
}

export const CFG = {
  PAIR_BONUS_PAISE:  parseInt(env('PAIR_BONUS_PAISE',  '100000')),
  CUTOFF_CAP_PAISE:  parseInt(env('CUTOFF_CAP_PAISE',  '10000000')),
  GST_PCT:           parseInt(env('GST_PCT',            '18')),
  TDS_PCT:           parseInt(env('TDS_PCT',            '5')),
  MIN_PAYOUT_PAISE:  parseInt(env('MIN_PAYOUT_PAISE',   '50000')),
  TZ:                env('TZ',            'Asia/Kolkata'),
  DATABASE_URL:      env('DATABASE_URL',  'postgresql://avg:avg@localhost:5432/avg'),
  JWT_SECRET:        env('JWT_SECRET',    'dev-secret-change-in-prod'),
  JWT_ACCESS_TTL:    '15m',
  JWT_REFRESH_TTL:   '30d',
  REDIS_URL:         env('REDIS_URL',     'redis://localhost:6379'),
  PORT:              parseInt(env('PORT', '3000')),
  NODE_ENV:          env('NODE_ENV', 'development'),
} as const
