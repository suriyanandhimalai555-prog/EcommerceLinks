/**
 * settings.ts — runtime key/value system settings backed by system_settings table.
 *
 * Reads go straight to the DB (indexed PK lookup — cheap and always fresh).
 * Writes are done inside the caller's transaction so they can be bundled with
 * admin_audit_log insertions.
 */

import type { PoolClient } from "pg";
import { pool } from "../lib/db.js";

// Typed defaults — returned when the key row is absent (e.g. before migration runs).
const DEFAULTS: Record<string, unknown> = {
	kyc_optional: false,
	welcome_email_enabled: false,
	login_otp_enabled: false,
};

/** Read a single setting. Returns the stored JSONB value (already parsed by pg). */
export async function getSetting<T = unknown>(key: string): Promise<T> {
	const { rows } = await pool().query<{ value: T }>(
		"SELECT value FROM system_settings WHERE key = $1",
		[key],
	);
	if (rows.length === 0) return DEFAULTS[key] as T ?? null as T;
	return rows[0].value;
}

/** Read all settings as a plain object (camelCase mapping happens at the route layer). */
export async function getAllSettings(): Promise<Record<string, unknown>> {
	const { rows } = await pool().query<{ key: string; value: unknown }>(
		"SELECT key, value FROM system_settings ORDER BY key",
	);
	const result: Record<string, unknown> = { ...DEFAULTS };
	for (const row of rows) result[row.key] = row.value;
	return result;
}

/**
 * Update a setting — must run inside the caller's withTxn so audit log can be
 * written in the same transaction.  Returns { before, after } for audit.
 */
export async function setSetting(
	c: PoolClient,
	key: string,
	value: unknown,
	actorId: string,
): Promise<{ before: unknown; after: unknown }> {
	// Lock the row and get current value.
	const { rows: existing } = await c.query<{ value: unknown }>(
		"SELECT value FROM system_settings WHERE key = $1 FOR UPDATE",
		[key],
	);
	const before = existing[0]?.value ?? DEFAULTS[key] ?? null;

	if (existing.length === 0) {
		await c.query(
			"INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)",
			[key, JSON.stringify(value), actorId],
		);
	} else {
		await c.query(
			"UPDATE system_settings SET value = $2::jsonb, updated_at = now(), updated_by = $3 WHERE key = $1",
			[key, JSON.stringify(value), actorId],
		);
	}

	return { before, after: value };
}
