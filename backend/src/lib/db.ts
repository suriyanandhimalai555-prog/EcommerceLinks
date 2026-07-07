import pg from 'pg'
import { CFG } from '../config.js'

// pg returns BIGINT columns as strings by default; parse them as strings and let
// callers convert to bigint explicitly — safer than auto-converting all int8.
// We do NOT override the global type parser to avoid breaking NUMERIC.

let _pool: pg.Pool | undefined

export function pool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: CFG.DATABASE_URL })
    _pool.on('error', (err) => {
      console.error('pg pool error', err)
    })
  }
  return _pool
}

export async function withTxn<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
