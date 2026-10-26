// Active stake left in a delegation pool whose validator has left the validator set: it earns nothing and can be
// unlocked and withdrawn immediately.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import { ownedPools } from '../owned.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { NATIVE } from './delegation.ts';

const VALIDATOR_INACTIVE = 4;   // 0x1::stake::get_validator_state
/** delegation_pool::MIN_COINS_ON_SHARES_POOL: unlock aborts if the delegator's resulting pending_inactive is below it. */
const MIN_UNLOCK = 1_000_000_000n;

export type InactiveHint = { pools: string[]; version?: number };

// Rewards are distributed every epoch while a validator is in the set; the last one dates when staking stopped. Older
// pools' rewards are indexed under the v1 event name only: with one name, such a pool matched nothing (scanning its
// whole history, which times out on the indexer) and looked like one that never earned a reward (#53).
const LAST_REWARD_QUERY = `query($p:String!){ delegated_staking_activities(where:{pool_address:{_eq:$p},
  event_type:{_in:["0x1::stake::DistributeRewards","0x1::stake::DistributeRewardsEvent"]}}, order_by:{transaction_version:desc}, limit:1){ transaction_version } }`;

// A pool's first indexed activity: when it began taking stake (the indexer's delegation history starts at genesis).
const FIRST_ACTIVITY_QUERY = `query($p:String!){ delegated_staking_activities(where:{pool_address:{_eq:$p}}, order_by:{transaction_version:asc}, limit:1){ transaction_version } }`;

const LAST_ADD_QUERY = `query($d:String!,$p:String!){ delegated_staking_activities(where:{delegator_address:{_eq:$d}, pool_address:{_eq:$p},
  event_type:{_in:["0x1::delegation_pool::AddStake","0x1::delegation_pool::AddStakeEvent"]}}, order_by:{transaction_version:desc}, limit:1){ transaction_version } }`;

async function blockTime(ctx: ReadContext, version: number): Promise<number | null> {
  const d = await ctx.chain.gql(`query($v:bigint!){ block_metadata_transactions(where:{version:{_lte:$v}}, order_by:{version:desc}, limit:1){ timestamp } }`, { v: String(version) });
  const ts = d.block_metadata_transactions[0]?.timestamp;
  return ts ? Math.floor(Date.parse(ts + 'Z') / 1000) : null;
}

/** Whether the pool's validator is inactive, and since when its stake has earned nothing: its last reward, or, for a
 *  pool that never earned one (none in the indexer's history, which starts at genesis), its first activity. Null when
 *  neither is indexed. */
function poolInfo(ctx: ReadContext, pool: string) {
  return once(ctx, `inactive-pool:${pool}:${ctx.ledger.version}`, async () => {
    const [state] = await ctx.chain.view('0x1::stake::get_validator_state', [pool], [], ctx.ledger.version);
    if (Number(state) !== VALIDATOR_INACTIVE) return { inactive: false, stoppedAt: null as number | null };
    const event = (await ctx.chain.gql(LAST_REWARD_QUERY, { p: pool })).delegated_staking_activities[0]
      ?? (await ctx.chain.gql(FIRST_ACTIVITY_QUERY, { p: pool })).delegated_staking_activities[0];
    return { inactive: true, stoppedAt: event ? await blockTime(ctx, Number(event.transaction_version)) : null };
  });
}

async function read(ctx: ReadContext, SOURCE: string, asset: string, ownerInput: string, hint?: InactiveHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failedPools = 0;
  const pools: string[] = hint?.pools.map(normalizeAddress) ?? await ownedPools(ctx, owner, 'active_shares');
  const found = await mapLimit(pools, 4, async (pool): Promise<Position | null> => {
    try {
      const info = await poolInfo(ctx, pool);
      if (!info.inactive) return null;
      const [active, , pendingInactive] = (await ctx.chain.view('0x1::delegation_pool::get_stake', [pool, owner], [], version)).map(BigInt);
      if (active === 0n) return null;
      const belowMinimum = active + pendingInactive < MIN_UNLOCK;
      // Stake added after the validator stopped has been idle only since it was added. Memoized: unchanged while the
      // amount and the pool's stop time are unchanged.
      let claimableSince: string | undefined;
      if (info.stoppedAt !== null) {
        const key = `${SOURCE}:since:${owner}:${pool}:${active}:${info.stoppedAt}`;
        claimableSince = await ctx.memo.get(key);
        if (!claimableSince) {
          const add = (await ctx.chain.gql(LAST_ADD_QUERY, { d: owner, p: pool })).delegated_staking_activities[0];
          const addedAt = add ? await blockTime(ctx, Number(add.transaction_version)) : null;
          claimableSince = iso(Math.max(info.stoppedAt, addedAt ?? 0));
          await ctx.memo.set(key, claimableSince);
        }
      }
      const locator = `${pool}/active`;
      const amount = [{ asset, raw: active.toString() }];
      return {
        ...positionIds(SOURCE, owner, locator, 'principal'), source: SOURCE, owner, locator, positionKind: 'principal',
        claimableSince, ageBasis: claimableSince ? 'protocol_closure' : 'unknown',
        provenance: { reader: '0x1::delegation_pool::get_stake', ledgerVersion: version },
        grossClaim: amount, expectedPayout: amount, payoutBasis: 'view',
        status: belowMinimum ? 'blocked' : 'recoverable',
        blockers: belowMinimum ? [{ code: 'below_unlock_minimum',
          detail: 'Unlocking needs at least 10 coins pending. Add stake to reach 10, then unlock and withdraw everything.' }] : [],
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [
          { function: '0x1::delegation_pool::unlock', arguments: [pool, active.toString()], prerequisites: [], expectedOutputs: [] },
          { function: '0x1::delegation_pool::withdraw', arguments: [pool, active.toString()],
            prerequisites: ['Run after unlock; with the validator out of the set, unlocked stake is withdrawable at once.'], expectedOutputs: amount },
        ],
      };
    } catch (err) {
      failedPools++;
      errors.push(`pool ${pool}: ${String(err).slice(0, 200)}`);
      return null;
    }
  });
  return { positions: found.filter((p): p is Position => p !== null), complete: failedPools === 0, errors, ledgerVersion: version };
}

function inactiveValidator(chain: keyof typeof NATIVE, id: string): SourceDef<InactiveHint> {
  const { asset, symbol, name } = NATIVE[chain];
  return {
    id,
    chain,
    protocol: `${name} native staking`,
    title: `${symbol} staked with a validator that stopped`,
    summary: `Your ${symbol} is still staked in ${name === 'Aptos' ? 'an' : 'a'} ${name} delegation pool whose validator left the validator set. It earns nothing and can be unlocked and withdrawn right away.`,
    category: 'staking',
    inclusionRule: 'R2 ended position: the pool\'s validator is inactive (stake::get_validator_state = 4), so staking stopped; unlock and withdraw are immediate.',
    protocolStatus: { state: 'live', evidence: `${name} framework module 0x1::delegation_pool; per-pool validator state read each run.`, checkedAt: '2026-10-19' },
    refresh: { nonZero: 'every_run', zero: 'monthly' },
    headlineAgeBases: ['protocol_closure'],
    howTo: [
      'In your wallet\'s staking view, unlock the stake from this validator, then withdraw it. With the validator out of the set, the withdrawal is available immediately.',
      'Or call 0x1::delegation_pool::unlock(pool, amount), then 0x1::delegation_pool::withdraw(pool, amount).',
    ],
    read: (ctx, owner, hint) => read(ctx, id, asset, owner, hint),
  };
}

export const delegationInactiveValidator = inactiveValidator('aptos', 'delegation-inactive-validator');
export const movementInactiveValidator = inactiveValidator('movement', 'movement-inactive-validator');
