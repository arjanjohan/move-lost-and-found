// Chain-wide candidate enumeration and source-level sanity checks (node-only: keyed indexer use).
import { iso } from '../shared/accounting.ts';
import { gqlAll, mapLimit, normalizeAddress } from '../shared/chain.ts';
import { AMNIS, AMNIS_WITHDRAWAL_COLLECTION } from '../shared/sources/amnis-withdrawals.ts';
import { ANIMESWAP, ANIMESWAP_POOLS, animeswapLps, assetOf as animeswapAsset, pairOf } from '../shared/sources/animeswap-closed.ts';
import { EARNIUM } from '../shared/sources/earnium-closed.ts';
import { ECHO, ECHO_OWN_WALLETS, ECHO_RESERVES } from '../shared/sources/echo-wound-down.ts';
import { HOUSTON, HOUSTON_POOLS } from '../shared/sources/houston-closed.ts';
import { AURO_CLOSED_AT, AURO_COLLECTION, AURO_ROUTER } from '../shared/sources/auro-closed.ts';
import { CANOPY_REWARDS, CANOPY_REWARDS_STATE } from '../shared/sources/canopy-rewards.ts';
import { CANOPY_VAULTS } from '../shared/sources/canopy-frozen.ts';
import { AAVE, type AaveHint, aaveReserves, findFreeze } from '../shared/sources/aave-frozen.ts';
import { ECHELON, FROZEN_MARKETS } from '../shared/sources/echelon-frozen.ts';
import { ECONIA, ECONIA_COIN_MARKETS, KANA_ECONIA_WRAPPER } from '../shared/sources/econia-idle.ts';
import { KAPT, STKAPT } from '../shared/sources/kofi-receipts.ts';
import { KOFI } from '../shared/sources/kofi-withdrawals.ts';
import { CAKE, type ClaimableHint, claimableHandle, LZ_COINS } from '../shared/sources/layerzero-claimable.ts';
import { MKLP } from '../shared/sources/merkle-mklp.ts';
import { chefState, MASTERCHEF } from '../shared/sources/pancake-farm.ts';
import { poolState, SMART_CHEF, SYRUP_POOLS } from '../shared/sources/pancake-syrup.ts';
import { VEMKL_COLLECTION } from '../shared/sources/merkle-vemkl.ts';
import { THALA_VE, THALA_VEST } from '../shared/sources/thala-thl.ts';
import { THALA_LSD } from '../shared/sources/thala-unstake.ts';
import { TORTUGA, TORTUGA_STATE } from '../shared/sources/tortuga-tickets.ts';
import { TRUFIN, unlockTable } from '../shared/sources/trufin-unlocks.ts';
import { TOPAZ, type TopazBid, type TopazHint, type TopazKind, topazTables, u64Key } from '../shared/sources/topaz-bids.ts';
import type { Sanity } from '../shared/snapshot.ts';
import { processorWatermark } from './client.ts';
import type { ChainReader, Ledger, Position } from '../shared/types.ts';

export interface Candidate { owner: string; hint?: unknown }

export interface Enumeration {
  candidates: Candidate[];
  cursor?: string;
  pages: number;
  /** True when every returned candidate had new activity since the stored cursor (so it is due for a read). */
  incremental?: boolean;
}

export interface Enumerator {
  sourceId: string;
  /** Indexer processor whose watermark bounds the enumeration; null when only the fullnode is read. */
  processor: string | null;
  /** Other processors whose tables the enumeration reads; any of them lagging degrades the run like `processor`. */
  alsoProcessors?: string[];
  /** Named enumeration scope; "complete" means complete within this, never chain-wide. */
  scope: string;
  run(chain: ChainReader, cursor: string | undefined): Promise<Enumeration>;
  sanity?(chain: ChainReader, ledger: Ledger, positions: Position[]): Promise<Sanity>;
}

const PAGE = 100;   // the indexer silently caps page size at 100

// Keyset over (delegator, pool, table_handle) inside 16 address-prefix ranges; offsets are unstable on a live table.
const DELEGATION_QUERY = `query($lo:String!,$hi:String!,$d:String!,$p:String!,$t:String!){
  current_delegator_balances(where:{pool_type:{_eq:"inactive_shares"}, shares:{_gt:"0"}, delegator_address:{_gte:$lo,_lt:$hi},
    _or:[{delegator_address:{_gt:$d}}, {delegator_address:{_eq:$d}, pool_address:{_gt:$p}},
         {delegator_address:{_eq:$d}, pool_address:{_eq:$p}, table_handle:{_gt:$t}}]},
    order_by:[{delegator_address:asc},{pool_address:asc},{table_handle:asc}], limit:${PAGE}){
    delegator_address pool_address table_handle last_transaction_version } }`;

const delegationEnumeratorFor = (sourceId: string): Enumerator => ({
  sourceId,
  processor: 'stake_processor',
  scope: 'current_delegator_balances rows with pool_type=inactive_shares and shares>0 (stake_processor)',
  async run(chain) {
    const hex = '0123456789abcdef';
    let pages = 0;
    const rows = (await mapLimit([...hex], 8, async (h, i) => {
      const out: any[] = [];
      let cursor = { d: '', p: '', t: '' };
      for (;;) {
        const page = (await chain.gql(DELEGATION_QUERY, { lo: '0x' + h, hi: i < 15 ? '0x' + hex[i + 1] : '0xg', ...cursor })).current_delegator_balances;
        pages++;
        out.push(...page);
        if (page.length < PAGE) return out;
        const last = page[page.length - 1];
        cursor = { d: last.delegator_address, p: last.pool_address, t: last.table_handle };
      }
    })).flat();
    const pools = new Map<string, { set: Set<string>; version: number }>();
    for (const r of rows) {
      const owner = normalizeAddress(r.delegator_address);
      const entry = pools.get(owner) ?? { set: new Set<string>(), version: 0 };
      entry.set.add(normalizeAddress(r.pool_address));
      entry.version = Math.max(entry.version, Number(r.last_transaction_version));
      pools.set(owner, entry);
    }
    // The latest row version is in the hint so that any change to an owner's rows marks the owner due.
    return { candidates: [...pools].map(([owner, e]) => ({ owner, hint: { pools: [...e.set].sort(), version: e.version } })), pages };
  },
  async sanity(chain, ledger, positions) {
    const perPool = new Map<string, bigint>();
    for (const p of positions) {
      if (!p.locator.endsWith('/inactive')) continue;
      const pool = p.locator.split('/')[0];
      perPool.set(pool, (perPool.get(pool) ?? 0n) + BigInt(p.grossClaim[0].raw));
    }
    const violations: string[] = [];
    await mapLimit([...perPool], 8, async ([pool, sum]) => {
      const [, inactive] = (await chain.view('0x1::stake::get_stake', [pool], [], ledger.version)).map(BigInt);
      if (sum > inactive + 1000n) violations.push(`${pool}: delegators ${sum} > pool inactive ${inactive}`);
    });
    return { check: 'per pool: sum of delegator inactive stake <= stake::get_stake(pool).inactive', ok: violations.length === 0,
      detail: violations.length ? violations.slice(0, 10).join('; ') : `${perPool.size} pools, 0 violations` };
  },
});
export const delegationEnumerator = delegationEnumeratorFor('native-delegation');
export const movementDelegationEnumerator = delegationEnumeratorFor('movement-native-delegation');

const SENDERS_QUERY = `query($c:String!,$m:String!,$f:String!,$after:bigint!,$until:bigint!){
  user_transactions(where:{entry_function_contract_address:{_eq:$c}, entry_function_module_name:{_eq:$m},
    entry_function_function_name:{_eq:$f}, version:{_gt:$after, _lte:$until}}, order_by:{version:asc}, limit:${PAGE}){ version sender } }`;

/** An entry function whose senders are candidates. `untilVersion` ends the scan where later calls cannot matter
 *  (for example deposits into pools that had already ended); `fromVersion` starts it where earlier calls cannot (calls
 *  that only mark an owner changed, when every owner is read after that version anyway). */
type EntryFunction = { contract: string; module: string; name: string; untilVersion?: number; fromVersion?: number };
const NO_LIMIT = '9223372036854775807';

/** New senders of entry functions since per-function version cursors (stored as one JSON object). Only the
 *  (contract, module, function) filter is indexed; entry_function_id_str alone times out. */
async function senders(chain: ChainReader, fns: EntryFunction[], cursor: string | undefined): Promise<Enumeration> {
  let cursors: Record<string, string> = {};
  try { cursors = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: rescan from the start */ }
  if (typeof cursors !== 'object' || cursors === null) cursors = {};
  const owners = new Set<string>();
  let pages = 0;
  for (const fn of fns) {
    const key = `${fn.contract}::${fn.module}::${fn.name}`;
    let after = cursors[key] ?? String(fn.fromVersion ?? 0);
    for (;;) {
      const page = (await chain.gql(SENDERS_QUERY, { c: fn.contract, m: fn.module, f: fn.name, after, until: String(fn.untilVersion ?? NO_LIMIT) })).user_transactions;
      pages++;
      page.forEach((t: any) => owners.add(normalizeAddress(t.sender)));
      if (page.length) after = String(page[page.length - 1].version);
      if (page.length < PAGE) break;
    }
    cursors[key] = after;
  }
  return { candidates: [...owners].map(owner => ({ owner })), cursor: JSON.stringify(cursors), pages, incremental: true };
}

function entrySenders(sourceId: string, fns: EntryFunction[], sanity: Enumerator['sanity']): Enumerator {
  return {
    sourceId,
    processor: 'user_transaction_processor',
    scope: `senders of ${fns.map(f => `${f.contract}::${f.module}::${f.name}${f.fromVersion ? ` from version ${f.fromVersion}` : ''}${f.untilVersion ? ` up to version ${f.untilVersion}` : ''}`).join(', ')} entry calls (calls made by other contracts excluded)`,
    run: (chain, cursor) => senders(chain, fns, cursor),
    sanity,
  };
}

const sumGross = (positions: Position[]) => positions.reduce((s, p) => s + BigInt(p.grossClaim[0].raw), 0n);
const pct = (part: bigint, whole: bigint) => (whole ? (Number(part * 10_000n / whole) / 100).toFixed(2) : '0') + '%';

export const thalaUnstakeEnumerator = entrySenders('thala-unstake',
  [{ contract: THALA_LSD, module: 'scripts', name: 'request_unstake_APT' }],
  async (chain, ledger, positions) => {
    const tlsd = await chain.resource(THALA_LSD, `${THALA_LSD}::staking::TLSD`, ledger.version);
    const held = BigInt(tlsd.apt_pending_withdrawal.value), matured = sumGross(positions);
    return { check: 'matured requests found <= TLSD.apt_pending_withdrawal (APT held for claims)', ok: matured <= held,
      detail: `matured ${matured} of ${held} held (${pct(matured, held)})` };
  });

export const kofiWithdrawalsEnumerator = entrySenders('kofi-withdrawals',
  [{ contract: KOFI, module: 'gateway', name: 'request_withdrawal_entry' },
   { contract: KOFI, module: 'gateway', name: 'unstake_and_request_withdrawal_entry' }],
  async (chain, ledger, positions) => {
    const [unlocked] = await chain.view(`${KOFI}::vault::get_unlocked_apt_balance`, [], [], ledger.version);
    const held = BigInt(unlocked), matured = sumGross(positions);
    // Not a hard ceiling: matured tickets can wait for APT still unlocking from validators.
    return { check: 'matured tickets found vs vault::get_unlocked_apt_balance (APT ready for withdrawals)', ok: null,
      detail: `matured ${matured} vs ${held} unlocked (${pct(matured, held)})` };
  });

export const tortugaTicketsEnumerator = entrySenders('tortuga-tickets',
  [{ contract: TORTUGA, module: 'stake_router', name: 'unstake' }],
  async (chain, ledger, positions) => {
    const status = await chain.resource(TORTUGA_STATE, `${TORTUGA}::stake_router::StakingStatus`, ledger.version);
    const outstanding = BigInt(status.total_claims_balance) - BigInt(status.total_claims_balance_cleared), found = sumGross(positions);
    return { check: 'tickets found <= outstanding claims (total_claims_balance - total_claims_balance_cleared)', ok: found <= outstanding,
      detail: `found ${found} of ${outstanding} outstanding (${pct(found, outstanding)})` };
  });

// Keyset on token_data_id; a token can only have one current owner with amount > 0 (non-fungible).
const COLLECTION_QUERY = `query($c:String!,$after:String!){ current_token_ownerships_v2(where:{current_token_data:{collection_id:{_eq:$c}},
  amount:{_gt:"0"}, token_data_id:{_gt:$after}}, order_by:{token_data_id:asc}, limit:${PAGE}){ token_data_id owner_address } }`;

/** Current owners of every token in a collection, with their token ids as the read hint. */
function collectionOwners(sourceId: string, collection: string, sanity: Enumerator['sanity']): Enumerator {
  return {
    sourceId,
    processor: 'token_v2_processor',
    scope: `current owners of tokens in collection ${collection} (current_token_ownerships_v2, amount > 0)`,
    async run(chain) {
      const tokens = new Map<string, string[]>();
      let after = '', pages = 0;
      for (;;) {
        const page = (await chain.gql(COLLECTION_QUERY, { c: collection, after })).current_token_ownerships_v2;
        pages++;
        for (const t of page) {
          const owner = normalizeAddress(t.owner_address);
          tokens.set(owner, [...(tokens.get(owner) ?? []), normalizeAddress(t.token_data_id)]);
        }
        if (page.length < PAGE) break;
        after = page[page.length - 1].token_data_id;
      }
      return { candidates: [...tokens].map(([owner, list]) => ({ owner, hint: { tokens: list.sort() } })), pages };
    },
    sanity,
  };
}

export const amnisWithdrawalsEnumerator = collectionOwners('amnis-withdrawals', AMNIS_WITHDRAWAL_COLLECTION,
  async (chain, ledger, positions) => {
    const [pending] = await chain.view(`${AMNIS}::withdrawal::total_pending_withdrawal`, [], [], ledger.version);
    const total = BigInt(pending), matured = sumGross(positions);
    return { check: 'matured withdrawal tokens found <= withdrawal::total_pending_withdrawal (all open tokens)', ok: matured <= total,
      detail: `matured ${matured} of ${total} pending (${pct(matured, total)})` };
  });

// Auro: current owners of CDP position NFTs. Every owner is re-read every run (the source's refresh), so withdrawals,
// repayments and changes to the pools' reserves are picked up without on-chain change events. A position is aged from
// its last change after the shutdown, which the hint carries per position:
// - an ownership change (the ownership row's last transaction): a position acquired after the shutdown;
// - any Auro call that touched it: a repayment (one that still had debt at the shutdown qualifies only once repaid), a
//   withdrawal from one of its pools, a deposit. Router calls on positions are scanned incrementally (liquidations need
//   a Pyth price, which stopped on 2026-04-30), and the positions each one touched are taken from account_transactions
//   at its version, so a call by anyone dates that position only. The scan stops at the account-transactions
//   processor's watermark, so a call whose touched accounts are not indexed yet is left for a later run.
const AURO_CLOSED_VERSION = 5_067_106_504;   // first version of 2026-05-01
const AURO_TOKENS_QUERY = `query($c:String!,$after:String!){ current_token_ownerships_v2(where:{current_token_data:{collection_id:{_eq:$c}},
  amount:{_gt:"0"}, token_data_id:{_gt:$after}}, order_by:{token_data_id:asc}, limit:${PAGE}){ token_data_id owner_address last_transaction_timestamp } }`;
/** auro_router's entry functions that act on an existing position (a new one is dated by its ownership row). An
 *  unfiltered scan of the router times out on the indexer. */
const AURO_POSITION_CALLS = ['deposit_entry', 'deposit_apt_entry', 'deposit_coin_entry', 'borrow_entry', 'repay_entry', 'withdraw_entry',
  'withdraw_coin_entry', 'exit_position', 'exit_position_coin', 'liquidate_entry', 'claim_rewards'];
const AURO_CALLS_QUERY = `query($a:bigint!,$w:bigint!){ user_transactions(where:{entry_function_contract_address:{_eq:"${AURO_ROUTER}"},
  entry_function_module_name:{_eq:"auro_router"}, entry_function_function_name:{_in:${JSON.stringify(AURO_POSITION_CALLS)}}, version:{_gt:$a, _lte:$w}},
  order_by:{version:asc}, limit:${PAGE}){ version timestamp } }`;
const TOUCHED_QUERY = `query($v:bigint!,$after:String!){ account_transactions(where:{transaction_version:{_eq:$v}, account_address:{_gt:$after}},
  order_by:{account_address:asc}, limit:${PAGE}){ account_address } }`;
export const auroClosedEnumerator: Enumerator = {
  sourceId: 'auro-closed-positions',
  processor: 'token_v2_processor',
  alsoProcessors: ['user_transaction_processor', 'account_transactions_processor'],
  scope: `current owners of tokens in collection ${AURO_COLLECTION} (current_token_ownerships_v2, amount > 0); plus ${AURO_ROUTER}::auro_router calls on positions after the shutdown and the accounts each touched`,
  async run(chain, cursor) {
    let stored: { v?: string; repaid?: Record<string, string> } = {};
    try { stored = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: rescan */ }
    if (typeof stored !== 'object' || stored === null) stored = {};
    // Every account an Auro call touched, with the latest such call's time; positions are found among them below.
    const repaid: Record<string, string> = stored.repaid && typeof stored.repaid === 'object' && !Array.isArray(stored.repaid) ? { ...stored.repaid } : {};
    // Calls and the accounts they touched come from two processors: scan only what both have indexed.
    const indexed = String([await processorWatermark(chain, 'user_transaction_processor'), await processorWatermark(chain, 'account_transactions_processor')]
      .map(m => BigInt(m.version)).reduce((a, b) => (a < b ? a : b)));
    let after = stored.v ?? String(AURO_CLOSED_VERSION), pages = 1;
    for (;;) {
      const page = (await chain.gql(AURO_CALLS_QUERY, { a: after, w: indexed })).user_transactions;
      pages++;
      for (const t of page) {
        const time = new Date(t.timestamp + 'Z').toISOString();
        const touched = await gqlAll(chain, TOUCHED_QUERY, { v: String(t.version) }, 'account_transactions', 'account_address');
        pages++;
        for (const r of touched) {
          const account = normalizeAddress(r.account_address);
          if (!repaid[account] || time > repaid[account]) repaid[account] = time;
        }
        after = String(t.version);
      }
      if (page.length < PAGE) break;
    }
    const owners = new Map<string, { tokens: string[]; changed: Record<string, string> }>();
    let from = '';
    for (;;) {
      const page = (await chain.gql(AURO_TOKENS_QUERY, { c: AURO_COLLECTION, after: from })).current_token_ownerships_v2;
      pages++;
      for (const t of page) {
        const owner = normalizeAddress(t.owner_address), token = normalizeAddress(t.token_data_id);
        const o = owners.get(owner) ?? { tokens: [], changed: {} };
        o.tokens.push(token);
        const moved = new Date(t.last_transaction_timestamp + 'Z').toISOString();
        const latest = [moved > AURO_CLOSED_AT ? moved : undefined, repaid[token]].filter((d): d is string => !!d).sort().pop();
        if (latest) o.changed[token] = latest;
        owners.set(owner, o);
      }
      if (page.length < PAGE) break;
      from = page[page.length - 1].token_data_id;
    }
    const candidates = [...owners].map(([owner, o]) => ({ owner, hint: { tokens: o.tokens.sort(), ...(Object.keys(o.changed).length ? { changed: o.changed } : {}), w: indexed } }));
    // Kept whole (a few accounts per repayment, which are rare): a position the ownership index has not caught up on
    // still finds its date in a later run.
    return { candidates, cursor: JSON.stringify({ v: after, repaid }), pages };
  },
  async sanity() {
    return { check: 'none', ok: null, detail: 'no contract total: the pools\' books overstate what the DAO account holds (stkAPT ~37%)' };
  },
};

// AnimeSwap: every store holding an AnimeSwap LP coin, per pool from the pair registry. The indexer files a store that
// migrated to the paired fungible asset under the coin type too. The pool account itself is left out: it holds the DAO
// fee minted in LP (4.5% of APT/USDC), the protocol's own, with no signer to recover it.
export const animeswapClosedEnumerator: Enumerator = {
  sourceId: 'animeswap-closed-lp',
  processor: 'fungible_asset_processor',
  scope: `stores holding any LP coin in ${ANIMESWAP}::AnimeSwapPoolV1::PairInfo (current_fungible_asset_balances, amount > 0), except the pool account`,
  async run(chain) {
    const lps = await animeswapLps(chain);
    const holders = new Map<string, Record<string, string>>();
    let pages = 1;
    for (const lp of lps) {
      let after = '';
      for (;;) {
        const rows = (await chain.gql(`query($a:String!,$s:String!){ current_fungible_asset_balances(where:{asset_type:{_eq:$a}, amount:{_gt:"0"},
          storage_id:{_gt:$s}}, order_by:{storage_id:asc}, limit:${PAGE}){ owner_address storage_id last_transaction_timestamp } }`, { a: lp, s: after })).current_fungible_asset_balances;
        pages++;
        for (const r of rows) {
          const owner = normalizeAddress(r.owner_address);
          if (owner === ANIMESWAP_POOLS || owner === ANIMESWAP) continue;
          const at = new Date(r.last_transaction_timestamp + 'Z').toISOString(), prev = holders.get(owner) ?? {};
          if (!prev[lp] || at > prev[lp]) holders.set(owner, { ...prev, [lp]: at });
        }
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1].storage_id;
      }
    }
    return { candidates: [...holders].map(([owner, lps]) => ({ owner, hint: { lps } })), pages };
  },
  async sanity(chain, ledger, positions) {
    // What the positions would pay, per pool and side, cannot exceed that side's reserve.
    const owed = new Map<string, bigint>();
    for (const p of positions) owed.set(`${p.locator}|${p.asset}`, (owed.get(`${p.locator}|${p.asset}`) ?? 0n) + BigInt(p.grossClaim[0].raw));
    let ok = true, pools = 0;
    for (const lp of new Set(positions.map(p => p.locator))) {
      const [x, y] = pairOf(lp);
      const state = await chain.resource(ANIMESWAP_POOLS, `${ANIMESWAP}::AnimeSwapPoolV1::LiquidityPool<${x}, ${y}>`, ledger.version);
      pools++;
      for (const [coin, reserve] of [[x, state.coin_x_reserve.value], [y, state.coin_y_reserve.value]] as const)
        ok &&= (owed.get(`${lp}|${animeswapAsset(coin)}`) ?? 0n) <= BigInt(reserve);
    }
    return { check: 'payouts found <= pool reserves, per pool and side', ok, detail: `${pools} pools with positions` };
  },
};

// Every delegation pool, then the active-stake delegators of pools whose validator is inactive.
const inactiveValidatorEnumeratorFor = (sourceId: string): Enumerator => ({
  sourceId,
  processor: 'stake_processor',
  scope: 'active_shares rows (shares > 0) in delegation pools whose validator state is inactive (4) at enumeration time',
  async run(chain) {
    let pages = 0, after = '';
    const pools: string[] = [];
    for (;;) {
      const page = (await chain.gql(`query($a:String!){ current_delegated_staking_pool_balances(where:{staking_pool_address:{_gt:$a}},
        order_by:{staking_pool_address:asc}, limit:${PAGE}){ staking_pool_address } }`, { a: after })).current_delegated_staking_pool_balances;
      pages++;
      pools.push(...page.map((p: any) => normalizeAddress(p.staking_pool_address)));
      if (page.length < PAGE) break;
      after = page[page.length - 1].staking_pool_address;
    }
    const ledger = await chain.ledger();
    const states = await mapLimit(pools, 8, async pool => Number((await chain.view('0x1::stake::get_validator_state', [pool], [], ledger.version))[0]));
    const inactive = pools.filter((_, i) => states[i] === 4);
    const owners = new Map<string, { pools: Set<string>; version: number }>();
    for (const pool of inactive) {
      let cursor = '';
      for (;;) {
        const rows = (await chain.gql(`query($p:String!,$a:String!){ current_delegator_balances(where:{pool_address:{_eq:$p}, pool_type:{_eq:"active_shares"},
          shares:{_gt:"0"}, delegator_address:{_gt:$a}}, order_by:{delegator_address:asc}, limit:${PAGE}){ delegator_address last_transaction_version } }`,
          { p: pool, a: cursor })).current_delegator_balances;
        pages++;
        for (const r of rows) {
          const owner = normalizeAddress(r.delegator_address);
          const entry = owners.get(owner) ?? { pools: new Set<string>(), version: 0 };
          entry.pools.add(pool);
          entry.version = Math.max(entry.version, Number(r.last_transaction_version));
          owners.set(owner, entry);
        }
        if (rows.length < PAGE) break;
        cursor = rows[rows.length - 1].delegator_address;
      }
    }
    return { candidates: [...owners].map(([owner, e]) => ({ owner, hint: { pools: [...e.pools].sort(), version: e.version } })), pages };
  },
  async sanity(chain, ledger, positions) {
    const perPool = new Map<string, bigint>();
    for (const p of positions) {
      const pool = p.locator.split('/')[0];
      perPool.set(pool, (perPool.get(pool) ?? 0n) + BigInt(p.grossClaim[0].raw));
    }
    const violations: string[] = [];
    await mapLimit([...perPool], 8, async ([pool, sum]) => {
      const [active] = (await chain.view('0x1::stake::get_stake', [pool], [], ledger.version)).map(BigInt);
      if (sum > active + 1000n) violations.push(`${pool}: delegators ${sum} > pool active ${active}`);
    });
    return { check: 'per pool: sum of delegator active stake <= stake::get_stake(pool).active', ok: violations.length === 0,
      detail: violations.length ? violations.slice(0, 10).join('; ') : `${perPool.size} pools, 0 violations` };
  },
});
export const inactiveValidatorEnumerator = inactiveValidatorEnumeratorFor('delegation-inactive-validator');
export const movementInactiveValidatorEnumerator = inactiveValidatorEnumeratorFor('movement-inactive-validator');

// One global table holds every TruFin unlock request; its owners are the candidates.
export const trufinUnlocksEnumerator: Enumerator = {
  sourceId: 'trufin-unlocks',
  processor: null,
  scope: `every entry of ${TRUFIN}::staker::Unlocks (one global SmartTable), read at a pinned ledger version`,
  async run(chain) {
    const ledger = await chain.ledger();
    const rows = await unlockTable({ chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() });
    return { candidates: [...new Set(rows.map(r => r.user))].map(owner => ({ owner, hint: { nonces: rows.filter(r => r.user === owner).map(r => r.nonce).sort() } })), pages: 1 };
  },
  async sanity(chain, ledger, positions) {
    const res = await chain.resource(TRUFIN, `${TRUFIN}::staker::Unlocks`, ledger.version);
    return { check: 'claimable requests found vs staker::Unlocks size (all pending requests)', ok: positions.length <= Number(res.unlocks.size),
      detail: `${positions.length} claimable of ${res.unlocks.size} pending` };
  },
};

// Every primary store holding Kofi kAPT or stkAPT, keyset-paged on storage_id.
export const kofiReceiptsEnumerator: Enumerator = {
  sourceId: 'kofi-receipts',
  processor: 'fungible_asset_processor',
  scope: 'primary stores holding Kofi kAPT or stkAPT (current_fungible_asset_balances, amount > 0)',
  async run(chain) {
    const holders = new Map<string, Record<string, number>>();
    let pages = 0;
    for (const asset of [KAPT, STKAPT]) {
      let after = '';
      for (;;) {
        const rows = (await chain.gql(`query($a:String!,$s:String!){ current_fungible_asset_balances(where:{asset_type:{_eq:$a}, is_primary:{_eq:true},
          amount:{_gt:"0"}, storage_id:{_gt:$s}}, order_by:{storage_id:asc}, limit:${PAGE}){ owner_address storage_id last_transaction_version } }`,
          { a: asset, s: after })).current_fungible_asset_balances;
        pages++;
        for (const r of rows) {
          const owner = normalizeAddress(r.owner_address);
          holders.set(owner, { ...(holders.get(owner) ?? {}), [asset]: Number(r.last_transaction_version) });
        }
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1].storage_id;
      }
    }
    return { candidates: [...holders].map(([owner, versions]) => ({ owner, hint: { versions } })), pages };
  },
  async sanity(chain, ledger, positions) {
    const parts: string[] = [];
    let ok = true;
    for (const [asset, symbol] of [[KAPT, 'kAPT'], [STKAPT, 'stkAPT']]) {
      const [supply] = await chain.view('0x1::fungible_asset::supply', [asset], ['0x1::fungible_asset::Metadata'], ledger.version);
      const total = BigInt(supply.vec[0]), found = positions.filter(p => p.asset === asset).reduce((s, p) => s + BigInt(p.grossClaim[0].raw), 0n);
      ok &&= found <= total;
      parts.push(`${symbol} ${found} of ${total} supply (${pct(found, total)})`);
    }
    return { check: 'receipts found in user primary stores <= token supply', ok, detail: parts.join('; ') };
  },
};

// Every store holding Merkle MKLP, in Coin or paired-FA form.
export const merkleMklpEnumerator: Enumerator = {
  sourceId: 'merkle-mklp',
  processor: 'fungible_asset_processor',
  scope: 'stores holding Merkle MKLP (both collateral types, Coin and paired FA; current_fungible_asset_balances, amount > 0)',
  async run(chain) {
    const holders = new Map<string, Record<string, number>>();
    let pages = 0;
    for (const m of MKLP) {
      const [paired] = await chain.view('0x1::coin::paired_metadata', [], [m.coin]);
      const ids = [m.coin, ...(paired?.vec?.[0]?.inner ? [normalizeAddress(paired.vec[0].inner)] : [])];
      let after = '';
      for (;;) {
        const rows = (await chain.gql(`query($a:[String!]!,$s:String!){ current_fungible_asset_balances(where:{asset_type:{_in:$a}, amount:{_gt:"0"},
          storage_id:{_gt:$s}}, order_by:{storage_id:asc}, limit:${PAGE}){ owner_address storage_id last_transaction_version } }`, { a: ids, s: after })).current_fungible_asset_balances;
        pages++;
        for (const r of rows) {
          const owner = normalizeAddress(r.owner_address), prev = holders.get(owner) ?? {};
          holders.set(owner, { ...prev, [m.coin]: Math.max(prev[m.coin] ?? 0, Number(r.last_transaction_version)) });
        }
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1].storage_id;
      }
    }
    return { candidates: [...holders].map(([owner, versions]) => ({ owner, hint: { versions } })), pages };
  },
  async sanity(chain, ledger, positions) {
    const parts: string[] = [];
    let ok = true;
    for (const m of MKLP) {
      const [supply] = await chain.view('0x1::coin::supply', [], [m.coin], ledger.version);
      const total = BigInt(supply.vec[0]), found = positions.filter(p => p.asset === m.coin).reduce((s, p) => s + BigInt(p.grossClaim[0].raw), 0n);
      ok &&= found <= total;
      parts.push(`${m.label} ${found} of ${total} supply (${pct(found, total)})`);
    }
    return { check: 'MKLP found in holder accounts <= MKLP supply', ok, detail: parts.join('; ') };
  },
};

export const merkleVemklEnumerator = collectionOwners('merkle-vemkl', VEMKL_COLLECTION,
  async () => ({ check: 'none', ok: null, detail: 'no contract total available: each lock holds its own stores' }));

// Receivers with a claimable entry in a LayerZero per-coin claimable table. Incremental: only entries written since
// the stored per-coin version cursor are fetched (a claim rewrites or deletes the entry, so it is seen too). The first
// run, with no cursor, reads every live entry.
export const layerzeroClaimableEnumerator: Enumerator = {
  sourceId: 'layerzero-claimable',
  processor: 'default_processor',
  scope: `entries of the LayerZero claimable tables (coin_bridge::CoinStore<T>.claimable_amt_ld, oft::CoinStore<T>.claimable_amount) for ${LZ_COINS.map(c => c.display).join(', ')} (current_table_items)`,
  async run(chain, cursor) {
    let cursors: Record<string, string> = {};
    try { cursors = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: full rescan */ }
    if (typeof cursors !== 'object' || cursors === null) cursors = {};
    const ledger = await chain.ledger();
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    const owners = new Map<string, Required<ClaimableHint>>();
    let pages = 0;
    for (const c of LZ_COINS) {
      const handle = await claimableHandle(ctx, c);
      if (!handle) continue;
      const table = await tableRows(chain, handle, cursors[c.coin]);
      pages += table.pages;
      cursors[c.coin] = table.cursor;
      const verify = new Map<number, string[]>(); // write version → owners whose entry will be verified on chain
      for (const r of table.rows) {
        const owner = normalizeAddress(r.decoded_key);
        const amount = r.is_deleted ? '0' : String(r.decoded_value ?? 0);
        const hint = owners.get(owner) ?? { versions: {}, amounts: {}, times: {} };
        hint.versions[c.coin] = Number(r.last_transaction_version);
        hint.amounts[c.coin] = amount;
        owners.set(owner, hint);
        if (BigInt(amount) >= c.verifyMin) verify.set(hint.versions[c.coin], [...verify.get(hint.versions[c.coin]) ?? [], owner]);
      }
      // Credit times for the entries that will be verified, a page of versions per query instead of one per position.
      const { times, pages: timePages } = await versionTimes(chain, [...verify.keys()]);
      pages += timePages;
      for (const [v, list] of verify) for (const owner of list) if (times.has(v)) owners.get(owner)!.times[c.coin] = times.get(v)!;
    }
    return { candidates: [...owners].map(([owner, hint]) => ({ owner, hint })), cursor: JSON.stringify(cursors), pages, incremental: true };
  },
  sanity: async () => ({ check: 'none', ok: null, detail: 'no contract total: claimable amounts are minted on claim' }),
};

const HEX = '0123456789abcdef';

/** Rows of a table: all of them with a parallel keyset over 16 key-prefix ranges when `since` is undefined, else
 *  the rows written after version `since` (version keyset). Returns the highest version seen as the next cursor. */
async function tableRows(chain: ChainReader, handle: string, since: string | undefined): Promise<{ rows: any[]; cursor: string; pages: number }> {
  const rows: any[] = [];
  let pages = 0, cursor = since ?? '0';
  const fields = 'key decoded_key decoded_value is_deleted last_transaction_version';
  if (since === undefined) {
    await mapLimit([...HEX], 8, async (c, i) => {
      let after = `0x${c}`;
      const end = i < 15 ? `0x${HEX[i + 1]}` : '0xg';
      for (;;) {
        const page = (await chain.gql(`query($h:String!,$a:String!,$e:String!){ current_table_items(where:{table_handle:{_eq:$h},
          is_deleted:{_eq:false}, key:{_gt:$a, _lt:$e}}, order_by:{key:asc}, limit:${PAGE}){ ${fields} } }`, { h: handle, a: after, e: end })).current_table_items;
        pages++;
        rows.push(...page);
        if (page.length < PAGE) break;
        after = page[page.length - 1].key;
      }
    });
  } else {
    let k = '';
    for (;;) {
      const page = (await chain.gql(`query($h:String!,$v:bigint!,$k:String!){ current_table_items(where:{table_handle:{_eq:$h},
        _or:[{last_transaction_version:{_gt:$v}}, {last_transaction_version:{_eq:$v}, key:{_gt:$k}}]},
        order_by:[{last_transaction_version:asc},{key:asc}], limit:${PAGE}){ ${fields} } }`, { h: handle, v: cursor, k })).current_table_items;
      pages++;
      rows.push(...page);
      if (page.length) { cursor = String(page[page.length - 1].last_transaction_version); k = page[page.length - 1].key; }
      if (page.length < PAGE) break;
    }
  }
  for (const r of rows) if (BigInt(r.last_transaction_version) > BigInt(cursor)) cursor = String(r.last_transaction_version);
  return { rows, cursor, pages };
}

/** Current rows of a u64-keyed table for the given ids, a page of keys per query. Slow on large tables (no key index:
 *  seconds per query), so only for the few ids an incremental scan needs. */
async function rowsByIds(chain: ChainReader, handle: string, ids: string[]): Promise<{ rows: Map<string, any>; pages: number }> {
  const rows = new Map<string, any>();
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 20) batches.push(ids.slice(i, i + 20));
  await mapLimit(batches, 4, async batch => {
    const page = (await chain.gql(`query($h:String!,$ks:[String!]!){ current_table_items(where:{table_handle:{_eq:$h}, key:{_in:$ks}},
      limit:${PAGE}){ decoded_key decoded_value is_deleted last_transaction_version } }`, { h: handle, ks: batch.map(id => u64Key(id)) })).current_table_items;
    for (const r of page) rows.set(String(r.decoded_key), r);
  });
  return { rows, pages: batches.length };
}

/** Write times (unix seconds) of transaction versions, a page of versions per query. */
async function versionTimes(chain: ChainReader, versions: number[]): Promise<{ times: Map<number, number>; pages: number }> {
  const times = new Map<number, number>();
  const unique = [...new Set(versions)];
  const batches: number[][] = [];
  for (let i = 0; i < unique.length; i += PAGE) batches.push(unique.slice(i, i + PAGE));
  await mapLimit(batches, 8, async batch => {
    const txs = (await chain.gql(`query($vs:[bigint!]!){ user_transactions(where:{version:{_in:$vs}}, limit:${PAGE}){ version timestamp } }`,
      { vs: batch.map(String) })).user_transactions;
    for (const t of txs) times.set(Number(t.version), Math.floor(Date.parse(t.timestamp + 'Z') / 1000));
  });
  return { times, pages: batches.length };
}

// Topaz bids with their bidder, escrowed APT and deadline, read from the bid tables themselves
// (collection_marketplace::Bids<APT>; bid_any::CoinEscrow<APT> joined to bid_any::Bids for the bidder). Rows are never
// deleted: a cancel or fill rewrites the bid with empty coins, so the per-table version cursors catch every change.
export const topazBidsEnumerator: Enumerator = {
  sourceId: 'topaz-bids',
  processor: 'default_processor',
  scope: `bids in ${TOPAZ}::collection_marketplace::Bids<APT> and ::bid_any::CoinEscrow<APT> (current_table_items)`,
  async run(chain, cursor) {
    let cursors: Record<string, string> = {};
    try { cursors = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: full rescan */ }
    if (typeof cursors !== 'object' || cursors === null) cursors = {};
    const ledger = await chain.ledger();
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    const tables = await topazTables(ctx);
    const hints = new Map<string, TopazHint>();
    const add = (buyer: string, kind: TopazKind, id: string, bid: TopazBid) => {
      const owner = normalizeAddress(buyer);
      const hint = hints.get(owner) ?? {};
      hint[kind] = { ...hint[kind], [id]: bid };
      hints.set(owner, hint);
    };
    const full = !cursors.c && !cursors.a && !cursors.b;
    const deadlineOf = (v: any) => v?.deadline !== undefined ? Math.floor(Number(v.deadline) / 1e6) : undefined;
    let pages = 0;
    const scan = async (key: string, handle: string) => {
      const t = await tableRows(chain, handle, cursors[key]);
      pages += t.pages;
      cursors[key] = t.cursor;
      return t.rows.filter(r => !r.is_deleted);
    };

    for (const r of await scan('c', tables.c.store)) {
      const v = r.decoded_value;
      add(v.buyer, 'c', String(r.decoded_key), { raw: String(v.coins?.value ?? 0), deadline: deadlineOf(v) });
    }
    const escrow = await scan('a', tables.a.store);
    const details = new Map((await scan('b', tables.anyBids)).map(r => [String(r.decoded_key), r.decoded_value]));
    const missing = escrow.map(r => String(r.decoded_key)).filter(id => !details.has(id));
    if (missing.length) {
      const looked = await rowsByIds(chain, tables.anyBids, missing);
      pages += looked.pages;
      for (const [id, r] of looked.rows) if (!r.is_deleted) details.set(id, r.decoded_value);
    }
    for (const r of escrow) {
      const id = String(r.decoded_key), d = details.get(id);
      if (!d?.buyer) continue;   // bidder unknown: counted nowhere (the bid row is never deleted, so this should not happen)
      add(d.buyer, 'a', id, { raw: String(r.decoded_value?.value ?? 0), deadline: deadlineOf(d) });
    }
    // A full scan keeps only bidders with escrowed coins; an incremental one keeps every change (a cancel empties a bid).
    const owners = [...hints].filter(([, h]) => !full || Object.values(h).some(m => Object.values(m).some(b => BigInt(b.raw) > 0n)));
    return { candidates: owners.map(([owner, hint]) => ({ owner, hint })), cursor: JSON.stringify(cursors), pages, incremental: true };
  },
  sanity: async () => ({ check: 'none', ok: null, detail: 'no contract total: each bid holds its own coins' }),
};

const CANOPY_CLAIMS: EntryFunction[] = [
  { contract: CANOPY_REWARDS, module: 'multi_rewards', name: 'claim_reward' },
  { contract: CANOPY_REWARDS, module: 'multi_rewards', name: 'unsubscribe' },
  { contract: CANOPY_REWARDS, module: 'router', name: 'claim_rewards' },
];

// Canopy stakers on Movement: every key of multi_rewards' user_staked_balances table (staker → staked tokens). The
// table key is not decoded by the indexer; it is the staker's address. Incremental by version: a stake or withdraw
// rewrites the staker's row. Claims do not, so stakers are also re-read monthly.
export const canopyEndedRewardsEnumerator: Enumerator = {
  sourceId: 'canopy-ended-rewards',
  processor: 'default_processor',
  scope: `stakers in ${CANOPY_REWARDS}::multi_rewards (MultiRewardsModule.user_staked_balances, current_table_items), plus senders of its claim and unsubscribe calls`,
  async run(chain, cursor) {
    let cursors: { t?: string; s?: string } = {};
    try { cursors = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: full rescan */ }
    if (typeof cursors !== 'object' || cursors === null) cursors = {};
    const state = await chain.resource(CANOPY_REWARDS_STATE, `${CANOPY_REWARDS}::multi_rewards::MultiRewardsModule`);
    if (!state) throw new Error('Canopy MultiRewardsModule missing');
    const table = await tableRows(chain, normalizeAddress(state.user_staked_balances.handle), cursors.t);
    // Claims and unsubscribes change what a staker is owed without touching the staking table.
    const claims = await senders(chain, CANOPY_CLAIMS, cursors.s);
    const owners = new Set([...table.rows.map(r => normalizeAddress(r.key)), ...claims.candidates.map(c => c.owner)]);
    return { candidates: [...owners].map(owner => ({ owner })), cursor: JSON.stringify({ t: table.cursor, s: claims.cursor }),
      pages: table.pages + claims.pages, incremental: true };
  },
  sanity: async () => ({ check: 'none', ok: null, detail: 'no contract total: earned rewards are computed per staker' }),
};

// Canopy vault shares (Movement): every store holding a vault's shares token (the staking pool's own store left out:
// its shares belong to the stakers), and every staker in multi_rewards (shares are staked there; the read checks which).
// Store holders carry each store's last change by shares token, stakers the version of their last stake or withdrawal
// by shares token (from multi_rewards' events since the first freeze: the staking row is one per staker, so its version
// does not say which shares changed), for aging.
const CANOPY_STAKES_FROM = 156_180_000;   // just before the first freeze (2026-06-16)
const STAKE_EVENTS_QUERY = `query($t:[String!]!,$v:bigint!,$i:bigint!){ events(where:{indexed_type:{_in:$t}, _or:[{transaction_version:{_gt:$v}},
  {transaction_version:{_eq:$v}, event_index:{_gt:$i}}]}, order_by:[{transaction_version:asc},{event_index:asc}], limit:${PAGE}){ transaction_version event_index data } }`;
export const canopyFrozenEnumerator: Enumerator = {
  sourceId: 'canopy-frozen-vaults',
  processor: 'fungible_asset_processor',
  // The read looks up stake and withdrawal times in user transactions.
  alsoProcessors: ['default_processor', 'events_processor', 'user_transaction_processor'],
  scope: `stores holding any ${CANOPY_VAULTS}::vault shares token (current_fungible_asset_balances), plus stakers in ${CANOPY_REWARDS}::multi_rewards (user_staked_balances) with their stakes and withdrawals from version ${CANOPY_STAKES_FROM}`,
  async run(chain) {
    const shares: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const [page] = await chain.view(`${CANOPY_VAULTS}::vault::vaults_view`, [String(offset), '100']);
      shares.push(...(page as any).vaults.map((v: any) => normalizeAddress(v.shares_address)));
      if ((page as any).vaults.length < 100) break;
    }
    // Share stores, the staking table and stakes come from three processors: the lowest watermark, taken before the
    // scans, is a version everything they read is at least as recent as.
    const w = String((await Promise.all(['fungible_asset_processor', 'default_processor', 'events_processor'].map(p => processorWatermark(chain, p))))
      .map(m => BigInt(m.version)).reduce((a, b) => (a < b ? a : b)));
    const hints = new Map<string, { at?: Record<string, string>; v?: Record<string, string> }>();
    let pages = 1;
    let after = '';
    for (;;) {
      const rows = (await chain.gql(`query($a:[String!]!,$s:String!){ current_fungible_asset_balances(where:{asset_type:{_in:$a}, amount:{_gt:"0"},
        storage_id:{_gt:$s}}, order_by:{storage_id:asc}, limit:${PAGE}){ owner_address asset_type storage_id is_primary last_transaction_timestamp } }`, { a: shares, s: after })).current_fungible_asset_balances;
      pages++;
      for (const r of rows) {
        const owner = normalizeAddress(r.owner_address), token = normalizeAddress(r.asset_type);
        if (owner === CANOPY_REWARDS_STATE) continue;
        // Only the primary store dates the wallet's shares; a secondary store's owner is a candidate without a date.
        const at = new Date(r.last_transaction_timestamp + 'Z').toISOString(), prev = hints.get(owner) ?? {};
        hints.set(owner, r.is_primary && (!prev.at?.[token] || at > prev.at[token]) ? { ...prev, at: { ...prev.at, [token]: at } } : prev);
      }
      if (rows.length < PAGE) break;
      after = rows[rows.length - 1].storage_id;
    }
    const state = await chain.resource(CANOPY_REWARDS_STATE, `${CANOPY_REWARDS}::multi_rewards::MultiRewardsModule`);
    if (!state) throw new Error('Canopy MultiRewardsModule missing');
    const table = await tableRows(chain, normalizeAddress(state.user_staked_balances.handle), undefined);
    for (const r of table.rows) {
      const owner = normalizeAddress(r.key);
      hints.set(owner, hints.get(owner) ?? {});
    }
    pages += table.pages;
    let v = String(CANOPY_STAKES_FROM), i = '-1';
    for (;;) {
      const events = (await chain.gql(STAKE_EVENTS_QUERY, { t: ['StakeEvent', 'WithdrawEvent', 'EmergencyWithdrawEvent'].map(e => `${CANOPY_REWARDS}::multi_rewards::${e}`), v, i })).events;
      pages++;
      for (const e of events) {
        // A staker the table does not list yet (its processor trailing) is a candidate too: the read finds what it holds.
        const owner = normalizeAddress(e.data.user), token = normalizeAddress(e.data.staking_token.inner), h = hints.get(owner) ?? {};
        hints.set(owner, { ...h, v: { ...h.v, [token]: String(e.transaction_version) } });
      }
      if (events.length < PAGE) break;
      const last = events[events.length - 1];
      v = String(last.transaction_version); i = String(last.event_index);
    }
    return { candidates: [...hints].map(([owner, hint]) => ({ owner, hint: { ...hint, w } })), pages };
  },
  sanity: async () => ({ check: 'none', ok: null, detail: 'no contract total: shares are spread over wallets and the staking pool' }),
};

// Senders of smart_chef::deposit: everyone who staked in a PancakeSwap (Aptos) CAKE syrup pool.
// Deposits after the last CAKE pool ended (version ~444.55M, 2024-02-09 14:05 UTC) only went to the Gui Inu pools.
// Withdrawals (any time) mark a staker changed, so an exit drops out in the next run instead of at a monthly re-read.
export const pancakeSyrupEnumerator = entrySenders('pancake-syrup-ended', [
  { contract: SMART_CHEF, module: 'smart_chef', name: 'deposit', untilVersion: 444_552_000 },
  { contract: SMART_CHEF, module: 'smart_chef', name: 'withdraw' },
  { contract: SMART_CHEF, module: 'smart_chef', name: 'emergency_withdraw' }],
  async (chain, ledger, positions) => {
    const parts: string[] = [];
    let ok = true;
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    for (const pool of SYRUP_POOLS) {
      const { staked } = await poolState(ctx, pool);
      const found = sumGross(positions.filter(p => p.locator === `pool-${pool.uid}` && p.positionKind === 'principal'));
      ok &&= found <= staked;
      if (staked > 0n) parts.push(`${pool.uid} ${pct(found, staked)}`);
    }
    return { check: 'stake found per pool <= pool total_staked_token', ok, detail: parts.join('; ') };
  });

// Deposits at any time: before the end they make a farmer; after it they harvest, so the farmer changed. A depositor
// with nothing pending is read once and never again (zero: 'never'). A harvest is also withdraw(0).
export const pancakeFarmEnumerator = entrySenders('pancake-farm-ended-rewards', [
  { contract: MASTERCHEF, module: 'masterchef', name: 'deposit' },
  { contract: MASTERCHEF, module: 'masterchef', name: 'withdraw' },
  { contract: MASTERCHEF, module: 'masterchef', name: 'emergency_withdraw' }],
  async (chain, ledger, positions) => {
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    const { cakeLeft } = await chefState(ctx);
    const found = sumGross(positions.filter(p => p.asset === CAKE));
    return { check: 'pending CAKE found <= CAKE held by MasterChef', ok: found <= cakeLeft, detail: `${found} of ${cakeLeft} (${pct(found, cakeLeft)})` };
  });

// Echelon suppliers at any time, Coin and fungible-asset markets: a frozen market still accepts supply, so a late
// supplier counts too. Withdrawals mark a supplier changed; so do borrows and repayments (a supplier counts only
// without debt). Those only matter after an owner's first read, which comes after this source was added (2026-10-20),
// so their scan starts there. Suppliers with nothing counted are read once (zero: 'never').
const ECHELON_DEBT_FROM = 7_694_000_000;
export const echelonFrozenEnumerator = entrySenders('echelon-frozen-markets', [
  ...['supply', 'withdraw', 'withdraw_all', 'supply_fa', 'withdraw_fa', 'withdraw_all_fa'].map(name => ({ contract: ECHELON, module: 'scripts', name })),
  ...['borrow', 'borrow_fa', 'repay', 'repay_all', 'repay_fa', 'repay_all_fa'].map(name => ({ contract: ECHELON, module: 'scripts', name, fromVersion: ECHELON_DEBT_FROM })),
],
  async (chain, ledger, positions) => {
    const parts: string[] = [];
    let ok = true;
    for (const m of FROZEN_MARKETS) {
      const [[shares], [num, den]] = await Promise.all([
        chain.view(`${ECHELON}::lending::market_total_shares`, [m.market], [], ledger.version),
        chain.view(`${ECHELON}::lending::exchange_rate`, [m.market], [], ledger.version),
      ]);
      const supplied = BigInt(shares) * BigInt(num) / BigInt(den);
      const found = sumGross(positions.filter(p => p.locator === m.label));
      ok &&= found <= supplied;
      parts.push(`${m.label} ${pct(found, supplied)} of supply found`);
    }
    // Coverage stays below 100%: suppliers in debt are left out, and so is supply held by contracts that never call
    // scripts::supply* themselves (vaults, strategies).
    return { check: 'supply found per market <= market supply (shares x exchange rate); coverage shown', ok, detail: parts.join('; ') };
  });

/** Scaled balances in an Aave token (aToken or debt token): its token_base user table, a SmartTable read bucket by
 *  bucket from the fullnode (the indexer's copy misses buckets). Fails unless every entry is read. */
async function aaveScaledBalances(chain: ChainReader, token: string, version: string): Promise<{ balances: Map<string, bigint>; reads: number }> {
  const table = (await chain.resource(token, `${AAVE}::token_base::TokenBaseState`, version)).user_state;
  const buckets = await mapLimit([...Array(Number(table.num_buckets)).keys()], 8, i => chain.tableItem(table.buckets.inner.handle, 'u64',
    `vector<0x1::smart_table::Entry<address,${AAVE}::token_base::UserState>>`, String(i), version));
  const balances = new Map<string, bigint>();
  for (const bucket of buckets) for (const e of bucket ?? []) balances.set(normalizeAddress(e.key), BigInt(e.value.balance));
  if (balances.size !== Number(table.size)) throw new Error(`Aave token ${token}: read ${balances.size} of ${table.size} holders`);
  return { balances, reads: buckets.length + 1 };
}

// Aave (Aptos): holders of frozen reserves' aTokens. Each holder's hint is its scaled balances in the frozen aTokens and
// in every debt token, so a supply, withdrawal, borrow or repayment re-reads it, and accruing interest does not. It also
// carries each frozen reserve's freeze time, dated once and kept in the cursor; a freeze that could not be dated yet is
// null, so its holders are re-read in the run that dates it. While no reserve is frozen, a run costs one view.
export const aaveFrozenEnumerator: Enumerator = {
  sourceId: 'aave-frozen-reserves',
  processor: null,
  scope: `holders of frozen Aave reserves' aTokens (${AAVE}::token_base user tables, every bucket, read from the fullnode at the run's ledger version)`,
  async run(chain, cursor) {
    let dated: Record<string, string> = {};
    try { dated = cursor ? JSON.parse(cursor).f ?? {} : {}; } catch { /* unreadable cursor: date again */ }
    const ledger = await chain.ledger();
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    const reserves = await aaveReserves(ctx);
    const frozen = reserves.filter(r => r.frozen);
    let pages = 1;
    if (!frozen.length) return { candidates: [], cursor, pages };
    for (const r of frozen) {
      const at = dated[r.asset] ?? await findFreeze(chain, ledger.version, r);
      if (at) dated[r.asset] = at;
    }
    const hints = new Map<string, AaveHint>();
    for (const r of frozen) {
      const t = await aaveScaledBalances(chain, r.aToken, ledger.version);
      pages += t.reads;
      for (const [owner, b] of t.balances) {
        const hint = hints.get(owner);
        if (b > 0n) hints.set(owner, { a: { ...hint?.a, [r.asset]: b.toString() }, d: {}, f: { ...hint?.f, [r.asset]: dated[r.asset] ?? null } });
      }
    }
    for (const r of reserves) {
      const t = await aaveScaledBalances(chain, r.debtToken, ledger.version);
      pages += t.reads;
      for (const [owner, b] of t.balances) {
        const hint = hints.get(owner);
        if (hint && b > 0n) hint.d[r.asset] = b.toString();
      }
    }
    return { candidates: [...hints].map(([owner, hint]) => ({ owner, hint })), cursor: JSON.stringify({ f: dated }), pages };
  },
  async sanity(chain, ledger, positions) {
    const ctx = { chain, ledger, memo: { get: async () => undefined, set: async () => {} }, scratch: new Map() };
    const frozen = (await aaveReserves(ctx)).filter(r => r.frozen);
    if (!frozen.length) return { check: 'none', ok: null, detail: 'no Aave reserve is frozen yet' };
    const parts: string[] = [];
    let ok = true;
    for (const r of frozen) {
      const [supply] = await chain.view(`${AAVE}::pool_data_provider::get_a_token_total_supply`, [r.asset], [], ledger.version);
      const found = sumGross(positions.filter(p => p.locator === r.symbol));
      ok &&= found <= BigInt(supply);
      parts.push(`${r.symbol} ${pct(found, BigInt(supply))} of supply found`);
    }
    // Coverage stays below 100%: suppliers in debt are left out.
    return { check: 'supply found per frozen reserve <= aToken total supply; coverage shown', ok, detail: parts.join('; ') };
  },
};

const noContractTotal: Enumerator['sanity'] = async () =>
  ({ check: 'none', ok: null, detail: 'no contract total available: balances are stored per account' });

// Econia: owners who registered a market account themselves, directly or through Kana's wrapper (accounts a custodian
// registered are out of scope, and custodian accounts are not counted). Another integration that registers accounts
// through its own entry functions is missed until it is listed here. Deposits, withdrawals and orders mark an owner
// changed; those only matter after an owner's first read, which comes after this source was added (2026-10-20), so
// their scan starts there. A fill of a resting order is sent by the taker, so makers are taken from the coin markets'
// open orders each run: current makers and last run's are re-read (a fill moves coins between base and quote, and the
// account whose order filled is read again in the run after). An owner's own call puts the run's time in its hint for
// every market (the scan does not see which one), and a change to its open orders it did not make (a fill, whole or
// partial) for that market only, so a balance that changed after the archive date is aged from the run that saw it,
// never from the archive.
const ECONIA_CHANGES_FROM = 7_696_900_000;
const ECONIA_REGISTRATIONS: EntryFunction[] = [
  ...['register_market_account', 'register_market_account_generic_base'].map(name => ({ contract: ECONIA, module: 'user', name })),
  ...['deposit_and_register_base', 'deposit_and_register_quote', 'place_limit_order_user_entry', 'place_market_order_user_entry']
    .map(name => ({ contract: KANA_ECONIA_WRAPPER, module: 'wrapper', name })),
];
const ECONIA_CHANGES: EntryFunction[] = [
  ...[['user', 'deposit_from_coinstore'], ['user', 'withdraw_to_coinstore'], ['market', 'place_limit_order_user_entry'],
    ['market', 'place_market_order_user_entry'], ['market', 'place_limit_order_passive_advance_user_entry'],
    ['market', 'change_order_size_user'], ['market', 'cancel_order_user'], ['market', 'cancel_all_orders_user']]
    .map(([module, name]) => ({ contract: ECONIA, module, name, fromVersion: ECONIA_CHANGES_FROM })),
  ...['place_limit_order_user_entry', 'place_market_order_user_entry', 'place_limit_order_user_entry_without_deposit',
    'place_market_order_user_entry_without_deposit', 'cancel_all_orders', 'deposit_and_register_base', 'deposit_and_register_quote']
    .map(name => ({ contract: KANA_ECONIA_WRAPPER, module: 'wrapper', name, fromVersion: ECONIA_CHANGES_FROM })),
];

const econiaSenders = entrySenders('econia-idle-accounts', [...ECONIA_REGISTRATIONS, ...ECONIA_CHANGES], noContractTotal);
export const econiaIdleEnumerator: Enumerator = {
  ...econiaSenders,
  scope: `${econiaSenders.scope}; plus owner-controlled makers with open orders in coin markets ${ECONIA_COIN_MARKETS[0]}-${ECONIA_COIN_MARKETS.at(-1)}`,
  async run(chain, cursor) {
    let stored: { r?: string; c?: string; m?: Record<string, string> } = {};
    try { stored = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: rescan */ }
    if (typeof stored !== 'object' || stored === null) stored = {};
    const ledger = await chain.ledger();
    const registered = await senders(chain, ECONIA_REGISTRATIONS, stored.r);
    const changed = await senders(chain, ECONIA_CHANGES, stored.c);
    // Each maker's open orders now (market, order id, remaining size), and last run's: an order that filled, in whole
    // or in part, moved coins between base and quote.
    const orders = new Map<string, string[]>();
    for (const market of ECONIA_COIN_MARKETS) {
      const [open] = await chain.view(`${ECONIA}::market::get_open_orders_all`, [market]);
      for (const o of [...open.asks, ...open.bids]) if (o.custodian_id === '0') {
        const maker = normalizeAddress(o.user);
        orders.set(maker, [...(orders.get(maker) ?? []), `${o.market_id}:${o.order_id}:${o.remaining_size}`]);
      }
    }
    const makers = Object.fromEntries([...orders].map(([maker, list]) => [maker, list.sort().join(',')]));
    // Only this shape is compared: any other (an earlier cursor's maker list) counts as no previous orders, which dates nobody.
    const previous: Record<string, string> = stored.m && typeof stored.m === 'object' && !Array.isArray(stored.m)
      ? Object.fromEntries(Object.entries(stored.m).filter(([, v]) => typeof v === 'string')) : {};
    // The owner's own calls date all its balances from this run, and changes to its orders since last run the balances
    // in that market. Every candidate carries a hint (empty when nothing changed): a read without one is the check
    // page's, which cannot tell whether a balance changed after the archive date.
    const since = iso(ledger.timestampSecs);
    const acted = new Set(changed.candidates.map(c => c.owner));
    const byMarket = (list: string) => {
      const m = new Map<string, string>();
      for (const o of list ? list.split(',') : []) { const id = o.slice(0, o.indexOf(':')); m.set(id, m.has(id) ? `${m.get(id)},${o}` : o); }
      return m;
    };
    const filled = new Map<string, string[]>();
    for (const maker of Object.keys(previous)) {
      const before = byMarket(previous[maker]), now = byMarket(makers[maker] ?? '');
      const markets = [...before.keys()].filter(id => before.get(id) !== now.get(id));
      if (markets.length) filled.set(maker, markets);
    }
    const owners = new Set([...registered.candidates.map(c => c.owner), ...acted, ...Object.keys(makers), ...Object.keys(previous)]);
    return { candidates: [...owners].map(owner => ({ owner, hint: { ...(acted.has(owner) ? { since } : {}),
        ...(filled.has(owner) ? { markets: Object.fromEntries(filled.get(owner)!.map(id => [id, since])) } : {}) } })),
      cursor: JSON.stringify({ r: registered.cursor, c: changed.cursor, m: makers }),
      pages: registered.pages + changed.pages + ECONIA_COIN_MARKETS.length, incremental: true };
  },
};

// Earnium: everyone who added liquidity or staked it (directly or through the router), ever, and every wallet holding
// LP (current primary stores per pool, transfers included). A staking call after the closure day began that moved a
// pool's LP (staking, unstaking, adding and staking) dates that pool's stake for its sender from the call's time, so a
// stake used after the closure is aged from then; wallet LP carries its store's last change, which every wallet move
// (adding, removing, unstaking, a transfer) updates. Reward claims move no LP and date nothing. A full scan every run (~140 pages): a wallet that sent all its LP
// away drops out and is re-read, and every hint carries this run's watermark, against which the read checks that
// nothing changed after the scans.
const EARNIUM_CHANGES_FROM = 7_706_000_000;   // 2026-10-21, before the closure's end of day
const EARNIUM_ADD = ['add_liquidity_entry', 'add_liquidity_coin_entry', 'add_liquidity_both_coins_entry', 'add_liquidity_and_stake_entry',
  'add_liquidity_and_stake_coin_entry', 'add_liquidity_and_stake_both_coins_entry'];
const EARNIUM_HOLDERS: EntryFunction[] = [
  ...EARNIUM_ADD.map(name => ({ contract: EARNIUM, module: 'router', name })),
  ...['stake', 'stake_and_lock'].map(name => ({ contract: EARNIUM, module: 'liquidity_stake_pool', name })),
];
const EARNIUM_CALLS_QUERY = `query($a:bigint!,$w:bigint!){ user_transactions(where:{entry_function_contract_address:{_eq:"${EARNIUM}"}, _or:[
  {entry_function_module_name:{_eq:"router"}, entry_function_function_name:{_in:${JSON.stringify(EARNIUM_ADD.filter(f => f.includes('_and_stake')))}}},
  {entry_function_module_name:{_eq:"liquidity_stake_pool"}, entry_function_function_name:{_in:["stake","stake_and_lock","unstake"]}}],
  version:{_gt:$a, _lte:$w}}, order_by:{version:asc}, limit:${PAGE}){ version sender timestamp } }`;
const LP_MOVES_QUERY = `query($v:bigint!,$p:[String!]!){ fungible_asset_activities(where:{transaction_version:{_eq:$v}, asset_type:{_in:$p}},
  limit:${PAGE}){ asset_type } }`;
const earniumSenders = entrySenders('earnium-closed-lp', EARNIUM_HOLDERS, noContractTotal);
export const earniumClosedEnumerator: Enumerator = {
  ...earniumSenders,
  alsoProcessors: ['fungible_asset_processor'],
  scope: `${earniumSenders.scope}; plus every wallet holding LP, and Earnium staking calls from version ${EARNIUM_CHANGES_FROM} with the pools whose LP they moved`,
  async run(chain) {
    // Calls and the LP they moved come from two processors: scan only what both have indexed. Taken before the scans,
    // so everything they read is at least this recent.
    const indexed = String([await processorWatermark(chain, 'user_transaction_processor'), await processorWatermark(chain, 'fungible_asset_processor')]
      .map(m => BigInt(m.version)).reduce((a, b) => (a < b ? a : b)));
    const holders = await senders(chain, EARNIUM_HOLDERS, undefined);
    const [pools] = await chain.view(`${EARNIUM}::liquidity_pool::pools`, []);
    const poolIds = (pools as { inner: string }[]).map(p => normalizeAddress(p.inner));
    let pages = holders.pages + 1;
    const staked = new Map<string, Record<string, string>>();
    let after = String(EARNIUM_CHANGES_FROM);
    for (;;) {
      const page = (await chain.gql(EARNIUM_CALLS_QUERY, { a: after, w: indexed })).user_transactions;
      pages++;
      for (const t of page) {
        const sender = normalizeAddress(t.sender), at = new Date(t.timestamp + 'Z').toISOString();
        const touched = (await chain.gql(LP_MOVES_QUERY, { v: String(t.version), p: poolIds })).fungible_asset_activities;
        pages++;
        for (const { asset_type } of touched) staked.set(sender, { ...staked.get(sender), [normalizeAddress(asset_type)]: at });
      }
      if (page.length) after = String(page[page.length - 1].version);
      if (page.length < PAGE) break;
    }
    // LP in wallets, also when it arrived by transfer: every pool's primary stores (staked LP sits in the staking pools'
    // own, non-primary stores), each with its last change.
    const lps = new Map<string, Record<string, string>>();
    for (const pool of poolIds) {
      let from = '';
      for (;;) {
        const rows = (await chain.gql(`query($a:String!,$s:String!){ current_fungible_asset_balances(where:{asset_type:{_eq:$a}, is_primary:{_eq:true},
          amount:{_gt:"0"}, storage_id:{_gt:$s}}, order_by:{storage_id:asc}, limit:${PAGE}){ owner_address storage_id last_transaction_timestamp } }`, { a: pool, s: from })).current_fungible_asset_balances;
        pages++;
        for (const r of rows) {
          const owner = normalizeAddress(r.owner_address);
          lps.set(owner, { ...lps.get(owner), [pool]: new Date(r.last_transaction_timestamp + 'Z').toISOString() });
        }
        if (rows.length < PAGE) break;
        from = rows[rows.length - 1].storage_id;
      }
    }
    // Every candidate carries a hint: a read without one is the check page's, which ages from the closure.
    const owners = new Set([...holders.candidates.map(c => c.owner), ...staked.keys(), ...lps.keys()]);
    return { candidates: [...owners].map(owner => ({ owner, hint: { ...(staked.has(owner) ? { staked: staked.get(owner) } : {}),
        ...(lps.has(owner) ? { lps: lps.get(owner) } : {}), w: indexed } })), pages };
  },
};

// HoustonSwap: everyone who added liquidity, ever (positions sit in the owner's own account, one PositionWallet per
// pair; a position can only move between accounts through another contract, and none is known). A liquidity call after
// the closure day began dates the pairs it changed for its sender, from the call's time: the sender's position wallets
// just before and at the call, compared. Calls are scanned once, from the cursor, so that comparison reads history the
// fullnode still keeps (~11 days; runs are weekly); the dates found are kept in the cursor. A call whose history is
// pruned anyway dates every pair its sender holds. The senders are a full scan every run (~25 pages): every hint carries
// this run's watermark, against which the read checks that nothing changed after the scans.
const HOUSTON_CHANGES_FROM = 7_715_000_000;   // 2026-10-22, before the closure's end of day
const HOUSTON_ADDS: EntryFunction[] = [{ contract: HOUSTON, module: 'liquidity_manager', name: 'add_liquidity' }];
const HOUSTON_CALLS_QUERY = `query($a:bigint!,$w:bigint!){ user_transactions(where:{entry_function_contract_address:{_eq:"${HOUSTON}"},
  entry_function_module_name:{_eq:"liquidity_manager"}, version:{_gt:$a, _lte:$w}}, order_by:{version:asc}, limit:${PAGE}){ version sender timestamp } }`;
const HOUSTON_WALLET = `${HOUSTON}::position::PositionWallet`;
/** An account's position wallets by pair (`<X, Y>`), as stored. */
async function houstonWallets(chain: ChainReader, owner: string, version: string): Promise<Map<string, string>> {
  const all = await chain.resources(owner, version);
  if (!all) throw new Error(`resources of ${owner}: more than one page`);
  return new Map(all.filter(r => r.type.startsWith(`${HOUSTON_WALLET}<`)).map(r => [r.type.slice(HOUSTON_WALLET.length), JSON.stringify(r.data)]));
}
const houstonSenders = entrySenders('houston-closed-lp', HOUSTON_ADDS, async (chain, ledger, positions) => {
  // What the pool pays the positions (principal: burn and owed fees; stored coins are the positions' own), per pair and
  // side, cannot exceed that pair's reserves (all fee tiers). A position the pool is short for is blocked and pays
  // nothing, so what it is owed does not count here.
  const paid = new Map<string, bigint>();
  for (const p of positions.filter(p => p.positionKind === 'principal')) {
    const key = `${p.locator.slice(0, p.locator.lastIndexOf('#'))}|${p.asset}`;
    paid.set(key, (paid.get(key) ?? 0n) + BigInt(p.expectedPayout[0]?.raw ?? 0));
  }
  const over: string[] = [];
  let pools = 0;
  for (const pair of new Set(positions.map(p => p.locator.slice(0, p.locator.lastIndexOf('#'))))) {
    const state = await chain.resource(HOUSTON_POOLS, `${HOUSTON}::pool::Pool${pair}`, ledger.version);
    pools++;
    const [x, y] = pairOf(`P${pair}`);
    for (const [side, coin] of [['reserve_x', x], ['reserve_y', y]]) {
      const reserve = (state.fee_tier.data as any[]).reduce((t, e) => t + BigInt(e.value[side].value), 0n);
      const p = paid.get(`${pair}|${animeswapAsset(coin)}`) ?? 0n;
      if (p > reserve) over.push(`${pair} ${side}: ${p} > ${reserve}`);
    }
  }
  return { check: 'amounts payable <= pool reserves, per pair and side', ok: over.length === 0,
    detail: `${pools} pairs with positions${over.length ? `; over: ${over.join('; ')}` : ''}` };
});
export const houstonClosedEnumerator: Enumerator = {
  ...houstonSenders,
  scope: `${houstonSenders.scope}; plus liquidity calls from version ${HOUSTON_CHANGES_FROM}, with the pairs they changed`,
  async run(chain, cursor) {
    let stored: { v?: string; moved?: Record<string, Record<string, string>> } = {};
    try { stored = cursor ? JSON.parse(cursor) : {}; } catch { /* unreadable cursor: rescan */ }
    if (typeof stored !== 'object' || stored === null) stored = {};
    // Taken before the scans, so everything they read is at least this recent.
    const indexed = (await processorWatermark(chain, 'user_transaction_processor')).version;
    const adders = await senders(chain, HOUSTON_ADDS, undefined);
    let pages = adders.pages;
    const moved = new Map<string, Record<string, string>>(Object.entries(stored.moved && typeof stored.moved === 'object' ? stored.moved : {}));
    let after = typeof stored.v === 'string' ? stored.v : String(HOUSTON_CHANGES_FROM);
    for (;;) {
      const page = (await chain.gql(HOUSTON_CALLS_QUERY, { a: after, w: indexed })).user_transactions;
      pages++;
      for (const t of page) {
        const sender = normalizeAddress(t.sender), at = new Date(t.timestamp + 'Z').toISOString(), v = BigInt(t.version);
        let changed: string[];
        try {
          const [before, now] = await Promise.all([houstonWallets(chain, sender, String(v - 1n)), houstonWallets(chain, sender, String(v))]);
          changed = [...new Set([...before.keys(), ...now.keys()])].filter(pair => before.get(pair) !== now.get(pair));
        } catch (err) {
          if (!/HTTP 410|pruned/i.test(String(err))) throw err;
          changed = [...(await houstonWallets(chain, sender, String(indexed))).keys()];
        }
        for (const pair of changed) moved.set(sender, { ...moved.get(sender), [pair]: at });
      }
      if (page.length < PAGE) break;
      after = String(page[page.length - 1].version);
    }
    // Every candidate carries a hint: a read without one is the check page's, which has no history to date it.
    const owners = new Set([...adders.candidates.map(c => c.owner), ...moved.keys()]);
    return { candidates: [...owners].map(owner => ({ owner, hint: { ...(moved.has(owner) ? { moved: moved.get(owner) } : {}), w: String(indexed) } })),
      cursor: JSON.stringify({ v: String(indexed), moved: Object.fromEntries(moved) }), pages };
  },
};

// Echo lending: every holder of an Echo aToken (aTokens cannot be transferred, so holders are suppliers) of about $1 or
// more, one scan per reserve, Echo's own wallets left out. Smaller holdings are dust: 47,870 of 48,460 APT holders hold
// 587 APT of the reserve's 297,679 (2026-10-24); the check page still reads any address in full. No hint: the age is the
// wind-down notice, and deposits stopped with it.
export const echoWoundDownEnumerator: Enumerator = {
  sourceId: 'echo-wound-down',
  processor: 'fungible_asset_processor',
  scope: `stores holding about $1 or more of any of the ${ECHO_RESERVES.length} ${ECHO} lending aTokens (current_fungible_asset_balances), except Echo's own wallets`,
  async run(chain) {
    const owners = new Set<string>();
    let pages = 0;
    for (const r of ECHO_RESERVES) {
      let after = '';
      for (;;) {
        const rows = (await chain.gql(`query($a:String!,$m:numeric!,$s:String!){ current_fungible_asset_balances(where:{asset_type:{_eq:$a}, amount:{_gte:$m},
          storage_id:{_gt:$s}}, order_by:{storage_id:asc}, limit:${PAGE}){ owner_address storage_id } }`, { a: r.aToken, m: r.minScaled.toString(), s: after })).current_fungible_asset_balances;
        pages++;
        for (const row of rows) {
          const owner = normalizeAddress(row.owner_address);
          if (!ECHO_OWN_WALLETS.has(owner)) owners.add(owner);
        }
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1].storage_id;
      }
    }
    return { candidates: [...owners].map(owner => ({ owner })), pages };
  },
  async sanity(chain, ledger, positions) {
    // What the positions are owed, per reserve, cannot exceed what all its lenders are owed (the aToken's supply).
    let ok = true;
    for (const r of ECHO_RESERVES) {
      const owed = positions.filter(p => p.locator === r.symbol || p.locator === `${r.symbol}/lent-out`).reduce((t, p) => t + BigInt(p.grossClaim[0].raw), 0n);
      if (owed === 0n) continue;
      const [supply] = await chain.view(`${ECHO}::pool_data_provider::get_a_token_total_supply`, [r.underlying], [], ledger.version);
      ok &&= owed <= BigInt(supply);
    }
    return { check: 'amounts found <= aToken supply, per reserve', ok, detail: `${ECHO_RESERVES.length} reserves` };
  },
};

export const thalaVethlEnumerator = entrySenders('thala-vethl-expired',
  [{ contract: THALA_VE, module: 'scripts', name: 'lock' }, { contract: THALA_VEST, module: 'farming_vesting', name: 'convert_to_vethl' }],
  noContractTotal);

export const thalaVestingEnumerator = entrySenders('thala-vesting-matured',
  [{ contract: THALA_VEST, module: 'farming_vesting', name: 'start_vesting' }],
  noContractTotal);

export const ENUMERATORS: Enumerator[] = [delegationEnumerator, thalaUnstakeEnumerator, kofiWithdrawalsEnumerator, tortugaTicketsEnumerator,
  amnisWithdrawalsEnumerator, thalaVethlEnumerator, thalaVestingEnumerator, inactiveValidatorEnumerator,
  trufinUnlocksEnumerator, movementDelegationEnumerator, movementInactiveValidatorEnumerator, kofiReceiptsEnumerator,
  merkleMklpEnumerator, merkleVemklEnumerator, layerzeroClaimableEnumerator, canopyEndedRewardsEnumerator, pancakeSyrupEnumerator, topazBidsEnumerator, pancakeFarmEnumerator, echelonFrozenEnumerator, aaveFrozenEnumerator, econiaIdleEnumerator, auroClosedEnumerator, animeswapClosedEnumerator, earniumClosedEnumerator, houstonClosedEnumerator, echoWoundDownEnumerator, canopyFrozenEnumerator];
