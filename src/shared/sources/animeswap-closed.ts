// AnimeSwap (Aptos AMM): liquidity left in AnimeSwap V1 pools after its frontend went away. animeswap.org and
// app.animeswap.org no longer resolve (2026-10-21) and no notice was found, so it is closed under the closed-frontend
// rule from that day. The pools still work (aggregators still route swaps through them), so an LP holder can remove
// liquidity directly. LP is a Coin (`LPCoinV1::LPCoin<X, Y>`), held in a CoinStore or its paired fungible-asset store.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import { ownedBalances } from '../owned.ts';
import type { Amount, ChainReader, Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';

export const ANIMESWAP = '0x16fe2df00ea7dde4a63409201f7f4e536bde7bb7335526a35d05111e68aa322c';
/** The resource account holding every pool and publishing the LP coin module. */
export const ANIMESWAP_POOLS = '0x796900ebe1a1a54ff9e932f19c548f5c1af5c6e7d34965857ac2f7b1d1ab2cbf';
export const ANIMESWAP_LP_PREFIX = `${ANIMESWAP_POOLS}::LPCoinV1::LPCoin<`;
/** End of the day both domains were found without an address record (no notice found; the archived app was served
 *  until at least 2026-08). */
export const ANIMESWAP_CLOSED_AT = '2026-10-21T23:59:59Z';
/** Minimum outputs in the removal step: 1% below the computed payout, against reserve moves before it lands. */
const SLIPPAGE_BPS = 100n;
const SOURCE = 'animeswap-closed-lp';

/** Display identity (CoinInfo symbol and decimals, read 2026-10-21) of coins in AnimeSwap's 20 largest pools that no
 *  other source lists. Display only: none of them has a price here. */
export const ANIMESWAP_COINS = [
  { coin: '0xa2eda21a58856fda86451436513b867c97eecb4ba099da5775520e0f7492e852::coin::T', symbol: 'whUSDT', decimals: 6 },
  { coin: '0xae478ff7d83ed072dbc5e264250e67ef58f57c99d89b447efd8a0a2e8b2be76e::coin::T', symbol: 'whWBTC', decimals: 8 },
  { coin: '0xcc8a89c8dce9693d354449f1f73e60e14e347417854f029db5bc8e7454008abb::coin::T', symbol: 'whWETH', decimals: 8 },
  { coin: '0xdd89c0e695df0692205912fb69fc290418bed0dbe6e4573d744a6d5e6bab6c13::coin::T', symbol: 'whSOL', decimals: 8 },
  { coin: `${ANIMESWAP}::AnimeCoin::ANI`, symbol: 'ANI', decimals: 8 },
  { coin: '0x84d7aeef42d38a5ffc3ccef853e1b82e4958659d16a7de736a29c55fbbeb0114::staked_aptos_coin::StakedAptosCoin', symbol: 'tAPT', decimals: 8 },
  { coin: '0x777821c78442e17d82c3d7a371f42de7189e4248e529fe6eee6bca40ddbb::apcoin::ApCoin', symbol: 'APC', decimals: 8 },
  { coin: '0x1000000fa32d122c18a6a31c009ce5e71674f22d06a581bb0a15575e6addadcc::usda::USDA', symbol: 'USDA', decimals: 6 },
];

/** Enumeration hint: each LP coin type the owner held at the scan, with the time its store last changed (indexer). A
 *  change re-reads the owner; the read itself looks the stores up again. */
export type AnimeswapHint = { lps: Record<string, string> };

/** `LPCoin<X, Y>` → [X, Y], splitting on the top-level comma (pool coins can be generic themselves). */
export function pairOf(lp: string): [string, string] {
  const inner = lp.slice(lp.indexOf('<') + 1, -1);
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '<') depth++;
    else if (inner[i] === '>') depth--;
    else if (inner[i] === ',' && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
  }
  throw new Error(`Not an AnimeSwap LP type: ${lp}`);
}

const utf8 = (hex: string) => new TextDecoder().decode(Uint8Array.from(hex.slice(2).match(/../g) ?? [], h => parseInt(h, 16)));

/** Every pool's LP coin type, from the pair registry (`PairInfo.pair_list`, hex-encoded `TypeInfo`s). The names keep the
 *  chain's own rendering, which is how the indexer files them. */
export async function animeswapLps(chain: ChainReader, version?: string): Promise<string[]> {
  const info = await chain.resource(ANIMESWAP_POOLS, `${ANIMESWAP}::AnimeSwapPoolV1::PairInfo`, version);
  if (!info) throw new Error('AnimeSwap PairInfo missing');
  return info.pair_list.map((p: any) => `${p.lp_coin.account_address}::${utf8(p.lp_coin.module_name)}::${utf8(p.lp_coin.struct_name)}`);
}

/** A pool coin's asset id (APT is keyed by its fungible-asset address). */
export const assetOf = (coin: string) => (coin === '0x1::aptos_coin::AptosCoin' ? APT : coin);

/** Integer square root, rounded down (the contract's Babylonian `sqrt_128`). */
export function isqrt(y: bigint): bigint {
  if (y < 4n) return y === 0n ? 0n : 1n;
  let z = y, x = y / 2n + 1n;
  while (x < z) { z = x; x = (y / x + x) / 2n; }
  return z;
}

interface Pool { reserveX: bigint; reserveY: bigint; supply: bigint; kLast: bigint; locked: boolean }

/** What removing `liquidity` pays, as `burn` computes it: the DAO's fee is first minted in LP (when √k grew since the
 *  last mint), then each side pays `liquidity × reserve / supply`, rounded down. */
export function removal(pool: Pool, liquidity: bigint, admin: { feeOn: boolean; daoFee: bigint }): [bigint, bigint] {
  let supply = pool.supply;
  if (admin.feeOn && pool.kLast !== 0n) {
    const rootK = isqrt(pool.reserveX * pool.reserveY), rootKLast = isqrt(pool.kLast);
    if (rootK > rootKLast) supply += supply * (rootK - rootKLast) / (rootK * admin.daoFee + rootKLast);
  }
  return [liquidity * pool.reserveX / supply, liquidity * pool.reserveY / supply];
}

const admin = (ctx: ReadContext) => once(ctx, `animeswap-admin:${ctx.ledger.version}`, async () => {
  const data = await ctx.chain.resource(ANIMESWAP_POOLS, `${ANIMESWAP}::AnimeSwapPoolV1::AdminData`, ctx.ledger.version);
  if (!data) throw new Error('AnimeSwap AdminData missing');
  return { feeOn: !!data.dao_fee_on, daoFee: BigInt(data.dao_fee) };
});

const pool = (ctx: ReadContext, lp: string) => once<Pool>(ctx, `animeswap-pool:${lp}:${ctx.ledger.version}`, async () => {
  const [x, y] = pairOf(lp);
  const version = ctx.ledger.version;
  const [state, [supply]] = await Promise.all([
    ctx.chain.resource(ANIMESWAP_POOLS, `${ANIMESWAP}::AnimeSwapPoolV1::LiquidityPool<${x}, ${y}>`, version),
    // coin::supply counts the Coin and its paired fungible asset; CoinInfo alone misses LP that migrated.
    ctx.chain.view('0x1::coin::supply', [], [lp], version),
  ]);
  if (!state || !supply?.vec?.length) throw new Error(`AnimeSwap pool ${lp} missing`);
  return { reserveX: BigInt(state.coin_x_reserve.value), reserveY: BigInt(state.coin_y_reserve.value), supply: BigInt(supply.vec[0]),
    locked: !!state.locked, kLast: BigInt(state.k_last) };
});

/** The owner's LP coin types as the indexer has them now: the amount over its stores and when the latest one changed.
 *  The indexer files a migrated store under its coin type too. */
async function lpsOf(ctx: ReadContext, owner: string): Promise<Map<string, { amount: bigint; at: string }>> {
  const rows = (await ownedBalances(ctx, owner)).filter(r => r.asset_type.startsWith(ANIMESWAP_LP_PREFIX));
  const lps = new Map<string, { amount: bigint; at: string }>();
  for (const r of rows) {
    const at = new Date(r.last_transaction_timestamp + 'Z').toISOString(), prev = lps.get(r.asset_type);
    lps.set(r.asset_type, { amount: (prev?.amount ?? 0n) + BigInt(r.amount), at: prev && prev.at > at ? prev.at : at });
  }
  return lps;
}

async function read(ctx: ReadContext, ownerInput: string, hint?: AnimeswapHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failed = 0;
  // Looked up again at read time, also with a hint: LP received after the enumeration's scan is read too.
  let indexed: Map<string, { amount: bigint; at: string }>;
  try { indexed = await lpsOf(ctx, owner); } catch (err) {
    return { positions: [], complete: false, errors: [`LP stores: ${String(err).slice(0, 200)}`], ledgerVersion: version };
  }
  const lps = [...new Set([...Object.keys(hint?.lps ?? {}), ...indexed.keys()])];
  const found = await mapLimit(lps, 4, async (lp): Promise<Position[]> => {
    try {
      const [[held], p, a] = await Promise.all([
        // coin::balance covers both the CoinStore and the paired fungible-asset store.
        ctx.chain.view('0x1::coin::balance', [owner], [lp], version), pool(ctx, lp), admin(ctx)]);
      const liquidity = BigInt(held);
      if (liquidity === 0n) return [];
      const [x, y] = pairOf(lp);
      const [ax, ay] = removal(p, liquidity, a);
      // The pool keeps working, so LP added or received after the shutdown is aged from that change. A balance the
      // indexer does not show yet changed after its store time: unknown until the indexer catches up.
      const store = indexed.get(lp);
      const since = store?.amount !== liquidity ? undefined : Date.parse(store.at) > Date.parse(ANIMESWAP_CLOSED_AT) ? store.at : ANIMESWAP_CLOSED_AT;
      const blockers = [
        ...(p.locked ? [{ code: 'paused', detail: 'The pool is locked.' }] : []),
        // burn aborts when either side rounds to zero (ERR_INSUFFICIENT_LIQUIDITY_BURN).
        ...(ax === 0n || ay === 0n ? [{ code: 'below_minimum', detail: 'Too little LP: removal aborts when either side rounds to zero.' }] : []),
      ];
      const outputs: Amount[] = [{ asset: assetOf(x), raw: ax.toString() }, { asset: assetOf(y), raw: ay.toString() }];
      const step = { function: `${ANIMESWAP}::AnimeSwapPoolV1::remove_liquidity_entry<${x}, ${y}>`,
        arguments: [liquidity.toString(), (ax * (10_000n - SLIPPAGE_BPS) / 10_000n).toString(), (ay * (10_000n - SLIPPAGE_BPS) / 10_000n).toString()],
        prerequisites: [], expectedOutputs: outputs };
      // One position per side, so a priced side still counts when the other coin has no price. One removal pays both,
      // so only the first side carries the step: shown twice, it would tell the owner to burn the same LP twice.
      return outputs.filter(o => o.raw !== '0').map((o, i): Position => ({
        ...positionIds(SOURCE, owner, lp, 'principal', o.asset), source: SOURCE, owner, locator: lp, positionKind: 'principal', asset: o.asset,
        claimableSince: since, ageBasis: since ? 'protocol_closure' : 'unknown',
        provenance: { reader: '0x1::coin::balance', ledgerVersion: version },
        grossClaim: [o], expectedPayout: blockers.length ? [] : [o], payoutBasis: 'derived',
        status: blockers.length ? 'blocked' : 'recoverable', blockers,
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs), steps: i === 0 ? [step] : [],
      }));
    } catch (err) {
      failed++;
      errors.push(`${lp}: ${String(err).slice(0, 200)}`);
      return [];
    }
  });
  return { positions: found.flat(), complete: failed === 0, errors, ledgerVersion: version };
}

export const animeswapClosedLp: SourceDef<AnimeswapHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'AnimeSwap',
  title: 'AnimeSwap liquidity left after its frontend went away',
  summary: 'AnimeSwap\'s website is gone, but its pools still work. Liquidity left in them can still be removed directly.',
  category: 'closed_app',
  inclusionRule: 'R2: frontend gone (animeswap.org and app.animeswap.org have no address record, 2026-10-21; no notice found), closed under the closed-frontend rule (decided 2026-10-21). R4: an AMM position carries no debt.',
  protocolStatus: {
    state: 'closed',
    evidence: 'animeswap.org and app.animeswap.org have no address record (2026-10-21), though the domain was renewed on 2026-09-24; the archived app was served until at least 2026-08. DefiLlama marks AnimeSwap dead. No closure notice found.',
    checkedAt: '2026-10-21',
    effectiveAt: ANIMESWAP_CLOSED_AT,
  },
  // ~5,800 holders, mostly dust. Swaps (aggregators still route through the pools) shift the split between a pool's two
  // sides, so holders with positions are re-read every run: the reserve check then compares them with the reserves at
  // the same version (re-read monthly, they tripped it on 2026-10-26, #55). A holder's own LP change re-reads it
  // through the hint.
  refresh: { nonZero: 'every_run', zero: 'monthly' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `Call ${ANIMESWAP}::AnimeSwapPoolV1::remove_liquidity_entry<X, Y>(liquidity, minimum X, minimum Y) from the account holding the LP, with the pool's coin types in the LP type's order.`,
  ],
  read,
};
