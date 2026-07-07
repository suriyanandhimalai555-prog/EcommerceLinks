import type pg from 'pg'
import type { AvgEvent } from './types.js'
import { TOPICS } from './topics.js'

interface RouteInfo {
  topic: string
  partitionKey: string
  aggregateType: string
  aggregateId: bigint
}

function route(e: AvgEvent): RouteInfo {
  switch (e.event_type) {
    case 'MemberRegistered':
    case 'MemberActivated':
    case 'MemberQualified':
      return { topic: TOPICS.lifecycle.name, partitionKey: String(e.member_id), aggregateType: 'member', aggregateId: BigInt(e.member_id) }
    case 'CounterIncrement':
      return { topic: TOPICS.increments.name, partitionKey: String(e.ancestor_id), aggregateType: 'member', aggregateId: BigInt(e.ancestor_id) }
    case 'PairMatched':
    case 'DeferredSweepRequested':
      return { topic: TOPICS.ledger.name, partitionKey: String(e.member_id), aggregateType: 'member', aggregateId: BigInt(e.member_id) }
    case 'RankEvalRequested':
    case 'RankAchieved':
      return { topic: TOPICS.ranks.name, partitionKey: String(e.member_id), aggregateType: 'member', aggregateId: BigInt(e.member_id) }
    case 'CutoffClosed':
      return { topic: TOPICS.payouts.name, partitionKey: String(e.cutoff_id), aggregateType: 'cutoff', aggregateId: BigInt(e.cutoff_id) }
    case 'PayoutBatchCreated':
      return { topic: TOPICS.payouts.name, partitionKey: String(e.batch_id), aggregateType: 'payout_batch', aggregateId: BigInt(e.batch_id) }
    case 'PayoutItemSettled':
    case 'PayoutItemFailed':
      return { topic: TOPICS.payouts.name, partitionKey: String(e.payout_item_id), aggregateType: 'payout_item', aggregateId: BigInt(e.payout_item_id) }
  }
}

// Must be called inside the caller's transaction — never opens its own.
export async function writeOutbox(c: pg.PoolClient, e: AvgEvent): Promise<void> {
  const { topic, partitionKey, aggregateType, aggregateId } = route(e)
  await c.query(
    `INSERT INTO events_outbox
       (event_id, event_type, aggregate_type, aggregate_id, partition_key, topic, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.event_id, e.event_type, aggregateType, aggregateId, partitionKey, topic, JSON.stringify(e)]
  )
}
