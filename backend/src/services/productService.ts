import type { PoolClient } from "pg";
import { pool, withTxn } from "../lib/db.js";
import { fromPaise, toPaise } from "../lib/money.js";
import {
	deleteObject,
	objectExists,
	presignGet,
	PRODUCT_KEY_RE,
} from "../lib/s3.js";

export interface ProductImage {
	id: string;
	key: string;
	url: string;
	sortOrder: number;
}

export interface AdminProduct {
	id: number;
	name: string;
	description: string;
	basePricePaise: number;
	active: boolean;
	images: ProductImage[];
}

function httpError(message: string, statusCode: number): Error {
	return Object.assign(new Error(message), { statusCode });
}

/** Ordered images for a set of products, keyed by product id. */
export async function imagesByProduct(
	productIds: number[],
): Promise<Map<number, ProductImage[]>> {
	const map = new Map<number, ProductImage[]>();
	if (productIds.length === 0) return map;
	const { rows } = await pool().query<{
		id: string;
		product_id: number;
		s3_key: string;
		sort_order: number;
	}>(
		`SELECT id, product_id, s3_key, sort_order FROM product_images
     WHERE product_id = ANY($1) ORDER BY product_id, sort_order`,
		[productIds],
	);
	const presignedRows = await Promise.all(
		rows.map(async (r) => ({
			id: String(r.id),
			product_id: Number(r.product_id),
			key: r.s3_key,
			url: await presignGet(r.s3_key, 3600), // 1-hour presigned URL
			sortOrder: Number(r.sort_order),
		}))
	);
	for (const r of presignedRows) {
		const list = map.get(r.product_id) ?? [];
		list.push({ id: r.id, key: r.key, url: r.url, sortOrder: r.sortOrder });
		map.set(r.product_id, list);
	}
	return map;
}

export async function listAdminProducts(): Promise<AdminProduct[]> {
	const { rows } = await pool().query<{
		id: number;
		name: string;
		description: string;
		base_price: string;
		active: boolean;
	}>(
		"SELECT id, name, description, base_price, active FROM products ORDER BY id",
	);
	const images = await imagesByProduct(rows.map((p) => Number(p.id)));
	return rows.map((p) => ({
		id: Number(p.id),
		name: p.name,
		description: p.description,
		basePricePaise: Number(toPaise(p.base_price)),
		active: p.active,
		images: images.get(Number(p.id)) ?? [],
	}));
}

// Only keys minted by our own presign route are accepted; anything else
// (foreign prefixes, path tricks, unuploaded keys) is rejected before the txn.
async function assertValidImageKeys(keys: string[]): Promise<void> {
	for (const key of keys) {
		if (!PRODUCT_KEY_RE.test(key))
			throw httpError(`Invalid image key: ${key}`, 400);
		if (!(await objectExists(key)))
			throw httpError(`Image not found in storage: ${key}`, 400);
	}
	if (new Set(keys).size !== keys.length)
		throw httpError("Duplicate image keys", 400);
}

async function writeAudit(
	c: PoolClient,
	actorId: string,
	action: string,
	targetId: string,
	before: unknown,
	after: unknown,
): Promise<void> {
	await c.query(
		`INSERT INTO admin_audit_log
       (actor_id, action, target_type, target_id, before_state, after_state)
     VALUES ($1,$2,'product',$3,$4,$5)`,
		[actorId, action, targetId, before, after],
	);
}

export interface ProductInput {
	name: string;
	description: string;
	basePricePaise: number;
	active: boolean;
	imageKeys: string[];
}

export async function createProduct(
	actorId: string,
	d: ProductInput,
): Promise<number> {
	await assertValidImageKeys(d.imageKeys);
	return withTxn(async (c) => {
		const { rows } = await c.query<{ id: number }>(
			`INSERT INTO products (name, description, base_price, active)
       VALUES ($1,$2,$3,$4) RETURNING id`,
			[d.name, d.description, fromPaise(BigInt(d.basePricePaise)), d.active],
		);
		const id = Number(rows[0].id);
		for (let i = 0; i < d.imageKeys.length; i++) {
			await c.query(
				"INSERT INTO product_images (product_id, s3_key, sort_order) VALUES ($1,$2,$3)",
				[id, d.imageKeys[i], i],
			);
		}
		await writeAudit(c, actorId, "create_product", String(id), null, {
			name: d.name,
			description: d.description,
			basePricePaise: d.basePricePaise,
			active: d.active,
			imageKeys: d.imageKeys,
		});
		return id;
	});
}

export async function updateProduct(
	actorId: string,
	id: number,
	d: Partial<ProductInput>,
): Promise<void> {
	if (d.imageKeys !== undefined) await assertValidImageKeys(d.imageKeys);

	// S3 deletes cannot join the txn — collect and delete only after commit.
	const removedKeys: string[] = [];

	await withTxn(async (c) => {
		const { rows: before } = await c.query<{
			name: string;
			description: string;
			base_price: string;
			active: boolean;
		}>(
			"SELECT name, description, base_price, active FROM products WHERE id=$1 FOR UPDATE",
			[id],
		);
		if (!before[0]) throw httpError("Product not found", 404);

		const setClauses: string[] = [];
		const values: unknown[] = [];
		if (d.name !== undefined) setClauses.push(`name=$${values.push(d.name)}`);
		if (d.description !== undefined)
			setClauses.push(`description=$${values.push(d.description)}`);
		if (d.basePricePaise !== undefined)
			setClauses.push(
				`base_price=$${values.push(fromPaise(BigInt(d.basePricePaise)))}`,
			);
		if (d.active !== undefined)
			setClauses.push(`active=$${values.push(d.active)}`);
		if (setClauses.length > 0) {
			values.push(id);
			await c.query(
				`UPDATE products SET ${setClauses.join(", ")} WHERE id=$${values.length}`,
				values,
			);
		}

		if (d.imageKeys !== undefined) {
			// imageKeys is the full ordered replacement set.
			const { rows: existing } = await c.query<{ s3_key: string }>(
				"SELECT s3_key FROM product_images WHERE product_id=$1",
				[id],
			);
			const next = new Set(d.imageKeys);
			for (const r of existing) {
				if (!next.has(r.s3_key)) removedKeys.push(r.s3_key);
			}
			await c.query("DELETE FROM product_images WHERE product_id=$1", [id]);
			for (let i = 0; i < d.imageKeys.length; i++) {
				await c.query(
					"INSERT INTO product_images (product_id, s3_key, sort_order) VALUES ($1,$2,$3)",
					[id, d.imageKeys[i], i],
				);
			}
		}

		await writeAudit(
			c,
			actorId,
			"patch_product",
			String(id),
			{
				name: before[0].name,
				description: before[0].description,
				basePricePaise: Number(toPaise(before[0].base_price)),
				active: before[0].active,
			},
			d,
		);
	});

	for (const key of removedKeys) await deleteObject(key);
}
