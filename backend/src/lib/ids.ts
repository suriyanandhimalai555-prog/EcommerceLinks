import { v5 as uuidv5 } from "uuid";

// RFC 4122 URL namespace
const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export function nextMemberCode(id: bigint): string {
	return "AVG" + (100000n + id).toString();
}

export function txnUuid(idempotencyKey: string): string {
	return uuidv5(idempotencyKey, NAMESPACE);
}
