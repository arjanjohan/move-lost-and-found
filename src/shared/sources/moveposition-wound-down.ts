// MovePosition (Movement lending): deposits left after its retirement. New deposits and borrows closed on 2026-10-19
// (every broker's max_deposit is 0 on chain; Superposition, the same contract on Aptos, still has non-zero caps and is
// not winding down). The app retires on 2026-12-22: it goes offline and support stops; positions stay on chain, and
// loans keep accruing and can be liquidated. Every exit (entry_public::redeem_v2) needs a risk packet that MovePosition's
// service signs for that portfolio, market and amount (the app fetches it), so deposits are team-gated (decided
// 2026-10-29). Whether packets are still served after 2026-12-22 is open (#60). Aged from the close.
import { debtBlocker, iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { CANOPY_VAULTS } from './canopy-frozen.ts';
import { MOVE } from './delegation.ts';

export const MOVEPOSITION = '0xccd2621d2897d407e06d18e6ebe3be0e6d9b61f1e809dd49360522b9105812cf';
/** End of the day deposits and borrows closed. */
export const MOVEPOSITION_CLOSED_AT = '2026-10-19T23:59:59Z';
const SOURCE = 'moveposition-wound-down';
const PACKET = 'Withdrawing needs a risk packet that MovePosition\'s service signs for this portfolio, market and amount (the app requests it); the app retires on 2026-12-22.';

/** A note's market: the coin type inside DepositNote<…> or LoanNote<…> (TypeInfo bytes, hex). */
export function noteMarket(id: { account_address: string; module_name: string; struct_name: string }, note: 'DepositNote' | 'LoanNote'): string | null {
  const text = (hex: string) => String.fromCharCode(...(hex.slice(2).match(/../g) ?? []).map(b => parseInt(b, 16)));
  const name = text(id.struct_name);
  if (normalizeAddress(id.account_address) !== MOVEPOSITION || text(id.module_name) !== 'broker' || !name.startsWith(`${note}<`) || !name.endsWith('>')) return null;
  return name.slice(note.length + 1, -1);
}

/** A market's broker (cash, what depositors are owed in all, pause flags) and the asset it pays, once per ledger version. */
const market = (ctx: ReadContext, coin: string) => once(ctx, `moveposition-market:${coin}:${ctx.ledger.version}`, async () => {
  const version = ctx.ledger.version;
  const [broker, { asset, decimals }] = await Promise.all([
    ctx.chain.resource(MOVEPOSITION, `${MOVEPOSITION}::broker::Broker<${coin}>`, version),
    // The chain's native coin is MOVE; any other market lends a virtual coin that maps to a fungible asset.
    coin === '0x1::aptos_coin::AptosCoin' ? { asset: MOVE, decimals: 8 } : (async () => {
      const [metadata] = await ctx.chain.view(`${MOVEPOSITION}::map::get_metadata`, [], [coin], version) as [{ inner: string }];
      const fa = normalizeAddress(metadata.inner);
      const [d] = await ctx.chain.view('0x1::fungible_asset::decimals', [fa], ['0x1::fungible_asset::Metadata'], version);
      return { asset: `movement:${fa}`, decimals: Number(d) };
    })(),
  ]);
  if (!broker) throw new Error(`no MovePosition broker for ${coin}`);
  // What depositors are owed in all is the cash plus what is lent out (broker::deposited is exactly that sum).
  return { available: BigInt(broker.available), owed: BigInt(broker.available) + BigInt(broker.borrowed),
    paused: Boolean(broker.is_paused || broker.is_redeem_paused), asset, decimals };
});

/** MovePosition's own accounts: the tenant (its fee portfolio) and the fee addresses it names, once per ledger version. */
const ownAccounts = (ctx: ReadContext) => once(ctx, `moveposition-own:${ctx.ledger.version}`, async () => {
  const tenant = await ctx.chain.resource(MOVEPOSITION, `${MOVEPOSITION}::tenant::Tenant`, ctx.ledger.version);
  if (!tenant) throw new Error('MovePosition tenant missing');
  return new Set([MOVEPOSITION, ...[tenant.liquidation_fee_address, tenant.interest_rate_fee_address, tenant.stability_fee_address].map(a => normalizeAddress(String(a)))]);
});

const coinsOf = async (ctx: ReadContext, coin: string, notes: string, side: 'dnotes' | 'lnotes') =>
  BigInt((await ctx.chain.view(`${MOVEPOSITION}::broker::calc_coins_from_${side}`, [notes], [coin], ctx.ledger.version))[0]);

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const none: ReadResult = { positions: [], complete: true, errors: [], ledgerVersion: version };
  try {
    if ((await ownAccounts(ctx)).has(owner)) return none;
    // An address without a portfolio reads as empty lists.
    const [view] = await ctx.chain.view(`${MOVEPOSITION}::portfolio::portfolio_view`, [owner], [], version) as [{ collaterals: any[]; liabilities: any[] }];
    const side = (rows: any[], note: 'DepositNote' | 'LoanNote') => rows.filter(r => r.instrument_balance !== '0').map(r => {
      const coin = noteMarket(r.instrument_id, note);
      if (!coin) throw new Error(`unrecognized MovePosition note ${JSON.stringify(r.instrument_id)}`);
      return { coin, notes: String(r.instrument_balance) };
    });
    const deposits = side(view.collaterals, 'DepositNote'), loans = side(view.liabilities, 'LoanNote');
    if (!deposits.length) return none;
    // Canopy's vault strategies lend here from objects of their own: canopy-frozen-vaults counts that money at the
    // vaults' share holders.
    if (await ctx.chain.resource(owner, `${CANOPY_VAULTS}::base_strategy::BaseStrategy`, version)) return none;
    const at = iso(ctx.ledger.timestampSecs);
    const base = { source: SOURCE, owner, positionKind: 'principal' as const, claimableSince: MOVEPOSITION_CLOSED_AT, ageBasis: 'protocol_closure' as const,
      provenance: { reader: `${MOVEPOSITION}::portfolio::portfolio_view`, ledgerVersion: version }, payoutBasis: 'view' as const,
      confidence: 'verified_view' as const, observedAt: at };
    const symbolOf = (coin: string) => coin.split('::').pop()!;
    // R4: any loan makes the depositor a borrower: its deposits are shown with what it owes, never counted.
    if (loans.length) {
      const owes = await mapLimit(loans, 2, async l => {
        const [{ decimals }, raw] = await Promise.all([market(ctx, l.coin), coinsOf(ctx, l.coin, l.notes, 'lnotes')]);
        return `${(Number(raw) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${symbolOf(l.coin)}`;
      });
      const detail = `This portfolio also borrows from MovePosition (owes ${owes.join(', ')}): repay the loans to withdraw this; unpaid loans keep accruing after 2026-12-22 and can be liquidated.`;
      const positions = await mapLimit(deposits, 2, async (d): Promise<Position> => {
        const [{ asset }, coins] = await Promise.all([market(ctx, d.coin), coinsOf(ctx, d.coin, d.notes, 'dnotes')]);
        return { ...positionIds(SOURCE, owner, symbolOf(d.coin), 'principal', asset), ...base, locator: symbolOf(d.coin), asset,
          grossClaim: [{ asset, raw: coins.toString() }], expectedPayout: [], status: 'blocked', blockers: [debtBlocker(detail)], steps: [] };
      });
      return { positions, complete: true, errors: [], ledgerVersion: version };
    }
    const errors: string[] = [];
    const found = await mapLimit(deposits, 2, async (d): Promise<Position[]> => {
      try {
        const [m, coins] = await Promise.all([market(ctx, d.coin), coinsOf(ctx, d.coin, d.notes, 'dnotes')]);
        if (coins === 0n) return [];
        const symbol = symbolOf(d.coin);
        // The cash is shared by all depositors, so each is counted for its pro-rata share of it; the rest is lent out, a
        // separate blocked part.
        const withdrawable = m.available >= m.owed || m.owed === 0n ? coins : coins * m.available / m.owed;
        const amount = (raw: bigint) => [{ asset: m.asset, raw: raw.toString() }];
        const out: Position[] = [];
        if (withdrawable > 0n) out.push({
          ...positionIds(SOURCE, owner, symbol, 'principal', m.asset), ...base, locator: symbol, asset: m.asset,
          grossClaim: amount(withdrawable), expectedPayout: m.paused ? [] : amount(withdrawable),
          status: m.paused ? 'blocked' : 'team_gated',
          blockers: [m.paused ? { code: 'paused', detail: `MovePosition pauses withdrawals from its ${symbol} market.` } : { code: 'price_packet', detail: PACKET }],
          steps: [{ function: `${MOVEPOSITION}::entry_public::redeem_v2<${d.coin}>`, arguments: ['<risk packet from MovePosition\'s service>'],
            prerequisites: ['A risk packet that MovePosition\'s service signs for this portfolio, market and amount.'], expectedOutputs: amount(withdrawable) }],
        });
        if (coins > withdrawable) out.push({
          ...positionIds(SOURCE, owner, `${symbol}/lent-out`, 'principal', m.asset), ...base, locator: `${symbol}/lent-out`, asset: m.asset,
          grossClaim: amount(coins - withdrawable), expectedPayout: [], status: 'blocked',
          blockers: [{ code: 'insufficient_cash', detail: `MovePosition lent out the ${symbol} market: its depositors are owed more than its cash, which comes back only as borrowers repay or are liquidated.` }],
          steps: [],
        });
        return out;
      } catch (err) {
        errors.push(`${d.coin}: ${String(err).slice(0, 200)}`);
        return [];
      }
    });
    return { positions: found.flat(), complete: errors.length === 0, errors, ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const movepositionWoundDown: SourceDef = {
  id: SOURCE,
  chain: 'movement',
  protocol: 'MovePosition',
  title: 'MovePosition deposits left after its retirement',
  summary: 'MovePosition closed new deposits and borrows on 2026-10-19 and retires its app on 2026-12-22. Every withdrawal needs a risk packet from MovePosition\'s own service, so deposits are team-gated; much of some markets is lent out. Counted only for depositors without MovePosition loans.',
  category: 'closed_app',
  inclusionRule: 'R2: MovePosition closed new deposits and borrows on 2026-10-19 and retires on 2026-12-22 (notice on moveposition.xyz); aged from the close (decided 2026-10-29). R4: depositors with any MovePosition loan are shown (blocked by it) but never counted. Withdrawals need an operator-signed packet: team-gated.',
  protocolStatus: {
    state: 'closed',
    evidence: 'Notice on moveposition.xyz (read 2026-10-29): new deposits and borrows closed 2026-10-19; the app retires 2026-12-22, goes offline and support stops; positions stay on chain, loans keep accruing and can be liquidated. On chain: every broker\'s max_deposit is 0.',
    checkedAt: '2026-10-29',
    effectiveAt: MOVEPOSITION_CLOSED_AT,
  },
  // The markets' cash changes as borrowers repay or are liquidated.
  refresh: { nonZero: 'weekly', zero: 'monthly' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    'Repay any loans, then withdraw in the MovePosition app (moveposition.xyz/portfolio: Repay → MAX, then Withdraw → MAX) before 2026-12-22.',
    `On chain, ${MOVEPOSITION}::entry_public::redeem_v2<market coin>(packet) from the portfolio's account; the packet comes from MovePosition's service.`,
  ],
  officialUrl: 'https://www.moveposition.xyz',
  read,
};
