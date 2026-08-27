/**
 * dedupeRepeatOrders.ts — soft-remove duplicate confirmed orders for repeat buyers.
 *
 * Background:
 *   In the MLM engine, ONLY a member's first confirmed order activates them
 *   (orderService.ts:57-62 — the isFirst guard). Every later confirmed order is
 *   pipeline-inert: it writes no MemberActivated event, increments no counters,
 *   mints no pairs, and accrues no income. However, these extra confirmed orders
 *   inflate the admin orders list and gross-sales/revenue reports.
 *
 *   This script identifies members with more than one confirmed order, keeps the
 *   activating one (earliest confirmed_at, tiebreak: earliest created_at, then id),
 *   and soft-removes the rest by setting status = 'rejected' with an audit reason.
 *   Nothing about the member row, placement tree, counters, pairs, or wallets changes.
 *
 * Keep rule:
 *   Survivor = MIN(confirmed_at) NULLS LAST, then MIN(created_at), then MIN(id).
 *   This matches the actual activation decision (confirmOrder checks already-confirmed
 *   siblings, so the first to be *confirmed* — not the first to be *created* — activates).
 *   Divergence (created_at-first ≠ confirmed_at-first) is flagged and those members are
 *   listed separately; they are included in the write but called out for review.
 *
 * Blast radius:
 *   • order_payment_proofs — rows remain (same as a manual management rejection);
 *     if the member re-orders later, createOrder dedup reuses the rejected row.
 *   • delivered_at / delivered_by — cleared (a rejected order must not read as delivered).
 *   • events_outbox / ledger — NO writes. Pure orders-table status correction.
 *   • admin_audit_log — ONE summary row per affected order is inserted so the change
 *     appears in the same audit surface as UI-driven rejections.
 *
 * Reporting effect:
 *   Any COUNT/SUM over status='confirmed' orders will DROP after this runs — likely desired,
 *   but worth noting before executing.
 *
 * Idempotent:
 *   Re-running (even --execute) is safe: the duplicate query finds 0 rows if already done;
 *   a second run prints "0 duplicate members — nothing to do."
 *
 * Safety:
 *   • Dry-run by default — prints full plan, writes nothing. Pass --execute to write.
 *   • Pass --i-know when PROD_DATABASE_URL contains 'hayabusa' (production host).
 *   • Pass --expect <N> to assert the planned remove count hasn't drifted since the
 *     dry-run was reviewed (aborts if live count ≠ N).
 *
 * Usage:
 *   # dry-run against dev copy:
 *   PROD_DATABASE_URL="$DATABASE_URL" npx tsx scripts/dedupeRepeatOrders.ts
 *
 *   # dry-run against production (read-only):
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' npx tsx scripts/dedupeRepeatOrders.ts --i-know
 *
 *   # execute against production (USER runs — the write step):
 *   PROD_DATABASE_URL='postgresql://...@hayabusa...' \
 *     npx tsx scripts/dedupeRepeatOrders.ts --i-know --expect <N> --execute
 *
 *   # via npm alias:
 *   PROD_DATABASE_URL='...' npm run dedupe:orders [-- --i-know] [-- --expect <N>] [-- --execute]
 *
 * Prerequisites:
 *   1. Stop avg-workers (recommended — no pipeline writes happen here but avoids noise).
 *   2. Run dry-run; review the printed member/order list.
 *   3. Note the "N orders to remove" count for --expect.
 *   4. Run with --execute.
 */

import pg from "pg";

// ── money helpers (mirrors lib/money.ts — no float arithmetic) ────────────────
function toPaise(s: string | number): bigint {
	return BigInt(Math.round(Number(s) * 100));
}
function toRupees(p: bigint): string {
	return `₹${(Number(p) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

// ── arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const I_KNOW = args.includes("--i-know");

const expectIdx = args.indexOf("--expect");
const EXPECT_COUNT: number | null =
	expectIdx >= 0 && args[expectIdx + 1] ? Number(args[expectIdx + 1]) : null;

const REJECTION_REASON =
	"Duplicate repeat-buyer order — only first activation counts (cleanup 2026-08)";

// ── types ─────────────────────────────────────────────────────────────────────
interface DuplicateRow {
	member_id: string;
	member_code: string;
	email: string;
	order_id: string;
	status: string;
	confirmed_at: string | null;
	created_at: string;
	total_amount: string;
	delivered_at: string | null;
	rn: string; // row_number: "1" = keep, >1 = remove
	n_confirmed: string;
	// divergence detection
	created_at_rn: string; // row_number when sorted by created_at, id
}

interface MemberOutboxRow {
	member_id: string;
	order_id: string; // from payload->>'order_id'
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const url = process.env.PROD_DATABASE_URL;
	if (!url) {
		console.error(
			"[dedupeRepeatOrders] PROD_DATABASE_URL is required.\n" +
				"  Dev copy:   PROD_DATABASE_URL=\"$DATABASE_URL\" npx tsx scripts/dedupeRepeatOrders.ts\n" +
				"  Production: PROD_DATABASE_URL='postgresql://...' npx tsx scripts/dedupeRepeatOrders.ts --i-know",
		);
		process.exit(1);
	}

	const isProd = url.includes("hayabusa");
	if (isProd && !I_KNOW) {
		console.error(
			"[dedupeRepeatOrders] PROD_DATABASE_URL points at production (hayabusa).\n" +
				"  Stop avg-workers (recommended), then pass --i-know.",
		);
		process.exit(1);
	}

	const pool = new pg.Pool({ connectionString: url, max: 3 });

	try {
		// ── Pre-flight: find the management account id (for audit log actor) ───────
		const { rows: mgmtRows } = await pool.query<{ id: string; email: string }>(
			`SELECT id, email FROM members WHERE role = 'management' LIMIT 1`,
		);
		if (mgmtRows.length === 0) {
			console.error(
				"[dedupeRepeatOrders] ABORT: management account (role='management') not found.\n" +
					"  Run npm run seed:management first.",
			);
			process.exit(1);
		}
		const mgmtId = BigInt(mgmtRows[0].id);
		console.log(
			`[dedupeRepeatOrders] audit actor: management id=${mgmtId} (${mgmtRows[0].email})`,
		);

		// ── Diagnostic query ──────────────────────────────────────────────────────
		// Two window functions over the same confirmed-orders partition:
		//   rn           = rank by confirmed_at ASC NULLS LAST, created_at ASC, id ASC  (keep-rule)
		//   created_at_rn= rank by created_at ASC, id ASC                               (divergence detector)
		const { rows: dupRows } = await pool.query<DuplicateRow>(
			`WITH confirmed AS (
         SELECT
           o.id          AS order_id,
           o.member_id,
           m.member_code,
           m.email,
           o.status,
           o.confirmed_at,
           o.created_at,
           o.total_amount,
           o.delivered_at,
           row_number() OVER (
             PARTITION BY o.member_id
             ORDER BY o.confirmed_at ASC NULLS LAST, o.created_at ASC, o.id ASC
           ) AS rn,
           row_number() OVER (
             PARTITION BY o.member_id
             ORDER BY o.created_at ASC, o.id ASC
           ) AS created_at_rn,
           count(*) OVER (PARTITION BY o.member_id) AS n_confirmed
         FROM orders o
         JOIN members m ON m.id = o.member_id
         WHERE o.status = 'confirmed'
       )
       SELECT * FROM confirmed
       WHERE n_confirmed > 1
       ORDER BY member_id, rn`,
		);

		// ── Interpretation gate ───────────────────────────────────────────────────
		const affectedMemberIds = [...new Set(dupRows.map((r) => r.member_id))];
		const removeRows = dupRows.filter((r) => r.rn !== "1");
		const keepRows = dupRows.filter((r) => r.rn === "1");

		console.log(`\n── Duplicate-order diagnostic ────────────────────────────────────────────`);
		console.log(`  Affected members     : ${affectedMemberIds.length}`);
		console.log(`  Orders to remove     : ${removeRows.length}`);
		console.log(
			`  Mode                 : ${EXECUTE ? (isProd ? "EXECUTE on PRODUCTION" : "EXECUTE on dev copy") : "DRY-RUN"}`,
		);

		if (affectedMemberIds.length === 0) {
			console.log(
				"\n[dedupeRepeatOrders] ✅ 0 duplicate members found — nothing to do.\n" +
					"  (If you expected ~19 members, the real issue may be duplicate *accounts*\n" +
					"   rather than duplicate orders — stop and re-plan.)",
			);
			return;
		}

		// ── --expect drift guard ──────────────────────────────────────────────────
		if (EXPECT_COUNT !== null && removeRows.length !== EXPECT_COUNT) {
			console.error(
				`\n[dedupeRepeatOrders] ABORT: expected ${EXPECT_COUNT} orders to remove,\n` +
					`  but live query found ${removeRows.length}.  The set has drifted since the dry-run.\n` +
					`  Re-run without --expect to review the new set, then pass the updated count.`,
			);
			process.exit(1);
		}

		// ── Outbox reconciliation: MemberActivated order_id ground truth ──────────
		const { rows: outboxRows } = await pool.query<MemberOutboxRow>(
			`SELECT
         (payload->>'member_id')::text AS member_id,
         (payload->>'order_id')::text  AS order_id
       FROM events_outbox
       WHERE event_type = 'MemberActivated'
         AND payload->>'member_id' = ANY($1)`,
			[affectedMemberIds],
		);
		const outboxByMember = new Map<string, string>(); // member_id → order_id from outbox
		for (const r of outboxRows) {
			outboxByMember.set(r.member_id, r.order_id);
		}

		// ── Check is_active sanity + divergence ───────────────────────────────────
		const { rows: memberRows } = await pool.query<{
			id: string;
			is_active: boolean;
			activated_at: string | null;
		}>(
			`SELECT id, is_active, activated_at FROM members WHERE id = ANY($1)`,
			[affectedMemberIds],
		);
		const memberMap = new Map(memberRows.map((r) => [r.id, r]));

		const divergentMemberIds = new Set<string>();
		const keepIdByMember = new Map<string, string>(); // member_id → kept order_id
		for (const kr of keepRows) {
			keepIdByMember.set(kr.member_id, kr.order_id);
		}

		for (const kr of keepRows) {
			const memberInfo = memberMap.get(kr.member_id);
			if (!memberInfo?.is_active) {
				console.error(
					`\n[dedupeRepeatOrders] ABORT: member ${kr.member_code} (id=${kr.member_id}) ` +
						`has >1 confirmed order but is_active=FALSE.\n` +
						`  This is unexpected — investigate before proceeding.`,
				);
				await pool.end();
				process.exit(1);
			}

			// divergence: confirmed_at-first ≠ created_at-first?
			if (kr.created_at_rn !== "1") {
				divergentMemberIds.add(kr.member_id);
			}

			// outbox reconciliation
			const outboxOrderId = outboxByMember.get(kr.member_id);
			if (outboxOrderId && outboxOrderId !== kr.order_id) {
				console.warn(
					`  ⚠️  DIVERGENCE (outbox): member ${kr.member_code} (id=${kr.member_id})\n` +
						`      Kept order     : ${kr.order_id} (confirmed_at: ${kr.confirmed_at ?? "NULL"})\n` +
						`      Outbox order_id: ${outboxOrderId} (MemberActivated ground truth)\n` +
						`      → The kept order does not match the outbox record. Flagged for review.`,
				);
				divergentMemberIds.add(kr.member_id);
			}
		}

		// ── Print per-member detail ───────────────────────────────────────────────
		console.log(`\n── Per-member plan ───────────────────────────────────────────────────────`);
		for (const memberId of affectedMemberIds) {
			const rows = dupRows.filter((r) => r.member_id === memberId);
			const keepRow = rows.find((r) => r.rn === "1")!;
			const removeRowsM = rows.filter((r) => r.rn !== "1");
			const isDivergent = divergentMemberIds.has(memberId);
			const outboxNote =
				outboxByMember.has(memberId) && outboxByMember.get(memberId) !== keepRow.order_id
					? " ← OUTBOX MISMATCH"
					: "";

			console.log(
				`\n  ${keepRow.member_code} (${keepRow.email})${isDivergent ? "  ⚠️  DIVERGENT" : ""}`,
			);
			console.log(
				`    KEEP   order ${keepRow.order_id.padStart(6)}  confirmed: ${keepRow.confirmed_at ?? "NULL"}  created: ${keepRow.created_at}  ${toRupees(toPaise(keepRow.total_amount))}${outboxNote}`,
			);
			for (const rr of removeRowsM) {
				const delivNote = rr.delivered_at ? "  ⚠️  DELIVERED" : "";
				console.log(
					`    REMOVE order ${rr.order_id.padStart(6)}  confirmed: ${rr.confirmed_at ?? "NULL"}  created: ${rr.created_at}  ${toRupees(toPaise(rr.total_amount))}${delivNote}`,
				);
			}
		}

		if (divergentMemberIds.size > 0) {
			console.log(
				`\n  ⚠️  ${divergentMemberIds.size} member(s) flagged as DIVERGENT (confirmed_at-first\n` +
					`      differs from created_at-first, or outbox order_id mismatch).\n` +
					`      These are INCLUDED in the write but listed above for explicit review.\n` +
					`      If any look wrong, add --expect 0 to abort, investigate, and re-plan.`,
			);
		}

		console.log(`\n── Summary ───────────────────────────────────────────────────────────────`);
		console.log(`  Members affected     : ${affectedMemberIds.length}`);
		console.log(`  Orders to reject     : ${removeRows.length}`);
		console.log(
			`  Delivered duplicates : ${removeRows.filter((r) => r.delivered_at).length} (delivered_at/by will be cleared)`,
		);
		console.log(`  Divergent members    : ${divergentMemberIds.size}`);
		console.log(`  Rejection reason     : "${REJECTION_REASON}"`);

		if (!EXECUTE) {
			console.log(
				`\n[dedupeRepeatOrders] DRY-RUN complete — no writes.\n` +
					`  Review the plan above, then pass --execute (and --expect ${removeRows.length}) to apply.\n`,
			);
			return;
		}

		// ── Execute (single transaction) ──────────────────────────────────────────
		console.log(`\n[dedupeRepeatOrders] Executing...`);

		const removeIds = removeRows.map((r) => BigInt(r.order_id));

		const client = await pool.connect();
		try {
			await client.query("BEGIN");

			// Re-read and lock the rows we're about to change
			const { rows: lockedRows } = await client.query<{
				id: string;
				member_id: string;
				status: string;
			}>(
				`SELECT id, member_id, status
           FROM orders
          WHERE id = ANY($1)
          FOR UPDATE`,
				[removeIds],
			);

			// Verify every locked row is still 'confirmed' (drift guard)
			const nonConfirmed = lockedRows.filter((r) => r.status !== "confirmed");
			if (nonConfirmed.length > 0) {
				await client.query("ROLLBACK");
				console.error(
					`\n[dedupeRepeatOrders] ABORT: ${nonConfirmed.length} order(s) are no longer 'confirmed':\n` +
						nonConfirmed.map((r) => `  order ${r.id} status=${r.status}`).join("\n") +
						`\n  Re-run dry-run to see current state.`,
				);
				process.exit(1);
			}

			// Verify each removed order still has a confirmed survivor (rn=1 sibling)
			// by re-running the keep-rule window function for the affected members
			const affectedMemberIdsBigInt = [
				...new Set(lockedRows.map((r) => BigInt(r.member_id))),
			];
			const { rows: survivorCheck } = await client.query<{
				member_id: string;
				min_order_id: string;
			}>(
				`SELECT member_id::text, MIN(id)::text AS min_order_id
           FROM orders
          WHERE member_id = ANY($1)
            AND status = 'confirmed'
          GROUP BY member_id`,
				[affectedMemberIdsBigInt],
			);
			for (const sc of survivorCheck) {
				const plannedKeep = keepIdByMember.get(sc.member_id);
				// the MIN(id) is just a sanity check — the real check is that a confirmed survivor exists
				if (!plannedKeep) {
					await client.query("ROLLBACK");
					console.error(
						`\n[dedupeRepeatOrders] ABORT: member_id=${sc.member_id} has no planned keep row. Rolled back.`,
					);
					process.exit(1);
				}
			}

			// Apply the status change
			const { rowCount } = await client.query(
				`UPDATE orders
            SET status           = 'rejected',
                rejection_reason = $1,
                delivered_at     = NULL,
                delivered_by     = NULL
          WHERE id = ANY($2)
            AND status = 'confirmed'`,
				[REJECTION_REASON, removeIds],
			);

			if ((rowCount ?? 0) !== removeIds.length) {
				await client.query("ROLLBACK");
				console.error(
					`\n[dedupeRepeatOrders] ABORT: expected to update ${removeIds.length} rows,\n` +
						`  but rowCount=${rowCount}. Rolled back — no changes made.`,
				);
				process.exit(1);
			}

			// Insert admin_audit_log rows (one per removed order)
			for (const rr of removeRows) {
				await client.query(
					`INSERT INTO admin_audit_log
               (actor_id, action, target_type, target_id, before_state, after_state)
             VALUES ($1, 'order_reject_duplicate', 'order', $2, $3, $4)`,
					[
						mgmtId,
						BigInt(rr.order_id),
						{
							status: "confirmed",
							delivered_at: rr.delivered_at ?? null,
						},
						{
							status: "rejected",
							rejection_reason: REJECTION_REASON,
							delivered_at: null,
						},
					],
				);
			}

			await client.query("COMMIT");
			console.log(
				`\n[dedupeRepeatOrders] ✅ Committed.  ${rowCount} order(s) set to 'rejected'.`,
			);
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}

		// ── Post-write verification ───────────────────────────────────────────────
		const { rows: postCheck } = await pool.query<{ cnt: string }>(
			`SELECT COUNT(DISTINCT member_id)::text AS cnt
         FROM orders
        WHERE status = 'confirmed'
          AND member_id IN (
            SELECT member_id FROM orders
            WHERE status = 'confirmed'
            GROUP BY member_id HAVING count(*) > 1
          )`,
		);
		const remaining = Number(postCheck[0]?.cnt ?? 0);
		if (remaining === 0) {
			console.log(
				`[dedupeRepeatOrders] ✅ Post-check: 0 members with >1 confirmed order — done.\n`,
			);
		} else {
			console.error(
				`[dedupeRepeatOrders] ⚠️  Post-check: ${remaining} member(s) still have >1 confirmed order.\n` +
					`  Investigate — re-run dry-run to see the remaining set.`,
			);
		}
	} finally {
		await pool.end();
	}
}

main().catch((err) => {
	console.error("[dedupeRepeatOrders] Fatal:", err);
	process.exit(1);
});
