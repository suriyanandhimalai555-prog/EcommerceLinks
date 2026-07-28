/**
 * Integration tests for product PDF attachments (migration 037).
 *
 * Management uploads PDFs separately from images; GET /products/:id returns them
 * as `documents[]` with the original filename and a presigned URL. S3 is mocked
 * here so `assertValidDocs`/`documentsByProduct` run without real AWS creds.
 *
 * Requires: Postgres running, migrations applied, root + management seeded.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeAll, vi } from 'vitest'

// Mock only the S3 side-effects; keep buildKey / regexes / sanitizeDownloadName real.
vi.mock('../../src/lib/s3.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/lib/s3.js')>()
  return {
    ...actual,
    s3Configured: () => true,
    objectExists: async () => true,
    presignGet: async (key: string, _expires?: number, name?: string) =>
      `https://s3.test/${key}?name=${encodeURIComponent(name ?? '')}`,
    presignUpload: async (key: string) => ({ key, url: 'https://s3.test', fields: {} }),
    deleteObject: vi.fn(async () => {}),
  }
})

import { app } from '../../src/api/server.js'
import { pool } from '../../src/lib/db.js'
import * as s3 from '../../src/lib/s3.js'

function signToken(memberId: bigint, memberCode: string, name: string): string {
  return app.jwt.sign({ sub: String(memberId), code: memberCode, name })
}

function docKey(): string {
  return `product-docs/${randomUUID()}.pdf`
}

let mgmtToken: string

async function createProduct(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/admin/products',
    headers: { authorization: `Bearer ${mgmtToken}` },
    payload: { name: `PDoc-${Date.now()}-${Math.random()}`, basePricePaise: 100000, ...payload },
  })
}

beforeAll(async () => {
  await app.ready()
  const { rows } = await pool().query<{ id: string; member_code: string }>(
    "SELECT id, member_code FROM members WHERE role = 'management' LIMIT 1",
  )
  if (!rows[0]) {
    console.warn('[productDocuments] management account not found — run npm run seed:management')
    return
  }
  mgmtToken = signToken(BigInt(rows[0].id), rows[0].member_code, 'AVG Management')
})

describe('Product PDF attachments', () => {
  it('creates a product with documents and returns them (ordered, with name + url) from GET /products/:id', async () => {
    if (!mgmtToken) return
    const k1 = docKey()
    const k2 = docKey()
    const create = await createProduct({
      description: 'has docs',
      active: true,
      imageKeys: [],
      documents: [
        { key: k1, name: 'Datasheet.pdf' },
        { key: k2, name: 'Warranty.pdf' },
      ],
    })
    expect(create.statusCode).toBe(201)
    const id = JSON.parse(create.body).id

    const get = await app.inject({ method: 'GET', url: `/products/${id}` })
    expect(get.statusCode).toBe(200)
    const body = JSON.parse(get.body)
    expect(body.documents).toHaveLength(2)
    expect(body.documents[0].name).toBe('Datasheet.pdf')
    expect(body.documents[1].name).toBe('Warranty.pdf')
    expect(body.documents[0].sortOrder).toBe(0)
    expect(body.documents[1].sortOrder).toBe(1)
    expect(body.documents[0].url).toContain('https://s3.test/product-docs/')
    // The response must NOT leak the raw S3 key to the member.
    expect(body.documents[0].key).toBeUndefined()

    await pool().query('DELETE FROM products WHERE id=$1', [id])
  })

  it('rejects a document key with a foreign/invalid prefix (400)', async () => {
    if (!mgmtToken) return
    const res = await createProduct({
      imageKeys: [],
      documents: [{ key: 'products/not-a-doc.pdf', name: 'x.pdf' }],
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects duplicate document keys (400)', async () => {
    if (!mgmtToken) return
    const k = docKey()
    const res = await createProduct({
      imageKeys: [],
      documents: [
        { key: k, name: 'a.pdf' },
        { key: k, name: 'b.pdf' },
      ],
    })
    expect(res.statusCode).toBe(400)
  })

  it('sanitizes the original filename (strips path separators / quotes)', async () => {
    if (!mgmtToken) return
    const k = docKey()
    const create = await createProduct({
      imageKeys: [],
      documents: [{ key: k, name: '../../etc/pa"ss.pdf' }],
    })
    expect(create.statusCode).toBe(201)
    const id = JSON.parse(create.body).id
    const { rows } = await pool().query<{ original_name: string }>(
      'SELECT original_name FROM product_documents WHERE product_id=$1',
      [id],
    )
    expect(rows[0].original_name).toBe('....etcpass.pdf') // slashes + quote removed
    await pool().query('DELETE FROM products WHERE id=$1', [id])
  })

  it('deleteProduct cleans up the document S3 objects (best-effort deleteObject called)', async () => {
    if (!mgmtToken) return
    const k = docKey()
    const create = await createProduct({ imageKeys: [], documents: [{ key: k, name: 'Manual.pdf' }] })
    const id = JSON.parse(create.body).id

    vi.mocked(s3.deleteObject).mockClear()
    const del = await app.inject({
      method: 'DELETE',
      url: `/admin/products/${id}`,
      headers: { authorization: `Bearer ${mgmtToken}` },
    })
    expect(del.statusCode).toBe(200)
    expect(vi.mocked(s3.deleteObject)).toHaveBeenCalledWith(k)

    const { rows } = await pool().query('SELECT 1 FROM product_documents WHERE s3_key=$1', [k])
    expect(rows.length).toBe(0) // cascaded away with the product
  })
})
