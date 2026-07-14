import { run as counterPairRun } from "./counterPair.js";
import { run as cutoffRun } from "./cutoff.js";
import { run as fanoutRun } from "./fanout.js";
import { run as ledgerRun } from "./ledger.js";
import { run as outboxRelayRun } from "./outboxRelay.js";
import { run as pairCompleteRun } from "./pairComplete.js";
import { run as payoutRun } from "./payout.js";
import { run as qualificationRun } from "./qualification.js";
import { run as rankRun } from "./rank.js";
import { run as reconcilerRun } from "./reconciler.js";

// IMPORTANT: run exactly one instance of this process per environment.
// Redis Streams consumer groups distribute entries across consumers; multiple
// avg-workers processes would interleave counterPair increments and break
// per-ancestor ordering. See PLAN.md §2A — "Critical constraint".

console.log("[avg-workers] starting all ten worker loops");

Promise.all([
	outboxRelayRun(),
	fanoutRun(),
	counterPairRun(),
	pairCompleteRun(),
	qualificationRun(),
	ledgerRun(),
	rankRun(),
	cutoffRun(),
	payoutRun(),
	reconcilerRun(),
]).catch((err) => {
	console.error("[avg-workers] fatal", err);
	process.exit(1);
});
