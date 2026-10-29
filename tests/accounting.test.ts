import { describe, expect, it } from 'vitest';
import { ageDays, assertUniqueIds, debtBlocker, freshPrices, positionIds, sourceTotals, UNPRICED_LIMIT, unpricedAssets, usd, type PriceBook } from '../src/shared/accounting.ts';
import { APT } from '../src/shared/sources/delegation.ts';
import type { AgeBasis, Position, Status } from '../src/shared/types.ts';
import { addr } from './fake-chain.ts';

const NOW = 1_800_000_000;
const DAY = 86_400;
const prices: PriceBook = { [APT]: { usd: 2, decimals: 8, at: '2026-10-18T00:00:00Z', source: 'test' } };

function pos(over: { owner?: string; locator?: string; apt?: number; days?: number | null; basis?: AgeBasis; status?: Status; asset?: string }): Position {
  const owner = over.owner ?? addr(1), locator = over.locator ?? 'pool/inactive';
  const amount = [{ asset: over.asset ?? APT, raw: String(Math.round((over.apt ?? 1) * 1e8)) }];
  return {
    ...positionIds('s', owner, locator, 'principal'), source: 's', owner, locator, positionKind: 'principal',
    claimableSince: over.days == null ? undefined : new Date((NOW - over.days * DAY) * 1000).toISOString(),
    ageBasis: over.basis ?? (over.days == null ? 'unknown' : 'onchain_maturity'),
    provenance: { reader: 'test', ledgerVersion: '1' }, grossClaim: amount, expectedPayout: amount, payoutBasis: 'view',
    status: over.status ?? 'recoverable', blockers: [], confidence: 'verified_view', observedAt: '2026-10-18T00:00:00Z', steps: [],
  };
}

const source = { headlineAgeBases: ['onchain_maturity', 'protocol_closure'] as AgeBasis[] };

describe('position ids', () => {
  it('keep principal, fees and per-asset rewards on one locator distinct', () => {
    const ids = [
      positionIds('s', addr(1), 'x', 'principal'), positionIds('s', addr(1), 'x', 'fees'),
      positionIds('s', addr(1), 'x', 'reward', 'a'), positionIds('s', addr(1), 'x', 'reward', 'b'),
    ];
    expect(new Set(ids.map(i => i.id)).size).toBe(4);
    expect(new Set(ids.map(i => i.parentId)).size).toBe(1);
  });

  it('reject duplicates in totals', () => {
    expect(() => assertUniqueIds([pos({}), pos({})])).toThrow(/Duplicate/);
  });
});

describe('aging', () => {
  it('has no age without a basis', () => {
    expect(ageDays(pos({ days: null }), NOW)).toBeNull();
  });

  it('buckets are cumulative and only count headline-eligible bases', () => {
    const t = sourceTotals(source, [
      pos({ locator: 'a', days: 200 }),
      pos({ locator: 'b', days: 100 }),
      pos({ locator: 'c', days: 40 }),
      pos({ locator: 'd', days: 400, basis: 'position_interaction' }),
      pos({ locator: 'e', days: null }),
    ], prices, NOW);
    expect(t.aged.ge30.positions).toBe(3);
    expect(t.aged.ge90.positions).toBe(2);
    expect(t.aged.ge180.positions).toBe(1);
    expect(t.headline.positions).toBe(2);
    expect(t.agedEstimated.ge90.positions).toBe(1);
    expect(t.byAgeBasis.unknown.positions).toBe(1);
  });

  it('keeps blocked and team-gated value out of the headline', () => {
    const t = sourceTotals(source, [
      pos({ locator: 'a', days: 200, status: 'blocked' }),
      pos({ locator: 'b', days: 200, status: 'team_gated' }),
    ], prices, NOW);
    expect(t.headline.usd).toBe(0);
    expect(t.face.usd).toBe(4);
    expect(t.byStatus.blocked.positions).toBe(1);
  });
});

describe('verification', () => {
  it('keeps indexer-only positions out of every total and reports them apart', () => {
    const unverified = { ...pos({ locator: 'b', days: 200 }), confidence: 'indexer_only' as const };
    const t = sourceTotals(source, [pos({ locator: 'a', days: 200 }), unverified], prices, NOW);
    expect(t.headline.positions).toBe(1);
    expect(t.byStatus.recoverable.positions).toBe(1);
    expect(t.face.positions).toBe(1);
    expect(t.unverified.positions).toBe(1);
  });
});

describe('blocked and borrowers', () => {
  it('values blocked positions at what they are owed, and keeps a borrower\'s supply out of every total', () => {
    const blocked = { ...pos({ locator: 'b', apt: 3, days: 200, status: 'blocked' }), expectedPayout: [] };
    const borrower = { ...pos({ locator: 'c', apt: 5, days: 200, status: 'blocked' }), expectedPayout: [], blockers: [debtBlocker('owes 1 APT')] };
    const t = sourceTotals(source, [pos({ locator: 'a', days: 200 }), blocked, borrower], prices, NOW);
    expect(t.byStatus.blocked).toMatchObject({ positions: 1, usd: 0 });
    expect(t.faceByStatus!.blocked).toMatchObject({ positions: 1, usd: 6 });
    expect(t.face).toMatchObject({ positions: 2, usd: 8 });
    expect(t.headline.positions).toBe(1);
  });
});

describe('usd', () => {
  it('counts unpriced value separately, never as zero', () => {
    expect(usd([{ asset: 'unknown', raw: '1' }], prices)).toBeNull();
    const t = sourceTotals(source, [pos({ locator: 'a', days: 200, asset: 'unknown' })], prices, NOW);
    expect(t.headline.unpriced).toBe(1);
    expect(t.headline.usd).toBe(0);
  });

  it('reports the largest wallet\'s share of the headline', () => {
    const t = sourceTotals(source, [
      pos({ owner: addr(1), locator: 'a', apt: 3, days: 200 }),
      pos({ owner: addr(2), locator: 'a', apt: 1, days: 200 }),
    ], prices, NOW);
    expect(t.headlineTopOwnerShare).toBe(0.75);
  });

  it('counts owners per source with the $10 floor', () => {
    const t = sourceTotals(source, [
      pos({ owner: addr(1), locator: 'a', apt: 3, days: 200 }),
      pos({ owner: addr(1), locator: 'b', apt: 3, days: 200 }),
      pos({ owner: addr(2), locator: 'a', apt: 1, days: 200 }),
    ], prices, NOW);
    expect(t.headline.owners).toBe(2);
    expect(t.headline.ownersMin10).toBe(1);
  });
});

describe('freshPrices', () => {
  it('drops quotes older than 7 days, so stale assets read as unpriced', () => {
    const now = Date.parse('2026-10-20T00:00:00Z') / 1000;
    const prices = { a: { usd: 1, decimals: 8, at: '2026-10-15T00:00:00Z', source: 't' }, b: { usd: 2, decimals: 8, at: '2026-10-01T00:00:00Z', source: 't' } };
    expect(Object.keys(freshPrices(prices, now))).toEqual(['a']);
  });
});


describe('unpriced assets', () => {
  it('lists, per asset and status, what counted positions hold without a price: payouts when claimable, what is owed otherwise', () => {
    const MKL = '0xmkl', LP = 'movement:0xlp';
    const blocked = { ...pos({ owner: addr(3), locator: 'b', asset: LP, apt: 5, status: 'blocked' }), expectedPayout: [] };
    const positions = [
      pos({ owner: addr(1), locator: 'a', asset: MKL, apt: 2 }), pos({ owner: addr(1), locator: 'c', asset: MKL, apt: 1 }),
      pos({ owner: addr(2), locator: 'a', asset: MKL, apt: 4 }), pos({ owner: addr(2), locator: 'd' }), blocked,
      // Never counted: a borrower's supply, and an indexer-only row.
      { ...pos({ owner: addr(4), locator: 'e', asset: MKL }), blockers: [debtBlocker('owes')] },
      { ...pos({ owner: addr(5), locator: 'f', asset: MKL }), confidence: 'indexer_only' as const },
    ];
    expect(unpricedAssets(positions, prices)).toEqual({ more: 0, assets: [
      { asset: MKL, status: 'recoverable', raw: '700000000', positions: 3, owners: 2 },
      { asset: LP, status: 'blocked', raw: '500000000', positions: 1, owners: 1 },
    ] });
    // Beyond the limit, the assets with the fewest positions are only counted.
    const many = Array.from({ length: UNPRICED_LIMIT + 3 }, (_, i) => pos({ owner: addr(1), locator: `m${i}`, asset: `0xa${i}` }));
    expect(unpricedAssets(many, prices).more).toBe(3);
  });
});
