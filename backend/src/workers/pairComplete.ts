import { randomUUID } from "crypto";
import { CFG } from "../config.js";
import { writeOutbox } from "../events/outbox.js";
import { TOPICS } from "../events/topics.js";
import type { AvgEvent } from "../events/types.js";
import { withTxn } from "../lib/db.js";
import { fromPaise } from "../lib/money.js";
import { startConsumer } from "../lib/streams.js";

const GROUP = "avg-pair-complete";

// On each activation, check the member's placement parent: if both L and R
// children are now active, the parent's (single) pair is complete — insert the
// pairs row and emit PairCompleted in the same transaction. Whichever sibling's
// activation event is consumed last necessarily sees both actives committed, so
// detection cannot miss; the parent row lock + ON CONFLICT make it fire once.
// The parent's own active/qualified status is NOT checked here — qualification
// gates the payout (pair_accruals release), not the accrual.
export async function detectPairCompletion(
	memberId: bigint,
	eventId: string,
): Promise<void> {
	await withTxn(async (c) => {
		const { rows: done } = await c.query(
			"SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2",
			[GROUP, eventId],
		);
		if (done.length > 0) return;

		const recordProcessed = () =>
			c.query(
				"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
				[GROUP, eventId],
			);

		const { rows: mRows } = await c.query<{ parent_id: string | null }>(
			"SELECT parent_id FROM members WHERE id=$1",
			[memberId],
		);
		const parentId = mRows[0]?.parent_id;
		if (!parentId) {
			// tree root (or missing row) — no parent to complete a pair for
			await recordProcessed();
			return;
		}

		// Serialize concurrent sibling activations on the parent's members row —
		// same explicit-lock pattern as registerMember's sponsor lock.
		await c.query("SELECT id FROM members WHERE id=$1 FOR UPDATE", [parentId]);

		const { rows: children } = await c.query<{
			id: string;
			position: string;
		}>("SELECT id, position FROM members WHERE parent_id=$1 AND is_active", [
			parentId,
		]);
		const left = children.find((r) => r.position === "L");
		const right = children.find((r) => r.position === "R");
		if (!left || !right) {
			await recordProcessed();
			return;
		}

		const { rows: pairRows } = await c.query<{ id: string }>(
			`INSERT INTO pairs (member_id, sequence_no, left_member_id, right_member_id, bonus_amount)
       VALUES ($1,1,$2,$3,$4)
       ON CONFLICT (member_id, sequence_no) DO NOTHING
       RETURNING id`,
			[parentId, left.id, right.id, fromPaise(BigInt(CFG.PAIR_BONUS_PAISE))],
		);
		if (pairRows[0]) {
			await writeOutbox(c, {
				event_id: randomUUID(),
				event_type: "PairCompleted",
				occurred_at: new Date().toISOString(),
				schema_version: 1,
				pair_id: Number(pairRows[0].id),
				member_id: Number(parentId),
				left_member_id: Number(left.id),
				right_member_id: Number(right.id),
				amount_paise: Number(CFG.PAIR_BONUS_PAISE),
			});
		}
		await recordProcessed();
	});
}

export async function run() {
	await startConsumer({
		stream: TOPICS.lifecycle.name,
		group: GROUP,
		mode: "message",
		onMessage: async (value) => {
			const e = JSON.parse(value) as AvgEvent;
			if (e.event_type !== "MemberActivated") return;
			await detectPairCompletion(BigInt(e.member_id), e.event_id);
		},
	});
}

const _argv1 = process.argv[1] ?? "";
if (_argv1.endsWith("pairComplete.ts") || _argv1.endsWith("pairComplete.js")) {
	run().catch((err) => {
		console.error("[pair-complete] fatal", err);
		process.exit(1);
	});
}
