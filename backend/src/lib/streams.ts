import { Redis } from "ioredis";
import { CFG } from "../config.js";

// Dedicated connection for publishing (non-blocking XADD).
// Do NOT reuse the shared redis() singleton from redis.ts — its XREADGROUP
// BLOCK calls would stall the network-tree cache reads.
let _publisher: Redis | undefined;
function publisher(): Redis {
	if (!_publisher) {
		_publisher = new Redis(CFG.REDIS_URL);
		_publisher.on("error", (err: Error) =>
			console.error("[streams] publisher error", err),
		);
	}
	return _publisher;
}

export async function publishToStream(
	stream: string,
	value: string,
): Promise<void> {
	// MAXLEN ~ caps the stream at ~1M entries; the events_outbox is the permanent record.
	await publisher().xadd(stream, "MAXLEN", "~", "1000000", "*", "data", value);
}

export interface ConsumerOpts {
	stream: string;
	group: string;
	/** Defaults to `${group}-${process.pid}` */
	consumer?: string;
	mode: "message" | "batch";
	/** Defaults to 10 for message mode, 500 for batch */
	count?: number;
	/** Called per-entry in message mode; XACK happens after this resolves */
	onMessage?: (value: string) => Promise<void>;
	/** Called with a full batch in batch mode; XACK all on success */
	onBatch?: (values: string[]) => Promise<void>;
}

type XEntry = [id: string, fields: string[]];

function extractValue(fields: string[]): string | null {
	const idx = fields.indexOf("data");
	return idx >= 0 ? (fields[idx + 1] ?? null) : null;
}

/** Runs forever (never resolves). Each consumer gets its own dedicated Redis connection. */
export async function startConsumer(opts: ConsumerOpts): Promise<void> {
	const { stream, group, mode, onMessage, onBatch } = opts;
	const consumer = opts.consumer ?? `${group}-${process.pid}`;
	const count = opts.count ?? (mode === "batch" ? 500 : 10);

	const conn = new Redis(CFG.REDIS_URL);
	conn.on("error", (err: Error) =>
		console.error(`[streams:${group}] error`, err),
	);

	// Bootstrap consumer group — MKSTREAM creates the stream if absent; BUSYGROUP means already exists.
	try {
		await conn.xgroup("CREATE", stream, group, "$", "MKSTREAM");
	} catch (err: unknown) {
		if (!(err instanceof Error) || !err.message.includes("BUSYGROUP"))
			throw err;
	}

	console.log(`[streams:${group}] consumer ${consumer} ready on ${stream}`);

	let lastClaim = Date.now();

	while (true) {
		// Every 60s, reclaim entries pending from crashed consumers and re-process them.
		// Safe because all consumers dedup via processed_events(consumer_group, event_id).
		if (Date.now() - lastClaim > 60_000) {
			try {
				// XAUTOCLAIM key group consumer min-idle-ms start COUNT n
				const claimed = (await (conn as any).call(
					"XAUTOCLAIM",
					stream,
					group,
					consumer,
					"60000",
					"0-0",
					"COUNT",
					String(count),
				)) as [string, XEntry[], string[]];
				const reclaimed: XEntry[] = claimed[1] ?? [];
				if (reclaimed.length > 0) {
					await dispatch(
						conn,
						stream,
						group,
						mode,
						reclaimed,
						onMessage,
						onBatch,
					);
				}
			} catch (err) {
				console.error(`[streams:${group}] xautoclaim error`, err);
			}
			lastClaim = Date.now();
		}

		// Read new entries assigned to this consumer.
		const result = (await (conn as any).xreadgroup(
			"GROUP",
			group,
			consumer,
			"COUNT",
			String(count),
			"BLOCK",
			"5000",
			"STREAMS",
			stream,
			">",
		)) as [[string, XEntry[]]] | null;

		if (!result) continue; // BLOCK timeout — loop and try again

		const entries: XEntry[] = result[0]?.[1] ?? [];
		if (entries.length === 0) continue;

		await dispatch(conn, stream, group, mode, entries, onMessage, onBatch);
	}
}

async function dispatch(
	conn: Redis,
	stream: string,
	group: string,
	mode: "message" | "batch",
	entries: XEntry[],
	onMessage?: (value: string) => Promise<void>,
	onBatch?: (values: string[]) => Promise<void>,
): Promise<void> {
	if (mode === "message") {
		for (const [id, fields] of entries) {
			const value = extractValue(fields);
			if (!value) {
				// Malformed entry — ack and skip so it doesn't block the consumer group.
				await conn.xack(stream, group, id);
				continue;
			}
			try {
				await onMessage!(value);
			} catch (err) {
				// Leave in pending — XAUTOCLAIM will redeliver after 60s.
				console.error(
					`[streams:${group}] handler error (id=${id}), leaving pending`,
					err,
				);
				continue;
			}
			// XACK after the handler's DB transaction commits → at-least-once delivery.
			await conn.xack(stream, group, id);
		}
	} else {
		const ids = entries.map(([id]) => id);
		const values = entries
			.map(([, fields]) => extractValue(fields))
			.filter(Boolean) as string[];
		try {
			await onBatch!(values);
		} catch (err) {
			// Leave all pending — XAUTOCLAIM will redeliver the whole batch.
			console.error(
				`[streams:${group}] batch handler error, leaving pending`,
				err,
			);
			return;
		}
		await conn.xack(stream, group, ...ids);
	}
}
