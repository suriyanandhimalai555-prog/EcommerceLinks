import { pool } from "../src/lib/db.js";
import { confirmOrder } from "../src/services/orderService.js";
import { registerMember } from "../src/services/placement.js";
import "dotenv/config";

const N = parseInt(process.argv[2] ?? "10", 10);

interface Member {
	id: string;
	memberCode: string;
	name: string;
}

async function simulate() {
	// BFS over open slots: every member refers at most 2 people (L then R).
	// Seed the queue from members that still have a free binary slot so the
	// script is re-runnable against a non-empty tree.
	const { rows: openRows } = await pool().query<{
		id: string;
		member_code: string;
		kids: string;
	}>(
		`SELECT m.id, m.member_code, COUNT(c.id) AS kids
     FROM members m
     LEFT JOIN members c ON c.parent_id = m.id
     GROUP BY m.id, m.member_code
     HAVING COUNT(c.id) < 2
     ORDER BY m.id
     LIMIT $1`,
		[N + 1],
	);
	if (!openRows[0]) throw new Error("Run scripts/seedRoot.ts first");

	console.log(
		`Simulating ${N} members (BFS from ${openRows[0].member_code}, 2-referral cap)`,
	);

	const queue: Member[] = openRows.map((r) => ({
		id: r.id,
		memberCode: r.member_code,
		name: "Existing",
	}));
	const childCount = new Map<string, number>(
		openRows.map((r) => [r.id, Number(r.kids)]),
	);
	const runTag = Date.now().toString().slice(-6);

	for (let i = 0; i < N; i++) {
		const sponsor = queue[0];
		if (!sponsor) throw new Error("BFS queue exhausted — no open slots left");

		try {
			const { memberId, memberCode } = await registerMember({
				sponsorCode: sponsor.memberCode,
				name: `Sim Member ${i + 1}`,
				phone: `9${runTag}${String(i + 1).padStart(3, "0")}`,
				email: `sim${runTag}-${i + 1}@sim.avg`,
				password: "Sim@12345",
			});

			// Simulate first product payment (Starter ₹10,000)
			const { rows: orderRows } = await pool().query<{ id: string }>(
				`INSERT INTO orders (member_id, product_id, base_amount, gst_amount, total_amount, idempotency_key)
         VALUES ($1, 1, 10000, 1800, 11800, $2) RETURNING id`,
				[memberId, `sim-${memberCode}-${Date.now()}`],
			);

			await confirmOrder(
				`sim-gw-${orderRows[0].id}`,
				BigInt(orderRows[0].id),
				`sim-ref-${orderRows[0].id}`,
			);

			queue.push({
				id: String(memberId),
				memberCode,
				name: `Sim Member ${i + 1}`,
			});
			const n = (childCount.get(sponsor.id) ?? 0) + 1;
			childCount.set(sponsor.id, n);
			if (n >= 2) queue.shift();
			if ((i + 1) % 10 === 0)
				console.log(`  ${i + 1}/${N} registered + activated`);
		} catch (err: unknown) {
			const e = err as { message?: string; statusCode?: number };
			if (e.statusCode === 409 && /referral limit/i.test(e.message ?? "")) {
				// Sponsor's slots were already partly filled before this run — move on
				queue.shift();
				i--;
				continue;
			}
			console.warn(`  [${i}] skipped: ${e.message}`);
		}
	}

	// Drain: wait 3s for workers to process outbox (in a real test, poll instead)
	console.log("Waiting 3s for worker pipeline...");
	await new Promise((r) => setTimeout(r, 3000));

	// Print top 5 members by pairs_matched
	const { rows: top } = await pool().query(
		`SELECT m.member_code, mc.left_active, mc.right_active, mc.pairs_matched,
            mc.left_qualified, mc.right_qualified,
            COALESCE(wb.balance, 0) AS wallet
     FROM member_counters mc
     JOIN members m ON m.id = mc.member_id
     LEFT JOIN accounts a ON a.owner_id = m.id AND a.kind='wallet'
     LEFT JOIN wallet_balances wb ON wb.account_id = a.id
     ORDER BY mc.pairs_matched DESC
     LIMIT 5`,
	);
	console.log("\nTop 5 by pairs_matched:");
	for (const r of top) {
		console.log(
			`  ${r.member_code}: L=${r.left_active} R=${r.right_active} pairs=${r.pairs_matched} qualL=${r.left_qualified} qualR=${r.right_qualified} wallet=₹${r.wallet}`,
		);
	}

	await pool().end();
}

simulate().catch((err) => {
	console.error("simulate failed:", err);
	process.exit(1);
});
