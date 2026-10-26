// HoustonSwap (Aptos concentrated-liquidity DEX): liquidity positions left in its pools after its app went away.
// app.houstonswap.io served the app until at least 2026-06-10 (Wayback) and houstonswap.io (its site, listed by OneKey)
// no longer resolves (2026-10-22); no notice was found, so it is closed under the closed-frontend rule from that day.
// The pools still work (routers still swap through them), so an owner can remove a position directly. Positions live in
// the owner's own account, one `position::PositionWallet<X, Y>` per pair, each a list of tick ranges with liquidity.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Amount, Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { assetOf, isqrt, pairOf } from './animeswap-closed.ts';

export const HOUSTON = '0x7ab72b249ec24f76fe66b6de19dcee1e3d3361db5c2cccfaa48ea8659060a1bd';
/** The resource account holding every pool (`pool::Pool<X, Y>`, one `PoolInfo` per fee tier). */
export const HOUSTON_POOLS = '0xdfa1f6cdefd77fa9fa1c499559f087a0ed39953cd9c20ab8acab6c2eb5539b78';
/** End of the day houstonswap.io was found without an address record (no notice found). */
export const HOUSTON_CLOSED_AT = '2026-10-22T23:59:59Z';
/** Minimum outputs in the removal step: 1% below the computed amounts, against price moves before it lands. */
const SLIPPAGE_BPS = 100n;
/** The removal's deadline argument: the contract only requires it not to have passed (simulated with u64 max). */
const NO_DEADLINE = '18446744073709551615';
const SOURCE = 'houston-closed-lp';

/** Display identity (CoinInfo symbol and decimals, read 2026-10-22) of coins in HoustonSwap's pools that no other
 *  source lists. Display only: none of them has a price here. */
export const HOUSTON_COINS = [
  { coin: '0x8d87a65ba30e09357fa2edea2c80dbac296e5dec2b18287113500b902942929d::celer_coin_manager::UsdcCoin', symbol: 'ceUSDC', decimals: 6 },
  { coin: '0x8d87a65ba30e09357fa2edea2c80dbac296e5dec2b18287113500b902942929d::celer_coin_manager::UsdtCoin', symbol: 'ceUSDT', decimals: 6 },
  { coin: '0x25a64579760a4c64be0d692327786a6375ec80740152851490cfd0b53604cf95::coin::ETERN', symbol: 'ETERN', decimals: 8 },
  { coin: `${HOUSTON}::coin::HOU`, symbol: 'HOU', decimals: 8 },
];

/** Enumeration hint, by pair (`<X, Y>`): when a HoustonSwap call of the owner's last changed that pair's positions after
 *  the closure began (`moved`); and the version the enumeration's scans reached (`w`). */
export type HoustonHint = { moved?: Record<string, string>; w?: string };

/** A tick as stored: a u64 with the sign in its top bit. */
export const tickOf = (v: string) => { const n = BigInt(v); return n >= 1n << 63n ? -(n - (1n << 63n)) : n; };
const tickArg = (t: bigint) => (t < 0n ? (1n << 63n) - t : t).toString();

const Q64 = 1n << 64n, Q128 = 1n << 128n;
/** √1.0001 in Q128. */
const SQRT_BASE = isqrt(10001n * (Q128 * Q128) / 10000n);

/** √(1.0001^tick) in Q64.64, from √1.0001 raised by squaring in Q128 (exact to well under one Q64 unit). */
export function sqrtPriceAt(tick: bigint): bigint {
  let r = Q128, b = SQRT_BASE;
  for (let e = tick < 0n ? -tick : tick; e > 0n; e >>= 1n) {
    if (e & 1n) r = r * b / Q128;
    b = b * b / Q128;
  }
  return (tick < 0n ? Q128 * Q128 / r : r) >> 64n;
}

/** What burning `liquidity` over [lower, upper) pays at the pool's current tick and price, rounded down. */
export function burnAmounts(liquidity: bigint, lower: bigint, upper: bigint, tick: bigint, sqrtPrice: bigint): [bigint, bigint] {
  const sa = sqrtPriceAt(lower), sb = sqrtPriceAt(upper);
  const x = (from: bigint) => liquidity * Q64 * (sb - from) / sb / from;
  const y = (to: bigint) => liquidity * (to - sa) / Q64;
  if (tick < lower) return [x(sa), 0n];
  if (tick < upper) return [x(sqrtPrice), y(sqrtPrice)];
  return [0n, y(sb)];
}

interface Tier { tick: bigint; sqrtPrice: bigint; reserveX: bigint; reserveY: bigint }

/** A pair's pool, by fee tier, once per ledger version. */
const pool = (ctx: ReadContext, pair: string) => once(ctx, `houston-pool:${pair}:${ctx.ledger.version}`, async () => {
  const data = await ctx.chain.resource(HOUSTON_POOLS, `${HOUSTON}::pool::Pool${pair}`, ctx.ledger.version);
  if (!data) throw new Error(`HoustonSwap pool ${pair} missing`);
  return new Map<string, Tier>((data.fee_tier.data as any[]).map(e => [String(e.key), {
    tick: tickOf(e.value.tick_latest.v), sqrtPrice: BigInt(e.value.sqrt_price_latest.v),
    reserveX: BigInt(e.value.reserve_x.value), reserveY: BigInt(e.value.reserve_y.value) }]));
});

const WALLET = `${HOUSTON}::position::PositionWallet`;
/** The owner's position wallets by pair (`<X, Y>`); null when its resources do not fit one page. */
async function wallets(ctx: ReadContext, owner: string, version: string): Promise<Map<string, any[]> | null> {
  const all = await ctx.chain.resources(owner, version);
  if (!all) return null;
  return new Map(all.filter(r => r.type.startsWith(`${WALLET}<`)).map(r => [r.type.slice(WALLET.length), (r.data.positions?.data ?? r.data.positions) as any[]]));
}

async function read(ctx: ReadContext, ownerInput: string, hint?: HoustonHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const errors: string[] = [];
  let failed = 0;
  let held: Map<string, any[]> | null;
  try { held = await wallets(ctx, owner, version); } catch (err) {
    return { positions: [], complete: false, errors: [`resources: ${String(err).slice(0, 200)}`], ledgerVersion: version };
  }
  if (!held) return { positions: [], complete: false, errors: ['resources: more than one page'], ledgerVersion: version };
  // A pair whose positions differ from those at the version the enumeration's scans reached changed after them: its age
  // is unknown until a later run dates the change.
  const then = hint?.w && Number(hint.w) < Number(version) && held.size > 0 ? await wallets(ctx, owner, hint.w).catch(() => null) : undefined;
  const found = await mapLimit([...held], 4, async ([pair, list]): Promise<Position[]> => {
    try {
      const tiers = await pool(ctx, pair);
      const [x, y] = pairOf(`P${pair}`).map(assetOf);
      const unscanned = then !== undefined && (then === null || JSON.stringify(then.get(pair) ?? null) !== JSON.stringify(list));
      // The pools still take liquidity, so a pair the owner changed after the closure is aged from that change. Without a
      // hint (the check page) there is no history to date it: unknown.
      const moved = hint?.moved?.[pair];
      const since = !hint || unscanned ? undefined : moved && Date.parse(moved) > Date.parse(HOUSTON_CLOSED_AT) ? moved : HOUSTON_CLOSED_AT;
      const positions: Position[] = [];
      for (const entry of list) {
        const p = entry.value ?? entry;
        const liquidity = BigInt(p.liquidity);
        // Every position on 2026-10-22 had liquidity; one without would hold only uncollected fees.
        if (liquidity === 0n) continue;
        const tier = tiers.get(String(p.fee_tier));
        if (!tier) throw new Error(`fee tier ${p.fee_tier} missing`);
        const lower = tickOf(p.lower_tick.v), upper = tickOf(p.upper_tick.v);
        const [bx, by] = burnAmounts(liquidity, lower, upper, tier.tick, tier.sqrtPrice);
        // Fees the position has been credited (owed, or stored) are paid with it; fees accrued since its last update are
        // left out (no view computes them).
        const fromPoolX = bx + BigInt(p.tokens_owed_x), fromPoolY = by + BigInt(p.tokens_owed_y);
        const ax = fromPoolX + BigInt(p.tokens_stored_x.value), ay = fromPoolY + BigInt(p.tokens_stored_y.value);
        // The pool pays the burn and owed fees from its reserves: a removal they cannot cover aborts (EINSUFFICIENT_BALANCE,
        // simulated). Stored coins are held in the position itself, so they do not draw on the reserves.
        const short = fromPoolX > tier.reserveX || fromPoolY > tier.reserveY;
        const blockers = short ? [{ code: 'reserve_short', detail: 'The pool holds less than this position is owed; removing it aborts.' }] : [];
        const outputs: Amount[] = [{ asset: x, raw: ax.toString() }, { asset: y, raw: ay.toString() }];
        const step = { function: `${HOUSTON}::liquidity_manager::remove_liquidity${pair}`,
          arguments: [owner, tickArg(lower), tickArg(upper), String(p.fee_tier), liquidity.toString(),
            (bx * (10_000n - SLIPPAGE_BPS) / 10_000n).toString(), (by * (10_000n - SLIPPAGE_BPS) / 10_000n).toString(), NO_DEADLINE],
          prerequisites: [], expectedOutputs: outputs };
        const locator = `${pair}#${p.id}`;
        // One position per side, so a priced side still counts when the other coin has no price: `principal` is what the
        // pool pays (burn and owed fees), `fees` the coins stored in the position itself. One removal pays all of them,
        // so only the first carries the step: shown twice, it would tell the owner to remove the same range twice.
        const parts: [Position['positionKind'], Amount][] = [
          ['principal', { asset: x, raw: fromPoolX.toString() }], ['principal', { asset: y, raw: fromPoolY.toString() }],
          ['fees', { asset: x, raw: p.tokens_stored_x.value }], ['fees', { asset: y, raw: p.tokens_stored_y.value }],
        ];
        let first = true;
        for (const [kind, o] of parts) if (o.raw !== '0') positions.push({
          ...positionIds(SOURCE, owner, locator, kind, o.asset), source: SOURCE, owner, locator, positionKind: kind, asset: o.asset,
          claimableSince: since, ageBasis: since ? 'protocol_closure' : 'unknown',
          provenance: { reader: `${WALLET}${pair}`, ledgerVersion: version },
          grossClaim: [o], expectedPayout: short ? [] : [o], payoutBasis: 'derived',
          status: short ? 'blocked' : 'recoverable', blockers,
          confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs), steps: first ? (first = false, [step]) : [],
        });
      }
      return positions;
    } catch (err) {
      failed++;
      errors.push(`${pair}: ${String(err).slice(0, 200)}`);
      return [];
    }
  });
  return { positions: found.flat(), complete: failed === 0, errors, ledgerVersion: version };
}

export const houstonClosedLp: SourceDef<HoustonHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'HoustonSwap',
  title: 'HoustonSwap liquidity left after its app went away',
  summary: 'HoustonSwap\'s website and app are gone, but its concentrated-liquidity pools still work. Liquidity positions left there can still be removed directly.',
  category: 'closed_app',
  inclusionRule: 'R2: frontend gone (houstonswap.io has no address record, 2026-10-22; no notice found), closed under the closed-frontend rule (decided 2026-10-21). R4: an AMM position carries no debt.',
  protocolStatus: {
    state: 'closed',
    evidence: 'houstonswap.io (HoustonSwap\'s site, as OneKey lists it) and app.houstonswap.io have no address record (2026-10-22); Wayback last shows the app served on 2026-06-10. The pools still trade through routers. No closure notice found.',
    checkedAt: '2026-10-22',
    effectiveAt: HOUSTON_CLOSED_AT,
  },
  // Swaps shift the split between a pair's sides, so owners with positions are re-read every run: the reserve check then
  // compares them with the reserves at the same version (re-read monthly, they tripped it on 2026-10-26, #55). An
  // owner's own calls after the closure re-date the pair through the hint.
  refresh: { nonZero: 'every_run', zero: 'monthly' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `Call ${HOUSTON}::liquidity_manager::remove_liquidity<X, Y>(your address, lower tick, upper tick, fee tier, liquidity, minimum X, minimum Y, deadline) for each position; it also pays the fees the position earned.`,
    'Ticks are passed as stored: a negative tick has the top bit of the u64 set.',
  ],
  read,
};
