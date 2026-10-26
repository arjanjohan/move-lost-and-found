// Econia (Aptos order book): coins left in Econia market accounts. Econia Labs archived the protocol's repository on
// 2025-09-08 (GitHub banner), the last order was placed on 2025-09-01 and the last deposit on 2025-07-24; since then the
// only activity is users withdrawing. Counted as deprecated from the archive date (decided 2026-10-20). Since Econia is
// closed, coins resting in open orders count too (R4, decided 2026-10-21): cancel the orders, then withdraw. Only
// accounts the owner controls (custodian 0) count: custodian accounts (Fliq, Kana) need their custodian to withdraw.
import { iso, positionIds } from '../accounting.ts';
import { gqlAll, mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { APT } from './delegation.ts';
import { WH_USDC } from './echelon-frozen.ts';
import { LZ_BRIDGE } from './layerzero-claimable.ts';

export const ECONIA = '0xc0deb00c405f84c85dc13442e305df75d1288100cdd82675695f6148c7ece51c';
/** Kana Labs' Econia trading wrapper: registers and deposits into the caller's own (custodian 0) market accounts. */
export const KANA_ECONIA_WRAPPER = '0x9538c839fe490ccfaf32ad9f7491b5e84e610ff6edc110ff883f06ebde82463d';
const SOURCE = 'econia-idle-accounts';
/** Econia's coin markets (ids 1 to 13; from 14 on every market has a generic base: Kana perps, then Fliq questions). */
export const ECONIA_COIN_MARKETS = Array.from({ length: 13 }, (_, i) => String(i + 1));
export const GUI = '0xe4ccb6d39136469f376242c31b34d10515c8eaaa38092f804db8e08a8f53c5b2::assets_v1::EchoCoin002';
export const EDOG = '0x5e975e7f36f2658d4cf146142899c659464a3e0d90f0f4d5f8b2447173c06ef6::EDOG::EDOG';
/** Every coin those markets trade, as recorded in positions (registry, 2026-10-20). */
export const ECONIA_COINS = [APT, WH_USDC, `${LZ_BRIDGE}::asset::USDC`, `${LZ_BRIDGE}::asset::USDT`, `${LZ_BRIDGE}::asset::WETH`, GUI, EDOG];
/** End of the day Econia Labs archived the repository (the banner gives the date only), so the age is never overstated. */
export const ECONIA_ARCHIVED_AT = '2025-09-08T23:59:59Z';
const APT_COIN = `${normalizeAddress('0x1')}::aptos_coin::AptosCoin`;

interface MarketInfo { base?: string; quote: string }

const coinType = (t: { package_address: string; module_name: string; type_name: string }) =>
  `${normalizeAddress(t.package_address)}::${t.module_name}::${t.type_name}`;
/** The asset a withdrawal pays: the coin type, or APT for the APT coin (prices and totals key APT by its 0xa asset). */
const payoutAsset = (coin: string) => (coin === APT_COIN ? APT : coin);

/** A market's base and quote coin types; a market with a generic (non-coin) base has no base coin. */
function marketInfo(ctx: ReadContext, id: string): Promise<MarketInfo> {
  return once(ctx, `econia-market:${id}`, async () => {
    const [m] = await ctx.chain.view(`${ECONIA}::registry::get_market_info`, [id], [], ctx.ledger.version);
    return { base: m.base_name_generic ? undefined : coinType(m.base_type), quote: coinType(m.quote_type) };
  });
}

/**
 * Enumeration hint: `since`, the time of the run that saw the owner act (a deposit, withdrawal or order of its own; the
 * scan does not see which market, so it dates them all); `markets`, per market, the time of the run that saw the
 * owner's orders there change without it (a fill).
 */
export interface EconiaHint { since?: string; markets?: Record<string, string> }

/** An owner's market accounts: totals, and whether coins rest in open asks or bids (cancelled before a withdrawal). */
interface MarketAccount { market_id: string; custodian_id: string; base_total: string; quote_total: string; hasAsks: boolean; hasBids: boolean }

/** An own account's key in MarketAccounts.map: the u128 id (market << 64 | custodian 0) in BCS, little-endian, so its
 *  first 8 bytes are zero. */
const OWN_KEYS_QUERY = `query($h:String!,$after:String!){ current_table_items(where:{table_handle:{_eq:$h}, key:{_like:"0x0000000000000000%", _gt:$after}},
  order_by:{key:asc}, limit:100){ key decoded_key } }`;

/** get_market_accounts lists every account with its orders. For an account with many (a Fliq bettor: 1,106 accounts,
 *  1,104 of them Fliq's question markets under its custodian) that exceeds the view's execution limit
 *  (EXECUTION_LIMIT_REACHED; so does get_all_market_account_ids_for_user, 2026-10-26, #55). Then only the owner's own
 *  (custodian 0) accounts are read, the only ones counted: the indexer lists their keys in MarketAccounts.map, and each
 *  is read from that table on chain. The same totals as the view (checked for 6 accounts), and coins locked (total above
 *  available) on a side wherever the view lists open orders on it. An own account registered after the indexer's
 *  watermark is missed until a later run. */
async function marketAccounts(ctx: ReadContext, owner: string): Promise<MarketAccount[]> {
  const version = ctx.ledger.version;
  try {
    const [accounts] = await ctx.chain.view(`${ECONIA}::user::get_market_accounts`, [owner], [], version);
    return (accounts as any[]).map(a => ({ market_id: a.market_id, custodian_id: a.custodian_id, base_total: a.base_total, quote_total: a.quote_total,
      hasAsks: a.asks.length > 0, hasBids: a.bids.length > 0 }));
  } catch (err) {
    if (!String(err).includes('EXECUTION_LIMIT_REACHED')) throw err;
  }
  const table = await ctx.chain.resource(owner, `${ECONIA}::user::MarketAccounts`, version);
  const own = await gqlAll<{ key: string; decoded_key: string }>(ctx.chain, OWN_KEYS_QUERY, { h: table.map.handle }, 'current_table_items', 'key');
  return mapLimit(own.map(k => k.decoded_key), 4, async id => {
    const a = await ctx.chain.tableItem(table.map.handle, 'u128', `${ECONIA}::user::MarketAccount`, id, version);
    return { market_id: String(BigInt(id) >> 64n), custodian_id: String(BigInt(id) & 0xffff_ffff_ffff_ffffn), base_total: a.base_total, quote_total: a.quote_total,
      hasAsks: BigInt(a.base_total) > BigInt(a.base_available), hasBids: BigInt(a.quote_total) > BigInt(a.quote_available) };
  });
}

async function read(ctx: ReadContext, ownerInput: string, hint?: EconiaHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  // A balance that changed after the archive date has been idle only since then: the latest of the dates that apply.
  // Without the enumeration hint (the check page) a later change cannot be ruled out, so the age is unknown.
  const sinceIn = (market: string) => hint && [ECONIA_ARCHIVED_AT, hint.since, hint.markets?.[market]]
    .filter((d): d is string => !!d).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  try {
    const own = (await marketAccounts(ctx, owner)).filter(a => a.custodian_id === '0');
    const positions: Position[] = [];
    for (const a of own) {
      const market = await marketInfo(ctx, a.market_id), since = sinceIn(a.market_id);
      // Totals include coins resting in open orders; cancelling them (asks: side true, bids: false) frees them first.
      const cancels = [...(a.hasAsks ? [true] : []), ...(a.hasBids ? [false] : [])].map(side => ({
        function: `${ECONIA}::market::cancel_all_orders_user`, arguments: [a.market_id, String(side)], prerequisites: [], expectedOutputs: [] }));
      const sides = [{ coin: market.base, amount: BigInt(a.base_total) }, { coin: market.quote, amount: BigInt(a.quote_total) }];
      // The cancels free both sides at once, so they are listed with the market's first position only.
      let cancelled = false;
      for (const { coin, amount } of sides) {
        if (!coin || amount === 0n) continue;
        const asset = payoutAsset(coin);
        const value = [{ asset, raw: amount.toString() }];
        const locator = `market-${a.market_id}`;
        positions.push({
          ...positionIds(SOURCE, owner, locator, 'principal', asset), source: SOURCE, owner, locator, positionKind: 'principal', asset,
          claimableSince: since, ageBasis: hint ? 'protocol_closure' : 'unknown',
          provenance: { reader: `${ECONIA}::user::get_market_accounts`, ledgerVersion: version },
          grossClaim: value, expectedPayout: value, payoutBasis: 'view',
          status: 'recoverable', blockers: [],
          confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
          // Arguments are (market id, amount): simulated; the reverse order aborts.
          steps: [...(cancelled ? [] : cancels), { function: `${ECONIA}::user::withdraw_to_coinstore<${coin}>`, arguments: [a.market_id, amount.toString()],
            prerequisites: cancelled && cancels.length ? [`cancel_all_orders_user for market ${a.market_id} (listed with its other side)`] : [], expectedOutputs: value }],
        });
        cancelled = true;
      }
    }
    return { positions, complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const econiaIdleAccounts: SourceDef<EconiaHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Econia',
  title: 'Econia market accounts left behind',
  summary: 'Econia, an on-chain order book, is no longer maintained: its team archived the code in September 2025 and nobody has traded since. Coins you deposited into an Econia market account, or left in open orders, are still there.',
  category: 'closed_app',
  inclusionRule: 'R2: Econia is deprecated (Econia Labs archived the repository on 2025-09-08; no order since 2025-09-01); the archive date is the effective date (decided 2026-10-20). R4: coins in open orders count since Econia is closed (decided 2026-10-21); accounts run by a custodian are left out.',
  protocolStatus: {
    state: 'deprecated',
    evidence: 'github.com/econia-labs/econia: "This repository was archived by the owner on Sep 8, 2025." Last limit order 2025-07-25, last market order 2025-09-01, last deposit 2025-07-24; only withdrawals since (checked 2026-10-20). PitchBook lists Econia Labs as out of business.',
    checkedAt: '2026-10-20',
  },
  // Version 2 (2026-10-21): coins in open orders count. Stored owners are all re-read once, so one whose balance was
  // only in orders (stored as nothing) is picked up.
  version: 2,
  refresh: { nonZero: 'monthly', zero: 'never' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `If the account has open orders, call ${ECONIA}::market::cancel_all_orders_user(market id, side) first (asks: true, bids: false).`,
    `Then call ${ECONIA}::user::withdraw_to_coinstore<coin type>(market id, amount) from the account, once per coin and market.`,
  ],
  officialUrl: 'https://github.com/econia-labs/econia',
  read,
};
