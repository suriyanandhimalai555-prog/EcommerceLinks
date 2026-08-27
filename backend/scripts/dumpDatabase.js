#!/usr/bin/env node
/**
 * dumpDatabase.js — dump a Postgres database to a plain-SQL file locally.
 *
 * Designed for the production DB (hayabusa.proxy.rlwy.net:53263) but works
 * against any URL.  Shells out to pg_dump so the dump is faithful and restorable.
 *
 * Usage (run from backend/):
 *   # 1. Make sure PROD_DATABASE_URL is set in backend/.env (uncomment the
 *   #    production line), then:
 *   npm run db:dump -- --yes
 *
 *   # 2. Or pass the URL inline:
 *   npm run db:dump -- --url "postgresql://...@hayabusa..." --yes
 *
 *   # 3. Against the dev copy (no --yes needed; omit hayabusa guard):
 *   PROD_DATABASE_URL="$DATABASE_URL" node scripts/dumpDatabase.js
 *
 * Output: scripts/out/prod-dump-<YYYYMMDD-HHmmss>.sql  (git-ignored)
 *
 * Prerequisites:
 *   pg_dump >= 16 must be on PATH.  Install:
 *     brew install postgresql@16
 *     export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
 *   (or: brew install libpq && export PATH="/opt/homebrew/opt/libpq/bin:$PATH")
 */

import 'dotenv/config'
import { spawnSync, spawn } from 'child_process'
import { createInterface } from 'readline'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, statSync } from 'fs'

// ── Arg parsing ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const YES = args.includes('--yes') || args.includes('--i-know')

const urlIdx = args.indexOf('--url')
const urlArg = urlIdx >= 0 && args[urlIdx + 1] ? args[urlIdx + 1] : null

// ── Resolve connection string — prompt if not provided ────────────────────────
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()) })
  })
}

let connstr = urlArg ?? process.env.PROD_DATABASE_URL ?? null
if (!connstr) {
  connstr = await prompt('[db:dump] Enter the database URL: ')
  if (!connstr) {
    console.error('[db:dump] ERROR: No URL entered. Aborting.')
    process.exit(1)
  }
}

// ── Parse host for display / guard ────────────────────────────────────────────
let host = connstr
try { host = new URL(connstr).host } catch { /* non-standard URL shape */ }

// ── Production host guard ──────────────────────────────────────────────────────
const isProd = connstr.includes('hayabusa')
if (isProd && !YES) {
  console.error(
    `[db:dump] ERROR: URL points at the production host (${host}).\n\n` +
    '  A full dump can be several hundred MB.  Confirm with --yes:\n' +
    '      npm run db:dump -- --yes',
  )
  process.exit(1)
}

// ── Verify pg_dump is on PATH ──────────────────────────────────────────────────
const versionResult = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' })
if (versionResult.error) {
  console.error(
    '[db:dump] ERROR: pg_dump not found on PATH.\n\n' +
    '  Install PostgreSQL 16 client tools, then add to your shell profile:\n\n' +
    '    brew install postgresql@16\n' +
    '    export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"\n\n' +
    '  Alternatively:\n' +
    '    brew install libpq\n' +
    '    export PATH="/opt/homebrew/opt/libpq/bin:$PATH"',
  )
  process.exit(1)
}

// ── Version check — client must be >= server (Railway Postgres 16) ─────────────
const versionLine = versionResult.stdout.trim() // "pg_dump (PostgreSQL) 16.3"
const majorMatch = versionLine.match(/(\d+)\.\d+/)
const clientMajor = majorMatch ? parseInt(majorMatch[1], 10) : 0

console.log(`[db:dump] pg_dump: ${versionLine}`)

if (clientMajor < 16) {
  console.error(
    `[db:dump] ERROR: pg_dump client is v${clientMajor}, but the Railway server is v16.\n` +
    '  pg_dump refuses to dump a server newer than the client.\n\n' +
    '  Upgrade:\n' +
    '    brew install postgresql@16\n' +
    '    export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"',
  )
  process.exit(1)
}

// ── Build output path ─────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, 'out')
mkdirSync(outDir, { recursive: true })

const now = new Date()
const p = (n) => String(n).padStart(2, '0')
const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
const prefix = isProd ? 'prod' : 'dev'
const outFile = join(outDir, `${prefix}-dump-${ts}.sql`)

// ── Run pg_dump ───────────────────────────────────────────────────────────────
const label = isProd ? 'PRODUCTION' : 'dev copy'
console.log(`[db:dump] Dumping ${label} database — host: ${host}`)
console.log(`[db:dump] Output → ${outFile}`)
console.log('[db:dump] Running pg_dump… (may take a few minutes for a large DB)\n')

const child = spawn(
  'pg_dump',
  [
    `--dbname=${connstr}`,
    '--no-owner',         // don't emit SET ROLE — restores cleanly into any fresh DB
    '--no-privileges',    // skip GRANT/REVOKE — Railway role names won't exist locally
    '--format=plain',     // human-readable SQL, restorable with psql
    `--file=${outFile}`,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] }, // stream pg_dump stderr live
)

child.on('close', (code) => {
  if (code !== 0) {
    console.error(`\n[db:dump] ERROR: pg_dump exited with code ${code}`)
    process.exit(code ?? 1)
  }

  let sizeStr = '(unknown size)'
  try {
    const bytes = statSync(outFile).size
    if (bytes >= 1_048_576) sizeStr = `${(bytes / 1_048_576).toFixed(1)} MB`
    else if (bytes >= 1_024)  sizeStr = `${(bytes / 1_024).toFixed(1)} KB`
    else                      sizeStr = `${bytes} bytes`
  } catch { /* file stat failed — non-fatal */ }

  console.log(`\n[db:dump] ✅ Done — ${sizeStr}`)
  console.log(`[db:dump] File: ${outFile}`)
  console.log('[db:dump]')
  console.log('[db:dump] To restore into a local throwaway DB:')
  console.log(`[db:dump]   createdb mydb && psql mydb -f "${outFile}"`)
})
