import type pg from "pg";
import { CFG } from "../config.js";
import { TOPICS } from "../events/topics.js";
import type {
	AvgEvent,
	DeferredSweepRequested,
	PairBonusAccrued,
	PendingBonusReleaseRequested,
	WithdrawableSweepRequested,
} from "../events/types.js";
import { withTxn } from "../lib/db.js";
import { txnUuid } from "../lib/ids.js";
import { fromPaise, toPaise } from "../lib/money.js";
import { startConsumer } from "../lib/streams.js";

const GROUP = "avg-ledger";

export interface LedgerLeg {
	accountId: bigint;
	direction: "D" | "C";
	amountPaise: bigint;
}

// Returns false if idempotencyKey already exists (skip). Enforces sum(D)=sum(C)>0.
export async function postLedgerTxn(
	c: pg.PoolClient,
	idempotencyKey: string,
	referenceType: string,
	referenceId: bigint | null,
	legs: LedgerLeg[],
): Promise<boolean> {
	const txnId = txnUuid(idempotencyKey);

	// Idempotency
	const { rows: existing } = await c.query(
		"SELECT 1 FROM ledger_txns WHERE idempotency_key=$1",
		[idempotencyKey],
	);
	if (existing.length > 0) return false;

	// Validate: sum of debits === sum of credits
	const debitTotal = legs
		.filter((l) => l.direction === "D")
		.reduce((s, l) => s + l.amountPaise, 0n);
	const creditTotal = legs
		.filter((l) => l.direction === "C")
		.reduce((s, l) => s + l.amountPaise, 0n);
	if (debitTotal !== creditTotal || debitTotal === 0n) {
		throw new Error(`Ledger imbalance: D=${debitTotal} C=${creditTotal}`);
	}

	await c.query(
		`INSERT INTO ledger_txns (txn_id, idempotency_key, reference_type, reference_id)
     VALUES ($1,$2,$3,$4)`,
		[txnId, idempotencyKey, referenceType, referenceId],
	);

	for (const leg of legs) {
		await c.query(
			`INSERT INTO ledger_entries (txn_id, account_id, direction, amount) VALUES ($1,$2,$3,$4)`,
			[txnId, leg.accountId, leg.direction, fromPaise(leg.amountPaise)],
		);
		// Update wallet_balances for wallet/deferred accounts
		const { rows: acRows } = await c.query<{ kind: string }>(
			"SELECT kind FROM accounts WHERE id=$1",
			[leg.accountId],
		);
		const kind = acRows[0]?.kind;
		if (kind === "wallet" || kind === "deferred_bonus" || kind === "withdrawable") {
			const signed =
				leg.direction === "C"
					? fromPaise(leg.amountPaise)
					: "-" + fromPaise(leg.amountPaise);
			await c.query(
				`UPDATE wallet_balances SET balance = balance + $1::numeric, updated_at = now() WHERE account_id = $2`,
				[signed, leg.accountId],
			);
		}
	}

	return true;
}

// Split a bonus into the amount that fits under the per-cutoff cap (wallet) and
// the overage above the cap. Pure — unit-tested in test/unit/ledger.test.ts.
// The overage is forfeited by creditBonusWithCap (see below).
export function splitAgainstCap(
	bonusPaise: bigint,
	alreadyEarnedPaise: bigint,
	capPaise: bigint,
): { walletAmt: bigint; overflowAmt: bigint } {
	const headroom = capPaise - alreadyEarnedPaise;
	const walletAmt =
		bonusPaise < headroom ? bonusPaise : headroom > 0n ? headroom : 0n;
	return { walletAmt, overflowAmt: bonusPaise - walletAmt };
}

// Credit a bonus to a member with per-cutoff cap enforcement: wallet up to the
// cap, and the overage above the ₹1 lakh weekly cap FORFEITED to the system
// bonus_forfeited account (it never reaches the member, but stays auditable).
// Runs inside the caller's transaction.
// Returns postLedgerTxn's result (false = idempotency-key hit, money already moved).
export async function creditBonusWithCap(
	c: pg.PoolClient,
	memberId: bigint,
	bonusPaise: bigint,
	idempotencyKey: string,
	referenceType: string,
	referenceId: bigint | null,
): Promise<boolean> {
	// Get member's wallet account
	const { rows: accs } = await c.query<{ id: string; kind: string }>(
		`SELECT id, kind FROM accounts WHERE owner_id=$1 AND kind='wallet'`,
		[memberId],
	);
	const walletAcc = accs.find((a) => a.kind === "wallet");
	if (!walletAcc)
		throw new Error(`Member ${memberId} has no wallet account`);
	const walletAccId = BigInt(walletAcc.id);

	// System bonus_expense (debit) + bonus_forfeited (overage sink) accounts.
	// bonus_forfeited is created by migration 036 — surface a clear error if it's
	// missing (code deployed ahead of the migration) rather than a raw TypeError
	// that would stall the ledger consumer on an opaque `.find(...)!` crash.
	const { rows: sysAcc } = await c.query<{ id: string; kind: string }>(
		`SELECT id, kind FROM accounts WHERE owner_type='system' AND kind IN ('bonus_expense','bonus_forfeited')`,
	);
	const expenseAcc = sysAcc.find((a) => a.kind === "bonus_expense");
	const forfeitedAcc = sysAcc.find((a) => a.kind === "bonus_forfeited");
	if (!expenseAcc)
		throw new Error("System bonus_expense account missing (run migrations)");
	if (!forfeitedAcc)
		throw new Error(
			"System bonus_forfeited account missing — run migration 036 before starting the ledger worker",
		);
	const expenseAccId = BigInt(expenseAcc.id);
	const forfeitedAccId = BigInt(forfeitedAcc.id);

	// Get or create cutoff_earnings for open cutoff
	const { rows: cutoffRows } = await c.query<{ id: string }>(
		`SELECT id FROM cutoffs WHERE status='open' LIMIT 1`,
	);
	if (!cutoffRows[0]) throw new Error("No open cutoff window");
	const cutoffId = BigInt(cutoffRows[0].id);

	// Lock cutoff_earnings row FOR UPDATE (insert if missing)
	await c.query(
		`INSERT INTO cutoff_earnings (member_id, cutoff_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
		[memberId, cutoffId],
	);
	const { rows: ceRows } = await c.query<{ earned: string }>(
		`SELECT earned FROM cutoff_earnings WHERE member_id=$1 AND cutoff_id=$2 FOR UPDATE`,
		[memberId, cutoffId],
	);
	const alreadyEarned = toPaise(ceRows[0].earned);
	const { walletAmt, overflowAmt } = splitAgainstCap(
		bonusPaise,
		alreadyEarned,
		BigInt(CFG.CUTOFF_CAP_PAISE),
	);

	// Double-entry: expense debited the full bonus; the part that fits under the
	// cap credits the member's wallet, the overage is forfeited to the system
	// bonus_forfeited account (D total === C total, always non-zero since bonuses
	// are ≥ ₹1000, so postLedgerTxn's idempotency behaves exactly as before).
	const legs: LedgerLeg[] = [
		{ accountId: expenseAccId, direction: "D", amountPaise: bonusPaise },
	];
	if (walletAmt > 0n)
		legs.push({
			accountId: walletAccId,
			direction: "C",
			amountPaise: walletAmt,
		});
	if (overflowAmt > 0n)
		legs.push({
			accountId: forfeitedAccId,
			direction: "C",
			amountPaise: overflowAmt,
		});

	// Phase 0.2: only update cutoff_earnings when the ledger txn is new.
	// If postLedgerTxn returns false (idempotency hit) the earnings row has already
	// been incremented by the original execution — updating again would double-count
	// against the cap on XAUTOCLAIM re-delivery. Only walletAmt counts toward the
	// cap; the forfeited overage is discarded and never tallied.
	const posted = await postLedgerTxn(
		c,
		idempotencyKey,
		referenceType,
		referenceId,
		legs,
	);
	if (posted) {
		await c.query(
			`UPDATE cutoff_earnings SET earned = earned + $1
         WHERE member_id=$2 AND cutoff_id=$3`,
			[fromPaise(walletAmt), memberId, cutoffId],
		);
	}
	return posted;
}

interface AccrualRow {
	id: string;
	pair_id: string;
	beneficiary_id: string;
	amount: string;
	release_seq: number;
}

// Pay one accrual and mark it released. The idempotency key is shared between
// the immediate path (accruePairBonus) and the retroactive path
// (releasePendingBonuses), so any interleaving posts the money exactly once;
// posted=false means a prior partial delivery already moved it.
// release_seq > 0 means an earlier release was clawed back (qualification
// revert); the key gains a :seq suffix so the old txn doesn't block re-credit.
async function releaseAccrual(c: pg.PoolClient, a: AccrualRow): Promise<void> {
	const key =
		a.release_seq > 0
			? `pairbonus:${a.pair_id}:${a.beneficiary_id}:${a.release_seq}`
			: `pairbonus:${a.pair_id}:${a.beneficiary_id}`;
	await creditBonusWithCap(
		c,
		BigInt(a.beneficiary_id),
		toPaise(a.amount),
		key,
		"pair",
		BigInt(a.id),
	);
	await c.query(
		`UPDATE pair_accruals SET status='released', released_at=now()
      WHERE id=$1 AND status='pending'`,
		[a.id],
	);
}

// Record the accrual for one beneficiary of a completed pair; pay immediately
// if the beneficiary is already qualified, otherwise leave it pending for
// releasePendingBonuses.
export async function accruePairBonus(e: PairBonusAccrued): Promise<void> {
	await withTxn(async (c) => {
		const { rows: done } = await c.query(
			"SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2",
			[GROUP, e.event_id],
		);
		if (done.length > 0) return;

		const { rows: ins } = await c.query<{ id: string }>(
			`INSERT INTO pair_accruals (pair_id, beneficiary_id, amount)
       VALUES ($1,$2,$3)
       ON CONFLICT (pair_id, beneficiary_id) DO NOTHING
       RETURNING id`,
			[e.pair_id, e.beneficiary_id, fromPaise(BigInt(e.amount_paise))],
		);

		let accrual: AccrualRow | undefined;
		if (ins[0]) {
			accrual = {
				id: ins[0].id,
				pair_id: String(e.pair_id),
				beneficiary_id: String(e.beneficiary_id),
				amount: fromPaise(BigInt(e.amount_paise)),
				release_seq: 0,
			};
		} else {
			const { rows } = await c.query<AccrualRow & { status: string }>(
				`SELECT id, pair_id, beneficiary_id, amount, release_seq, status
           FROM pair_accruals WHERE pair_id=$1 AND beneficiary_id=$2 FOR UPDATE`,
				[e.pair_id, e.beneficiary_id],
			);
			if (rows[0]?.status === "pending") accrual = rows[0];
		}

		if (accrual) {
			const { rows: q } = await c.query<{ is_qualified: boolean }>(
				"SELECT is_qualified FROM members WHERE id=$1",
				[e.beneficiary_id],
			);
			if (q[0]?.is_qualified) await releaseAccrual(c, accrual);
		}

		await c.query(
			"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
			[GROUP, e.event_id],
		);
	});
}

// Retroactive payout: the member just qualified — release everything pending.
export async function releasePendingBonuses(
	e: PendingBonusReleaseRequested,
): Promise<void> {
	await withTxn(async (c) => {
		const { rows: done } = await c.query(
			"SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2",
			[GROUP, e.event_id],
		);
		if (done.length > 0) return;

		const { rows: pending } = await c.query<AccrualRow>(
			`SELECT id, pair_id, beneficiary_id, amount, release_seq
         FROM pair_accruals
        WHERE beneficiary_id=$1 AND status='pending'
        ORDER BY id
        FOR UPDATE`,
			[e.member_id],
		);
		// Large backlogs make a large txn; per-accrual ledger idempotency keys
		// keep a mid-txn crash + re-delivery safe. Acceptable at current scale.
		for (const a of pending) {
			await releaseAccrual(c, a);
		}

		await c.query(
			"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
			[GROUP, e.event_id],
		);
	});
}

export async function sweepDeferred(e: DeferredSweepRequested): Promise<void> {
	await withTxn(async (c) => {
		const { rows: done } = await c.query(
			"SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2",
			[GROUP, e.event_id],
		);
		if (done.length > 0) return;

		const memberId = BigInt(e.member_id);
		const newCutoff = BigInt(e.new_cutoff_id);

		const { rows: accs } = await c.query<{ id: string; kind: string }>(
			`SELECT id, kind FROM accounts WHERE owner_id=$1 AND kind IN ('wallet','deferred_bonus')`,
			[memberId],
		);
		const walletAccId = BigInt(accs.find((a) => a.kind === "wallet")!.id);
		const deferredAccId = BigInt(
			accs.find((a) => a.kind === "deferred_bonus")!.id,
		);

		// Check deferred balance
		const { rows: defBal } = await c.query<{ balance: string }>(
			"SELECT balance FROM wallet_balances WHERE account_id=$1 FOR UPDATE",
			[deferredAccId],
		);
		const deferred = toPaise(defBal[0]?.balance ?? "0");
		if (deferred === 0n) {
			await c.query(
				"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
				[GROUP, e.event_id],
			);
			return;
		}

		// Get new window's earnings
		await c.query(
			`INSERT INTO cutoff_earnings (member_id, cutoff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
			[memberId, newCutoff],
		);
		const { rows: newCE } = await c.query<{ earned: string }>(
			`SELECT earned FROM cutoff_earnings WHERE member_id=$1 AND cutoff_id=$2 FOR UPDATE`,
			[memberId, newCutoff],
		);
		const cap = BigInt(CFG.CUTOFF_CAP_PAISE);
		const newEarned = toPaise(newCE[0].earned);
		const moveAmt =
			deferred < cap - newEarned
				? deferred
				: cap - newEarned > 0n
					? cap - newEarned
					: 0n;

		if (moveAmt > 0n) {
			await postLedgerTxn(
				c,
				`sweep:${e.new_cutoff_id}:${memberId}`,
				"sweep",
				null,
				[
					{ accountId: deferredAccId, direction: "D", amountPaise: moveAmt },
					{ accountId: walletAccId, direction: "C", amountPaise: moveAmt },
				],
			);
			await c.query(
				`UPDATE cutoff_earnings SET earned = earned + $1 WHERE member_id=$2 AND cutoff_id=$3`,
				[fromPaise(moveAmt), memberId, newCutoff],
			);
		}

		await c.query(
			"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
			[GROUP, e.event_id],
		);
	});
}

// Sweep the snapshotted earnings wallet balance into the withdrawable wallet.
// The exact amount_paise is carried in the event (captured at cutoff-close time)
// so this handler is order-independent and safe under XAUTOCLAIM re-delivery.
export async function sweepToWithdrawable(
	e: WithdrawableSweepRequested,
): Promise<void> {
	await withTxn(async (c) => {
		const { rows: done } = await c.query(
			"SELECT 1 FROM processed_events WHERE consumer_group=$1 AND event_id=$2",
			[GROUP, e.event_id],
		);
		if (done.length > 0) return;

		const memberId = BigInt(e.member_id);
		const moveAmt = BigInt(e.amount_paise);

		if (moveAmt === 0n) {
			await c.query(
				"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
				[GROUP, e.event_id],
			);
			return;
		}

		const { rows: accs } = await c.query<{ id: string; kind: string }>(
			`SELECT id, kind FROM accounts WHERE owner_id=$1 AND kind IN ('wallet','withdrawable')`,
			[memberId],
		);
		const walletAccId = BigInt(accs.find((a) => a.kind === "wallet")!.id);
		const withdrawableAccId = BigInt(
			accs.find((a) => a.kind === "withdrawable")!.id,
		);

		// Idempotency key uses a distinct prefix (wsweep:) to avoid collision
		// with the deferred sweep which uses (sweep:).
		await postLedgerTxn(
			c,
			`wsweep:${e.closed_cutoff_id}:${memberId}`,
			"wsweep",
			null,
			[
				{ accountId: walletAccId, direction: "D", amountPaise: moveAmt },
				{
					accountId: withdrawableAccId,
					direction: "C",
					amountPaise: moveAmt,
				},
			],
		);

		await c.query(
			"INSERT INTO processed_events (consumer_group, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
			[GROUP, e.event_id],
		);
	});
}

export async function run() {
	await startConsumer({
		stream: TOPICS.ledger.name,
		group: GROUP,
		mode: "message",
		onMessage: async (value) => {
			const e = JSON.parse(value) as AvgEvent;
			if (e.event_type === "PairBonusAccrued") await accruePairBonus(e);
			if (e.event_type === "PendingBonusReleaseRequested")
				await releasePendingBonuses(e);
			if (e.event_type === "DeferredSweepRequested") await sweepDeferred(e);
			if (e.event_type === "WithdrawableSweepRequested")
				await sweepToWithdrawable(e);
		},
	});
}

const _argv1 = process.argv[1] ?? "";
if (_argv1.endsWith("ledger.ts") || _argv1.endsWith("ledger.js")) {
	run().catch((err) => {
		console.error("[ledger] fatal", err);
		process.exit(1);
	});
}
