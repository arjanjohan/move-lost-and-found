import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerKind } from '../src/shared/owners.ts';
import { sourceTotals } from '../src/shared/accounting.ts';
import { assetDisplay } from '../src/shared/assets.ts';
import { AAVE, aaveFrozenReserves, AAVE_UNFROZEN_AT, USDC } from '../src/shared/sources/aave-frozen.ts';
import { CANOPY_REWARDS, canopyEndedRewards } from '../src/shared/sources/canopy-rewards.ts';
import { CANOPY_ROUTER, CANOPY_VAULTS, canopyFrozenVaults, FROZEN_VAULTS } from '../src/shared/sources/canopy-frozen.ts';
import { APT, delegation, MOVE, movementDelegation } from '../src/shared/sources/delegation.ts';
import { EARNIUM, EARNIUM_CLOSED_AT, earniumClosedLp } from '../src/shared/sources/earnium-closed.ts';
import { ANIMESWAP, ANIMESWAP_CLOSED_AT, ANIMESWAP_POOLS, animeswapClosedLp, isqrt, pairOf } from '../src/shared/sources/animeswap-closed.ts';
import { ARIES, ARIES_CLOSED_AT, ariesWoundDown, reserveType } from '../src/shared/sources/aries-wound-down.ts';
import { ECHO, ECHO_CLOSED_AT, ECHO_RESERVES, ECHO_WRAPPED, ECHO_WRAPPER, echoWoundDown } from '../src/shared/sources/echo-wound-down.ts';
import { GOBLIN_CHEF, GOBLIN_CHEF_ACCOUNT, GOBLIN_VAULTS, goblinWipedOut, WIPED_VAULTS } from '../src/shared/sources/goblin-wiped-out.ts';
import { AURO_CLOSED_AT, AURO_COLLECTION, AURO_DAO, AURO_ROUTER, auroClosedPositions } from '../src/shared/sources/auro-closed.ts';
import { keccak256 } from '../src/shared/keccak.ts';
import { portalTransfer, WH_CORE, WH_TOKEN_BRIDGE, wormholeUnredeemed } from '../src/shared/sources/wormhole-unredeemed.ts';
import { burnAmounts, HOUSTON, HOUSTON_CLOSED_AT, HOUSTON_POOLS, houstonClosedLp, sqrtPriceAt, tickOf } from '../src/shared/sources/houston-closed.ts';
import { echelonFrozenMarkets, FROZEN_MARKETS } from '../src/shared/sources/echelon-frozen.ts';
import { ECONIA, ECONIA_ARCHIVED_AT, ECONIA_COINS, econiaIdleAccounts } from '../src/shared/sources/econia-idle.ts';
import { ASSETS } from '../src/shared/assets.ts';
import { delegationInactiveValidator } from '../src/shared/sources/delegation-inactive.ts';
import { KAPT, kofiReceipts, STKAPT } from '../src/shared/sources/kofi-receipts.ts';
import { MARKET_MAX_AGE_SECS } from '../src/shared/market.ts';
import { AGE_LIMIT_MS } from '../src/node/state.ts';
import { kofiWithdrawals } from '../src/shared/sources/kofi-withdrawals.ts';
import { BTCB, layerzeroClaimable, LZ_COINS } from '../src/shared/sources/layerzero-claimable.ts';
import { merkleMklp, MKLP } from '../src/shared/sources/merkle-mklp.ts';
import { ESMKL, MKL, merkleVemkl, PREMKL } from '../src/shared/sources/merkle-vemkl.ts';
import { MASTERCHEF, pancakeFarmEndedRewards } from '../src/shared/sources/pancake-farm.ts';
import { pancakeSyrupEnded, SYRUP_POOLS } from '../src/shared/sources/pancake-syrup.ts';
import { thalaVestingMatured, thalaVethlExpired } from '../src/shared/sources/thala-thl.ts';
import { THALA_LSD, thalaUnstake } from '../src/shared/sources/thala-unstake.ts';
import { TOPAZ_CLOSED_AT, topazBids, u64Key } from '../src/shared/sources/topaz-bids.ts';
import { tortugaTickets } from '../src/shared/sources/tortuga-tickets.ts';
import { trufinUnlocks } from '../src/shared/sources/trufin-unlocks.ts';
import { addr, context, fakeChain, memoryMemo } from './fake-chain.ts';

const OWNER = addr('abc');
const POOL = addr('def');
const NOW = 1_800_000_000;

function delegationChain(stake: string[], opts: { early?: boolean; lockedUntil?: number; unlockSecs?: number; failArchive?: boolean } = {}) {
  return fakeChain({
    view: (fn) => {
      if (fn === '0x1::delegation_pool::get_stake') return stake;
      if (fn === '0x1::delegation_pool::can_withdraw_pending_inactive') return [opts.early ?? false];
      throw new Error(fn);
    },
    gql: (query) => {
      if (query.includes('delegated_staking_activities')) return { delegated_staking_activities: [{ transaction_version: 42 }] };
      if (query.includes('user_transactions')) return { user_transactions: [{ timestamp: new Date((opts.unlockSecs ?? NOW - 300 * 86_400) * 1000).toISOString().slice(0, -1) }] };
      throw new Error('unexpected gql');
    },
    archiveResource: () => {
      if (opts.failArchive) throw new Error('archive down');
      return { locked_until_secs: String(opts.lockedUntil ?? NOW - 290 * 86_400) };
    },
  });
}

describe('native delegation', () => {
  it('ignores a stale indexer row whose stake is zero on chain', async () => {
    const r = await delegation.read(context(delegationChain(['0', '0', '0'])), OWNER, { pools: [POOL] });
    expect(r.positions).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it('dates inactive stake at the lockup end after the unlock', async () => {
    const lockedUntil = NOW - 290 * 86_400;
    const r = await delegation.read(context(delegationChain(['5', '700', '0'], { lockedUntil })), OWNER, { pools: [POOL] });
    expect(r.positions).toHaveLength(1);
    const [p] = r.positions;
    expect(p.expectedPayout).toEqual([{ asset: expect.any(String), raw: '700' }]);
    expect(p.ageBasis).toBe('onchain_maturity');
    expect(Date.parse(p.claimableSince!) / 1000).toBe(lockedUntil);
    expect(p.id).toBe(`native-delegation:${OWNER}:${POOL}/inactive:principal`);
  });

  it('dates early-withdrawable pending stake as estimated, and skips it while the validator is active', async () => {
    const early = await delegation.read(context(delegationChain(['0', '0', '900'], { early: true })), OWNER, { pools: [POOL] });
    expect(early.positions.map(p => p.ageBasis)).toEqual(['position_interaction']);
    const waiting = await delegation.read(context(delegationChain(['0', '0', '900'], { early: false })), OWNER, { pools: [POOL] });
    expect(waiting.positions).toEqual([]);
  });

  it('keeps amounts complete when only aging fails', async () => {
    const r = await delegation.read(context(delegationChain(['0', '700', '0'], { failArchive: true })), OWNER, { pools: [POOL] });
    expect(r.complete).toBe(true);
    expect(r.positions[0].ageBasis).toBe('unknown');
    expect(r.errors[0]).toMatch(/age/);
  });

  it('marks the read incomplete when a pool read fails', async () => {
    const chain = fakeChain({ view: () => { throw new Error('fullnode down'); } });
    const r = await delegation.read(context(chain), OWNER, { pools: [POOL] });
    expect(r.complete).toBe(false);
    expect(r.positions).toEqual([]);
  });

  it('memoizes claimableSince for an unchanged amount', async () => {
    const memo = memoryMemo();
    await delegation.read(context(delegationChain(['0', '700', '0']), undefined, memo), OWNER, { pools: [POOL] });
    const chain = delegationChain(['0', '700', '0']);
    await delegation.read(context(chain, undefined, memo), OWNER, { pools: [POOL] });
    expect(chain.calls.some(c => c.startsWith('archiveResource'))).toBe(false);
  });
});

describe('thala unstake', () => {
  const request = (id: number, endSec: number, amount = '1000') => ({ account: OWNER, request_id: String(id), start_sec: '0', end_sec: String(endSec), amount });
  const chain = (requests: unknown[], paused = false) => fakeChain({
    view: () => [requests],
    resource: (_a, type) => (type === `${THALA_LSD}::staking::PauseFlag` ? { paused } : null),
  });

  it('counts matured requests only, aged at end_sec', async () => {
    const r = await thalaUnstake.read(context(chain([request(1, NOW - 100), request(2, NOW + 100)])), OWNER);
    expect(r.positions.map(p => p.locator)).toEqual(['1']);
    expect(r.positions[0].ageBasis).toBe('onchain_maturity');
    expect(r.positions[0].status).toBe('recoverable');
  });

  it('blocks matured requests while paused', async () => {
    const r = await thalaUnstake.read(context(chain([request(1, NOW - 100)], true)), OWNER);
    expect(r.positions[0].status).toBe('blocked');
    expect(r.positions[0].blockers[0].code).toBe('paused');
  });

  it('marks the read incomplete when the view fails', async () => {
    const r = await thalaUnstake.read(context(fakeChain({ view: () => { throw new Error('down'); } })), OWNER);
    expect(r.complete).toBe(false);
  });
});

describe('kofi withdrawals', () => {
  const ticket = (id: number, unlock: number, apt = '1000', fees = '0') =>
    ({ ticket_id: String(id), user: OWNER, kapt_amount: apt, apt_amount: apt, unlock_timestamp: String(unlock), withdraw_fees: fees });
  const chain = (tickets: unknown[], paused = false) => fakeChain({
    view: () => [tickets],
    resource: (_a, type) => (type.endsWith('::config::GlobalConfig') ? { gateway_config: { withdrawals_paused: paused } } : null),
  });

  it('counts unlocked tickets only, aged at unlock_timestamp, net of withdrawal fees', async () => {
    const r = await kofiWithdrawals.read(context(chain([ticket(1, NOW - 100, '1000', '30'), ticket(2, NOW + 100)])), OWNER);
    expect(r.positions.map(p => p.locator)).toEqual(['1']);
    expect(r.positions[0].grossClaim[0].raw).toBe('1000');
    expect(r.positions[0].expectedPayout[0].raw).toBe('970');
    expect(r.positions[0].claimableSince).toBe(new Date((NOW - 100) * 1000).toISOString());
  });

  it('blocks unlocked tickets while withdrawals are paused', async () => {
    const r = await kofiWithdrawals.read(context(chain([ticket(1, NOW - 100)], true)), OWNER);
    expect(r.positions[0].status).toBe('blocked');
  });
});

describe('tortuga tickets', () => {
  // Outstanding queue: cleared up to 1000, reserve 500 → queue positions up to 1500 are funded.
  const chain = (tickets: unknown[]) => fakeChain({
    resource: (_a, type) => type.endsWith('::stake_router::TicketStore') ? { tickets }
      : type.endsWith('::stake_router::StakingStatus') ? { total_claims_balance: '2000', total_claims_balance_cleared: '1000', cooldown_period: '3600' }
      : type.endsWith('::validator_router::AptosCoinReserve') ? { coin: { value: '500' } } : null,
  });
  const ticket = (id: number, amount: number, created: number) => ({ id: String(id), amount: String(amount), timestamp: String(created) });

  it('splits cooled-down tickets into funded (recoverable) and queued behind the reserve (blocked)', async () => {
    const r = await tortugaTickets.read(context(chain([ticket(1400, 100, NOW - 7200), ticket(1900, 100, NOW - 7200), ticket(1950, 50, NOW - 60)])), OWNER);
    expect(r.positions.map(p => [p.locator, p.status])).toEqual([['1400', 'recoverable'], ['1900', 'blocked']]);
    expect(r.positions[1].blockers[0].code).toBe('reserve_short');
    expect(r.positions[0].claimableSince).toBe(new Date((NOW - 7200 + 3600) * 1000).toISOString());
  });

  it('claims by index in the owner\'s ticket list', async () => {
    const r = await tortugaTickets.read(context(chain([ticket(1950, 50, NOW - 60), ticket(1400, 100, NOW - 7200)])), OWNER);
    expect(r.positions[0].steps[0].arguments).toEqual(['1']);
  });

  it('reads nothing more for an account without tickets', async () => {
    const r = await tortugaTickets.read(context(fakeChain({ resource: () => null })), OWNER);
    expect(r).toMatchObject({ positions: [], complete: true });
  });
});

describe('asset display', () => {
  it('reads a coin type\'s and a fungible asset\'s symbol and decimals, and leaves other ids undescribed', async () => {
    const chain = fakeChain({ view: (fn, args, typeArgs) => fn.endsWith('::symbol') ? [typeArgs[0] === '0x1::fungible_asset::Metadata' ? `FA ${args[0]}` : 'COIN'] : ['6'] });
    expect(await assetDisplay(chain, '0x2::c::D')).toEqual({ symbol: 'COIN', decimals: 6 });
    expect(await assetDisplay(chain, addr('e1'))).toEqual({ symbol: `FA ${addr('e1')}`, decimals: 6 });
    expect(await assetDisplay(chain, 'wormhole:2:0xab')).toBeNull();
    expect(chain.calls.filter(c => c.startsWith('view'))).toHaveLength(4);
  });
});

describe('owner kind', () => {
  it('classifies resource accounts, objects and ordinary accounts, once', async () => {
    const zero = '0x' + '0'.repeat(64);
    const [res, user, obj, fresh] = [addr('b1'), addr('b2'), addr('b3'), addr('b4')];
    const chain = fakeChain({
      account: a => (a === res ? { authentication_key: zero, sequence_number: '0' } : a === user ? { authentication_key: user, sequence_number: '3' } : null),
      resource: a => (a === obj ? { owner: user } : null),
    });
    const ctx = context(chain);
    expect(await ownerKind(ctx, res)).toBe('resource_account');
    expect(await ownerKind(ctx, user)).toBe('user');
    expect(await ownerKind(ctx, obj)).toBe('object');
    expect(await ownerKind(ctx, fresh)).toBe('user');
    const before = chain.calls.length;
    await ownerKind(ctx, res);
    expect(chain.calls.length).toBe(before);
  });

  it('files an object with an account resource as an object, also over an entry cached before ObjectCore came first', async () => {
    const obj = addr('b5');
    const chain = fakeChain({ account: () => ({ authentication_key: obj, sequence_number: '0' }), resource: () => ({ owner: addr('b2') }) });
    const memo = memoryMemo();
    await memo.set(`owner-kind:${obj}`, 'user');
    await memo.set(`owner-kind:v1:${obj}`, 'user');
    expect(await ownerKind(context(chain, undefined, memo), obj)).toBe('object');
  });

  it('treats framework-reserved addresses as program-controlled without reading', async () => {
    const chain = fakeChain({});
    expect(await ownerKind(context(chain), addr(0))).toBe('resource_account');
    expect(await ownerKind(context(chain), addr('a'))).toBe('resource_account');
    expect(chain.calls).toEqual([]);
  });
});

describe('thala THL', () => {
  it('counts a THL lock once its unlockable epoch is reached, aged at the epoch start', async () => {
    const chain = (unlockable: number) => fakeChain({
      resource: () => ({ vetoken: { locked: { value: '500' }, unlockable_epoch: String(unlockable) } }),
      view: fn => (fn.endsWith('::now_epoch') ? ['100'] : fn.endsWith('::seconds_in_epoch') ? ['604800'] : []),
    });
    const expired = await thalaVethlExpired.read(context(chain(90)), OWNER);
    expect(expired.positions).toHaveLength(1);
    expect(expired.positions[0].claimableSince).toBe(new Date(90 * 604800 * 1000).toISOString());
    expect((await thalaVethlExpired.read(context(chain(101)), OWNER)).positions).toEqual([]);
  });

  it('counts matured vesting claims at their claimable amount and skips accounts without claims', async () => {
    const claim = (id: number, end: number, ready: string) =>
      ({ claim_id: String(id), beneficiary: OWNER, total_amount: '1000', claimable_amount: ready, end_sec: String(end) });
    const chain = fakeChain({ resource: () => ({ claim_ids: ['1', '2'] }), view: () => [[claim(1, NOW - 10, '1000'), claim(2, NOW + 10, '400')]] });
    const r = await thalaVestingMatured.read(context(chain), OWNER);
    expect(r.positions.map(p => [p.locator, p.expectedPayout[0].raw])).toEqual([['1', '1000']]);
    const none = fakeChain({ resource: () => ({ claim_ids: [] }) });
    expect((await thalaVestingMatured.read(context(none), OWNER)).positions).toEqual([]);
    expect(none.calls.some(c => c.startsWith('view'))).toBe(false);
  });
});

describe('delegation with an inactive validator', () => {
  const STOP = NOW - 200 * 86_400, FIRST = NOW - 500 * 86_400;
  // `rewards: 'v1'`: the pool's rewards are indexed under the v1 event name only.
  const chain = (opts: { state?: number; active?: string; pending?: string; rewards?: boolean | 'v1'; firstActivity?: boolean; addedAt?: number }) => fakeChain({
    view: fn => fn === '0x1::stake::get_validator_state' ? [String(opts.state ?? 4)]
      : fn === '0x1::delegation_pool::get_stake' ? [opts.active ?? '5000000000', '0', opts.pending ?? '0'] : [],
    gql: (query, vars) => query.includes('DistributeRewards') ? { delegated_staking_activities: opts.rewards === false
        || (opts.rewards === 'v1' && !query.includes('DistributeRewardsEvent')) ? [] : [{ transaction_version: 10 }] }
      : query.includes('order_by:{transaction_version:asc}') ? { delegated_staking_activities: opts.firstActivity === false ? [] : [{ transaction_version: 5 }] }
      : query.includes('AddStake') ? { delegated_staking_activities: opts.addedAt ? [{ transaction_version: 20 }] : [] }
      : query.includes('block_metadata_transactions') ? { block_metadata_transactions: [{ timestamp: new Date((({ '20': opts.addedAt!, '5': FIRST } as Record<string, number>)[(vars as any).v] ?? STOP) * 1000).toISOString().slice(0, -1) }] }
      : { current_delegator_balances: [] },
  });
  const read = (opts: Parameters<typeof chain>[0]) => delegationInactiveValidator.read(context(chain(opts)), OWNER, { pools: [POOL] });

  it('ignores pools whose validator is active', async () => {
    expect((await read({ state: 2 })).positions).toEqual([]);
  });

  it('dates idle stake at the validator\'s last reward, or at a later add', async () => {
    expect((await read({})).positions[0]).toMatchObject({ ageBasis: 'protocol_closure', claimableSince: new Date(STOP * 1000).toISOString(), status: 'recoverable' });
    const later = NOW - 100 * 86_400;
    expect((await read({ addedAt: later })).positions[0].claimableSince).toBe(new Date(later * 1000).toISOString());
  });

  it('dates stake in a pool that never earned a reward from the pool\'s first activity (or a later add)', async () => {
    expect((await read({ rewards: false })).positions[0]).toMatchObject({ ageBasis: 'protocol_closure', claimableSince: new Date(FIRST * 1000).toISOString() });
    const later = NOW - 100 * 86_400;
    expect((await read({ rewards: false, addedAt: later })).positions[0].claimableSince).toBe(new Date(later * 1000).toISOString());
    // Nothing indexed for the pool at all: unknown.
    expect((await read({ rewards: false, firstActivity: false })).positions[0].ageBasis).toBe('unknown');
  });

  it('dates a pool whose rewards are indexed under the v1 event name only from its last reward, not its first activity', async () => {
    expect((await read({ rewards: 'v1' })).positions[0].claimableSince).toBe(new Date(STOP * 1000).toISOString());
  });

  it('blocks stake below the 10 APT unlock minimum', async () => {
    const p = (await read({ active: '500000000' })).positions[0];
    expect(p.status).toBe('blocked');
    expect(p.blockers[0].code).toBe('below_unlock_minimum');
    expect((await read({ active: '500000000', pending: '600000000' })).positions[0].status).toBe('recoverable');
  });
});

describe('trufin unlocks', () => {
  const POOL2 = addr('0901');
  const row = (nonce: number, user: string) => ({ key: String(nonce), value: { user, amount: '2000', delegation_pool: POOL2, olc: '5' } });
  const chain = (opts: { listed?: boolean; claimable?: boolean; size?: number }) => fakeChain({
    resource: () => ({ unlocks: { size: String(opts.size ?? 2), num_buckets: '1', buckets: { inner: { handle: '0xh' } } } }),
    tableItem: () => [row(1, OWNER), row(2, addr(7))],
    view: fn => fn.endsWith('::staker::whitelist') ? [addr('aa')] : fn.endsWith('::is_whitelisted') ? [opts.listed ?? true]
      : fn.endsWith('::is_claimable') ? [opts.claimable ?? true] : [],
    archiveResource: () => ({ observed_lockup_cycle: { index: '9' } }),
    gql: () => ({ user_transactions: [{ timestamp: '2026-07-25T22:34:03' }] }),
  });

  it('lists only the owner\'s claimable requests, whitelisted as recoverable', async () => {
    const r = await trufinUnlocks.read(context(chain({})), OWNER);
    expect(r.positions.map(p => [p.locator, p.status])).toEqual([['1', 'recoverable']]);
  });

  it('marks requests of wallets off the whitelist as needing the team', async () => {
    const r = await trufinUnlocks.read(context(chain({ listed: false })), OWNER);
    expect(r.positions[0].status).toBe('team_gated');
  });

  it('refuses a partial table instead of reporting no request', async () => {
    const r = await trufinUnlocks.read(context(chain({ size: 3 })), OWNER);
    expect(r.complete).toBe(false);
  });
});

describe('movement delegation', () => {
  it('reads the same framework module but prices MOVE apart from APT', async () => {
    const chain = fakeChain({
      view: fn => (fn === '0x1::delegation_pool::get_stake' ? ['0', '700', '0'] : [false]),
      gql: query => query.includes('delegated_staking_activities') ? { delegated_staking_activities: [] } : {},
    });
    const r = await movementDelegation.read(context(chain), OWNER, { pools: [POOL] });
    expect(movementDelegation.chain).toBe('movement');
    expect(r.positions[0].expectedPayout[0].asset).toBe(MOVE);
    expect(r.positions[0].id.startsWith('movement-native-delegation:')).toBe(true);
  });
});

describe('kofi receipts', () => {
  const chain = (balances: Record<string, string>, changedAt: number) => fakeChain({
    view: (fn, args) => fn.endsWith('::get_exchange_rate') ? ['108560114']
      : fn === '0x1::primary_fungible_store::balance' ? [balances[(args as string[])[1]] ?? '0'] : [],
    gql: () => ({ user_transactions: [{ timestamp: new Date(changedAt * 1000).toISOString().slice(0, -1) }] }),
  });
  const versions = { [KAPT]: 10, [STKAPT]: 11 };

  it('values kAPT 1:1 and stkAPT at the live rate, and never counts them while the market is unchecked', async () => {
    const r = await kofiReceipts.read(context(chain({ [KAPT]: '100000000', [STKAPT]: '100000000' }, 1_700_000_000)), OWNER, { versions });
    expect(r.positions.map(p => [p.locator, p.expectedPayout[0].raw])).toEqual([['kAPT', '100000000'], ['stkAPT', '108560114']]);
    expect(r.positions.every(p => p.status === 'unknown' && p.blockers[0].code === 'market_check_unavailable')).toBe(true);
  });

  it('dates holdings from the wind-down, or from a later balance change', async () => {
    const early = await kofiReceipts.read(context(chain({ [KAPT]: '5' }, 1_700_000_000)), OWNER, { versions: { [KAPT]: 10 } });
    expect(early.positions[0].claimableSince).toBe('2026-07-24T07:55:53.000Z');
    const later = NOW - 10 * 86_400;
    const late = await kofiReceipts.read(context(chain({ [KAPT]: '5' }, later)), OWNER, { versions: { [KAPT]: 10 } });
    expect(late.positions[0].claimableSince).toBe(new Date(later * 1000).toISOString());
  });
});

describe('merkle mklp', () => {
  const [OLD, NEW] = MKLP;
  const chain = (balances: Record<string, string>, whitelist: string) => fakeChain({
    view: (fn, _args, typeArgs) => fn === '0x1::coin::balance' ? [balances[typeArgs[0]] ?? '0']
      : fn.endsWith('::get_release_mklp_whitelist_amount') ? [whitelist] : [],
    gql: () => ({ user_transactions: [] }),
  });

  it('needs the team for old lzUSDC MKLP even when whitelisted', async () => {
    const r = await merkleMklp.read(context(chain({ [OLD.coin]: '5000000' }, '5000000')), OWNER, { versions: { [OLD.coin]: 1 } });
    expect(r.positions[0]).toMatchObject({ status: 'team_gated', blockers: [{ code: 'admin_migration_required' }] });
  });

  it('lets a whitelisted wallet release USDC MKLP, and needs the team otherwise', async () => {
    const listed = await merkleMklp.read(context(chain({ [NEW.coin]: '5000000' }, '5000000')), OWNER, { versions: { [NEW.coin]: 1 } });
    expect(listed.positions[0].status).toBe('recoverable');
    const unlisted = await merkleMklp.read(context(chain({ [NEW.coin]: '5000000' }, '0')), OWNER, { versions: { [NEW.coin]: 1 } });
    expect(unlisted.positions[0]).toMatchObject({ status: 'team_gated', blockers: [{ code: 'release_whitelist_required' }] });
  });

  it('keeps amounts in MKLP units (unpriced), never a guessed USD value', async () => {
    const r = await merkleMklp.read(context(chain({ [NEW.coin]: '5000000' }, '0')), OWNER, { versions: { [NEW.coin]: 1 } });
    expect(r.positions[0].expectedPayout).toEqual([{ asset: NEW.coin, raw: '5000000' }]);
  });
});

describe('merkle veMKL', () => {
  const TOKEN = addr('7e');
  const chain = (balances: { mkl?: string; premkl?: string; es?: string }, owner = OWNER) => fakeChain({
    resource: (address, type) => type === '0x1::object::ObjectCore' ? { owner }
      : type.endsWith('::staking::VoteEscrowedMKL') ? { lock_time: '1722470400', mkl_token: { inner: addr('51') }, esmkl_token: { inner: addr('52') } }
      : address === addr('51') ? { balance: balances.premkl ?? balances.mkl ?? '0', metadata: { inner: balances.premkl ? PREMKL : MKL } }
      : address === addr('52') ? { balance: balances.es ?? '0', metadata: { inner: ESMKL } } : null,
  });

  it('pays locked PreMKL out as MKL, keeping the gross claim in PreMKL', async () => {
    const r = await merkleVemkl.read(context(chain({ premkl: '34161152' })), OWNER, { tokens: [TOKEN] });
    expect(r.positions[0].grossClaim).toEqual([{ asset: PREMKL, raw: '34161152' }]);
    expect(r.positions[0].expectedPayout).toEqual([{ asset: MKL, raw: '34161152' }]);
  });

  it('lists MKL and esMKL, dated from the wind-down', async () => {
    const r = await merkleVemkl.read(context(chain({ mkl: '100', es: '20' })), OWNER, { tokens: [TOKEN] });
    expect(r.positions[0].expectedPayout).toEqual([{ asset: MKL, raw: '100' }, { asset: ESMKL, raw: '20' }]);
    expect(r.positions[0].claimableSince).toBe('2026-02-12T00:00:00.000Z');
  });

  it('skips a lock that moved to another owner', async () => {
    expect((await merkleVemkl.read(context(chain({ mkl: '100' }, addr(9))), OWNER, { tokens: [TOKEN] })).positions).toEqual([]);
  });
});

describe('kofi receipts with a market test', () => {
  const chain = () => fakeChain({
    view: (fn, args) => fn.endsWith('::get_exchange_rate') ? ['100000000']
      : fn === '0x1::primary_fungible_store::balance' ? [(args as string[])[1] === KAPT ? '100000000' : '0'] : [],
    gql: () => ({ user_transactions: [{ timestamp: '2026-08-01T00:00:00' }] }),
  });
  const market = (verdict: 'usable' | 'none' | 'unknown', all = false) =>
    ({ verdict: async () => verdict, allUsable: async () => all });

  it('reads nothing when every bucket has a usable market', async () => {
    const c = chain();
    const r = await kofiReceipts.read({ ...context(c), market: market('usable', true) }, OWNER, { versions: { [KAPT]: 1 } });
    expect(r.positions).toEqual([]);
    expect(c.calls.some(x => x.includes('primary_fungible_store'))).toBe(false);
  });

  it('counts a stranded receipt as recoverable and skips one with a usable market', async () => {
    const stranded = await kofiReceipts.read({ ...context(chain()), market: market('none') }, OWNER, { versions: { [KAPT]: 1 } });
    expect(stranded.positions[0].status).toBe('recoverable');
    const liquid = await kofiReceipts.read({ ...context(chain()), market: market('usable') }, OWNER, { versions: { [KAPT]: 1 } });
    expect(liquid.positions).toEqual([]);
  });
});

describe('layerzero claimable', () => {
  const chain = (amount: string | null) => fakeChain({
    resource: (_a, type) => type.includes('::coin_bridge::CoinStore<') ? { claimable_amt_ld: { handle: '0xab' } }
      : type.includes('::oft::CoinStore<') ? { claimable_amount: { handle: '0xcd' } } : null,
    tableItem: () => amount,
    gql: () => ({ user_transactions: [{ timestamp: '2025-01-01T00:00:00' }], current_table_items: [{ last_transaction_version: 7 }] }),
  });

  it('lists a credited bridge transfer, dated when the bridge wrote it', async () => {
    const r = await layerzeroClaimable.read(context(chain('1500000')), OWNER, { versions: { [LZ_COINS[0].coin]: 7 } });
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ locator: 'USDC', status: 'recoverable', ageBasis: 'onchain_maturity', claimableSince: '2025-01-01T00:00:00.000Z' });
    expect(r.positions[0].steps[0].function).toContain('::coin_bridge::claim_coin<');
  });

  it('lists nothing when the receiver has no entry', async () => {
    expect((await layerzeroClaimable.read(context(chain(null)), OWNER, { versions: { [LZ_COINS[0].coin]: 7 } })).positions).toEqual([]);
  });

  it('reads an OFT coin from its own claimable table, padded as the indexer stores handles', async () => {
    const c = chain('5000000');
    const r = await layerzeroClaimable.read(context(c), OWNER, { versions: { [BTCB]: 7 } });
    expect(r.positions[0]).toMatchObject({ locator: 'BTC.b', asset: BTCB, expectedPayout: [{ asset: BTCB, raw: '5000000' }] });
    expect(r.positions[0].steps[0].function).toBe(`0x43d8cad89263e6936921a0adb8d5d49f0e236c229460f01b14dca073114df2b9::oft::claim<${BTCB}>`);
    expect(c.calls).toContain(`tableItem 0x${'cd'.padStart(64, '0')}`);
  });

  it('lists nothing for an entry the indexer saw claimed', async () => {
    const c = chain('1500000');
    expect((await layerzeroClaimable.read(context(c), OWNER, { versions: { [LZ_COINS[0].coin]: 7 }, amounts: { [LZ_COINS[0].coin]: '0' } })).positions).toEqual([]);
  });
});

describe('layerzero claimable dust', () => {
  it('lists entries below the verification threshold as indexer-only, without reading the chain', async () => {
    const chain = fakeChain({});
    const r = await layerzeroClaimable.read(context(chain), OWNER, { versions: { [LZ_COINS[0].coin]: 7 }, amounts: { [LZ_COINS[0].coin]: '5000' } });
    expect(r.positions[0]).toMatchObject({ confidence: 'indexer_only', expectedPayout: [{ asset: LZ_COINS[0].coin, raw: '5000' }] });
    expect(chain.calls).toEqual([]);
  });
});

describe('topaz bids', () => {
  const handles: Record<string, string> = { 'collection_marketplace::Index': '0xc1', 'collection_marketplace::Bids<': '0xc2', 'bid_any::Index': '0xa1', 'bid_any::CoinEscrow<': '0xa2', 'bid_any::Bids': '0xa3' };
  const pad = (h: string) => '0x' + h.slice(2).padStart(64, '0');
  const chain = (bids: Record<string, { coins: string; deadline: number; buyer?: string }>) => fakeChain({
    resource: (_a, type) => {
      const k = Object.keys(handles).find(k => type.includes(`::${k}`))!;
      return { bids: { handle: handles[k] }, coins: { handle: handles[k] } };
    },
    tableItem: (handle, _kt, _vt, key) => {
      if (handle === pad('0xc1')) return Object.keys(bids);
      if (handle === pad('0xa1')) return null;
      if (handle === pad('0xc2')) return bids[String(key)] ? { coins: { value: bids[String(key)].coins }, deadline: String(bids[String(key)].deadline * 1e6), cancelled: false, buyer: bids[String(key)].buyer ?? OWNER } : null;
      throw new Error(`table ${handle}`);
    },
    gql: (query) => query.includes('current_table_items') ? { current_table_items: [{ last_transaction_version: 9 }] }
      : { user_transactions: [{ timestamp: '2023-01-01T00:00:00' }] },
  });

  it('counts an expired bid from its deadline, and an open one (Topaz is closed) from the shutdown', async () => {
    const r = await topazBids.read(context(chain({ '7': { coins: '50000000', deadline: 1_700_000_000 }, '8': { coins: '30000000', deadline: 2_500_000_000 } })), OWNER);
    expect(r.complete).toBe(true);
    expect(r.positions.map(p => [p.locator, p.ageBasis, p.claimableSince])).toEqual([
      ['collection-bid:7', 'onchain_maturity', new Date(1_700_000_000_000).toISOString()],
      ['collection-bid:8', 'protocol_closure', TOPAZ_CLOSED_AT]]);
    expect(r.positions[0].steps[0]).toMatchObject({ function: expect.stringContaining('::collection_marketplace::cancel<0x1::aptos_coin::AptosCoin>'), arguments: ['7'] });
  });

  it('leaves the age of an open bid placed after the shutdown unknown (bid ids are sequential)', async () => {
    const r = await topazBids.read(context(chain({ '312100': { coins: '50000000', deadline: 2_500_000_000 } })), OWNER);
    expect(r.positions[0]).toMatchObject({ ageBasis: 'unknown', claimableSince: undefined, status: 'recoverable' });
  });

  it('skips bids whose escrow is empty', async () => {
    expect((await topazBids.read(context(chain({ '7': { coins: '0', deadline: 1 } })), OWNER)).positions).toEqual([]);
  });

  it('lists a bidder below the verification threshold as indexer-only, without reading the chain', async () => {
    const c = fakeChain({});
    const r = await topazBids.read(context(c), OWNER, { a: { 3: { raw: '1000', deadline: 1 }, 4: { raw: '0', deadline: 1 }, 5: { raw: '9', deadline: 2_500_000_000 } } });
    // The funded bids (3 expired, 5 open) sum to under the threshold: both indexer-only.
    expect(r.positions.map(p => [p.locator, p.confidence])).toEqual([['token-bid:3', 'indexer_only'], ['token-bid:5', 'indexer_only']]);
    expect(c.calls).toEqual([]);
  });

  it('with a hint, reads only the bids it lists as funded, not the bidder\'s whole index', async () => {
    const c = chain({ '7': { coins: '50000000', deadline: 1_700_000_000 }, '8': { coins: '30000000', deadline: 2_500_000_000 } });
    const r = await topazBids.read(context(c), OWNER, { c: { 7: { raw: '50000000', deadline: 1_700_000_000 }, 8: { raw: '30000000', deadline: 2_500_000_000 }, 9: { raw: '0', deadline: 1 } } });
    expect(r.positions.map(p => p.locator)).toEqual(['collection-bid:7', 'collection-bid:8']);
    expect(c.calls.filter(x => x.startsWith('tableItem'))).toEqual([`tableItem ${pad('0xc2')}`, `tableItem ${pad('0xc2')}`]);
  });

  it('ignores an id that Topaz\'s index lists under this bidder when the bid belongs to someone else', async () => {
    expect((await topazBids.read(context(chain({ '1': { coins: '100000', deadline: 1_700_000_000, buyer: addr('77') } })), OWNER)).positions).toEqual([]);
  });

  it('treats a deadline stored in milliseconds (reads as 1970) as no deadline: open, from the shutdown', async () => {
    expect((await topazBids.read(context(chain({ '6': { coins: '50000000', deadline: 1_667_140_861 } })), OWNER)).positions[0])
      .toMatchObject({ ageBasis: 'onchain_maturity' });
    expect((await topazBids.read(context(chain({ '6': { coins: '50000000', deadline: 1_667_140 } })), OWNER)).positions[0])
      .toMatchObject({ ageBasis: 'protocol_closure', claimableSince: TOPAZ_CLOSED_AT });
  });

  it('counts a bid without a deadline (0) as open, from the shutdown', async () => {
    expect((await topazBids.read(context(chain({ '9': { coins: '50000000', deadline: 0 } })), OWNER)).positions[0])
      .toMatchObject({ ageBasis: 'protocol_closure', claimableSince: TOPAZ_CLOSED_AT });
  });

  it('encodes u64 keys as the indexer stores them', () => {
    expect(u64Key('310341')).toBe('0x45bc040000000000');
  });
});

describe('canopy ended rewards', () => {
  const POOL_ENDED = addr('e1'), POOL_LIVE = addr('e2'), STAKE = addr('5a');
  const row = (pool: string, earned: string, subscribed = true) => ({ pool: { inner: pool }, is_subscribed: subscribed, pool_staking_token: { inner: STAKE },
    effective_staked_amount: '1', rewards: [{ reward_token: { inner: '0xa' }, earned_amount: earned, reward_per_token_paid: '0' }] });
  const chain = (rows: unknown[]) => fakeChain({
    view: (fn, args) => {
      if (fn.endsWith('::get_user_pool_positions')) return [rows];
      if (fn.endsWith('::get_all_pool_list')) return [[{ inner: POOL_ENDED }, { inner: POOL_LIVE }]];
      if (fn.endsWith('::get_reward_token_details')) return [[{ token: { inner: '0xa' }, period_finish: String(args[0] === POOL_ENDED ? NOW - 100 * 86_400 : NOW + 86_400) }]];
      throw new Error(fn);
    },
  });

  it('lists rewards of an ended period, aged from its finish, and skips a running one', async () => {
    const r = await canopyEndedRewards.read(context(chain([row(POOL_ENDED, '500'), row(POOL_LIVE, '700')])), OWNER);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ asset: MOVE, positionKind: 'reward', status: 'recoverable', ageBasis: 'onchain_maturity',
      claimableSince: new Date((NOW - 100 * 86_400) * 1000).toISOString(), expectedPayout: [{ asset: MOVE, raw: '500' }] });
    expect(r.positions[0].steps[0].arguments).toEqual([STAKE]);
  });

  it('blocks rewards of a pool the staker left', async () => {
    const r = await canopyEndedRewards.read(context(chain([row(POOL_ENDED, '500', false)])), OWNER);
    expect(r.positions[0]).toMatchObject({ status: 'blocked', blockers: [{ code: 'unsubscribed' }] });
  });

  it('reads nothing more when nothing was earned', async () => {
    const c = chain([row(POOL_ENDED, '0')]);
    expect((await canopyEndedRewards.read(context(c), OWNER)).positions).toEqual([]);
    expect(c.calls).toHaveLength(1);
  });
});

describe('pancake syrup ended', () => {
  const pool = SYRUP_POOLS.find(p => p.uid === 'U2')!;
  const chain = (rewardLeft: string) => fakeChain({
    resource: (address, type) => {
      if (type.includes('::PoolInfo<')) return type.includes('::U2>') ? { end_timestamp: String(NOW - 600 * 86_400), last_reward_timestamp: String(NOW - 600 * 86_400 + 5),
        acc_token_per_share: '3000000000000', precision_factor: '1000000000000', total_reward_token: { value: rewardLeft }, total_staked_token: { value: '1' } } : null;
      if (type.includes('::UserInfo<') && type.includes('::U2>')) return { amount: '1000', reward_debt: '1200' };
      return null;
    },
  });

  it('lists the stake and the final pending reward of an ended pool', async () => {
    const r = await pancakeSyrupEnded.read(context(chain('999999')), OWNER);
    expect(r.positions.map(p => [p.positionKind, p.expectedPayout[0]?.raw, p.status])).toEqual([['principal', '1000', 'recoverable'], ['reward', '1800', 'recoverable']]);
    expect(r.positions[0]).toMatchObject({ asset: pool.stake, ageBasis: 'onchain_maturity', claimableSince: new Date((NOW - 600 * 86_400) * 1000).toISOString() });
    expect(r.positions[0].steps[0]).toMatchObject({ function: `0xfd1d8a523f1be89277ac0787ae3469312667e3d0b3f75a5f01bfc95530a2dc91::smart_chef::withdraw<${pool.types}>`, arguments: ['1000'] });
  });

  it('falls back to emergency_withdraw when the pool cannot pay the reward', async () => {
    const r = await pancakeSyrupEnded.read(context(chain('10')), OWNER);
    expect(r.positions[0].steps[0].function).toContain('::smart_chef::emergency_withdraw<');
    expect(r.positions[1]).toMatchObject({ status: 'blocked', blockers: [{ code: 'reward_unfunded' }], expectedPayout: [] });
  });

  it('reads only the pools a staker was found in after the first read', async () => {
    const memo = memoryMemo();
    const c = chain('999999');
    await pancakeSyrupEnded.read(context(c, undefined, memo), OWNER);
    const first = c.calls.filter(x => x.startsWith('resource ' + OWNER)).length;
    await pancakeSyrupEnded.read(context(c, undefined, memo), OWNER);
    expect(first).toBe(SYRUP_POOLS.length);
    expect(c.calls.filter(x => x.startsWith('resource ' + OWNER)).length - first).toBe(1);
  });
});

describe('pancake farm ended rewards', () => {
  const LP = '0xc7::swap::LPToken<A, B>';
  const chain = (opts: { amount: string; debt: string; apt: string; cakeLeft?: string; end?: number }) => fakeChain({
    resource: (address, type) => {
      if (type.endsWith('::masterchef::MasterChef')) return { end_timestamp: String(opts.end ?? NOW - 200 * 86_400), lps: ['x', LP], pool_info: [{ acc_cake_per_share: '0' }, { acc_cake_per_share: '1086204168124' }] };
      if (type.endsWith('::masterchef::PoolUserInfo') && address === OWNER) return { pids: ['1'], pid_to_user_info: { inner: { handle: '0xab' } } };
      return null;
    },
    tableItem: () => ({ amount: opts.amount, reward_debt: opts.debt }),
    view: (fn, _args, types) => {
      if (fn === '0x1::coin::balance') return [types[0] === '0x1::aptos_coin::AptosCoin' ? '1000000000' : opts.cakeLeft ?? '577073010581'];
      if (fn.endsWith('::get_pending_apt')) return [opts.apt];
      throw new Error(fn);
    },
  });

  it('lists the CAKE and APT a staked LP earned before emissions ended, harvested with withdraw(0)', async () => {
    const r = await pancakeFarmEndedRewards.read(context(chain({ amount: '111190', debt: '41917', apt: '33565' })), OWNER);
    expect(r.positions.map(p => [p.asset, p.expectedPayout[0]?.raw, p.status, p.confidence])).toEqual([
      ['0x159df6b7689437016108a019fd5bef736bac692b6d4a1f10c941f6fbb9a74ca6::oft::CakeOFT', '78858', 'recoverable', 'derived_math'],
      ['0x000000000000000000000000000000000000000000000000000000000000000a', '33565', 'recoverable', 'verified_view'],
    ]);
    expect(r.positions[0].steps[0]).toMatchObject({ function: `${MASTERCHEF}::masterchef::withdraw<${LP}>`, arguments: ['0'] });
    expect(r.positions[0]).toMatchObject({ ageBasis: 'onchain_maturity', claimableSince: new Date((NOW - 200 * 86_400) * 1000).toISOString() });
  });

  it('lists nothing for a farmer who harvested after the end, or while emissions still run', async () => {
    expect((await pancakeFarmEndedRewards.read(context(chain({ amount: '40332529', debt: '43809361', apt: '0' })), OWNER)).positions).toEqual([]);
    expect((await pancakeFarmEndedRewards.read(context(chain({ amount: '111190', debt: '41917', apt: '1', end: NOW + 86_400 })), OWNER)).positions).toEqual([]);
  });

  it('blocks both rewards when MasterChef cannot pay one of them, since one harvest pays both', async () => {
    const c = fakeChain({
      resource: (address, type) => {
        if (type.endsWith('::masterchef::MasterChef')) return { end_timestamp: String(NOW - 200 * 86_400), lps: ['x', LP], pool_info: [{ acc_cake_per_share: '0' }, { acc_cake_per_share: '1086204168124' }] };
        if (type.endsWith('::masterchef::PoolUserInfo') && address === OWNER) return { pids: ['1'], pid_to_user_info: { inner: { handle: '0xab' } } };
        return null;
      },
      tableItem: () => ({ amount: '111190', reward_debt: '41917' }),
      view: (fn, _args, types) => fn === '0x1::coin::balance' ? [types[0] === '0x1::aptos_coin::AptosCoin' ? '5' : '577073010581'] : ['33565'],
    });
    const r = await pancakeFarmEndedRewards.read(context(c), OWNER);
    expect(r.positions.map(p => p.status)).toEqual(['blocked', 'blocked']);
  });

  it('blocks a reward MasterChef cannot pay', async () => {
    const r = await pancakeFarmEndedRewards.read(context(chain({ amount: '111190', debt: '41917', apt: '0', cakeLeft: '10' })), OWNER);
    expect(r.positions[0]).toMatchObject({ status: 'blocked', blockers: [{ code: 'reward_unfunded' }], expectedPayout: [] });
  });
});

describe('market-dependent refresh', () => {
  it('re-reads receipt holders within the lifetime of the market quotes their positions rest on', () => {
    expect(AGE_LIMIT_MS[kofiReceipts.refresh.nonZero]).toBeLessThanOrEqual(MARKET_MAX_AGE_SECS * 1000);
    expect(AGE_LIMIT_MS[kofiReceipts.refresh.zero]).toBeLessThanOrEqual(MARKET_MAX_AGE_SECS * 1000);
  });
});

describe('echelon frozen markets', () => {
  const market = (label: string) => FROZEN_MARKETS.find(m => m.label === label)!;
  const LZUSDC = market('lzUSDC'), KAPT_MARKET = market('kAPT'), THL_MARKET = market('THL'), WHWETH = market('whWETH'), OTHER = addr('c3');
  type Opts = { coins: string; frozen?: boolean; cash?: string; held?: string[]; unpriced?: string[]; debt?: { principal: string; interest_accumulated: string } };
  const chain = (opts: Opts) => fakeChain({
    resource: (address, type) => {
      if (type.endsWith('::lending::Vault') && address === OWNER) return {
        collaterals: { data: [...(opts.held ?? [LZUSDC.market]).map(m => ({ key: { inner: m }, value: '3000000' })), { key: { inner: OTHER }, value: '9' }] },
        liabilities: { data: opts.debt ? [{ key: { inner: OTHER }, value: opts.debt }] : [] } };
      if (type.endsWith('::lending::Market')) return { collateral_factor_bps: opts.frozen === false ? '7000' : '0', borrow_cap: '0',
        total_cash: opts.cash ?? '99999999999', total_liability: opts.cash === undefined ? '0' : '3000000', total_reserve: '0' };
      return null;
    },
    view: (fn, args) => {
      if (fn.endsWith('::account_coins')) return [opts.coins];
      if (fn.endsWith('::asset_price')) {
        if ((opts.unpriced ?? []).includes(args[0] as string)) throw new Error('view: HTTP 400 {"message":"Move abort in 0x92e9::tiered_oracle: ERR_ORACLE_INVALID_PRICE(0x6b): "}');
        return [{ v: '18446744073709551616' }];
      }
      throw new Error(fn);
    },
  });
  const read = (opts: Opts) => echelonFrozenMarkets.read(context(chain(opts)), OWNER);

  it('lists supply in a frozen market, aged from the freeze, and ignores other markets', async () => {
    const r = await read({ coins: '1500000' });
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ locator: 'lzUSDC', asset: LZUSDC.asset, status: 'recoverable', ageBasis: 'protocol_closure',
      claimableSince: LZUSDC.frozenAt, expectedPayout: [{ asset: LZUSDC.asset, raw: '1500000' }] });
    expect(r.positions[0].steps).toEqual([{ function: expect.stringContaining(`::scripts::withdraw_all<${LZUSDC.asset}>`), arguments: [LZUSDC.market],
      prerequisites: [], expectedOutputs: [{ asset: LZUSDC.asset, raw: '1500000' }] }]);
  });

  it('withdraws from a fungible-asset market with withdraw_all_fa', async () => {
    const r = await read({ coins: '7', held: [KAPT_MARKET.market] });
    expect(r.positions[0]).toMatchObject({ locator: 'kAPT', asset: KAPT_MARKET.asset, claimableSince: KAPT_MARKET.frozenAt });
    expect(r.positions[0].steps[0]).toMatchObject({ function: expect.stringMatching(/::scripts::withdraw_all_fa$/), arguments: [KAPT_MARKET.market] });
  });

  it('shows a supplier with any Echelon debt (even dust or interest only) blocked by it, never counted', async () => {
    for (const debt of [{ principal: '300000', interest_accumulated: '0' }, { principal: '0', interest_accumulated: '1' }]) {
      const r = await read({ coins: '1500000', debt });
      expect(r.positions.map(p => [p.status, p.blockers[0].code, p.grossClaim[0].raw, p.expectedPayout, p.steps])).toEqual([['blocked', 'has_debt', '1500000', [], []]]);
    }
    // A repaid liability entry (all zero) is no debt.
    expect((await read({ coins: '1500000', debt: { principal: '0', interest_accumulated: '0' } })).positions).toHaveLength(1);
  });

  it('counts a lender\'s pro-rata share of a short market\'s cash, withdrawn as shares, and blocks when there is none', async () => {
    // Cash 1M of 4M supply (3M borrowed): a lender owed 1.5M is counted for 1.5M x 1/4 = 375K, so all lenders together
    // never exceed the 1M cash. withdraw_all would take all 1.5M and abort, so the step withdraws 375K worth of shares
    // (3M shares for 1.5M coins: 750K shares).
    const partial = await read({ coins: '1500000', cash: '1000000' });
    expect(partial.positions[0]).toMatchObject({ status: 'recoverable', grossClaim: [{ raw: '1500000' }], expectedPayout: [{ raw: '375000' }] });
    expect(partial.positions[0].steps[0]).toMatchObject({ function: expect.stringContaining(`::scripts::withdraw<${LZUSDC.asset}>`), arguments: [LZUSDC.market, '750000'] });
    const none = await read({ coins: '1500000', cash: '0' });
    expect(none.positions[0]).toMatchObject({ status: 'blocked', blockers: [{ code: 'insufficient_cash' }], expectedPayout: [] });
    // A claim the cash covers is withdrawn whole (that is what withdraw_all pays); the position still counts 1/4.
    const covered = await read({ coins: '500000', cash: '1000000' });
    expect(covered.positions[0]).toMatchObject({ expectedPayout: [{ raw: '125000' }],
      steps: [{ function: expect.stringContaining('::scripts::withdraw_all<'), expectedOutputs: [{ raw: '500000' }] }] });
    // 3 raw units x 1/4 rounds to nothing while the market has cash: no position.
    expect((await read({ coins: '3', cash: '1000000' })).positions).toEqual([]);
  });

  it('asks to withdraw the one held market without a price first, and blocks everything with two', async () => {
    const one = await read({ coins: '1500000', held: [THL_MARKET.market, LZUSDC.market], unpriced: [THL_MARKET.market] });
    const by = Object.fromEntries(one.positions.map(p => [p.locator, p]));
    expect(by.THL).toMatchObject({ status: 'recoverable', steps: [{ prerequisites: [] }] });
    expect(by.lzUSDC).toMatchObject({ status: 'recoverable', steps: [{ prerequisites: [expect.stringContaining('Withdraw your THL first')] }] });
    const two = await read({ coins: '1500000', held: [THL_MARKET.market, WHWETH.market, LZUSDC.market], unpriced: [THL_MARKET.market, WHWETH.market] });
    expect(two.positions).toHaveLength(3);
    for (const p of two.positions) expect(p).toMatchObject({ status: 'blocked', blockers: [{ code: 'stale_oracle' }], expectedPayout: [{ raw: '1500000' }] });
    // Short of cash, the unpriced market itself only allows a partial withdrawal, which leaves it in the vault: blocked.
    const short = await read({ coins: '1500000', cash: '1000000', held: [THL_MARKET.market], unpriced: [THL_MARKET.market] });
    expect(short.positions[0]).toMatchObject({ locator: 'THL', status: 'blocked', blockers: [{ code: 'stale_oracle' }], expectedPayout: [{ raw: '375000' }] });
  });

  it('does not count a market Echelon reopened', async () => {
    expect((await read({ coins: '1500000', frozen: false })).positions).toEqual([]);
  });

  it('lists every market and asset at a full-length address (price lookups are exact), once', () => {
    expect(new Set(FROZEN_MARKETS.map(m => m.market)).size).toBe(FROZEN_MARKETS.length);
    expect(FROZEN_MARKETS.filter(m => !/^0x[0-9a-f]{64}$/.test(m.market) || !/^0x[0-9a-f]{64}(::|$)/.test(m.asset))).toEqual([]);
  });
});


describe('aave frozen reserves', () => {
  const FREEZE = AAVE_UNFROZEN_AT + 500n;
  const LEDGER = { version: String(AAVE_UNFROZEN_AT + 1000n), timestampSecs: NOW };
  const reserve = (symbol: string, underlying: string, o: { frozen?: boolean; paused?: boolean; cash?: string } = {}) => ({
    underlying_asset: underlying, symbol, a_token_address: addr(`a${symbol.length}`), variable_debt_token_address: addr(`d${symbol.length}`),
    is_frozen: o.frozen ?? true, is_active: true, is_paused: o.paused ?? false, available_liquidity: o.cash ?? '99000000' });
  type Opts = { reserves?: unknown[]; debt?: string; balance?: string; supply?: string };
  const chain = (opts: Opts = {}) => fakeChain({
    view: (fn) => {
      if (fn.endsWith('::get_reserves_data')) return [opts.reserves ?? [reserve('USDC', USDC)], {}];
      if (fn.endsWith('::get_user_account_data')) return ['0', opts.debt ?? '0', '0', '0', '0', '0'];
      if (fn.endsWith('::balance_of')) return [opts.balance ?? '400000'];
      if (fn.endsWith('::get_a_token_total_supply')) return [opts.supply ?? '1000000'];
      if (fn.endsWith('::pool::get_reserve_data')) return [{ inner: addr('r1') }];
      throw new Error(fn);
    },
    // Frozen (bit 57) from version FREEZE on.
    archiveResource: (_address, _type, version) => ({ configuration: { data: (BigInt(version) >= FREEZE ? 1n << 57n : 0n).toString() } }),
    gql: (_query, vars) => ({ user_transactions: vars.v === String(FREEZE) ? [{ timestamp: '2026-11-02T10:00:00' }] : [] }),
  });

  it('reads nothing but the reserve flags while no reserve is frozen', async () => {
    const c = chain({ reserves: [reserve('USDC', USDC, { frozen: false })] });
    expect(await aaveFrozenReserves.read(context(c, LEDGER), OWNER)).toMatchObject({ positions: [], complete: true });
    expect(c.calls).toEqual([`view ${AAVE}::ui_pool_data_provider_v3::get_reserves_data`]);
  });

  it('counts a debt-free supplier of a frozen reserve, aged from the freeze found on the archive node', async () => {
    const memo = memoryMemo();
    const r = await aaveFrozenReserves.read(context(chain(), LEDGER, memo), OWNER);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ locator: 'USDC', asset: USDC, status: 'recoverable', ageBasis: 'protocol_closure',
      claimableSince: '2026-11-02T10:00:00.000Z', expectedPayout: [{ asset: USDC, raw: '400000' }],
      steps: [{ function: `${AAVE}::supply_logic::withdraw`, arguments: [USDC, (2n ** 256n - 1n).toString(), OWNER] }] });
    // The freeze time is memoized: a later read does not search again.
    const again = chain();
    await aaveFrozenReserves.read(context(again, LEDGER, memo), OWNER);
    expect(again.calls.filter(c => c.startsWith('archiveResource'))).toEqual([]);
  });

  it('takes the freeze time from the enumeration hint without searching', async () => {
    const c = chain();
    const r = await aaveFrozenReserves.read(context(c, LEDGER), OWNER, { a: {}, d: {}, f: { [USDC]: '2026-11-01T00:00:00.000Z' } });
    expect(r.positions[0]).toMatchObject({ claimableSince: '2026-11-01T00:00:00.000Z', ageBasis: 'protocol_closure' });
    expect(c.calls.filter(x => x.startsWith('archiveResource'))).toEqual([]);
  });

  it('shows a supplier with any Aave debt, blocked by it and never counted', async () => {
    const r = await aaveFrozenReserves.read(context(chain({ debt: '1' }), LEDGER), OWNER);
    expect(r.complete).toBe(true);
    expect(r.positions.length).toBeGreaterThan(0);
    expect(r.positions.every(p => p.status === 'blocked' && p.blockers[0].code === 'has_debt' && p.expectedPayout.length === 0)).toBe(true);
  });

  it('counts the pro-rata share of a short reserve\'s cash and withdraws that amount; blocks a paused reserve', async () => {
    // Cash 1M of 4M lent out: a lender owed 1.5M is counted for 375K.
    const short = await aaveFrozenReserves.read(context(chain({ reserves: [reserve('USDC', USDC, { cash: '1000000' })], balance: '1500000', supply: '4000000' }), LEDGER), OWNER);
    expect(short.positions[0]).toMatchObject({ grossClaim: [{ raw: '1500000' }], expectedPayout: [{ raw: '375000' }], steps: [{ arguments: [USDC, '375000', OWNER] }] });
    // A balance the cash covers is withdrawn whole (that is what the step pays); the position still counts 125K.
    const covered = await aaveFrozenReserves.read(context(chain({ reserves: [reserve('USDC', USDC, { cash: '1000000' })], balance: '500000', supply: '4000000' }), LEDGER), OWNER);
    expect(covered.positions[0]).toMatchObject({ expectedPayout: [{ raw: '125000' }],
      steps: [{ arguments: [USDC, (2n ** 256n - 1n).toString(), OWNER], expectedOutputs: [{ raw: '500000' }] }] });
    const paused = await aaveFrozenReserves.read(context(chain({ reserves: [reserve('USDC', USDC, { paused: true })] }), LEDGER), OWNER);
    expect(paused.positions[0]).toMatchObject({ status: 'blocked', blockers: [{ code: 'paused' }] });
  });

  it('pays the APT reserve out as APT (0xa is the paired fungible asset of the APT coin)', async () => {
    const r = await aaveFrozenReserves.read(context(chain({ reserves: [reserve('APT', '0xa')] }), LEDGER), OWNER);
    expect(r.positions[0]).toMatchObject({ locator: 'APT', asset: APT, expectedPayout: [{ asset: APT }] });
  });

  it('leaves the age unknown when the freeze cannot be dated', async () => {
    const base = chain();
    const undated = fakeChain({
      view: (fn, args, t) => base.view(fn, args, t),
      archiveResource: (a, t, v) => base.archiveResource(a, t, v),
      gql: () => ({ user_transactions: [] }),
    });
    const r = await aaveFrozenReserves.read(context(undated, LEDGER), OWNER);
    expect(r.positions[0]).toMatchObject({ ageBasis: 'unknown', claimableSince: undefined });
    // An archive failure keeps the position too, with an unknown age, and the read complete.
    const noArchive = fakeChain({ view: (fn, args, t) => base.view(fn, args, t), archiveResource: () => { throw new Error('archive: HTTP 503'); } });
    expect(await aaveFrozenReserves.read(context(noArchive, LEDGER), OWNER)).toMatchObject({ complete: true,
      positions: [{ ageBasis: 'unknown', expectedPayout: [{ raw: '400000' }] }] });
  });
});

describe('econia accounts', () => {
  const LZUSDC = LZ_COINS.find(c => c.display.includes('USDC'))!.coin;
  const coin = (t: string) => { const [package_address, module_name, type_name] = t.split('::'); return { package_address, module_name, type_name }; };
  const markets: Record<string, unknown> = {
    7: { base_name_generic: '', base_type: coin('0x1::aptos_coin::AptosCoin'), quote_type: coin(LZUSDC) },
    8: { base_name_generic: '', base_type: coin('0x1::aptos_coin::AptosCoin'), quote_type: coin(LZUSDC) },
    12: { base_name_generic: 'YT_9', base_type: coin('0x1::string::String'), quote_type: coin(LZUSDC) },
  };
  // Totals: what the account holds, including coins resting in its open orders.
  const account = (market: string, o: { custodian?: string; asks?: unknown[]; bids?: unknown[]; base?: string; quote?: string } = {}) => ({ market_id: market,
    custodian_id: o.custodian ?? '0', asks: o.asks ?? [], bids: o.bids ?? [], base_total: o.base ?? '0', quote_total: o.quote ?? '0' });
  const chain = (accounts: unknown[]) => fakeChain({ view: (fn, args) => {
    if (fn.endsWith('::user::get_market_accounts')) return [accounts];
    if (fn.endsWith('::registry::get_market_info')) return [markets[args[0] as string]];
    throw new Error(fn);
  } });

  it('lists the base and quote of an account the owner controls, aged from the archive date', async () => {
    const r = await econiaIdleAccounts.read(context(chain([account('7', { base: '200000000', quote: '5000445704' })])), OWNER, {});
    expect(r.positions.map(p => [p.asset, p.expectedPayout[0].raw])).toEqual([[APT, '200000000'], [LZUSDC, '5000445704']]);
    expect(r.positions[0]).toMatchObject({ locator: 'market-7', claimableSince: ECONIA_ARCHIVED_AT, ageBasis: 'protocol_closure', status: 'recoverable',
      steps: [{ function: `${ECONIA}::user::withdraw_to_coinstore<${addr(1)}::aptos_coin::AptosCoin>`, arguments: ['7', '200000000'] }] });
  });

  it('leaves the age unknown without the enumeration hint (the check page cannot rule out a later change)', async () => {
    const r = await econiaIdleAccounts.read(context(chain([account('7', { quote: '5' })])), OWNER);
    expect(r.positions[0]).toMatchObject({ ageBasis: 'unknown', claimableSince: undefined, status: 'recoverable' });
  });

  it('ages a balance that changed after the archive date from that change, never earlier', async () => {
    const accounts = [account('7', { quote: '5' })];
    const later = await econiaIdleAccounts.read(context(chain(accounts)), OWNER, { since: '2026-10-27T03:17:00.000Z' });
    expect(later.positions[0].claimableSince).toBe('2026-10-27T03:17:00.000Z');
    const earlier = await econiaIdleAccounts.read(context(chain(accounts)), OWNER, { since: '2025-01-01T00:00:00.000Z' });
    expect(earlier.positions[0].claimableSince).toBe(ECONIA_ARCHIVED_AT);
    // A fill dates only the market it happened in.
    const fill = await econiaIdleAccounts.read(context(chain([...accounts, account('8', { quote: '6' })])), OWNER, { markets: { 8: '2026-10-27T03:17:00.000Z' } });
    expect(fill.positions.map(p => [p.locator, p.claimableSince])).toEqual([['market-7', ECONIA_ARCHIVED_AT], ['market-8', '2026-10-27T03:17:00.000Z']]);
  });

  it('reads only the own accounts of an owner too large for get_market_accounts, listed by the indexer and read on chain', async () => {
    let indexed = '100';   // the table processor's watermark; the read is at version 100
    // Market 7, own account: 200 base units (all in asks), 50 quote units (10 in bids); the indexer lists own keys only.
    const id7 = ((7n << 64n) | 0n).toString();
    const items: Record<string, unknown> = { [id7]: { base_total: '200', base_available: '0', quote_total: '50', quote_available: '40' } };
    const seen: string[] = [];
    const c = fakeChain({
      view: (fn, args) => {
        if (fn.endsWith('::user::get_market_accounts')) throw new Error('view: HTTP 400 {"message":"VMError with status EXECUTION_LIMIT_REACHED"}');
        if (fn.endsWith('::registry::get_market_info')) return [markets[args[0] as string]];
        throw new Error(fn);
      },
      resource: () => ({ map: { handle: '0xh' } }),
      gql: (q, vars) => {
        seen.push(q);
        if (q.includes('processor_status')) return { processor_status: [{ last_success_version: indexed }] };
        return { current_table_items: vars.after === '' ? [{ key: '0x00000000000000000700000000000000', decoded_key: id7 }] : [] };
      },
      tableItem: (_h, _k, _v, key) => items[key as string],
    });
    const r = await econiaIdleAccounts.read(context(c), OWNER, {});
    expect(r.complete).toBe(true);
    expect(seen.find(q => q.includes('current_table_items'))).toContain('_like:"0x0000000000000000%"');
    expect(r.positions.map(p => [p.locator, p.asset, p.expectedPayout[0].raw])).toEqual([['market-7', APT, '200'], ['market-7', LZUSDC, '50']]);
    expect(r.positions[0].steps.map(s => [s.function, s.arguments])).toEqual([
      [`${ECONIA}::market::cancel_all_orders_user`, ['7', 'true']], [`${ECONIA}::market::cancel_all_orders_user`, ['7', 'false']],
      [`${ECONIA}::user::withdraw_to_coinstore<${addr(1)}::aptos_coin::AptosCoin>`, ['7', '200']]]);
    // The table index behind the read's version: an account registered since could be missing, so the read is incomplete.
    indexed = '99';
    vi.useFakeTimers();
    try {
      const pending = econiaIdleAccounts.read(context(c), OWNER, {});
      await vi.runAllTimersAsync();
      const behind = await pending;
      expect([behind.complete, behind.positions, behind.errors[0]]).toEqual([false, [], expect.stringContaining('behind the read')]);
    } finally { vi.useRealTimers(); }
  });

  it('counts coins resting in open orders (Econia is closed), cancelling them before the withdrawal', async () => {
    const r = await econiaIdleAccounts.read(context(chain([account('7', { base: '5', quote: '9', asks: [{}], bids: [{}] })])), OWNER, {});
    expect(r.positions.map(p => [p.asset, p.expectedPayout[0].raw])).toEqual([[APT, '5'], [LZUSDC, '9']]);
    expect(r.positions[0].steps.map(s => [s.function.replace(/<.*$/, '').split('::').pop(), s.arguments])).toEqual([
      ['cancel_all_orders_user', ['7', 'true']], ['cancel_all_orders_user', ['7', 'false']], ['withdraw_to_coinstore', ['7', '5']]]);
    // The cancels free both sides: the other side lists only its withdrawal, after them.
    expect(r.positions[1].steps).toMatchObject([{ arguments: ['7', '9'], prerequisites: [expect.stringContaining('cancel_all_orders_user')] }]);
  });

  it('has display metadata (decimals) for every coin the coin markets trade', () => {
    expect(ECONIA_COINS.filter(c => !ASSETS[c])).toEqual([]);
  });

  it('leaves out custodian accounts, a generic base and empty sides', async () => {
    const r = await econiaIdleAccounts.read(context(chain([
      account('7', { quote: '5', custodian: '6' }),
      account('12', { base: '5', quote: '7' }),
      account('8'),
    ])), OWNER);
    expect(r.positions.map(p => [p.locator, p.asset, p.expectedPayout[0].raw])).toEqual([['market-12', LZUSDC, '7']]);
  });
});

describe('auro closed positions', () => {
  const NFT = addr('f1'), POOL = addr('f2'), STAPT_COIN = '0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a::stapt_token::StakedApt';
  type Opts = { debt?: boolean; held?: string; owner?: string; token?: string; deposited?: string; shares?: string; lock?: string; fee?: string };
  // Pool books: 1,000 supplied over 800 shares; the position holds 200 shares (250 coins).
  const chain = (o: Opts = {}) => fakeChain({
    resource: (address, type) => {
      if (address === NFT && type === '0x1::object::ObjectCore') return { owner: o.owner ?? OWNER };
      if (address === NFT && type.endsWith('::lending_pool::UserPosition')) return {
        deposit_shares: { data: [{ key: { inner: POOL }, value: o.shares ?? '200' }] }, debt_shares: { data: o.debt ? [{ key: { inner: POOL }, value: '1' }] : [] },
        last_deposited_times: o.deposited ?? '1762830676' };
      if (address === POOL && type.endsWith('::lending_pool::State')) return { total_reserves_amount: '1000', total_debt_amount: '0', total_fees: '0', total_supply_shares: '800', is_paused: false, lock_times: o.lock ?? '0', early_withdraw_fee_bps: o.fee ?? '0' };
      if (address === POOL && type.endsWith('::lending_pool::LendingPool')) return { token: o.token ?? STAPT_COIN, fungible_asset: { inner: addr('a8') } };
      return null;
    },
    view: (fn, args) => {
      // The DAO's balance of the pool's held asset (Auro wraps a coin pool's coin in its own fungible asset).
      if (fn === '0x1::primary_fungible_store::balance' && args[0] === AURO_DAO && args[1] === addr('a8')) return [o.held ?? '1000'];
      throw new Error(fn);
    },
    gql: () => ({ current_token_ownerships_v2: [{ token_data_id: NFT, current_token_data: { collection_id: AURO_COLLECTION } }] }),
  });

  it('counts a debt-free position from the shutdown date, withdrawn whole with the exact share amount', async () => {
    const r = await auroClosedPositions.read(context(chain()), OWNER, { tokens: [NFT] });
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ asset: STAPT_COIN, status: 'recoverable', claimableSince: AURO_CLOSED_AT, ageBasis: 'protocol_closure',
      grossClaim: [{ raw: '250' }], expectedPayout: [{ raw: '250' }],
      steps: [{ function: `${AURO_ROUTER}::auro_router::withdraw_coin_entry<${STAPT_COIN}>`, arguments: [NFT, '250'] }] });
    // A fungible-asset pool uses withdraw_entry; the check page finds the position NFTs itself, but without the
    // enumeration's repayment history it leaves the age unknown.
    const fa = await auroClosedPositions.read(context(chain({ token: addr('a7') })), OWNER);
    expect(fa.positions[0]).toMatchObject({ ageBasis: 'unknown', claimableSince: undefined,
      steps: [{ function: `${AURO_ROUTER}::auro_router::withdraw_entry` }] });
  });

  it('ages a position topped up or repaid after the shutdown from that deposit or repayment', async () => {
    const after = await auroClosedPositions.read(context(chain({ deposited: '1780000000' })), OWNER, { tokens: [NFT] });
    expect(after.positions[0].claimableSince).toBe(new Date(1_780_000_000 * 1000).toISOString());
    const repaid = await auroClosedPositions.read(context(chain()), OWNER, { tokens: [NFT], changed: { [NFT]: '2026-05-07T16:32:48.000Z' } });
    expect(repaid.positions[0].claimableSince).toBe('2026-05-07T16:32:48.000Z');
    // A change to another of the owner's positions does not re-date this one.
    const other = await auroClosedPositions.read(context(chain()), OWNER, { tokens: [NFT], changed: { [addr('f9')]: '2026-05-07T16:32:48.000Z' } });
    expect(other.positions[0].claimableSince).toBe(AURO_CLOSED_AT);
  });

  it('leaves the age unknown for a position that changed after the version the enumeration scans reached', async () => {
    // At version 90 (the scans') the position differed from the read's version 100: repaid, withdrawn from, or held by
    // someone else since.
    const c = chain();
    const at90 = (then: { position?: object; owner?: string }) => ({ ...c, resource: async (address: string, type: string, version?: string) =>
      version === '90' && type.endsWith('::lending_pool::UserPosition') && then.position ? then.position
        : version === '90' && type === '0x1::object::ObjectCore' && then.owner ? { owner: then.owner } : c.resource(address, type) });
    const current = await c.resource(NFT, `x::lending_pool::UserPosition`);
    for (const then of [{ position: { ...current, debt_shares: { data: [{ key: { inner: POOL }, value: '1' }] } } },
      { position: { ...current, deposit_shares: { data: [{ key: { inner: POOL }, value: '300' }] } } }, { owner: addr('e9') }]) {
      const r = await auroClosedPositions.read(context(at90(then)), OWNER, { tokens: [NFT], w: '90' });
      expect(r.positions[0]).toMatchObject({ ageBasis: 'unknown', claimableSince: undefined });
    }
    // Unchanged since the scans, or scanned at the read's version: dated as usual.
    expect((await auroClosedPositions.read(context(c), OWNER, { tokens: [NFT], w: '90' })).positions[0].claimableSince).toBe(AURO_CLOSED_AT);
    expect((await auroClosedPositions.read(context(c), OWNER, { tokens: [NFT], w: '100' })).positions[0].claimableSince).toBe(AURO_CLOSED_AT);
  });

  it('shows positions with debt as blocked, and leaves out position NFTs that moved', async () => {
    // With debt: the collateral is shown, blocked by it, without steps and never counted.
    expect((await auroClosedPositions.read(context(chain({ debt: true })), OWNER, { tokens: [NFT] })).positions
      .map(p => [p.status, p.blockers[0].code, p.expectedPayout, p.steps])).toEqual([['blocked', 'has_debt', [], []]]);
    expect((await auroClosedPositions.read(context(chain({ owner: addr('e9') })), OWNER, { tokens: [NFT] })).positions).toEqual([]);
  });

  it('counts the pro-rata share of what the pool really holds, and blocks a position the pool cannot pay whole', async () => {
    // The DAO holds 400 of the 1,000 on the books: 250 x 0.4 = 100 counted; 250 > 400 is false, so it can be withdrawn whole.
    const short = await auroClosedPositions.read(context(chain({ held: '400' })), OWNER, { tokens: [NFT] });
    expect(short.positions[0]).toMatchObject({ status: 'recoverable', expectedPayout: [{ raw: '100' }], steps: [{ expectedOutputs: [{ raw: '250' }] }] });
    // Holding 200 < 250: only a partial withdrawal could pay, and that needs a fresh Pyth price; nothing is payable now.
    const blocked = await auroClosedPositions.read(context(chain({ held: '200' })), OWNER, { tokens: [NFT] });
    expect(blocked.positions[0]).toMatchObject({ status: 'blocked', blockers: [{ code: 'insufficient_cash' }], grossClaim: [{ raw: '250' }], expectedPayout: [] });
    // 201 shares are 251.25 coins: the full withdrawal requests 252 and pays 251, so a pool holding 251 cannot pay it.
    // Deposited 100 s before the fake ledger time, in a pool with a 1-day lock and a fee: the fee formula is unknown.
    const early = await auroClosedPositions.read(context(chain({ deposited: '1799999900', lock: '86400', fee: '50' })), OWNER, { tokens: [NFT] });
    expect(early.positions[0]).toMatchObject({ status: 'unknown', blockers: [{ code: 'early_withdraw_fee' }], expectedPayout: [] });
    const rounded = await auroClosedPositions.read(context(chain({ shares: '201', held: '251' })), OWNER, { tokens: [NFT] });
    expect(rounded.positions[0]).toMatchObject({ status: 'blocked', blockers: [{ code: 'insufficient_cash' }], steps: [{ arguments: [NFT, '252'] }] });
  });
});

describe('animeswap closed lp', () => {
  const USDC_COIN = '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC';
  const LP = `${ANIMESWAP_POOLS}::LPCoinV1::LPCoin<0x1::aptos_coin::AptosCoin, ${USDC_COIN}>`;
  type Opts = { held?: string; indexed?: string | null; at?: string; reserveX?: string; kLast?: string; feeOn?: boolean; gqlDown?: boolean };
  // Pool books: 1,000,000 APT units and 2,000,000 USDC units over 1,000 LP; the owner holds 100 LP.
  const chain = (o: Opts = {}) => fakeChain({
    resource: (address, type) => {
      if (address !== ANIMESWAP_POOLS) return null;
      if (type.endsWith('::AnimeSwapPoolV1::AdminData')) return { dao_fee_on: o.feeOn ?? true, dao_fee: 5 };
      if (type === `${ANIMESWAP}::AnimeSwapPoolV1::LiquidityPool<0x1::aptos_coin::AptosCoin, ${USDC_COIN}>`) {
        const x = o.reserveX ?? '1000000';
        return { coin_x_reserve: { value: x }, coin_y_reserve: { value: '2000000' }, k_last: o.kLast ?? String(BigInt(x) * 2_000_000n), locked: false };
      }
      return null;
    },
    view: (fn, args, typeArgs) => {
      if (fn === '0x1::coin::balance' && args[0] === OWNER && typeArgs[0] === LP) return [o.held ?? '100'];
      if (fn === '0x1::coin::supply' && typeArgs[0] === LP) return [{ vec: ['1000'] }];
      throw new Error(fn);
    },
    gql: () => {
      if (o.gqlDown) throw new Error('indexer down');
      const amount = o.indexed === undefined ? o.held ?? '100' : o.indexed;
      return { current_fungible_asset_balances: amount === null ? [] : [
        { asset_type: LP, storage_id: addr('5'), amount, last_transaction_timestamp: o.at ?? '2024-01-02T03:04:05' }] };
    },
  });
  const hint = { lps: { [LP]: '2024-01-02T03:04:05.000Z' } };

  it('splits a pair type at its top-level comma and takes integer square roots like the contract', () => {
    expect(pairOf(`${ANIMESWAP_POOLS}::LPCoinV1::LPCoin<0x1::a::B<0x2::c::D, 0x3::e::F>, 0x4::g::H>`)).toEqual(['0x1::a::B<0x2::c::D, 0x3::e::F>', '0x4::g::H']);
    expect([0n, 1n, 3n, 4n, 15n, 16n, 2_000_000_000_000n].map(isqrt)).toEqual([0n, 1n, 1n, 2n, 3n, 4n, 1_414_213n]);
  });

  it('counts each side of the LP at its removal payout, from the closure date, with a 1% minimum', async () => {
    const r = await animeswapClosedLp.read(context(chain()), OWNER, hint);
    expect(r.complete).toBe(true);
    expect(r.positions.map(p => [p.asset, p.expectedPayout[0].raw])).toEqual([[APT, '100000'], [USDC_COIN, '200000']]);
    expect(r.positions[0]).toMatchObject({ status: 'recoverable', claimableSince: ANIMESWAP_CLOSED_AT, ageBasis: 'protocol_closure', locator: LP,
      steps: [{ function: `${ANIMESWAP}::AnimeSwapPoolV1::remove_liquidity_entry<0x1::aptos_coin::AptosCoin, ${USDC_COIN}>`, arguments: ['100', '99000', '198000'] }] });
    expect(new Set(r.positions.map(p => p.parentId)).size).toBe(1);
    // One removal pays both sides: the step is listed once.
    expect(r.positions[1].steps).toEqual([]);
    // LP added or received after the shutdown is aged from that change (the store's time now, not the hint's).
    const later = await animeswapClosedLp.read(context(chain({ at: '2026-12-01T00:00:00' })), OWNER, hint);
    expect(later.positions[0].claimableSince).toBe('2026-12-01T00:00:00.000Z');
  });

  it('leaves the age unknown when the indexer does not show the on-chain balance yet', async () => {
    // The indexer still shows 40 LP (or none) where the chain holds 100: the store time is from before the change.
    for (const indexed of ['40', null]) {
      const r = await animeswapClosedLp.read(context(chain({ indexed })), OWNER, hint);
      expect(r.positions.map(p => [p.ageBasis, p.claimableSince, p.status])).toEqual([['unknown', undefined, 'recoverable'], ['unknown', undefined, 'recoverable']]);
    }
  });

  it('reads LP the indexer shows that the hint does not list, and is incomplete without the indexer', async () => {
    const OTHER = `${ANIMESWAP_POOLS}::LPCoinV1::LPCoin<0x1::a::B, 0x1::c::D>`;
    const c = chain();
    // The hinted pool's LP is gone (balance 0); the indexed one is read.
    const r = await animeswapClosedLp.read(context({ ...c,
      resource: async (a, t, v) => t.endsWith('LiquidityPool<0x1::a::B, 0x1::c::D>') ? { coin_x_reserve: { value: '1' }, coin_y_reserve: { value: '1' }, k_last: '1', locked: false } : c.resource(a, t, v),
      view: async (fn, args, typeArgs = [], v) => typeArgs[0] !== OTHER ? c.view(fn, args, typeArgs, v) : fn === '0x1::coin::balance' ? ['0'] : [{ vec: ['1'] }] }),
      OWNER, { lps: { [OTHER]: '2024-01-02T03:04:05.000Z' } });
    expect(r.complete).toBe(true);
    expect(r.positions.map(p => p.locator)).toEqual([LP, LP]);
    const down = await animeswapClosedLp.read(context(chain({ gqlDown: true })), OWNER, hint);
    expect(down).toMatchObject({ positions: [], complete: false });
  });

  it('mints the DAO fee in LP first when the pool grew since the last mint', async () => {
    // root k 1,414,213 vs 1,000,000: fee LP = 1000 x 414,213 / (1,414,213 x 5 + 1,000,000) = 51, so 100 of 1,051 LP.
    const r = await animeswapClosedLp.read(context(chain({ kLast: '1000000000000' })), OWNER, hint);
    expect(r.positions.map(p => p.expectedPayout[0].raw)).toEqual(['95147', '190294']);
    const off = await animeswapClosedLp.read(context(chain({ kLast: '1000000000000', feeOn: false })), OWNER, hint);
    expect(off.positions.map(p => p.expectedPayout[0].raw)).toEqual(['100000', '200000']);
  });

  it('blocks LP too small to remove, and finds the LP from the indexer without a hint', async () => {
    // 100 x 5 / 1000 rounds to 0 APT: burn aborts.
    const dust = await animeswapClosedLp.read(context(chain({ reserveX: '5' })), OWNER, hint);
    expect(dust.positions).toHaveLength(1);
    expect(dust.positions[0]).toMatchObject({ asset: USDC_COIN, status: 'blocked', blockers: [{ code: 'below_minimum' }], expectedPayout: [] });
    const checked = await animeswapClosedLp.read(context(chain()), OWNER);
    expect(checked.positions.map(p => p.claimableSince)).toEqual([ANIMESWAP_CLOSED_AT, ANIMESWAP_CLOSED_AT]);
    expect((await animeswapClosedLp.read(context(chain({ held: '0', indexed: null })), OWNER, hint)).positions).toEqual([]);
  });
});

describe('earnium closed lp', () => {
  const POOL = addr('e1');
  // `held`: per pool, the owner's wallet LP, staked LP and unlock time. Pool books pay 2 APT units and 3 kAPT units per LP.
  type Held = Record<string, { wallet: string; staked: string; unlock: string }>;
  const chain = (held: Held, pools = [POOL]) => fakeChain({
    view: (fn, args) => {
      if (fn.endsWith('::liquidity_pool::pools')) return [pools.map(inner => ({ inner }))];
      if (fn.endsWith('::liquidity_stake_pool::user_info')) return [(args[1] as string[]).map(p => {
        const h = held[p] ?? { wallet: '0', staked: '0', unlock: '0' };
        return { wallet_balance: h.wallet, staked: h.staked, unlock_time: h.unlock, rewards: { data: [] } };
      })];
      if (fn.endsWith('::liquidity_pool::supported_inner_assets')) return [[{ inner: '0xa' }, { inner: KAPT }]];
      if (fn.endsWith('::liquidity_pool::is_stable')) return [false];
      if (fn.endsWith('::coin_wrapper::get_original')) return [args[0] === '0x' + '0'.repeat(63) + 'a' ? '0x1::aptos_coin::AptosCoin' : args[0]];
      if (fn.endsWith('::router::redeemable_liquidity')) return [String(BigInt(args[1] as string) * 2n), String(BigInt(args[1] as string) * 3n)];
      throw new Error(fn);
    },
  });
  const raw = (r: { positions: { asset?: string; expectedPayout: { raw: string }[]; status: string }[] }) => r.positions.map(p => [p.asset, p.expectedPayout[0]?.raw, p.status]);

  it('counts wallet LP and unstakable LP as separate parts at the removal payout, unstaking first, from the closure', async () => {
    const r = await earniumClosedLp.read(context(chain({ [POOL]: { wallet: '100', staked: '400', unlock: '0' } })), OWNER, {});
    expect(r.complete).toBe(true);
    expect(raw(r)).toEqual([[APT, '200', 'recoverable'], [KAPT, '300', 'recoverable'], [APT, '800', 'recoverable'], [KAPT, '1200', 'recoverable']]);
    expect(r.positions.map(p => [p.locator, p.claimableSince, p.ageBasis])).toEqual([
      [POOL, EARNIUM_CLOSED_AT, 'protocol_closure'], [POOL, EARNIUM_CLOSED_AT, 'protocol_closure'],
      [`${POOL}/staked`, EARNIUM_CLOSED_AT, 'protocol_closure'], [`${POOL}/staked`, EARNIUM_CLOSED_AT, 'protocol_closure']]);
    const steps = (i: number) => r.positions[i].steps.map(s => [s.function.split('::').slice(-2).join('::'), s.arguments]);
    expect(steps(0)).toEqual([['router::remove_liquidity_entry', [APT, KAPT, 'false', '100', '198', '297', OWNER]]]);
    expect(steps(2)).toEqual([
      ['liquidity_stake_pool::unstake', [POOL, '400']],
      ['router::remove_liquidity_entry', [APT, KAPT, 'false', '400', '792', '1188', OWNER]],
    ]);
    expect([r.positions[1].steps, r.positions[3].steps]).toEqual([[], []]);
    // A staking call after the closure dates the stake, not the wallet LP; wallet LP received later dates only itself.
    // A call in another pool dates nothing here.
    const both = context(chain({ [POOL]: { wallet: '100', staked: '400', unlock: '0' } }));
    const staked = await earniumClosedLp.read(both, OWNER, { staked: { [POOL]: '2026-12-01T00:00:00.000Z' } });
    expect(staked.positions.map(p => p.claimableSince)).toEqual([EARNIUM_CLOSED_AT, EARNIUM_CLOSED_AT, '2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z']);
    const received = await earniumClosedLp.read(both, OWNER, { lps: { [POOL]: '2026-11-02T00:00:00.000Z' } });
    expect(received.positions.map(p => p.claimableSince)).toEqual(['2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', EARNIUM_CLOSED_AT, EARNIUM_CLOSED_AT]);
    const other = await earniumClosedLp.read(both, OWNER, { staked: { [addr('e9')]: '2026-12-01T00:00:00.000Z' } });
    expect(other.positions.map(p => p.claimableSince)).toEqual(Array(4).fill(EARNIUM_CLOSED_AT));
  });

  it('leaves the age unknown for a part whose holdings changed after the version the enumeration scans reached', async () => {
    // At version 90 (the scans') the owner had 100 LP staked in POOL and 50 in OTHER's wallet; at the read's version 100
    // it has unstaked 60 of POOL's to its wallet (both parts changed), and staked 30 in OTHER (its wallet is unchanged).
    const OTHER = addr('e2');
    const now: Held = { [POOL]: { wallet: '60', staked: '40', unlock: '0' }, [OTHER]: { wallet: '50', staked: '30', unlock: '0' } };
    const c = chain(now, [POOL, OTHER]), then = chain({ [POOL]: { wallet: '0', staked: '100', unlock: '0' }, [OTHER]: { wallet: '50', staked: '0', unlock: '0' } }, [POOL, OTHER]);
    const at90 = { ...c, view: async (fn: string, args: unknown[], typeArgs: string[], version?: string) =>
      version === '90' ? then.view(fn, args, typeArgs) : c.view(fn, args, typeArgs) };
    const r = await earniumClosedLp.read(context(at90), OWNER, { w: '90' });
    expect(r.positions.filter((_, i) => i % 2 === 0).map(p => [p.locator, p.ageBasis, p.claimableSince])).toEqual([
      [POOL, 'unknown', undefined], [`${POOL}/staked`, 'unknown', undefined],
      [OTHER, 'protocol_closure', EARNIUM_CLOSED_AT], [`${OTHER}/staked`, 'unknown', undefined]]);
  });

  it('blocks a stake still locked, and leaves out LP locked forever', async () => {
    const locked = await earniumClosedLp.read(context(chain({ [POOL]: { wallet: '100', staked: '400', unlock: '1900000000' } })), OWNER);
    expect(raw(locked)).toEqual([[APT, '200', 'recoverable'], [KAPT, '300', 'recoverable'], [APT, undefined, 'blocked'], [KAPT, undefined, 'blocked']]);
    expect(locked.positions[2]).toMatchObject({ locator: `${POOL}/locked`, blockers: [{ code: 'locked' }], grossClaim: [{ raw: '800' }], ageBasis: 'unknown' });
    // Unstaking comes first, once the lock ends.
    expect(locked.positions[2].steps.map(s => [s.function.split('::').pop(), s.arguments[s.function.endsWith('::unstake') ? 1 : 3], s.prerequisites])).toEqual([
      ['unstake', '400', [`after ${new Date(1_900_000_000_000).toISOString()}`]], ['remove_liquidity_entry', '400', []]]);
    // Locked forever on purpose (launch liquidity): it can never come out, so it is not left behind (R3).
    const forever = await earniumClosedLp.read(context(chain({ [POOL]: { wallet: '0', staked: '400', unlock: '18446744073709551615' } })), OWNER);
    expect(forever.positions).toEqual([]);
  });

  it('leaves the age unknown without a hint (the check page has no history to date a part)', async () => {
    const r = await earniumClosedLp.read(context(chain({ [POOL]: { wallet: '100', staked: '400', unlock: '0' } })), OWNER);
    expect(r.positions.map(p => [p.ageBasis, p.claimableSince, p.status])).toEqual(Array(4).fill(['unknown', undefined, 'recoverable']));
  });

  it('ages a stake that unlocked after the closure from its unlock', async () => {
    // Unlocked on 2026-09-21, before the closure: the closure date stays. Unlocked on 2026-11-18, after it: from then.
    const before = await earniumClosedLp.read(context(chain({ [POOL]: { wallet: '0', staked: '400', unlock: '1790000000' } })), OWNER, {});
    expect(before.positions[0].claimableSince).toBe(EARNIUM_CLOSED_AT);
    const after = await earniumClosedLp.read(context(chain({ [POOL]: { wallet: '0', staked: '400', unlock: '1795000000' } })), OWNER, {});
    expect(after.positions[0].claimableSince).toBe(new Date(1_795_000_000_000).toISOString());
  });

  it('reads the pools 20 at a time', async () => {
    const pools = Array.from({ length: 25 }, (_, i) => addr(`e${i + 10}`));
    const c = chain({ [pools[24]]: { wallet: '1', staked: '0', unlock: '0' } }, pools);
    const r = await earniumClosedLp.read(context(c), OWNER, {});
    expect(r.positions.map(p => p.locator)).toEqual([pools[24], pools[24]]);
    expect(c.calls.filter(x => x.includes('user_info'))).toHaveLength(2);
  });
});

describe('canopy frozen vaults', () => {
  const byName = (n: string) => [...FROZEN_VAULTS].find(([, v]) => v.name === n)![0];
  const MOVE0 = byName('CV MOVE-0'), SUSDA = byName('CV sUSDa-46'), RSETH = byName('CV rsETH-26');
  const share = (v: string) => addr(`5${v.slice(3, 10)}`);
  type Held = Record<string, { wallet?: string; staked?: string; open?: boolean }>;
  // Each vault pays 2 asset units per share.
  const chain = (held: Held) => fakeChain({
    view: (fn, args) => {
      if (fn.endsWith('::vault::vaults_view')) return [{ vaults: [MOVE0, SUSDA, RSETH].map(v => ({ vault_address: v, shares_address: share(v), asset_address: '0xa' })) }];
      if (fn.endsWith('::rewards_view::get_user_pool_positions')) return [Object.entries(held).filter(([, h]) => h.staked).map(([v]) => ({ pool_staking_token: { inner: share(v) } }))];
      const v = [MOVE0, SUSDA, RSETH].find(x => share(x) === args[1] || x === args[0]);
      if (fn === '0x1::primary_fungible_store::balance') return [held[v!]?.wallet ?? '0'];
      if (fn.endsWith('::multi_rewards::get_user_staked_balance')) return [held[v!]?.staked ?? '0'];
      if (fn.endsWith('::vault::shares_to_amount')) return [String(BigInt(args[1] as string) * 2n)];
      throw new Error(fn);
    },
    resource: (address, type) => type === `${CANOPY_VAULTS}::vault::Vault` ? { is_paused: false, deposit_limit: { vec: held[address]?.open ? [] : ['0'] } } : null,
    gql: query => query.includes('user_transactions') ? { user_transactions: [{ timestamp: '2026-10-20T05:00:00' }] }
      : { current_fungible_asset_balances: Object.entries(held).filter(([, h]) => h.wallet).map(([v]) => ({ asset_type: share(v), storage_id: addr('6'), is_primary: true })) },
  });

  it('counts shares in the wallet and staked in a frozen vault as separate parts, unstaking first; blocked where withdrawing aborts', async () => {
    // The stake (version 5) came long before the freeze, so its time is not looked up.
    const r = await canopyFrozenVaults.read(context(chain({ [MOVE0]: { wallet: '50', staked: '100' } })), OWNER, { at: { [share(MOVE0)]: '2026-01-01T00:00:00.000Z' }, v: { [share(MOVE0)]: '5' } });
    expect(r.complete).toBe(true);
    expect(r.positions.map(p => [p.locator, p.grossClaim[0].raw, p.status, p.blockers[0]?.code, p.expectedPayout, p.claimableSince])).toEqual([
      [MOVE0, '100', 'blocked', 'withdrawal_aborts', [], '2026-10-16T14:40:46Z'], [`${MOVE0}/staked`, '200', 'blocked', 'withdrawal_aborts', [], '2026-10-16T14:40:46Z']]);
    // MOVE-0 takes withdraw_coin in Canopy's withdrawal guide; empty strategies and packets, 1% max loss, 0 min out.
    const withdrawCoin = `${CANOPY_ROUTER}::router::withdraw_coin<0x1::aptos_coin::AptosCoin, 0x1::aptos_coin::AptosCoin>`;
    expect(r.positions.map(p => p.steps.map(s => [s.function, s.arguments]))).toEqual([
      [[withdrawCoin, [MOVE0, '[]', '[]', '50', 'some(100)', 'some(0)']]],
      [[`${CANOPY_REWARDS}::multi_rewards::withdraw`, [share(MOVE0), '100']], [withdrawCoin, [MOVE0, '[]', '[]', '100', 'some(100)', 'some(0)']]]]);
    // Wallet shares received after the freeze date only the wallet part, not the stake.
    const received = await canopyFrozenVaults.read(context(chain({ [SUSDA]: { wallet: '1', staked: '9' } })), OWNER, { at: { [share(SUSDA)]: '2026-10-20T00:00:00.000Z' } });
    expect(received.positions.map(p => [p.locator, p.claimableSince])).toEqual([[SUSDA, '2026-10-20T00:00:00.000Z'], [`${SUSDA}/staked`, '2026-10-16T14:40:46Z']]);
  });

  it('is recoverable where withdrawing works, aged from a later change of the owner\'s shares', async () => {
    const r = await canopyFrozenVaults.read(context(chain({ [SUSDA]: { wallet: '7' } })), OWNER, { at: { [share(SUSDA)]: '2026-10-20T00:00:00.000Z' } });
    expect(r.positions[0]).toMatchObject({ status: 'recoverable', expectedPayout: [{ raw: '14' }], claimableSince: '2026-10-20T00:00:00.000Z' });
    // A vault the guide lists with no other call: withdraw_fa_with_coin_type<AptosCoin>.
    expect(r.positions[0].steps.map(s => s.function)).toEqual([`${CANOPY_ROUTER}::router::withdraw_fa_with_coin_type<0x1::aptos_coin::AptosCoin>`]);
    // A change to another vault's shares, in the wallet or staked, does not re-date this one.
    const other = await canopyFrozenVaults.read(context(chain({ [SUSDA]: { wallet: '7' } })), OWNER,
      { at: { [share(MOVE0)]: '2026-10-20T00:00:00.000Z' }, v: { [share(MOVE0)]: '300000000' } });
    expect(other.positions[0].claimableSince).toBe('2026-10-16T14:40:46Z');
    // A stake of these shares after the freeze dates them from that transaction.
    const restaked = await canopyFrozenVaults.read(context(chain({ [SUSDA]: { staked: '7' } })), OWNER, { v: { [share(SUSDA)]: '300000000' } });
    expect(restaked.positions[0].claimableSince).toBe('2026-10-20T05:00:00.000Z');
    // Its transaction not indexed yet: the time is unknown, so is the age.
    const c = chain({ [SUSDA]: { staked: '7' } });
    const unindexed = await canopyFrozenVaults.read(context({ ...c, gql: (async (q: string, v?: Record<string, unknown>) =>
      q.includes('user_transactions') ? { user_transactions: [] } : c.gql(q, v)) as typeof c.gql }), OWNER, { v: { [share(SUSDA)]: '300000000' } });
    expect(unindexed.positions[0]).toMatchObject({ ageBasis: 'unknown', claimableSince: undefined });
    expect(r.positions[0].steps).toHaveLength(1);
    // MovePosition strategies need a price packet from its operator: team-gated, payout kept.
    const packet = await canopyFrozenVaults.read(context(chain({ [RSETH]: { staked: '3' } })), OWNER, {});
    expect(packet.positions[0]).toMatchObject({ status: 'team_gated', expectedPayout: [{ raw: '6' }], claimableSince: '2026-06-16T13:09:26Z', blockers: [{ code: 'price_packet' }] });
    expect(packet.positions[0].steps[1].prerequisites[0]).toMatch(/MovePosition/);
  });

  it('leaves the age unknown for shares that changed after the version the enumeration scans reached', async () => {
    // At version 90 (the scans') the owner had 3 sUSDa shares in its wallet; at the read's version 100 it has 7.
    const at90 = (wallet: string) => {
      const c = chain({ [SUSDA]: { wallet: '7' } });
      return { ...c, view: async (fn: string, args: unknown[], typeArgs: string[], version?: string) =>
        version === '90' && fn === '0x1::primary_fungible_store::balance' ? [wallet] : c.view(fn, args, typeArgs) };
    };
    const hint = { at: { [share(SUSDA)]: '2026-01-01T00:00:00.000Z' }, w: '90' };
    expect((await canopyFrozenVaults.read(context(at90('3')), OWNER, hint)).positions[0]).toMatchObject({ ageBasis: 'unknown', claimableSince: undefined });
    expect((await canopyFrozenVaults.read(context(at90('7')), OWNER, hint)).positions[0].claimableSince).toBe('2026-10-16T14:40:46Z');
    // A staker whose hint has no store time received wallet shares after the scan: they are read, with no age yet.
    const received = await canopyFrozenVaults.read(context(at90('0')), OWNER, { v: { [share(MOVE0)]: '5' }, w: '90' });
    expect(received.positions[0]).toMatchObject({ locator: SUSDA, grossClaim: [{ raw: '14' }], ageBasis: 'unknown' });
  });

  it('leaves the age unknown without a hint, and reads each vault on its own', async () => {
    const c = chain({ [SUSDA]: { wallet: '7' }, [MOVE0]: { wallet: '5' } });
    const r = await canopyFrozenVaults.read(context(c), OWNER);
    expect(r.positions.map(p => [p.locator, p.ageBasis, p.claimableSince])).toEqual(expect.arrayContaining([[SUSDA, 'unknown', undefined], [MOVE0, 'unknown', undefined]]));
    // MOVE-0's shares cannot be valued: sUSDa is still read, and the read is incomplete.
    const failing = await canopyFrozenVaults.read(context({ ...c, view: async (fn, args, typeArgs, v) =>
      fn.endsWith('::vault::shares_to_amount') && args[0] === MOVE0 ? Promise.reject(new Error('view failed')) : c.view(fn, args, typeArgs, v) }), OWNER, {});
    expect(failing.complete).toBe(false);
    expect(failing.positions.map(p => p.locator)).toEqual([SUSDA]);
  });

  it('reads the wallet for a staking token even when the indexer shows no store yet', async () => {
    // All 7 shares were just withdrawn from staking into the wallet; the indexer has not caught up.
    const c = chain({ [SUSDA]: { wallet: '7', staked: '0' } });
    const r = await canopyFrozenVaults.read(context({ ...c, gql: (async () => ({ current_fungible_asset_balances: [] })) as typeof c.gql }), OWNER, {});
    expect(r.positions.map(p => [p.locator, p.grossClaim[0].raw])).toEqual([[SUSDA, '14']]);
  });

  it('shows shares in a secondary store the owner holds, uncounted', async () => {
    const c = chain({ [SUSDA]: { wallet: '7' } });
    const store = addr('7e');
    const r = await canopyFrozenVaults.read(context({ ...c,
      gql: (async (q: string, v?: Record<string, unknown>) => q.includes('user_transactions') ? c.gql(q, v)
        : { current_fungible_asset_balances: [{ asset_type: share(SUSDA), storage_id: addr('6'), is_primary: true }, { asset_type: share(SUSDA), storage_id: store, is_primary: false }] }) as typeof c.gql,
      view: async (fn, args, typeArgs, v) => fn === '0x1::object::owner' ? [OWNER] : fn === '0x1::fungible_asset::balance' ? ['3'] : c.view(fn, args, typeArgs, v) }), OWNER, {});
    expect(r.positions.map(p => [p.locator, p.grossClaim[0].raw, p.status, p.blockers[0]?.code, p.expectedPayout])).toEqual([
      [SUSDA, '14', 'recoverable', undefined, [{ asset: `movement:${addr('a')}`, raw: '14' }]], [`${SUSDA}/store/${store}`, '6', 'unknown', 'secondary_store', []]]);
  });

  it('leaves out a vault that is open to deposits', async () => {
    expect((await canopyFrozenVaults.read(context(chain({ [SUSDA]: { wallet: '7', open: true } })), OWNER)).positions).toEqual([]);
  });
});

describe('houston closed lp', () => {
  const USDC_COIN = '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC';
  const PAIR = `<0x1::aptos_coin::AptosCoin, ${USDC_COIN}>`;
  const neg = (t: number) => ((1n << 63n) + BigInt(t)).toString();
  const Q64 = 2 ** 64;
  // Float references: √(1.0001^tick), and the burn amounts of liquidity L over [a, b) at price p.
  const sqrtF = (t: number) => 1.0001 ** (t / 2);
  const close = (got: bigint, want: number) => expect(Math.abs(Number(got) - want) / Math.max(want, 1)).toBeLessThan(1e-9);

  it('decodes signed ticks and prices them like 1.0001^tick', () => {
    expect([tickOf('120'), tickOf(neg(120)), tickOf('0')]).toEqual([120n, -120n, 0n]);
    expect(sqrtPriceAt(0n)).toBe(1n << 64n);
    for (const t of [1, 120, 27660, -58680, 443580, -443580]) close(sqrtPriceAt(BigInt(t)), sqrtF(t) * Q64);
  });

  it('splits a range into its two coins by where the price sits', () => {
    const L = 10n ** 12n, [a, b] = [-1200, 2400];
    const below = burnAmounts(L, BigInt(a), BigInt(b), -5000n, sqrtPriceAt(-5000n));
    close(below[0], 1e12 * (sqrtF(b) - sqrtF(a)) / (sqrtF(a) * sqrtF(b)));
    expect(below[1]).toBe(0n);
    const above = burnAmounts(L, BigInt(a), BigInt(b), 9000n, sqrtPriceAt(9000n));
    expect(above[0]).toBe(0n);
    close(above[1], 1e12 * (sqrtF(b) - sqrtF(a)));
    const p = sqrtF(300), inside = burnAmounts(L, BigInt(a), BigInt(b), 300n, sqrtPriceAt(300n));
    close(inside[0], 1e12 * (sqrtF(b) - p) / (p * sqrtF(b)));
    close(inside[1], 1e12 * (p - sqrtF(a)));
  });

  const position = (o: { id?: string; liquidity?: string; owedX?: string; storedY?: string } = {}) => ({ id: o.id ?? '3', lower_tick: { v: neg(1200) }, upper_tick: { v: '2400' }, fee_tier: '0',
    liquidity: o.liquidity ?? '1000000000000', tokens_owed_x: o.owedX ?? '0', tokens_owed_y: '0', tokens_stored_x: { value: '0' }, tokens_stored_y: { value: o.storedY ?? '0' } });
  const wallet = (positions: unknown[]) => [{ type: `${HOUSTON}::position::PositionWallet${PAIR}`, data: { positions } }, { type: '0x1::account::Account', data: {} }];
  // The pool sits at tick 300; reserves cover the default position unless told otherwise.
  const chain = (positions: unknown[], reserveY = '10000000000000') => fakeChain({
    resources: () => wallet(positions),
    resource: (address, type) => address === HOUSTON_POOLS && type === `${HOUSTON}::pool::Pool${PAIR}` ? { fee_tier: { data: [{ key: '0', value: {
      tick_latest: { v: '300' }, sqrt_price_latest: { v: sqrtPriceAt(300n).toString() }, reserve_x: { value: '10000000000000' }, reserve_y: { value: reserveY } } }] } } : null,
  });

  it('counts each coin of a position at its burn amount from the closure, removed whole with a 1% minimum', async () => {
    const r = await houstonClosedLp.read(context(chain([position({ owedX: '7' })])), OWNER, { w: '100' });
    expect(r.complete).toBe(true);
    const [x, y] = burnAmounts(10n ** 12n, -1200n, 2400n, 300n, sqrtPriceAt(300n));
    expect(r.positions.map(p => [p.asset, p.expectedPayout[0].raw])).toEqual([[APT, String(x + 7n)], [USDC_COIN, String(y)]]);
    expect(r.positions[0]).toMatchObject({ status: 'recoverable', claimableSince: HOUSTON_CLOSED_AT, ageBasis: 'protocol_closure', locator: `${PAIR}#3`,
      steps: [{ function: `${HOUSTON}::liquidity_manager::remove_liquidity${PAIR}`,
        arguments: [OWNER, neg(1200), '2400', '0', '1000000000000', String(x * 99n / 100n), String(y * 99n / 100n), '18446744073709551615'] }] });
    expect(r.positions[1].steps).toEqual([]);
  });

  it('blocks a position its pool cannot pay, and leaves the age unknown for a pair that changed after the scans', async () => {
    const short = await houstonClosedLp.read(context(chain([position()], '5')), OWNER);
    expect(short.positions.map(p => [p.status, p.blockers[0]?.code, p.expectedPayout])).toEqual([['blocked', 'reserve_short', []], ['blocked', 'reserve_short', []]]);
    // At version 90 (the scans') the wallet held a smaller position.
    const c = chain([position()]);
    const at90 = { ...c, resources: async (address: string, version?: string) => version === '90' ? wallet([position({ liquidity: '5' })]) : c.resources(address) };
    expect((await houstonClosedLp.read(context(at90), OWNER, { w: '90' })).positions[0]).toMatchObject({ ageBasis: 'unknown', claimableSince: undefined });
    const same = { ...c, resources: async (address: string) => c.resources(address) };
    expect((await houstonClosedLp.read(context(same), OWNER, { w: '90' })).positions[0].claimableSince).toBe(HOUSTON_CLOSED_AT);
    // A pair changed after the closure is aged from that change.
    const later = await houstonClosedLp.read(context(c), OWNER, { moved: { [PAIR]: '2026-12-01T00:00:00.000Z' } });
    expect(later.positions[0].claimableSince).toBe('2026-12-01T00:00:00.000Z');
  });

  it('pays stored coins from the position itself: they do not draw on the pool\'s reserves', async () => {
    const [, y] = burnAmounts(10n ** 12n, -1200n, 2400n, 300n, sqrtPriceAt(300n));
    // The reserves cover the burn exactly; the position also stores 1,000 of Y.
    const r = await houstonClosedLp.read(context(chain([position({ storedY: '1000' })], String(y))), OWNER, { w: '100' });
    expect(r.positions.map(p => [p.positionKind, p.status, p.expectedPayout[0]?.raw, p.steps.length])).toEqual([
      ['principal', 'recoverable', expect.any(String), 1], ['principal', 'recoverable', String(y), 0], ['fees', 'recoverable', '1000', 0]]);
    expect(new Set(r.positions.map(p => p.id)).size).toBe(3);
  });

  it('leaves the age unknown without a hint (the check page has no history to date a pair)', async () => {
    const r = await houstonClosedLp.read(context(chain([position()])), OWNER);
    expect(r.positions.map(p => [p.ageBasis, p.claimableSince, p.status])).toEqual([['unknown', undefined, 'recoverable'], ['unknown', undefined, 'recoverable']]);
  });
});

describe('aries wound down', () => {
  const hexOf = (t: string) => '0x' + Buffer.from(t).toString('hex');
  const info = (address: string, module: string, struct: string) => ({ account_address: address, module_name: hexOf(module), struct_name: hexOf(struct) });
  const APT_INFO = info('0x1', 'aptos_coin', 'AptosCoin'), USDC_INFO = info(ARIES, 'fa_to_coin_wrapper', 'WrappedUSDC');
  const APT_T = '0x1::aptos_coin::AptosCoin', USDC_T = `${ARIES}::fa_to_coin_wrapper::WrappedUSDC`, USDC_FA = addr('5dc');
  const table = (keys: unknown[]) => ({ inner: { inner: { handle: addr('7a') }, length: String(keys.length) }, head: { vec: keys.slice(0, 1) }, tail: { vec: keys.slice(-1) } });
  type Opts = { deposits?: unknown[]; loans?: unknown[]; loanShare?: string; cash?: string; redeem?: boolean; stale?: boolean | Error; aptQuote?: Error; late?: boolean; indexedTo?: string };
  // Profile "Main Account": APT quoted 500 (and USDC 70); APT's reserve holds `cash`.
  const chain = (o: Opts = {}) => fakeChain({
    // Deposits by the owner after the wind-down.
    gql: q => q.includes('processor_status') ? { processor_status: [{ last_success_version: o.indexedTo ?? '100' }] }
      : { user_transactions: [{ version: '7700000001', entry_function_id_str: '0x1::aptos_account::transfer' },
        ...(o.late ? [{ version: '7700000000', entry_function_id_str: `${ARIES}::controller::deposit_fa` }] : [])] },
    resource: (address, type) => {
      if (address === OWNER && type === `${ARIES}::profile::Profiles`) return { profile_signers: { data: [{ key: 'profileMain Account', value: { account: addr('9f') } }] } };
      if (address === addr('9f') && type === `${ARIES}::profile::Profile`) return { deposited_reserves: table(o.deposits ?? [APT_INFO, USDC_INFO]), borrowed_reserves: table(o.loans ?? []) };
      if (address === ARIES && type === `${ARIES}::fa_to_coin_wrapper::WrapperCoinInfo<${USDC_T}>`) return { metadata: { inner: USDC_FA } };
      return null;
    },
    tableItem: (_h, _k, _v, key: any) => ({ val: {}, next: { vec: key.struct_name === APT_INFO.struct_name ? [USDC_INFO] : [] } }),
    view: (fn, _args, typeArgs) => {
      if (fn.endsWith('::profile::profile_deposit')) { if (typeArgs[0] === APT_T && o.aptQuote) throw o.aptQuote; return typeArgs[0] === APT_T ? ['400', '500'] : ['90', '70']; }
      if (fn.endsWith('::profile::profile_loan')) return [o.loanShare ?? '0', '0'];
      if (fn.endsWith('::reserve::reserve_state')) return [{ total_cash_available: typeArgs[0] === APT_T ? (o.cash ?? '1000') : '1000', reserve_config: { allow_redeem: o.redeem ?? true } }];
      if (fn.endsWith('::oracle::get_reserve_price')) { if (o.stale) throw o.stale === true ? new Error('Move abort in oracle: EORACLE_PRICE_STALE(0x2)') : o.stale; return [{}]; }
      throw new Error(fn);
    },
  });

  it('decodes reserve types, keeping the framework address short', () => {
    expect(reserveType(APT_INFO)).toBe(APT_T);
    expect(reserveType(USDC_INFO)).toBe(USDC_T);
  });

  it('counts each supplied reserve at the protocol\'s quote, withdrawing everything with u64 max', async () => {
    const r = await ariesWoundDown.read(context(chain()), OWNER);
    expect(r.complete).toBe(true);
    expect(r.positions[0]).toMatchObject({ asset: APT, status: 'recoverable', grossClaim: [{ raw: '500' }], expectedPayout: [{ raw: '500' }],
      claimableSince: ARIES_CLOSED_AT, locator: `Main Account/${APT_T}`,
      steps: [{ function: `${ARIES}::controller::withdraw<${APT_T}>`, arguments: [hexOf('Main Account'), '18446744073709551615', 'false'] }] });
    // Aries's own wrapper coins are paid as the fungible asset they wrap, through withdraw_fa.
    expect(r.positions[1]).toMatchObject({ asset: USDC_FA, grossClaim: [{ raw: '70' }], steps: [{ function: `${ARIES}::controller::withdraw_fa<${USDC_T}>` }] });
    expect(ariesWoundDown.checkOnly).toBe(true);
  });

  it('blocks a deposit its reserve cannot pay, one that cannot be redeemed, and one held back by a stale price', async () => {
    const code = async (o: Opts) => (await ariesWoundDown.read(context(chain(o)), OWNER)).positions[0].blockers[0]?.code;
    expect(await code({ cash: '499' })).toBe('reserves_removed');
    expect(await code({ redeem: false })).toBe('paused');
    expect(await code({ stale: true })).toBe('stale_oracle');
    // The last reserve left needs no price.
    expect(await code({ stale: true, deposits: [APT_INFO] })).toBeUndefined();
    // A deposit with a blocker of its own is classified without reading other reserves' prices.
    const known = await ariesWoundDown.read(context(chain({ cash: '499', stale: new Error('fetch failed') })), OWNER);
    expect(known.positions.map(p => [p.asset, p.blockers[0]?.code])).toEqual([[APT, 'reserves_removed']]);
    // A price read that fails otherwise is not a stale price: the read is incomplete.
    const down = await ariesWoundDown.read(context(chain({ stale: new Error('fetch failed') })), OWNER);
    expect(down).toMatchObject({ complete: false, positions: [] });
  });

  it('reads each reserve on its own: an overflowing quote is blocked, another failure leaves the read incomplete', async () => {
    const overflow = await ariesWoundDown.read(context(chain({ aptQuote: new Error('ARITHMETIC_ERROR: Subtraction overflow') })), OWNER);
    expect(overflow.complete).toBe(true);
    expect(overflow.positions.map(p => [p.asset, p.status, p.blockers[0]?.code, p.grossClaim])).toEqual([
      [APT, 'blocked', 'reserve_accounting_negative', []], [USDC_FA, 'recoverable', undefined, [{ asset: USDC_FA, raw: '70' }]]]);
    const down = await ariesWoundDown.read(context(chain({ aptQuote: new Error('fetch failed') })), OWNER);
    expect(down.complete).toBe(false);
    expect(down.positions.map(p => p.asset)).toEqual([USDC_FA]);
    // The unread reserve still counts for the oracle check: with its price stale, USDC cannot come out alone either.
    const staleUnread = await ariesWoundDown.read(context(chain({ aptQuote: new Error('fetch failed'), stale: true })), OWNER);
    expect(staleUnread.positions.map(p => [p.asset, p.status, p.blockers[0]?.code])).toEqual([[USDC_FA, 'blocked', 'stale_oracle']]);
  });

  it('pays a coin in Aries\'s own package that is not a registered wrapper as itself, through withdraw', async () => {
    const LEGACY = info(ARIES, 'legacy_coins', 'Legacy'), LEGACY_T = `${ARIES}::legacy_coins::Legacy`;
    const r = await ariesWoundDown.read(context(chain({ deposits: [LEGACY] })), OWNER);
    expect(r.complete).toBe(true);
    expect(r.positions[0]).toMatchObject({ asset: LEGACY_T, grossClaim: [{ raw: '70' }], steps: [{ function: `${ARIES}::controller::withdraw<${LEGACY_T}>` }] });
  });

  it('reads a profile key rendered as text or as hex', async () => {
    const c = chain();
    const hexKey = { ...c, resource: async (address: string, type: string, v?: string) => address === OWNER && type === `${ARIES}::profile::Profiles`
      ? { profile_signers: { data: [{ key: hexOf('profileMain Account'), value: { account: addr('9f') } }] } } : c.resource(address, type, v) };
    const r = await ariesWoundDown.read(context(hexKey), OWNER);
    expect(r.complete).toBe(true);
    expect(r.positions.map(p => p.locator)).toEqual([`Main Account/${APT_T}`, `Main Account/${USDC_T}`]);
  });

  it('leaves the age unknown when the owner deposited after the wind-down, or the indexer has not reached the read', async () => {
    const r = await ariesWoundDown.read(context(chain({ late: true })), OWNER);
    expect(r.positions.map(p => [p.ageBasis, p.claimableSince])).toEqual([['unknown', undefined], ['unknown', undefined]]);
    vi.useFakeTimers();
    try {
      const behind = ariesWoundDown.read(context(chain({ indexedTo: '99' })), OWNER);
      await vi.runAllTimersAsync();
      expect((await behind).positions.map(p => p.ageBasis)).toEqual(['unknown', 'unknown']);
    } finally { vi.useRealTimers(); }
  });

  it('shows a profile with debt blocked by it, without steps and never counted', async () => {
    const r = await ariesWoundDown.read(context(chain({ loans: [APT_INFO], loanShare: '5' })), OWNER);
    expect(r.positions.map(p => [p.asset, p.status, p.blockers[0].code, p.expectedPayout, p.steps])).toEqual([
      [APT, 'blocked', 'has_debt', [], []], [USDC_FA, 'blocked', 'has_debt', [], []]]);
    expect(r.positions[0].blockers[0].detail).toMatch(/borrows \(AptosCoin\)/);
    expect((await ariesWoundDown.read(context(chain({ loans: [APT_INFO], loanShare: '0' })), OWNER)).positions.map(p => p.status)).toEqual(['recoverable', 'recoverable']);
  });
});

describe('keccak256', () => {
  it('matches the standard vectors, across a block boundary too', () => {
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    expect(hex(keccak256(new Uint8Array()))).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(hex(keccak256(new TextEncoder().encode('abc')))).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    expect(hex(keccak256(new Uint8Array(200).fill(7)))).toBe('4143ef737e81b990c8b604140712d1b0667457ad90b65918a9fa319d00c5b361');
  });
});

describe('wormhole unredeemed', () => {
  afterEach(() => vi.unstubAllGlobals());
  const be = (v: bigint | number, len: number) => Uint8Array.from({ length: len }, (_, i) => Number((BigInt(v) >> BigInt(8 * (len - 1 - i))) & 0xffn));
  const addrBytes = (a: string) => Uint8Array.from(Buffer.from(a.slice(2).padStart(64, '0'), 'hex'));
  // A Portal transfer of 1.5 APT (native to Aptos, chain 22) to `to`, signed by guardian set `set` (no signatures), from
  // emitter 0xe0 on chain 2.
  const vaa = (to: string, set = 7, emitter = '0xe0') => Buffer.from(new Uint8Array([1, ...be(set, 4), 0, ...be(1_700_000_000, 4), ...be(0, 4), ...be(2, 2), ...addrBytes(emitter), ...be(9, 8), 15,
    1, ...be(150_000_000, 32), ...addrBytes('0xa'), ...be(22, 2), ...addrBytes(to), ...be(22, 2), ...be(0, 32)])).toString('base64');
  // Guardian set 6 expires at `expiry6` (the ledger's time is 1,800,000,000); set 4 expired long ago.
  const chain = (consumed = false, expiry6 = 1_700_000_000) => fakeChain({
    resource: (address, type) => type === `${WH_TOKEN_BRIDGE}::state::State` ? { consumed_vaas: { elems: { handle: addr('c1') } }, wrapped_infos: { handle: addr('c2') },
        native_infos: { handle: addr('c3') }, registered_emitters: { handle: addr('c4') } }
      : type === `${WH_CORE}::state::WormholeState` ? { guardian_set_index: { number: '7' }, guardian_sets: { handle: addr('c5') } } : null,
    tableItem: (handle, _k, _v, key) => handle === addr('c1') ? (consumed ? { dummy_field: false } : null)
      : handle === addr('c3') ? { account_address: '0x1', module_name: '0x' + Buffer.from('aptos_coin').toString('hex'), struct_name: '0x' + Buffer.from('AptosCoin').toString('hex') }
      : handle === addr('c5') ? { index: { number: key }, expiration_time: { number: String(key === '6' ? expiry6 : 1_600_000_000) } } : null,
    view: () => ['8'],
    gql: (_q, v) => ({ current_table_items: v.h === addr('c4') && (v.k as { number: string }).number === '2' ? [{ decoded_value: { external_address: addr('e0') } }] : [] }),
  });
  const api = (raw: string[]) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ operations: raw.map((r, i) => ({ id: `2/emitter/${i}`, vaa: { raw: r } })) }))));

  it('decodes a Portal transfer from a VAA', () => {
    const t = portalTransfer(Uint8Array.from(Buffer.from(vaa(OWNER), 'base64')))!;
    expect(t).toMatchObject({ guardianSet: 7, timestamp: 1_700_000_000, emitterChain: 2, emitter: addr('e0'), amount: 150_000_000n, tokenChain: 22, to: OWNER, toChain: 22 });
  });

  it('counts a transfer to the owner that the bridge never consumed, redeemed with its VAA', async () => {
    api([vaa(OWNER), vaa(addr('dd'))]);
    const r = await wormholeUnredeemed.read(context(chain()), OWNER);
    expect(r.complete).toBe(true);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ asset: APT, status: 'recoverable', grossClaim: [{ raw: '150000000' }], positionKind: 'request',
      claimableSince: new Date(1_700_000_000_000).toISOString(), ageBasis: 'onchain_maturity',
      steps: [{ function: `${WH_TOKEN_BRIDGE}::complete_transfer::submit_vaa_and_register_entry<0x1::aptos_coin::AptosCoin>` }] });
    expect(wormholeUnredeemed.thirdParty).toMatch(/Wormholescan/);
  });

  it('skips consumed transfers and messages from an unregistered emitter', async () => {
    api([vaa(OWNER)]);
    expect((await wormholeUnredeemed.read(context(chain(true)), OWNER)).positions).toEqual([]);
    api([vaa(OWNER, 7, '0xe1')]);
    expect((await wormholeUnredeemed.read(context(chain()), OWNER)).positions).toEqual([]);
  });

  it('needs the guardians for a VAA from an expired guardian set, not from one still in its grace period', async () => {
    api([vaa(OWNER, 4)]);
    expect((await wormholeUnredeemed.read(context(chain()), OWNER)).positions[0]).toMatchObject({ status: 'team_gated', expectedPayout: [{ raw: '150000000' }], blockers: [{ code: 'guardian_set_expired' }] });
    api([vaa(OWNER, 6)]);
    expect((await wormholeUnredeemed.read(context(chain()), OWNER)).positions[0].status).toBe('team_gated');
    api([vaa(OWNER, 6)]);
    expect((await wormholeUnredeemed.read(context(chain(false, 1_800_000_100)), OWNER)).positions[0]).toMatchObject({ status: 'recoverable', blockers: [] });
  });

  it('reports a failed lookup as incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const r = await wormholeUnredeemed.read(context(chain()), OWNER);
    expect(r).toMatchObject({ complete: false, positions: [] });
  });
});

describe('echo wound down', () => {
  const [APT_R, USDT_R, XBTC_R] = ['APT', 'lzUSDT', 'xBTC'].map(s => ECHO_RESERVES.find(r => r.symbol === s)!);
  type Opts = { debt?: string; aptCash?: string; held?: string[]; owesUsdt?: string; wrapperHeld?: string };
  // OWNER supplies 1,000 APT units (the reserve: 100 cash for 10,000 owed) and 50 USDT units (cash 500 for 400 owed).
  const chain = (o: Opts = {}) => fakeChain({
    gql: () => ({ current_fungible_asset_balances: [...(o.held ?? [APT_R.aToken, USDT_R.aToken]), ...(o.owesUsdt ? [USDT_R.debtToken] : [])]
      .map((a, i) => ({ asset_type: a, storage_id: addr(`f${i}`), is_primary: true, amount: '1' })) }),
    view: (fn, args) => {
      if (fn.endsWith('::user_logic::get_user_account_data')) return ['5', o.debt ?? '0', '0', '0', '0', '0'];
      if (fn.endsWith('::pool_data_provider::get_user_reserve_data')) return args[0] === APT_R.underlying ? ['1000', '0', '0', '0', true]
        : ['50', o.owesUsdt ?? '0', '0', '0', true];
      // Echo's wrapper account holds the wrapped xBTC (supply 1,000).
      if (fn === '0x1::primary_fungible_store::balance' && args[0] === ECHO_WRAPPER) return [o.wrapperHeld ?? '1000'];
      if (fn === '0x1::coin::supply') return [{ vec: ['1000'] }];
      if (fn === '0x1::primary_fungible_store::balance') return [args[1] === APT_R.underlying ? (o.aptCash ?? '100') : '500'];
      if (fn.endsWith('::pool_data_provider::get_a_token_total_supply')) return [args[0] === APT_R.underlying ? '10000' : '400'];
      throw new Error(fn);
    },
  });

  it('counts a lender\'s pro-rata share of a short reserve as recoverable and the lent-out rest as blocked', async () => {
    const r = await echoWoundDown.read(context(chain()), OWNER);
    expect(r.complete).toBe(true);
    expect(r.positions.map(p => [p.locator, p.grossClaim[0].raw, p.status, p.blockers[0]?.code, p.claimableSince])).toEqual([
      ['APT', '10', 'recoverable', undefined, ECHO_CLOSED_AT], ['APT/lent-out', '990', 'blocked', 'insufficient_cash', ECHO_CLOSED_AT],
      ['lzUSDT', '50', 'recoverable', undefined, ECHO_CLOSED_AT]]);
    // Short: the pro-rata amount; covered: everything (u256 max).
    expect(r.positions[0].steps[0]).toMatchObject({ function: `${ECHO}::router::withdraw_simple<0x1::aptos_coin::AptosCoin>`, arguments: [APT_R.underlying, '10', OWNER, 'false'] });
    expect(r.positions[2].steps[0].arguments[1]).toBe((2n ** 256n - 1n).toString());
    expect(r.positions[1].steps).toEqual([]);
    expect(r.positions[0].asset).toBe(APT);
  });

  it('shows a borrower\'s supply, blocked by its debt and never counted', async () => {
    const r = await echoWoundDown.read(context(chain({ debt: '1', owesUsdt: '1234500' })), OWNER);
    expect(r.positions.map(p => [p.locator, p.grossClaim[0].raw, p.status, p.blockers[0].code, p.expectedPayout, p.steps])).toEqual([
      ['APT', '1000', 'blocked', 'has_debt', [], []], ['lzUSDT', '50', 'blocked', 'has_debt', [], []]]);
    expect(r.positions[0].blockers[0].detail).toMatch(/owes 1\.2345 lzUSDT/);
    const t = sourceTotals(echoWoundDown, r.positions, { [APT]: { usd: 1, decimals: 8, at: '2026-10-24T00:00:00Z', source: 'test' } }, 1_800_000_000);
    expect([t.face.positions, t.byStatus.blocked.positions, t.faceByStatus!.blocked.positions]).toEqual([0, 0, 0]);
  });

  it('pays a wrapper coin as the token it wraps, unwrapped in the withdrawal, while the wrapper holds its supply', async () => {
    const r = await echoWoundDown.read(context(chain({ held: [XBTC_R.aToken] })), OWNER);
    const xbtc = ECHO_WRAPPED[XBTC_R.coin];
    expect(r.positions.map(p => [p.locator, p.asset, p.expectedPayout, p.status])).toEqual([['xBTC', xbtc, [{ asset: xbtc, raw: '50' }], 'recoverable']]);
    expect(r.positions[0].steps[0]).toMatchObject({ function: `${ECHO}::router_fa::withdraw<${XBTC_R.coin}>`,
      arguments: [xbtc, XBTC_R.underlying, (2n ** 256n - 1n).toString(), OWNER, 'false'] });
    // The wrapper short of the supply: not read, rather than valued as a token it cannot be unwrapped into.
    const short = await echoWoundDown.read(context(chain({ held: [XBTC_R.aToken], wrapperHeld: '999' })), OWNER);
    expect(short).toMatchObject({ complete: false, positions: [] });
    expect(short.errors[0]).toMatch(/holds 999 of the 1000 xBTC/);
  });

  it('leaves out Echo\'s own wallets and owners holding no aToken', async () => {
    expect((await echoWoundDown.read(context(chain()), '0x3b9a45c9d5c73e27c48f85a26a3e9b3fcef44af44ddf9e0995bf17390b1d1bb8')).positions).toEqual([]);
    const c = chain({ held: [] });
    expect((await echoWoundDown.read(context(c), OWNER)).positions).toEqual([]);
    expect(c.calls.filter(x => x.startsWith('view'))).toEqual([]);
    // No cash at all: the whole balance is blocked.
    expect((await echoWoundDown.read(context(chain({ aptCash: '0', held: [APT_R.aToken] })), OWNER)).positions.map(p => [p.locator, p.status])).toEqual([['APT/lent-out', 'blocked']]);
  });
});

describe('goblin wiped out', () => {
  // APT-USDC (MasterChef pool 0): 1,000 shares, each owed 2 APT units and 0.5 USDC units (what the vault recorded at the
  // wipe-out); its stores hold `stores` (default 100 APT units, 1,000 USDC units).
  const VAULT = '0x77d56ce63cf4d8c36a60a8a8f29e11ebbf7a1c0e22d6cd069d7f2e950d2fd0bd';
  const WIPED_AT = WIPED_VAULTS.get(VAULT)!.wipedAt;
  type Opts = { wallet?: string; staked?: string; stores?: [string, string]; storeChanged?: string; stakeChanged?: string; named?: boolean };
  const chain = (o: Opts = {}) => fakeChain({
    gql: q => (q.includes('current_fungible_asset_balances')
      ? { current_fungible_asset_balances: o.wallet ? [{ asset_type: VAULT, storage_id: addr('51'), is_primary: true, amount: o.wallet,
        last_transaction_timestamp: o.storeChanged ?? '2026-07-01T00:00:00', last_transaction_version: '1' }] : [] }
      : { user_transactions: o.stakeChanged ? [{ timestamp: o.stakeChanged }] : [] }),
    resource: (address, type) => {
      if (type.endsWith('::vaults::Vault')) return { token_a: { inner: APT }, token_b: { inner: USDC }, total_shares: '1000' };
      // The closed position held 0.1 APT units and 0.4 USDC units per share.
      if (type.endsWith('::vaults::ClearOut')) return { token_a_store: { inner: addr('5a') }, token_b_store: { inner: addr('5b') },
        position_amount_a: '100', position_amount_b: '400', name_list: o.named ? [OWNER] : [addr('99')] };
      if (type.endsWith('::masterchef::PoolUserInfo')) return o.staked && address === OWNER ? {} : null;
      throw new Error(type);
    },
    view: (fn, args) => {
      if (fn === '0x1::primary_fungible_store::balance') return [o.wallet ?? '0'];
      if (fn === '0x1::fungible_asset::balance') return [args[0] === addr('5a') ? (o.stores?.[0] ?? '100') : (o.stores?.[1] ?? '1000')];
      if (fn.endsWith('::vaults::get_token_amount_by_share')) return [String(BigInt(args[1] as string) * 2n), String(BigInt(args[1] as string) / 2n)];
      if (fn.endsWith('::masterchef::get_user_info')) {
        if (args[0] === '0') return [o.staked, '0'];
        throw new Error(`Move abort in ${GOBLIN_CHEF}::masterchef: ERROR_POOL_USER_INFO_NOT_EXIST(0x60006)`);
      }
      throw new Error(fn);
    },
  });
  const rows = (ps: Awaited<ReturnType<typeof goblinWipedOut.read>>['positions']) => ps.map(p => [p.locator.replace(VAULT, 'V'), p.status, p.asset, p.grossClaim[0].raw, p.claimableSince]);

  it('counts each holder for its pro-rata share of a short store, blocks the rest, and withdraws as many shares as the store covers', async () => {
    // 100 shares are owed 200 APT units and 50 USDC units; their pro-rata share of the stores is 10 APT and 100 USDC.
    const r = await goblinWipedOut.read(context(chain({ wallet: '100', storeChanged: '2026-09-01T00:00:00' })), OWNER);
    expect(r.complete).toBe(true);
    // The store changed after the wipe-out (a partial withdrawal): aged from that change.
    expect(rows(r.positions)).toEqual([
      ['V', 'recoverable', APT, '10', '2026-09-01T00:00:00.000Z'], ['V', 'recoverable', USDC, '50', '2026-09-01T00:00:00.000Z'],
      ['V/store-short', 'blocked', APT, '190', '2026-09-01T00:00:00.000Z']]);
    expect(r.positions[2].blockers[0].code).toBe('store_short');
    // The APT store covers 50 of the 100 shares, which pay their full claim; listed once for both tokens.
    expect(r.positions[0].steps).toEqual([{ function: `${GOBLIN_VAULTS}::vaults::remove_as_pair`, arguments: [VAULT, '50'], prerequisites: [],
      expectedOutputs: [{ asset: APT, raw: '100' }, { asset: USDC, raw: '25' }] }]);
    expect(r.positions[1].steps).toEqual([]);
  });

  it('reads shares staked in the MasterChef, unstaked first, aged from the wipe-out when no later MasterChef call', async () => {
    const r = await goblinWipedOut.read(context(chain({ staked: '20', stakeChanged: '2026-08-01T00:00:00' })), OWNER);
    expect(rows(r.positions)).toEqual([
      ['V/staked', 'recoverable', APT, '2', WIPED_AT], ['V/staked', 'recoverable', USDC, '10', WIPED_AT], ['V/staked/store-short', 'blocked', APT, '38', WIPED_AT]]);
    expect(r.positions[0].steps.map(s => [s.function, s.arguments])).toEqual([
      [`${GOBLIN_CHEF}::masterchef::withdraw`, ['0', '20']], [`${GOBLIN_VAULTS}::vaults::remove_as_pair`, [VAULT, '20']]]);
  });

  it('counts the whole claim where the store covers it, and nothing where a token\'s store is empty', async () => {
    const covered = await goblinWipedOut.read(context(chain({ wallet: '100', stores: ['100000', '100000'] })), OWNER);
    expect(rows(covered.positions)).toEqual([['V', 'recoverable', APT, '200', WIPED_AT], ['V', 'recoverable', USDC, '50', WIPED_AT]]);
    expect(covered.positions[0].steps[0].arguments).toEqual([VAULT, '100']);
    const empty = await goblinWipedOut.read(context(chain({ wallet: '100', stores: ['0', '1000'] })), OWNER);
    expect(rows(empty.positions)).toEqual([['V/store-short', 'blocked', APT, '200', WIPED_AT], ['V/store-short', 'blocked', USDC, '50', WIPED_AT]]);
  });

  it('pays an account on the vault\'s name list at the closed position\'s amounts', async () => {
    const r = await goblinWipedOut.read(context(chain({ wallet: '100', named: true })), OWNER);
    // 100 shares of the position's 100 APT and 400 USDC units: 10 and 40, within the stores' pro-rata shares (10, 100).
    expect(rows(r.positions)).toEqual([['V', 'recoverable', APT, '10', WIPED_AT], ['V', 'recoverable', USDC, '40', WIPED_AT]]);
    expect(r.positions[0].steps[0]).toMatchObject({ arguments: [VAULT, '100'], expectedOutputs: [{ asset: APT, raw: '10' }, { asset: USDC, raw: '40' }] });
  });

  it('leaves out the MasterChef\'s own account and reads nothing more for an owner without shares', async () => {
    expect((await goblinWipedOut.read(context(chain({ wallet: '100' })), GOBLIN_CHEF_ACCOUNT)).positions).toEqual([]);
    const c = chain();
    expect((await goblinWipedOut.read(context(c), OWNER)).positions).toEqual([]);
    expect(c.calls.filter(x => x.startsWith('view'))).toEqual([]);
  });
});
