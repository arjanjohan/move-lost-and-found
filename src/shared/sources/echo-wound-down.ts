// Echo Protocol (Aptos lending, an Aave v3 fork): supply left in Echo's lending reserves after its wind-down. Echo
// announced on 2026-10-19 that it is winding down: no new deposits, loans or stakes; repayments, withdrawals and
// unstaking stay open until 2026-11-19 23:59 UTC (borrowers by 2026-11-14), after which unpaid loans are liquidated for
// lenders and "remaining positions move into liquidation and settlement" (no process published). Aged from the notice
// (decided 2026-10-24). Most of the APT reserve is lent out (to Echo's own aBTC-collateral wallet), so its lenders cannot
// withdraw until the loans are repaid or liquidated: those positions are blocked on the reserve's cash.
import { debtBlocker, iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import { assetId, ownedBalances } from '../owned.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { assetOf } from './animeswap-closed.ts';

export const ECHO = '0xeab7ea4d635b6b6add79d5045c4a45d8148d88287b1cfa1c3b6a4b56f46839ed';
/** End of the day Echo announced its wind-down (deposits and loans stopped at 00:00 UTC that day). */
export const ECHO_CLOSED_AT = '2026-10-19T23:59:59Z';
/** withdraw_simple(asset, u256::MAX, to, false) withdraws the whole balance (simulated 2026-10-24: a USDT lender was
 *  paid its balance with interest). */
const WITHDRAW_ALL = (2n ** 256n - 1n).toString();
const SOURCE = 'echo-wound-down';

/** Echo's own wallets (ordinary accounts) that supply most of the aBTC reserve and borrow the APT reserve against it:
 *  DefiLlama's adapter leaves them out of Echo's TVL for the same reason. The protocol's own position, not a user's. */
export const ECHO_OWN_WALLETS = new Set([
  '0xe7518ae420007626da09e3afff0f9076343267b94797043203e506e3599e965b',
  '0x3b9a45c9d5c73e27c48f85a26a3e9b3fcef44af44ddf9e0995bf17390b1d1bb8',
]);

/** Every lending reserve (read 2026-10-24; Echo adds none while winding down): Echo's aToken and variable-debt token
 *  (neither can be transferred, so an account's own stores name what it supplies and owes), the reserve's underlying
 *  token (Echo's wrapper of a coin), the account holding the reserve's cash, the coin a withdrawal pays, decimals, and
 *  the smallest holding (in the aToken's scaled units, about $1) the enumeration lists. */
export const ECHO_RESERVES = ([
  ['APT', '0x7f5170624083679dbb5a8119e3dec380d95fddfd0940a4fb7118c7d9db61d425', '0x4a1655da0e64eb8d641b820b7d9e0aa5433cd7436e81f62d21b947d12933fcd1', '0xf8d3506b42a6879680974fc745526c9cbd48b0b0816079aa59f65fc865bdfbf6', '0xe6a9765b0a7ebf70080e9ad115e3e70b637394a04363f5dda865887c0c21781e', '0x1::aptos_coin::AptosCoin', 8, 100_000_000n],
  ['aBTC', '0xee2a8176e27b75bd30419b0ded6c00f15ec551135a6ea69f2575601ec87439a6', '0x8dcaf4d5453e938271e99940e56c0ff17cedac3bc62421c32e598202972563a6', '0x2760ca0d7ed74fec37f1c539fd752b5c684fa011c539a79def7a6c67717ebace', '0xfab1043eef2567172318567d1fe40dc7bdf025c0235c941062fd3c3bff03cab2', '0x4e1854f6d332c9525e258fb6e66f84b6af8aba687bbcb832a24768c4e175feec::abtc::ABTC', 10, 100_000n],
  ['lzUSDT', '0x66c070de0eb43e4c593d1b1ba7a12da2ce07c9e59286d3bef6d329bea49f6034', '0xfd87ffc7afd8da69da3939c16792515368333385b37803489831a8133821ada9', '0x66cca033c185547a88494a9c71baa0dd2185212cfe5e79ec2ec0c4040b5c35c0', '0x558b499a4ce14742369d8633c3c0470eb18384d2a0b4465e7b63d79c4e15153a', '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDT', 6, 1_000_000n],
  ['lzUSDC', '0xa89f8bfbde6dd6c04689897d3db0ad9543081c8cb112283248f276423eb64a2a', '0xe7abd29ed72c3de3efff113ee0f7e32753a55327a0de32370baa88ae29c9efbe', '0xc2315bdb8f7789e1817ac423e80748075fa68b7e33949bde8c2769a46fdb212', '0x8e98956c4cdac6cca210bb1a51b04e2018e43129fdee095be193b8109dba1234', '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC', 6, 1_000_000n],
  ['eAPT', '0xba7b9f87c9827e6c4793cceb7d8d3804a99f9ce2f01107688321cebd42763a56', '0xdc554f478d7351f530a646add8e9c7023227fcee02e8a9cdb85a2c707a717b7d', '0x77d97d473f0be79c6b55c7577f92fff6e27cde3e39c473247b76d411dd63a344', '0x7c8d3688a0e8c2d958b65de43bcaf283617a2c2415a3fca32c3d26adcbb32ba7', `${ECHO}::fa_coin::EAPT`, 8, 100_000_000n],
  ['USDt (Echo)', '0x2312117306fb327d8453efdd78814ff7990e7e84c688f787fd09d03cc3799872', '0x82d1fa8e9d5b6a1ad4df9e7ced1991e7cd058062575b122331ddec1f9c5b8da3', '0xb993e4c6f53e1e40d4bd9ae6033fe0c07fcd7e385e9cd9ab6fb54ae4f8eb55b1', '0xf33e154df60cf4beab56012edf3ada3f16582309ff5ccd4a6d42a8cd0f9f1157', `${ECHO}::fa_coin::USDT`, 6, 1_000_000n],
  ['USDC (Echo)', '0xd800d1799eb5db387d2b241ef8f7a31dd53992f1a341d79c19ed1db2f736d9ca', '0x9e515f5e6ed650730a5a9dcff6c6b12ee0f4aea2511297245892dcef1e35aeb9', '0xc9699e980dace9ecd74ef411db855cd532ea7be73ac84c47aaccbb6f82f47a57', '0xedd8c4e74b838ac73dfc041c4ebe2cdd51e0378c572ab9d31d0e0b5b08bdcbca', `${ECHO}::fa_coin::USDC`, 6, 1_000_000n],
  ['TruAPT', '0x8e77071b4e4a9839419fc1b1d715b491fb6b502203824b62bf402658ccb9a3bd', '0x26809d0d766deda97e67ed71deec587634bcc466b12a4f5ce9f457a3eeff9461', '0x633786a0316f24a3d79a56571c7970e3465f673962fae42b2e55b95482470efb', '0xe220de69ef8365d27ffaa245d695f74f5fb395a9f332866f1e1b5f3264bfb92c', `${ECHO}::fa_coin::TruAPT`, 8, 100_000_000n],
  ['xBTC', '0xe4a4b33b1a1dec625f4706bd01859b192602080ff7485136b13fbe238acfb565', '0x07f24f28cd299228dcd50f76f3806e99541658fd7bb0f74ba2ceda9322824c32', '0xd03ef5ba3d8742597f3d2ad2707e8800eb6888517ae5563de22b7822e3cf6603', '0x8deeef53489ec4181c378339e497b492303eaa00e350be234d92e5e16da913c4', `${ECHO}::fa_coin::XBTC`, 8, 1_000n],
] as [string, string, string, string, string, string, number, bigint][]).map(([symbol, aToken, debtToken, underlying, cashAccount, coin, decimals, minScaled]) =>
  ({ symbol, aToken, debtToken, underlying, cashAccount, coin, decimals, minScaled }));

export type EchoReserve = (typeof ECHO_RESERVES)[number];

/** Echo's wrapper coins (`fa_coin`) → the token each wraps 1:1 (`asset_wrapper::AssetList`, read 2026-10-29).
 *  `router_fa::withdraw` unwraps in the same call and pays that token (simulated 2026-10-29: an xBTC and a TruAPT lender
 *  were paid OKX xBTC and TruFin truAPT); `router::withdraw_simple` pays Echo's coin instead. */
export const ECHO_WRAPPED: Record<string, string> = {
  [`${ECHO}::fa_coin::EAPT`]: '0x8a7403ae3d95f181761cf36742680442c698b49e047350b77a8906ec5168bdae',
  [`${ECHO}::fa_coin::USDT`]: '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b',
  [`${ECHO}::fa_coin::USDC`]: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
  [`${ECHO}::fa_coin::TruAPT`]: '0xaef6a8c3182e076db72d64324617114cacf9a52f28325edc10b483f7f05da0e7',
  [`${ECHO}::fa_coin::XBTC`]: '0x81214a80d82035a190fcb76b6ff3c0145161c3a9f33d137f2bbaee4cfec8a387',
};
/** The account holding the wrapped tokens; it held exactly each wrapper coin's supply on 2026-10-29. */
export const ECHO_WRAPPER = '0x6420f913c33dde94cabb135d1bd8db56f229bda3f81e409b854632a734dcae59';

/** What a withdrawal from the reserve pays: the wrapped token for Echo's wrapper coins, else the coin itself. */
export const payoutAsset = (r: EchoReserve) => ECHO_WRAPPED[r.coin] ?? assetOf(r.coin);

/** A wrapper coin is paid as its token only while the wrapper's account holds the coin's whole supply in it (checked
 *  once per ledger version); otherwise the read fails rather than value the coin as a token it cannot be unwrapped into. */
const wrapperCovered = (ctx: ReadContext, r: EchoReserve) => once(ctx, `echo-wrapper:${r.coin}:${ctx.ledger.version}`, async () => {
  const [[held], [supply]] = await Promise.all([
    ctx.chain.view('0x1::primary_fungible_store::balance', [ECHO_WRAPPER, ECHO_WRAPPED[r.coin]], ['0x1::fungible_asset::Metadata'], ctx.ledger.version),
    ctx.chain.view('0x1::coin::supply', [], [r.coin], ctx.ledger.version),
  ]);
  const total = BigInt((supply as { vec: string[] }).vec[0] ?? 0);
  if (BigInt(held) < total) throw new Error(`Echo's wrapper holds ${held} of the ${total} ${r.symbol} its coin's supply needs`);
});

/** A reserve's cash (what lenders can take out now) and what its lenders are owed in all, once per ledger version. */
const reserveState = (ctx: ReadContext, r: EchoReserve) => once(ctx, `echo-reserve:${r.aToken}:${ctx.ledger.version}`, async () => {
  const [[cash], [supply]] = await Promise.all([
    ctx.chain.view('0x1::primary_fungible_store::balance', [r.cashAccount, r.underlying], ['0x1::fungible_asset::Metadata'], ctx.ledger.version),
    ctx.chain.view(`${ECHO}::pool_data_provider::get_a_token_total_supply`, [r.underlying], [], ctx.ledger.version),
  ]);
  return { cash: BigInt(cash), supply: BigInt(supply) };
});

const amountText = (raw: bigint, r: EchoReserve) =>
  `${(Number(raw) / 10 ** r.decimals).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${r.symbol}`;

/** A borrower's supply: each reserve it supplies, owed in full, blocked by its debt, which the detail lists (from the
 *  debt tokens it holds; without them, as the account total says there is debt, unnamed). */
async function borrower(ctx: ReadContext, owner: string, supplied: EchoReserve[], borrowed: EchoReserve[]): Promise<ReadResult> {
  const version = ctx.ledger.version;
  // (balance with interest, debt with interest, scaled debt, rate, collateral) per reserve.
  const data = new Map(await mapLimit([...new Set([...supplied, ...borrowed])], 2, async r =>
    [r, (await ctx.chain.view(`${ECHO}::pool_data_provider::get_user_reserve_data`, [r.underlying, owner], [], version)).map(String)] as const));
  const owes = borrowed.filter(r => BigInt(data.get(r)![1]) > 0n).map(r => amountText(BigInt(data.get(r)![1]), r));
  const detail = `This account also borrows from Echo${owes.length ? ` (owes ${owes.join(', ')})` : ''}: repay the debt to withdraw this; Echo liquidates unpaid loans after 2026-11-14.`;
  const positions = supplied.flatMap((r): Position[] => {
    const coins = BigInt(data.get(r)![0]);
    if (coins === 0n) return [];
    const asset = payoutAsset(r);
    return [{
      ...positionIds(SOURCE, owner, r.symbol, 'principal', asset), source: SOURCE, owner, locator: r.symbol, positionKind: 'principal', asset,
      claimableSince: ECHO_CLOSED_AT, ageBasis: 'protocol_closure',
      provenance: { reader: `${ECHO}::pool_data_provider::get_user_reserve_data`, ledgerVersion: version },
      grossClaim: [{ asset, raw: coins.toString() }], expectedPayout: [], payoutBasis: 'view', status: 'blocked', blockers: [debtBlocker(detail)],
      confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs), steps: [],
    }];
  });
  return { positions, complete: true, errors: [], ledgerVersion: version };
}

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  const none: ReadResult = { positions: [], complete: true, errors: [], ledgerVersion: version };
  if (ECHO_OWN_WALLETS.has(owner)) return none;
  try {
    // aTokens cannot be transferred, so a supplier's own stores name its reserves (the indexer; amounts come from chain).
    const held = new Set((await ownedBalances(ctx, owner)).map(b => assetId(b.asset_type)));
    const reserves = ECHO_RESERVES.filter(r => held.has(r.aToken));
    if (!reserves.length) return none;
    // R4: any Echo debt makes the supplier a borrower: its supply is shown with what it owes, never counted.
    const [, debt] = await ctx.chain.view(`${ECHO}::user_logic::get_user_account_data`, [owner], [], version);
    if (BigInt(debt) > 0n) return borrower(ctx, owner, reserves, ECHO_RESERVES.filter(r => held.has(r.debtToken)));
    const errors: string[] = [];
    const found = await mapLimit(reserves, 2, async (r): Promise<Position[]> => {
      try {
        // The balance with interest (a_token_factory::balance_of is the scaled balance, without it).
        const wrapped = ECHO_WRAPPED[r.coin];
        const [[balance], state] = await Promise.all([
          ctx.chain.view(`${ECHO}::pool_data_provider::get_user_reserve_data`, [r.underlying, owner], [], version), reserveState(ctx, r)]);
        const coins = BigInt(balance);
        if (coins === 0n) return [];
        if (wrapped) await wrapperCovered(ctx, r);
        // The cash is shared by all lenders, so each is counted for its pro-rata share of it when the reserve is short; the
        // rest is lent out, a separate blocked part.
        const withdrawable = state.cash >= state.supply || state.supply === 0n ? coins : coins * state.cash / state.supply;
        const asset = payoutAsset(r);
        const withdrawAmount = coins <= state.cash ? WITHDRAW_ALL : withdrawable.toString();
        const amount = (raw: bigint) => [{ asset, raw: raw.toString() }];
        const base = { source: SOURCE, owner, positionKind: 'principal' as const, asset, claimableSince: ECHO_CLOSED_AT, ageBasis: 'protocol_closure' as const,
          provenance: { reader: `${ECHO}::pool_data_provider::get_user_reserve_data`, ledgerVersion: version }, payoutBasis: 'view' as const,
          confidence: 'verified_view' as const, observedAt: iso(ctx.ledger.timestampSecs) };
        const out: Position[] = [];
        if (withdrawable > 0n) out.push({
          ...positionIds(SOURCE, owner, r.symbol, 'principal', asset), ...base, locator: r.symbol,
          grossClaim: amount(withdrawable), expectedPayout: amount(withdrawable), status: 'recoverable', blockers: [],
          // The whole balance while the cash covers it (what the step pays then); otherwise the pro-rata amount, since the
          // whole balance would abort. A wrapper coin is withdrawn and unwrapped in one call.
          steps: [{ ...(wrapped
            ? { function: `${ECHO}::router_fa::withdraw<${r.coin}>`, arguments: [wrapped, r.underlying, withdrawAmount, owner, 'false'] }
            : { function: `${ECHO}::router::withdraw_simple<${r.coin}>`, arguments: [r.underlying, withdrawAmount, owner, 'false'] }),
            prerequisites: [], expectedOutputs: amount(coins <= state.cash ? coins : withdrawable) }],
        });
        if (coins > withdrawable) out.push({
          ...positionIds(SOURCE, owner, `${r.symbol}/lent-out`, 'principal', asset), ...base, locator: `${r.symbol}/lent-out`,
          grossClaim: amount(coins - withdrawable), expectedPayout: [], status: 'blocked',
          blockers: [{ code: 'insufficient_cash', detail: `Echo lent out the ${r.symbol} reserve: its lenders are owed more than its cash, which comes back only as borrowers repay, or from liquidations after 2026-11-14.` }],
          steps: [],
        });
        return out;
      } catch (err) {
        errors.push(`${r.symbol}: ${String(err).slice(0, 200)}`);
        return [];
      }
    });
    return { positions: found.flat(), complete: errors.length === 0, errors, ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const echoWoundDown: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Echo Protocol',
  title: 'Echo lending supply left after its wind-down',
  summary: 'Echo Protocol is winding down (notice 2026-10-19): withdrawals stay open until 2026-11-19. Most of its APT reserve is lent out, so APT lenders cannot withdraw until loans are repaid or liquidated. Counted only for suppliers without Echo debt.',
  category: 'closed_app',
  inclusionRule: 'R2: Echo announced its wind-down on 2026-10-19 (no new deposits or loans; withdrawals until 2026-11-19); aged from the notice (decided 2026-10-24). R4: suppliers with any Echo debt are shown (blocked by it) but never counted. Echo\'s own aBTC wallets are left out.',
  protocolStatus: {
    state: 'closed',
    evidence: 'Echo\'s wind-down notice of 2026-10-19 (reported by TokenPost, CryptoBriefing, KuCoin News): deposits, loans and stakes stopped; repayments, withdrawals and unstaking until 2026-11-19 23:59 UTC; unpaid loans liquidated for lenders after 2026-11-14.',
    checkedAt: '2026-10-24',
    effectiveAt: ECHO_CLOSED_AT,
  },
  // The reserves' cash changes as borrowers repay or are liquidated: re-read weekly while the wind-down runs.
  refresh: { nonZero: 'weekly', zero: 'monthly' },
  // 2: Echo's wrapper coins are paid as the token they wrap, through router_fa::withdraw; every owner is re-read once.
  version: 2,
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    'Withdraw in the Echo app (echo-protocol.xyz) before 2026-11-19 23:59 UTC, or',
    `call ${ECHO}::router::withdraw_simple<coin>(reserve token, amount, your address, false) from the supplying account; an amount of 2^256 - 1 withdraws everything.`,
    `For Echo's wrapped tokens (eAPT, USDt, USDC, TruAPT, xBTC), call ${ECHO}::router_fa::withdraw<Echo coin>(token, reserve token, amount, your address, false) instead: it pays the token itself rather than Echo's coin.`,
  ],
  officialUrl: 'https://www.echo-protocol.xyz',
  read,
};
