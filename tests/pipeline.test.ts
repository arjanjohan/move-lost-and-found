import { OWNER_RULES } from '../src/shared/owners.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestCapReached } from '../src/node/client.ts';
import { SOURCES } from '../src/shared/sources/index.ts';
import { ENUMERATORS } from '../src/node/enumerators.ts';
import { amnisWithdrawalsEnumerator, echoWoundDownEnumerator, goblinWipedOutEnumerator } from '../src/node/enumerators.ts';
import { GOBLIN_CHEF, GOBLIN_CHEF_ACCOUNT, WIPED_VAULTS } from '../src/shared/sources/goblin-wiped-out.ts';
import { aaveFrozenEnumerator, animeswapClosedEnumerator, canopyFrozenEnumerator, movepositionWoundDownEnumerator, earniumClosedEnumerator, houstonClosedEnumerator, auroClosedEnumerator, econiaIdleEnumerator, type Enumerator } from '../src/node/enumerators.ts';
import { ANIMESWAP_POOLS } from '../src/shared/sources/animeswap-closed.ts';
import { CANOPY_REWARDS_STATE } from '../src/shared/sources/canopy-rewards.ts';
import { fetchPrices } from '../src/node/prices.ts';
import { keepPrevious, reclassifiedUnder, runOrder, runSource } from '../src/node/snapshot.ts';
import { State } from '../src/node/state.ts';
import { positionIds } from '../src/shared/accounting.ts';
import { AAVE, AAVE_UNFROZEN_AT } from '../src/shared/sources/aave-frozen.ts';
import { STAPT, STHAPT } from '../src/shared/sources/echelon-frozen.ts';
import { STKAPT } from '../src/shared/sources/kofi-receipts.ts';
import type { ChainReader, Position, ReadResult, SourceDef } from '../src/shared/types.ts';
import { MOVEPOSITION } from '../src/shared/sources/moveposition-wound-down.ts';
import { addr, fakeChain } from './fake-chain.ts';

const freshWatermark = () => ({ processor_status: [{ last_success_version: 99, last_transaction_timestamp: new Date().toISOString().slice(0, -1) }] });

function position(owner: string, raw = '100'): Position {
  const amount = [{ asset: 'apt', raw }];
  return { ...positionIds('t', owner, 'x', 'principal'), source: 't', owner, locator: 'x', positionKind: 'principal', ageBasis: 'unknown',
    provenance: { reader: 'test', ledgerVersion: '1' }, grossClaim: amount, expectedPayout: amount, payoutBasis: 'view',
    status: 'recoverable', blockers: [], confidence: 'verified_view', observedAt: '2026-10-18T00:00:00Z', steps: [] };
}

function source(read: (owner: string) => Promise<ReadResult>): SourceDef {
  return { id: 't', chain: 'aptos', protocol: 'Test', title: '', summary: '', category: 'staking', inclusionRule: '', howTo: [],
    protocolStatus: { state: 'live', evidence: '', checkedAt: '' }, refresh: { nonZero: 'every_run', zero: 'weekly' },
    headlineAgeBases: ['onchain_maturity'], read: (_ctx, owner) => read(owner) };
}

const enumerator = (owners: string[], fail = false): Enumerator => ({
  sourceId: 't', processor: 'p', scope: 'test',
  run: async () => { if (fail) throw new Error('indexer 503'); return { candidates: owners.map(owner => ({ owner })), pages: 1 }; },
});

const chain = (watermark: (q: string, v: Record<string, unknown>) => unknown = freshWatermark, authKey?: string): ChainReader => fakeChain({
  gql: (q, v) => watermark(q, v),
  resource: () => null,
  account: (address: string) => ({ authentication_key: authKey ?? address, sequence_number: '1' }),
});

describe('runSource', () => {
  it('reports an indexer failure mid-enumeration as degraded', async () => {
    const { run } = await runSource(source(async () => { throw new Error('unreachable'); }), enumerator([], true), new State(':memory:'), chain(), { hit: false });
    expect(run.degradedReasons.join()).toMatch(/run failed: Error: indexer 503/);
  });

  it('reports a lagging indexer watermark as degraded', async () => {
    const stale = () => ({ processor_status: [{ last_success_version: 1, last_transaction_timestamp: '2026-01-01T00:00:00' }] });
    const { run } = await runSource(source(async () => ({ positions: [], complete: true, errors: [], ledgerVersion: '1' })),
      enumerator([addr(1)]), new State(':memory:'), chain(stale), { hit: false });
    expect(run.degradedReasons.join()).toMatch(/behind/);
  });

  it('reports a lagging second processor the enumeration reads as degraded', async () => {
    const mixed = (_q: string, v: Record<string, unknown>) => ({ processor_status: [{ last_success_version: 1,
      last_transaction_timestamp: v?.p === 'q' ? '2026-01-01T00:00:00' : new Date().toISOString().slice(0, -1) }] });
    const { run } = await runSource(source(async () => ({ positions: [], complete: true, errors: [], ledgerVersion: '1' })),
      { ...enumerator([addr(1)]), alsoProcessors: ['q'] }, new State(':memory:'), chain(mixed), { hit: false });
    expect(run.degradedReasons).toEqual([expect.stringMatching(/^indexer q is \d+ min behind$/)]);
  });

  it('keeps previous positions when a revalidation read is incomplete', async () => {
    const state = new State(':memory:');
    const owner = addr(1);
    await runSource(source(async o => ({ positions: [position(o)], complete: true, errors: [], ledgerVersion: '1' })), enumerator([owner]), state, chain(), { hit: false });
    const { run } = await runSource(source(async () => ({ positions: [], complete: false, errors: ['view failed'], ledgerVersion: '2' })),
      enumerator([owner]), state, chain(), { hit: false });
    expect(state.positionsOf('t').map(p => p.owner)).toEqual([owner]);
    expect(run.verification.incomplete).toBe(1);
    expect(run.degradedReasons.join()).toMatch(/incompletely/);
  });

  it('stops at the request cap even when the source catches the reader error', async () => {
    const capHit = { hit: false };
    let reads = 0;
    const capped: ChainReader = { ...chain(), view: async () => { throw new RequestCapReached('cap'); } };
    const def: SourceDef = { ...source(async () => ({ positions: [], complete: true, errors: [], ledgerVersion: '1' })),
      read: async (ctx, owner) => {
        reads++;
        try { await ctx.chain.view('0x1::a::b', [owner]); return { positions: [], complete: true, errors: [], ledgerVersion: '1' }; }
        catch (err) { return { positions: [], complete: false, errors: [String(err)], ledgerVersion: '1' }; }
      } };
    const { run } = await runSource(def, enumerator([addr(1), addr(2), addr(3), addr(4), addr(5), addr(6), addr(7), addr(8), addr(9), addr('a1')]), new State(':memory:'), capped, capHit);
    expect(capHit.hit).toBe(true);
    expect(reads).toBeLessThan(10);
    expect(run.degradedReasons.join()).toMatch(/request cap/);
  });

  it('stops at the request cap and says so', async () => {
    const capHit = { hit: false };
    const { run } = await runSource(source(async () => { throw new RequestCapReached('cap'); }), enumerator([addr(1), addr(2)]),
      new State(':memory:'), chain(), capHit);
    expect(capHit.hit).toBe(true);
    expect(run.degradedReasons.join()).toMatch(/request cap/);
  });
});

describe('run order', () => {
  it('runs the named source first, then sources with nothing read yet, then the rest in their usual order', () => {
    const sources = ['a', 'b', 'c', 'd'].map(id => ({ id }));
    const known = (id: string) => id !== 'c';
    expect(runOrder(sources, undefined, known).map(s => s.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(runOrder(sources, 'd', known).map(s => s.id)).toEqual(['d', 'c', 'a', 'b']);
  });
});

describe('market evidence', () => {
  it('re-runs a market-dependent source in a single-source run once its quotes have expired', () => {
    const now = Date.parse('2026-10-20T00:00:00Z') / 1000;
    const kofi = { ...source(async () => { throw new Error(); }), id: 'k', usesMarketQuotes: true } as SourceDef;
    const plain = { ...source(async () => { throw new Error(); }), id: 'p' } as SourceDef;
    const prev = { run: { verification: { end: '2026-10-19T00:00:00Z' } }, ownerRules: OWNER_RULES } as any;
    const quotes = (...at: string[]) => ({ kapt: Object.fromEntries(at.map((t, i) => [String(i), { verdict: 'usable' as const, quotedAt: t }])) });
    expect(keepPrevious(plain, prev, 'x', now)).toBe(true);
    // Classified under an older owner rule (or before it was recorded): re-run, not copied.
    expect(keepPrevious(plain, { ...prev, ownerRules: OWNER_RULES - 1 }, 'x', now)).toBe(false);
    expect(keepPrevious(plain, { ...prev, ownerRules: undefined }, 'x', now)).toBe(false);
    expect(keepPrevious(kofi, prev, 'x', now, quotes('2026-10-18T00:00:00Z', '2026-10-17T00:00:00Z'))).toBe(true);
    // The run ended recently, but one quote it relied on is older than 7 days: decided by the quote, not the run.
    expect(keepPrevious(kofi, prev, 'x', now, quotes('2026-10-18T00:00:00Z', '2026-10-12T00:00:00Z'))).toBe(false);
    expect(keepPrevious(kofi, prev, 'x', now, {})).toBe(false);
    expect(keepPrevious(kofi, undefined, 'x', now, quotes('2026-10-18T00:00:00Z'))).toBe(false);
  });

  it('reports a run whose receipt positions have no market quote as degraded', async () => {
    const blocked: Position = { ...position(addr(1)), status: 'unknown', blockers: [{ code: 'market_check_unavailable', detail: '' }] };
    const { run } = await runSource(source(async () => ({ positions: [blocked], complete: true, errors: [], ledgerVersion: '1' })),
      enumerator([addr(1)]), new State(':memory:'), chain(), { hit: false });
    expect(run.degradedReasons.join()).toMatch(/without market evidence/);
  });
});

describe('owner rule', () => {
  it('keeps positions held by a resource account visible, as contract-held', async () => {
    const state = new State(':memory:');
    await runSource(source(async o => ({ positions: [position(o)], complete: true, errors: [], ledgerVersion: '1' })),
      enumerator([addr(1)]), state, chain(freshWatermark, '0x' + '0'.repeat(64)), { hit: false });
    const [p] = state.positionsOf('t');
    expect(p.status).toBe('contract_held');
    expect(p.blockers.map(b => b.code)).toEqual(['unsupported_owner']);
  });

  it('leaves positions held by an ordinary account unchanged', async () => {
    const state = new State(':memory:');
    await runSource(source(async o => ({ positions: [position(o)], complete: true, errors: [], ledgerVersion: '1' })),
      enumerator([addr('b1')]), state, chain(), { hit: false });
    expect(state.positionsOf('t')[0].status).toBe('recoverable');
  });
});

describe('state', () => {
  it('re-reads non-zero owners every run and zero owners weekly', () => {
    const state = new State(':memory:');
    const def = source(async () => { throw new Error(); });
    state.upsertCandidates('t', [{ owner: addr(1) }, { owner: addr(2) }, { owner: addr(3) }], '2026-10-01T00:00:00Z');
    const now = new Date().toISOString();
    state.recordRead('t', addr(1), [position(addr(1))], true, now);
    state.recordRead('t', addr(2), [], true, now);
    const due = state.due(def, Date.now(), new Set()).map(d => d.owner);
    expect(due).toContain(addr(1));      // non-zero
    expect(due).not.toContain(addr(2));  // zero, read just now
    expect(due).toContain(addr(3));      // never read
  });

  it('never re-reads a zero owner of a never-refresh source unless the enumerator reports it', () => {
    const state = new State(':memory:');
    const def = { ...source(async () => { throw new Error(); }), refresh: { nonZero: 'monthly', zero: 'never' } } as SourceDef;
    state.upsertCandidates('t', [{ owner: addr(1) }], '2026-01-01T00:00:00Z');
    state.recordRead('t', addr(1), [], true, '2026-01-01T00:00:00Z');
    expect(state.due(def, Date.parse('2027-01-01T00:00:00Z'), new Set())).toEqual([]);
    state.upsertCandidates('t', [{ owner: addr(1) }], '2027-01-01T00:00:00Z', true);
    expect(state.due(def, Date.parse('2027-01-01T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(1)]);
  });

  it('spreads monthly re-reads over four weekly runs and reads everyone within 35 days', () => {
    const state = new State(':memory:');
    const def = { ...source(async () => { throw new Error(); }), refresh: { nonZero: 'monthly', zero: 'monthly' } } as SourceDef;
    const owners = Array.from({ length: 64 }, (_, i) => addr((0xb00 + i).toString(16)));
    const readAt = Date.parse('2026-10-05T03:00:00Z');
    state.upsertCandidates('t', owners.map(owner => ({ owner })), new Date(readAt).toISOString());
    for (const o of owners) state.recordRead('t', o, [position(o)], true, new Date(readAt).toISOString());
    const dueAt = (days: number) => state.due(def, readAt + days * 86_400_000, new Set()).map(d => d.owner);
    expect(dueAt(14)).toEqual([]);
    const weeks = [21, 28, 35].map(d => dueAt(d).length);
    expect(weeks[0]).toBeGreaterThan(0);
    expect(weeks[0]).toBeLessThan(owners.length);
    expect(dueAt(35).length).toBe(owners.length);
  });
});

describe('state changes', () => {
  const def = () => source(async () => { throw new Error(); });

  it('makes an owner with positions due when a full scan no longer returns it', async () => {
    const state = new State(':memory:');
    const monthly = { ...def(), refresh: { nonZero: 'monthly', zero: 'monthly' } } as SourceDef;
    state.upsertCandidates('t', [{ owner: addr(1) }, { owner: addr(2) }], '2026-10-01T00:00:00Z');
    state.recordRead('t', addr(1), [position(addr(1))], true, '2026-10-01T00:00:01Z');
    state.recordRead('t', addr(2), [position(addr(2))], true, '2026-10-01T00:00:01Z');
    expect(state.due(monthly, Date.parse('2026-10-02T00:00:00Z'), new Set())).toEqual([]);
    state.markGone('t', new Set([addr(1)]), '2026-10-02T00:00:00Z');
    expect(state.due(monthly, Date.parse('2026-10-02T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(2)]);
  });

  it('makes a zero owner due again when an activity scan returns it', () => {
    const state = new State(':memory:');
    state.upsertCandidates('t', [{ owner: addr(1) }], '2026-10-01T00:00:00Z');
    state.recordRead('t', addr(1), [], true, '2026-10-01T00:00:01Z');
    expect(state.due(def(), Date.parse('2026-10-02T00:00:00Z'), new Set())).toEqual([]);
    state.upsertCandidates('t', [{ owner: addr(1) }], '2026-10-02T00:00:00Z', true);
    expect(state.due(def(), Date.parse('2026-10-02T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(1)]);
  });

  it('makes an owner due when its hint changes, and not when it stays the same', () => {
    const state = new State(':memory:');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { version: 1 } }], '2026-10-01T00:00:00Z');
    state.recordRead('t', addr(1), [], true, '2026-10-01T00:00:01Z');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { version: 1 } }], '2026-10-02T00:00:00Z');
    expect(state.due(def(), Date.parse('2026-10-02T00:00:00Z'), new Set())).toEqual([]);
    state.upsertCandidates('t', [{ owner: addr(1), hint: { version: 2 } }], '2026-10-03T00:00:00Z');
    expect(state.due(def(), Date.parse('2026-10-03T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(1)]);
  });

  it('does not count a new scan watermark in a hint as a change', () => {
    const state = new State(':memory:');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { lps: { a: 'x' }, w: '10' } }], '2026-10-01T00:00:00Z');
    state.recordRead('t', addr(1), [], true, '2026-10-01T00:00:01Z');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { lps: { a: 'x' }, w: '20' } }], '2026-10-02T00:00:00Z');
    expect(state.due(def(), Date.parse('2026-10-02T00:00:00Z'), new Set())).toEqual([]);
    state.upsertCandidates('t', [{ owner: addr(1), hint: { lps: { a: 'y' }, w: '30' } }], '2026-10-03T00:00:00Z');
    expect(state.due(def(), Date.parse('2026-10-03T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(1)]);
  });

  it('re-reads an owner whose age was unknown when the scan watermark advances', () => {
    const state = new State(':memory:');
    const position = (ageBasis: string) => ({ id: `t:${addr(1)}:x:principal`, ageBasis } as unknown as Position);
    const monthly = { ...def(), refresh: { nonZero: 'monthly', zero: 'monthly' } } as SourceDef;
    state.upsertCandidates('t', [{ owner: addr(1), hint: { lps: { a: 'x' }, w: '10' } }], '2026-10-01T00:00:00Z');
    state.recordRead('t', addr(1), [position('unknown')], true, '2026-10-01T00:00:01Z');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { lps: { a: 'x' }, w: '10' } }], '2026-10-02T00:00:00Z');
    expect(state.due(monthly, Date.parse('2026-10-02T00:00:00Z'), new Set())).toEqual([]);
    state.upsertCandidates('t', [{ owner: addr(1), hint: { lps: { a: 'x' }, w: '20' } }], '2026-10-03T00:00:00Z');
    expect(state.due(monthly, Date.parse('2026-10-03T00:00:00Z'), new Set()).map(d => d.owner)).toEqual([addr(1)]);
    // Dated now: the next watermark is not a change.
    state.recordRead('t', addr(1), [position('protocol_closure')], true, '2026-10-03T00:00:01Z');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { lps: { a: 'x' }, w: '30' } }], '2026-10-04T00:00:00Z');
    expect(state.due(monthly, Date.parse('2026-10-04T00:00:00Z'), new Set())).toEqual([]);
  });

  it('merges an incremental hint into the stored one and reads with it', () => {
    const state = new State(':memory:');
    state.upsertCandidates('t', [{ owner: addr(1), hint: { versions: { a: 1 } } }, { owner: addr(2), hint: { versions: { a: 5 } } }], '2026-10-01T00:00:00Z', true);
    state.upsertCandidates('t', [{ owner: addr(1), hint: { versions: { b: 2 } } }], '2026-10-02T00:00:00Z', true);
    const due = state.due(def(), Date.parse('2026-10-02T00:00:00Z'), new Set([addr(1)]), true);
    expect(due.find(d => d.owner === addr(1))?.hint).toEqual({ versions: { a: 1, b: 2 } });
    expect(due.find(d => d.owner === addr(2))?.hint).toEqual({ versions: { a: 5 } });
  });

  it('adds the changed_at column to a state file written before it existed', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'state-')), 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec('create table candidates (source text, owner text, hint text, first_seen text, last_read_at text, last_nonzero integer, last_complete integer, primary key (source, owner))');
    old.close();
    const state = new State(path);
    state.upsertCandidates('t', [{ owner: addr(1) }], '2026-10-01T00:00:00Z');
    expect(state.candidateCount('t')).toBe(1);
  });
});

describe('prices', () => {
  afterEach(() => vi.unstubAllGlobals());
  // stAPT: 1.2171 amAPT each; sthAPT: 1.25 thAPT each, less a 0.15% unstake fee; stkAPT: 1.04 kAPT each, less a 0.5% fee.
  const rates = (fail: false | 'all' | 'thala' = false) => fakeChain({ view: (fn) => {
    if (fail === 'all' || (fail === 'thala' && fn.includes('::staking::'))) throw new Error('view: HTTP 500');
    if (fn.endsWith('::stapt_price')) return ['121710000'];
    if (fn.endsWith('::thAPT_sthAPT_exchange_rate')) return ['125', '100'];
    if (fn.endsWith('::unstake_APT_fee_bps')) return ['15'];
    if (fn.endsWith('::rewards_manager::get_exchange_rate')) return ['104000000'];
    if (fn.endsWith('::config::get_withdrawal_fee')) return ['50'];
    throw new Error(fn);
  } });

  it('returns no price, with an error, when the provider is down', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNRESET'); });
    const { prices, errors } = await fetchPrices(1_800_000_000, rates());
    expect(prices).toEqual({});
    expect(errors[0]).toMatch(/coingecko/);
  });

  it('refuses a quote older than 7 days', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ aptos: { usd: 1, last_updated_at: 1_800_000_000 - 8 * 86_400 } })));
    const { prices, errors } = await fetchPrices(1_800_000_000, rates());
    expect(prices).toEqual({});
    expect(errors[0]).toMatch(/older than 7 days/);
  });

  it('values stAPT, sthAPT and stkAPT at redemption from on-chain rates and the APT quote, dated like that quote', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ aptos: { usd: 2, last_updated_at: 1_800_000_000 - 60 } })));
    const { prices } = await fetchPrices(1_800_000_000, rates());
    const at = new Date((1_800_000_000 - 60) * 1000).toISOString();
    expect(prices[STAPT]).toMatchObject({ decimals: 8, at, source: expect.stringMatching(/^derived/) });
    expect(prices[STAPT].usd).toBeCloseTo(2 * 1.2171);
    expect(prices[STHAPT].usd).toBeCloseTo(2 * 1.25 * 0.9985);
    expect(prices[STKAPT].usd).toBeCloseTo(2 * 1.04 * 0.995);
    // A failed rate read leaves that receipt unpriced, with an error, and the other priced; no APT quote means nothing
    // to derive from.
    const failed = await fetchPrices(1_800_000_000, rates('all'));
    expect(failed.prices[STAPT]).toBeUndefined();
    expect(failed.errors).toContainEqual(expect.stringMatching(/stAPT redemption rate/));
    const thala = await fetchPrices(1_800_000_000, rates('thala'));
    expect(thala.prices[STHAPT]).toBeUndefined();
    expect(thala.prices[STAPT].usd).toBeCloseTo(2 * 1.2171);
    expect(thala.errors.filter(e => /redemption/.test(e))).toEqual([expect.stringMatching(/^sthAPT redemption rate/)]);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({})));
    expect((await fetchPrices(1_800_000_000, rates())).prices).toEqual({});
  });
});

describe('source version', () => {
  it('re-reads every candidate when a source\'s rules change', async () => {
    const state = new State(':memory:');
    const owner = addr(1);
    let reads = 0;
    const read = async (o: string) => { reads++; return { positions: [position(o)], complete: true, errors: [], ledgerVersion: '1' }; };
    const def = { ...source(read), refresh: { nonZero: 'monthly' as const, zero: 'monthly' as const } };
    await runSource(def, enumerator([owner]), state, chain(), { hit: false });
    await runSource(def, enumerator([owner]), state, chain(), { hit: false });
    expect(reads).toBe(1);                              // monthly: not due again
    await runSource({ ...def, version: 2 }, enumerator([owner]), state, chain(), { hit: false });
    expect(reads).toBe(2);                              // new rules: due at once
  });

  it('re-reads every owner with positions, and only those, when the owner rule changes', async () => {
    const state = new State(':memory:');
    const [held, empty] = [addr(1), addr(2)];
    const reads: string[] = [];
    const read = async (o: string) => { reads.push(o); return { positions: o === held ? [position(o)] : [], complete: true, errors: [], ledgerVersion: '1' }; };
    const def = { ...source(read), refresh: { nonZero: 'monthly' as const, zero: 'monthly' as const } };
    await runSource(def, enumerator([held, empty]), state, chain(), { hit: false });
    await runSource(def, enumerator([held, empty]), state, chain(), { hit: false });
    expect(reads.sort()).toEqual([held, empty].sort());  // monthly: each read once
    // A state written under the previous owner rule.
    state.setCursor(`owner-rules:${def.id}`, String(OWNER_RULES - 1));
    await runSource(def, enumerator([held, empty]), state, chain(), { hit: false });
    expect(reads.filter(o => o === held)).toHaveLength(2);
    expect(reads.filter(o => o === empty)).toHaveLength(1);
  });

  it('publishes the owner rule only once every owner with positions has been re-read under it', async () => {
    const state = new State(':memory:');
    const [a, b] = [addr(1), addr(2)];
    const def = { ...source(async (o: string) => ({ positions: [position(o)], complete: true, errors: [], ledgerVersion: '1' })),
      refresh: { nonZero: 'monthly' as const, zero: 'monthly' as const } };
    await runSource(def, enumerator([a, b]), state, chain(), { hit: false });
    expect(reclassifiedUnder(state, def.id)).toBe(OWNER_RULES);
    // A new rule version: both owners pending until a run re-reads them; a run that does not (skipped) publishes none.
    const fresh = new State(':memory:');
    await runSource(def, enumerator([a, b]), fresh, chain(), { hit: false });
    fresh.setCursor(`owner-rules:${def.id}`, String(OWNER_RULES - 1));
    fresh.setCursor(`owner-rules-done:${def.id}`, String(OWNER_RULES - 1));
    expect(reclassifiedUnder(fresh, def.id)).toBe(OWNER_RULES - 1);
    await runSource(def, enumerator([a, b]), fresh, chain(), { hit: false });
    expect(reclassifiedUnder(fresh, def.id)).toBe(OWNER_RULES);
  });
});

describe('aave enumerator', () => {
  const FREEZE = AAVE_UNFROZEN_AT + 500n;
  const reserve = (n: number, frozen: boolean) => ({ underlying_asset: addr(`e${n}`), symbol: `R${n}`, a_token_address: addr(`a${n}`),
    variable_debt_token_address: addr(`d${n}`), is_frozen: frozen, is_active: true, is_paused: false, available_liquidity: '1' });
  // Each token's user table: 2 buckets; holders 1 and 2 in aToken a1, holder 2 owes on debt token d2.
  const entries: Record<string, [number, string][][]> = {
    [addr('a1')]: [[[1, '50']], [[2, '70'], [3, '0']]],
    [addr('d1')]: [[], []],
    [addr('d2')]: [[[2, '9']], []],
  };
  const aave = (frozen: boolean, opts: { missing?: boolean; archive?: boolean } = {}) => {
    const c = fakeChain({
      view: (fn) => fn.endsWith('::get_reserves_data') ? [[reserve(1, frozen), reserve(2, false)], {}] : [{ inner: addr('r1') }],
      resource: (address) => ({ user_state: { num_buckets: '2', size: String(entries[address].flat().length + (opts.missing ? 1 : 0)), buckets: { inner: { handle: address } } } }),
      tableItem: (handle, _k, _v, key) => entries[handle][Number(key)].map(([n, balance]) => ({ key: addr(n), value: { balance, additional_data: '0' } })),
      // Frozen (bit 57) from version FREEZE on; without the archive, the freeze cannot be dated.
      archiveResource: opts.archive === false ? undefined : (_a, _t, version) => ({ configuration: { data: (BigInt(version) >= FREEZE ? 1n << 57n : 0n).toString() } }),
      gql: (_q, vars) => ({ user_transactions: vars.v === String(FREEZE) ? [{ timestamp: '2026-11-02T10:00:00' }] : [] }),
    });
    return Object.assign(c, { ledger: async () => ({ version: String(AAVE_UNFROZEN_AT + 1000n), timestampSecs: 1_800_000_000 }) });
  };

  it('costs one view while no reserve is frozen', async () => {
    const c = aave(false);
    expect(await aaveFrozenEnumerator.run(c, undefined)).toMatchObject({ candidates: [], pages: 1 });
    expect(c.calls).toEqual([`view ${AAVE}::ui_pool_data_provider_v3::get_reserves_data`]);
  });

  it('lists holders of frozen aTokens with their scaled balances, debts and freeze time as the hint, and fails on a missing holder', async () => {
    const r = await aaveFrozenEnumerator.run(aave(true), undefined);
    const f = { [addr('e1')]: '2026-11-02T10:00:00.000Z' };
    expect(r.candidates).toEqual([
      { owner: addr(1), hint: { a: { [addr('e1')]: '50' }, d: {}, f } },
      { owner: addr(2), hint: { a: { [addr('e1')]: '70' }, d: { [addr('e2')]: '9' }, f } },
    ]);
    // The freeze time is kept in the cursor: the next run does not search again.
    const next = aave(true);
    await aaveFrozenEnumerator.run(next, r.cursor);
    expect(next.calls.filter(c => c.startsWith('archiveResource'))).toEqual([]);
    await expect(aaveFrozenEnumerator.run(aave(true, { missing: true }), undefined)).rejects.toThrow(/read 3 of 4 holders/);
  });

  it('marks a freeze it cannot date as null, so the run that dates it changes the hints', async () => {
    const r = await aaveFrozenEnumerator.run(aave(true, { archive: false }), undefined);
    expect(r.candidates[0].hint).toMatchObject({ f: { [addr('e1')]: null } });
    expect(JSON.parse(r.cursor!)).toEqual({ f: {} });
  });
});

describe('econia enumerator', () => {
  // Owner 1 rests asks in market 7 (owner-controlled), and in market 8 unless told otherwise; owner 9's order is a
  // custodian's and is ignored.
  const econia = (asks: { maker: number; size: string; market?: string }[]) => fakeChain({
    gql: () => ({ user_transactions: [] }),
    view: (_fn, args) => [{ asks: asks.filter(a => (a.market ?? '7') === args[0])
      .map(a => ({ user: addr(a.maker), custodian_id: '0', market_id: args[0], order_id: '11', remaining_size: a.size })),
      bids: args[0] === '7' ? [{ user: addr(9), custodian_id: '6', market_id: '7', order_id: '12', remaining_size: '5' }] : [] }],
  });

  it('re-reads makers, and dates a maker from the run that sees its orders change without it', async () => {
    const first = await econiaIdleEnumerator.run(econia([{ maker: 1, size: '10' }]), undefined);
    expect(first.candidates).toEqual([{ owner: addr(1), hint: {} }]);
    expect(first.incremental).toBe(true);
    // Unchanged orders: no date.
    const same = await econiaIdleEnumerator.run(econia([{ maker: 1, size: '10' }]), first.cursor);
    expect(same.candidates).toEqual([{ owner: addr(1), hint: {} }]);
    // Partly filled by a taker: that market is dated from this run (the fake ledger's time).
    const partial = await econiaIdleEnumerator.run(econia([{ maker: 1, size: '4' }]), same.cursor);
    expect(partial.candidates).toEqual([{ owner: addr(1), hint: { markets: { 7: '2027-01-15T08:00:00.000Z' } } }]);
    // Filled whole: no longer a maker, read once more with a date, then dropped.
    const gone = await econiaIdleEnumerator.run(econia([]), partial.cursor);
    expect(gone.candidates).toEqual([{ owner: addr(1), hint: { markets: { 7: '2027-01-15T08:00:00.000Z' } } }]);
    expect((await econiaIdleEnumerator.run(econia([]), gone.cursor)).candidates).toEqual([]);
  });

  it('dates only the market whose orders filled', async () => {
    const first = await econiaIdleEnumerator.run(econia([{ maker: 1, size: '10' }, { maker: 1, size: '3', market: '8' }]), undefined);
    const r = await econiaIdleEnumerator.run(econia([{ maker: 1, size: '10' }, { maker: 1, size: '1', market: '8' }]), first.cursor);
    expect(r.candidates).toEqual([{ owner: addr(1), hint: { markets: { 8: '2027-01-15T08:00:00.000Z' } } }]);
  });

  it('dates nobody from a cursor in an earlier shape', async () => {
    for (const m of [[addr(1)], { [addr(1)]: ['7'] }]) {
      const r = await econiaIdleEnumerator.run(econia([{ maker: 1, size: '10' }]), JSON.stringify({ m }));
      expect(r.candidates).toEqual([{ owner: addr(1), hint: {} }]);
    }
  });

  it('gives an owner who only registered an empty hint, so the read keeps the archive date', async () => {
    const c = fakeChain({
      gql: (_q, vars) => ({ user_transactions: vars.f === 'register_market_account' && vars.after === '0' ? [{ version: '5', sender: addr(2) }] : [] }),
      view: () => [{ asks: [], bids: [] }],
    });
    expect((await econiaIdleEnumerator.run(c, undefined)).candidates).toEqual([{ owner: addr(2), hint: {} }]);
  });
});

describe('auro enumerator', () => {
  // `indexed`: the account-transactions processor's watermark; `calls`: the user-transactions processor's (the same
  // unless given).
  // `full`: the call touched a full page of accounts.
  const auro = (indexed: string, calls = indexed, full = false) => fakeChain({ gql: (query, vars) => {
    if (query.includes('processor_status')) return { processor_status: [{ last_success_version: vars.p === 'user_transaction_processor' ? calls : indexed,
      last_transaction_timestamp: '2026-10-21T00:00:00' }] };
    if (query.includes('current_token_ownerships_v2')) return { current_token_ownerships_v2: [
      { token_data_id: addr('f1'), owner_address: addr(1), last_transaction_timestamp: '2025-01-01T00:00:00' },
      { token_data_id: addr('f3'), owner_address: addr(1), last_transaction_timestamp: '2026-06-01T00:00:00' },
      { token_data_id: addr('f2'), owner_address: addr(2), last_transaction_timestamp: '2025-01-01T00:00:00' }] };
    // One Auro call after the shutdown (a repayment), sent by someone else (addr 9); it touched position f1 and a pool.
    if (query.includes('user_transactions')) return { user_transactions: vars.a === '5067106504' && BigInt(vars.w as string) >= 5_100_000_000n
      ? [{ version: '5100000000', timestamp: '2026-05-07T16:32:48' }] : [] };
    if (query.includes('account_transactions')) return { account_transactions: vars.v === '5100000000'
      ? (full ? Array.from({ length: 100 }, (_, i) => ({ account_address: addr(1000 + i) }))
        : [{ account_address: addr(9) }, { account_address: addr('d0') }, { account_address: addr('f1') }]) : [] };
    throw new Error(query);
  } });

  it('dates a position by an Auro call that touched it after the shutdown, whoever sent it, and by an ownership change after it', async () => {
    const r = await auroClosedEnumerator.run(auro('5200000000'), undefined);
    expect(r.candidates).toEqual([
      { owner: addr(1), hint: { tokens: [addr('f1'), addr('f3')], changed: { [addr('f1')]: '2026-05-07T16:32:48.000Z', [addr('f3')]: '2026-06-01T00:00:00.000Z' }, w: '5200000000' } },
      { owner: addr(2), hint: { tokens: [addr('f2')], w: '5200000000' } },
    ]);
    expect(JSON.parse(r.cursor!)).toMatchObject({ v: '5100000000', repaid: { [addr('f1')]: '2026-05-07T16:32:48.000Z' } });
    // The repayment is remembered across runs.
    expect((await auroClosedEnumerator.run(auro('5200000000'), r.cursor)).candidates[0].hint).toMatchObject({ changed: { [addr('f1')]: '2026-05-07T16:32:48.000Z' } });
  });

  it('fails rather than miss accounts when a call touched a full page of them', async () => {
    await expect(auroClosedEnumerator.run(auro('5200000000', '5200000000', true), undefined)).rejects.toThrow(/100\+ accounts/);
  });

  it('leaves a call either index has not reached for a later run', async () => {
    const early = await auroClosedEnumerator.run(auro('5050000000'), undefined);
    expect(JSON.parse(early.cursor!)).toEqual({ v: '5067106504', repaid: {} });
    const callsBehind = await auroClosedEnumerator.run(auro('5200000000', '5050000000'), undefined);
    expect(JSON.parse(callsBehind.cursor!)).toEqual({ v: '5067106504', repaid: {} });
    expect(callsBehind.candidates[0].hint).toMatchObject({ w: '5050000000' });
    expect((await auroClosedEnumerator.run(auro('5200000000'), early.cursor)).candidates[0].hint).toMatchObject({ changed: { [addr('f1')]: '2026-05-07T16:32:48.000Z' } });
  });
});

describe('animeswap enumerator', () => {
  it('lists every pool\'s LP holders with each store\'s last change, leaving out the pool account', async () => {
    const hex = (t: string) => '0x' + Buffer.from(t).toString('hex');
    const lps = ['LPCoin<0x1::aptos_coin::AptosCoin, 0x2::c::D>', 'LPCoin<0x3::e::F, 0x4::g::H>'];
    const c = fakeChain({
      resource: () => ({ pair_list: lps.map(t => ({ lp_coin: { account_address: ANIMESWAP_POOLS, module_name: hex('LPCoinV1'), struct_name: hex(t) } })) }),
      gql: (_q, vars) => ({ current_fungible_asset_balances: vars.a === `${ANIMESWAP_POOLS}::LPCoinV1::${lps[0]}` ? [
        { owner_address: addr(1), storage_id: addr('a1'), last_transaction_timestamp: '2024-01-02T03:04:05' },
        { owner_address: ANIMESWAP_POOLS, storage_id: addr('a2'), last_transaction_timestamp: '2024-01-02T03:04:05' },
      ] : vars.a === `${ANIMESWAP_POOLS}::LPCoinV1::${lps[1]}` ? [{ owner_address: addr(1), storage_id: addr('a3'), last_transaction_timestamp: '2025-02-03T04:05:06' }] : [] }),
    });
    const r = await animeswapClosedEnumerator.run(c, undefined);
    expect(r.candidates).toEqual([{ owner: addr(1), hint: { lps: {
      [`${ANIMESWAP_POOLS}::LPCoinV1::${lps[0]}`]: '2024-01-02T03:04:05.000Z', [`${ANIMESWAP_POOLS}::LPCoinV1::${lps[1]}`]: '2025-02-03T04:05:06.000Z' } } }]);
    expect(r.pages).toBe(3);
  });
});

describe('earnium enumerator', () => {
  it('lists everyone who added or staked liquidity and every wallet holding LP; dates the stakes a staking call after the closure moved', async () => {
    const POOL = addr('e1'), OTHER = addr('e2');
    const c = fakeChain({
      view: () => [[{ inner: POOL }, { inner: OTHER }]],
      gql: (query, vars) => {
        if (query.includes('processor_status')) return { processor_status: [{ last_success_version: '7706000500', last_transaction_timestamp: '2026-10-21T00:00:00' }] };
        if (query.includes('current_fungible_asset_balances')) return { current_fungible_asset_balances: vars.a === POOL && vars.s === ''
          ? [{ owner_address: addr(3), storage_id: addr('a3'), last_transaction_timestamp: '2026-11-01T00:00:00' }] : [] };
        // Owner 2 unstaked from POOL (its LP moved), then claimed rewards (no LP moved); owner 4's call is past the watermark.
        if (query.includes('fungible_asset_activities')) return { fungible_asset_activities: vars.v === '7706000100' ? [{ asset_type: POOL }, { asset_type: POOL }] : [] };
        if (query.includes('_or:')) return { user_transactions: vars.a === '7706000000' ? [{ version: '7706000100', sender: addr(2), timestamp: '2026-10-21T10:00:00' },
          { version: '7706000200', sender: addr(2), timestamp: '2026-10-21T11:00:00' }, ...(BigInt(vars.w as string) >= 7_706_000_600n ? [{ version: '7706000600', sender: addr(4), timestamp: '2026-10-21T12:00:00' }] : [])] : [] };
        return { user_transactions: vars.f === 'stake' && vars.after === '0' ? [{ version: '5', sender: addr(1) }, { version: '6', sender: addr(2) }] : [] };
      },
    });
    const r = await earniumClosedEnumerator.run(c, undefined);
    // Every hint carries the version the scans reached.
    expect(r.candidates).toEqual([
      { owner: addr(1), hint: { w: '7706000500' } },
      { owner: addr(2), hint: { staked: { [POOL]: '2026-10-21T10:00:00.000Z' }, w: '7706000500' } },
      // Holds LP it never added or staked itself (a transfer in).
      { owner: addr(3), hint: { lps: { [POOL]: '2026-11-01T00:00:00.000Z' }, w: '7706000500' } },
    ]);
    // A full scan every run: a wallet that sent all its LP away drops out, and is re-read as gone.
    expect(r.incremental).toBeFalsy();
    expect(earniumClosedEnumerator.alsoProcessors).toEqual(['fungible_asset_processor']);
  });
});

describe('canopy frozen enumerator', () => {
  it('lists share holders with their store\'s last change and stakers with their last stake or withdrawal by shares token, leaving out the staking pool', async () => {
    const c = fakeChain({
      view: () => [{ vaults: [{ shares_address: addr('51'), vault_address: addr('52') }] }],
      resource: () => ({ user_staked_balances: { handle: addr('99') } }),
      gql: (query, vars) => query.includes('processor_status')
        ? { processor_status: [{ last_success_version: vars.p === 'events_processor' ? '250000000' : vars.p === 'default_processor' ? '240000000' : '260000000', last_transaction_timestamp: '2026-10-21T00:00:00' }] }
        : query.includes('current_table_items')
        // The staking table, walked in 16 key ranges: both stakers sit in the first.
        ? { current_table_items: vars.a === '0x0' ? [{ key: addr(1), last_transaction_version: '7' }, { key: addr(2), last_transaction_version: '9' }] : [] }
        : query.includes('events')
        // Owner 2 staked shares 51, then withdrew shares 53; owner 3 staked but the table does not list it yet.
        ? { events: vars.v === '156180000' ? [{ transaction_version: '200000000', event_index: 0, data: { user: addr(2), staking_token: { inner: addr('51') } } },
          { transaction_version: '200000005', event_index: 1, data: { user: addr(2), staking_token: { inner: addr('53') } } },
          { transaction_version: '200000006', event_index: 0, data: { user: addr(3), staking_token: { inner: addr('51') } } }] : [] }
        : { current_fungible_asset_balances: [
          { owner_address: addr(1), asset_type: addr('51'), storage_id: addr('a1'), is_primary: true, last_transaction_timestamp: '2026-10-01T00:00:00' },
          // A later change in owner 1's secondary store does not date its wallet shares.
          { owner_address: addr(1), asset_type: addr('51'), storage_id: addr('a3'), is_primary: false, last_transaction_timestamp: '2026-10-05T00:00:00' },
          { owner_address: CANOPY_REWARDS_STATE, asset_type: addr('51'), storage_id: addr('a2'), is_primary: false, last_transaction_timestamp: '2026-10-01T00:00:00' }] },
    });
    expect((await canopyFrozenEnumerator.run(c, undefined)).candidates).toEqual([
      // Every hint carries the lowest of the three processors' watermarks.
      { owner: addr(1), hint: { at: { [addr('51')]: '2026-10-01T00:00:00.000Z' }, w: '240000000' } },
      { owner: addr(2), hint: { v: { [addr('51')]: '200000000', [addr('53')]: '200000005' }, w: '240000000' } },
      { owner: addr(3), hint: { v: { [addr('51')]: '200000006' }, w: '240000000' } },
    ]);
  });
});

describe('moveposition enumerator', () => {
  // 2,001 registered portfolios over three pages (1,000 each), the tenant's own first.
  const registry = [MOVEPOSITION, ...Array.from({ length: 2000 }, (_, i) => addr(`${i + 1}`))];
  const chain = (len: number) => fakeChain({ view: (fn, args) => fn.endsWith('::tenant::get_portfolios_len_v2') ? [String(len)]
    : [registry.slice(Number(args[0]) * 1000, Number(args[0]) * 1000 + 1000)] });

  it('pages the tenant\'s registry and leaves out its own fee portfolio', async () => {
    const r = await movepositionWoundDownEnumerator.run(chain(2001), undefined);
    expect([r.candidates.length, r.candidates[0], r.pages]).toEqual([2000, { owner: addr('1') }, 4]);
  });

  it('fails when the pages hold fewer portfolios than the registry counts', async () => {
    await expect(movepositionWoundDownEnumerator.run(chain(2002), undefined)).rejects.toThrow(/2001 portfolios read of 2002/);
  });
});

describe('houston enumerator', () => {
  it('checks what the pool pays against its reserves, leaving out coins stored in the positions and positions it is short for', async () => {
    const PAIR = '<0x1::aptos_coin::AptosCoin, 0x2::c::D>';
    const c = fakeChain({ resource: () => ({ fee_tier: { data: [{ key: '0', value: { reserve_x: { value: '100' }, reserve_y: { value: '50' } } }] } }) });
    // `paid` defaults to what the position is owed; a blocked position (reserve_short) pays nothing.
    const p = (kind: string, asset: string, raw: string, paid = raw) => ({ locator: `${PAIR}#1`, positionKind: kind, asset,
      grossClaim: [{ asset, raw }], expectedPayout: paid === '0' ? [] : [{ asset, raw: paid }] } as unknown as Position);
    const APT_FA = '0x000000000000000000000000000000000000000000000000000000000000000a';
    const positions = [p('principal', APT_FA, '100'), p('principal', '0x2::c::D', '50'), p('fees', '0x2::c::D', '1000'), p('principal', '0x2::c::D', '1000', '0')];
    expect((await houstonClosedEnumerator.sanity!(c, { version: '1', timestampSecs: 0 }, positions)).ok).toBe(true);
    const over = await houstonClosedEnumerator.sanity!(c, { version: '1', timestampSecs: 0 }, [...positions, p('principal', '0x2::c::D', '1')]);
    expect(over.ok).toBe(false);
    expect(over.detail).toContain(`${PAIR} reserve_y: 51 > 50`);
  });

  it('lists everyone who added liquidity, and dates the pairs a liquidity call after the closure changed', async () => {
    const PAIR = '<0x1::aptos_coin::AptosCoin, 0x2::c::D>', OTHER = '<0x3::e::F, 0x1::aptos_coin::AptosCoin>';
    const W = '0x7ab72b249ec24f76fe66b6de19dcee1e3d3361db5c2cccfaa48ea8659060a1bd::position::PositionWallet';
    const c = fakeChain({
      gql: (query, vars) => {
        if (query.includes('processor_status')) return { processor_status: [{ last_success_version: '7715000500', last_transaction_timestamp: '2026-10-22T00:00:00' }] };
        // Owner 2 removed liquidity in PAIR after the closure began; its OTHER wallet did not change.
        if (query.includes('entry_function_module_name:{_eq:"liquidity_manager"}, version')) return { user_transactions: vars.a === '7715000000'
          ? [{ version: '7715000100', sender: addr(2), timestamp: '2026-10-22T10:00:00' }] : [] };
        return { user_transactions: vars.f === 'add_liquidity' && vars.after === '0' ? [{ version: '5', sender: addr(1) }, { version: '6', sender: addr(2) }] : [] };
      },
    });
    const wallets = { ...c, resources: async (_address: string, version?: string) => [{ type: `${W}${PAIR}`, data: { positions: [{ liquidity: version === '7715000099' ? '9' : '4' }] } },
      { type: `${W}${OTHER}`, data: { positions: [{ liquidity: '1' }] } }] };
    const r = await houstonClosedEnumerator.run(wallets, undefined);
    expect(r.candidates).toEqual([
      { owner: addr(1), hint: { w: '7715000500' } },
      { owner: addr(2), hint: { moved: { [PAIR]: '2026-10-22T10:00:00.000Z' }, w: '7715000500' } },
    ]);
    expect(r.incremental).toBeFalsy();
    // Calls are scanned once: the next run starts at the watermark and keeps the dates in the cursor.
    expect(JSON.parse(r.cursor!)).toEqual({ v: '7715000500', moved: { [addr(2)]: { [PAIR]: '2026-10-22T10:00:00.000Z' } } });
    const next = await houstonClosedEnumerator.run(wallets, r.cursor);
    expect(next.candidates[1]).toEqual({ owner: addr(2), hint: { moved: { [PAIR]: '2026-10-22T10:00:00.000Z' }, w: '7715000500' } });
    // History the fullnode pruned: every pair the sender holds is dated from the call.
    const pruned = { ...wallets, resources: async (address: string, version?: string) => {
      if (version !== '7715000500') throw new Error('resources: HTTP 410 {"message":"Ledger version 7715000099 is pruned"}');
      return wallets.resources(address, version);
    } };
    expect((await houstonClosedEnumerator.run(pruned, undefined)).candidates[1].hint).toEqual(
      { moved: { [PAIR]: '2026-10-22T10:00:00.000Z', [OTHER]: '2026-10-22T10:00:00.000Z' }, w: '7715000500' });
  });
});

describe('check-only sources', () => {
  it('have no enumerator, and every other source has one', () => {
    for (const s of SOURCES) expect(ENUMERATORS.some(e => e.sourceId === s.id)).toBe(!s.checkOnly);
  });
});

describe('echo enumerator', () => {
  it('lists holders of about $1 or more per reserve, leaving out Echo\'s own wallets', async () => {
    const seen: Record<string, unknown>[] = [];
    const c = fakeChain({ gql: (_q, vars) => { seen.push(vars); return { current_fungible_asset_balances: vars.a === '0x7f5170624083679dbb5a8119e3dec380d95fddfd0940a4fb7118c7d9db61d425'
      ? [{ owner_address: addr(1), storage_id: addr('a1') }, { owner_address: '0x3b9a45c9d5c73e27c48f85a26a3e9b3fcef44af44ddf9e0995bf17390b1d1bb8', storage_id: addr('a2') }] : [] }; } });
    const r = await echoWoundDownEnumerator.run(c, undefined);
    expect(r.candidates).toEqual([{ owner: addr(1) }]);
    expect(seen[0]).toMatchObject({ m: '100000000' });
    expect(r.pages).toBe(9);
  });
});

describe('goblin enumerator', () => {
  const [FIRST] = [...WIPED_VAULTS.keys()];
  it('lists every share holder (paged on version, the boundary read again) and every staker, leaving out the MasterChef', async () => {
    const seen: Record<string, unknown>[] = [];
    // The first vault: 100 stores, 99 changed at version 5 and one at 6, then that one again and the MasterChef's at 7.
    const first = Array.from({ length: 100 }, (_, i) => ({ storage_id: addr(`5${i}`), owner_address: addr(100 + i), last_transaction_version: i < 99 ? '5' : '6' }));
    const c = fakeChain({ gql: (q, vars) => {
      seen.push(vars);
      if (q.includes('user_transactions')) return { user_transactions: vars.after === '0' && (vars.f === 'deposit' || vars.f === 'zap_in_with_single')
        ? [{ version: vars.f === 'deposit' ? '10' : '12', sender: vars.f === 'deposit' ? addr(7) : addr(8) }] : [] };
      if (vars.v !== FIRST) return { current_fungible_asset_balances: [] };
      return { current_fungible_asset_balances: vars.from === '0' ? first
        : [first[99], { storage_id: addr('chef'), owner_address: GOBLIN_CHEF_ACCOUNT, last_transaction_version: '7' }] };
    } });
    const r = await goblinWipedOutEnumerator.run(c, undefined);
    expect(r.candidates.length).toBe(102);
    expect(r.candidates.map(x => x.owner)).toEqual(expect.arrayContaining([addr(7), addr(8), addr(100), addr(199)]));
    expect(r.candidates.map(x => x.owner)).not.toContain(GOBLIN_CHEF_ACCOUNT);
    expect(seen.filter(v => v.v === FIRST).map(v => v.from)).toEqual(['0', '6']);
    expect(r.incremental).toBe(true);
    expect(JSON.parse(r.cursor!)).toMatchObject({ [`${GOBLIN_CHEF}::masterchef::deposit`]: '10' });
    // Six staking entry functions, then one page per vault plus the first vault's second.
    expect(r.pages).toBe(6 + WIPED_VAULTS.size + 1);
  });

  it('checks what is counted against each store and what is owed against what all shares are owed', async () => {
    const c = fakeChain({
      resource: (_a, type) => (type.endsWith('::Vault') ? { token_a: { inner: addr('aa') }, token_b: { inner: addr('bb') }, total_shares: '1000' }
        : { token_a_store: { inner: addr('5a') }, token_b_store: { inner: addr('5b') }, position_amount_a: '50', position_amount_b: '600' }),
      view: (fn, args) => (fn.endsWith('::get_token_amount_by_share') ? ['2000', '500'] : [args[0] === addr('5a') ? '100' : '1000']),
    });
    const p = (locator: string, asset: string, raw: string, status: string) =>
      ({ locator, asset, status, grossClaim: [{ asset, raw }], expectedPayout: status === 'recoverable' ? [{ asset, raw }] : [] } as unknown as Position);
    const ok = [p(FIRST, addr('aa'), '100', 'recoverable'), p(`${FIRST}/store-short`, addr('aa'), '1900', 'blocked'), p(FIRST, addr('bb'), '500', 'recoverable')];
    const ledger = { version: '1', timestampSecs: 0 };
    expect((await goblinWipedOutEnumerator.sanity!(c, ledger, ok)).ok).toBe(true);
    // Named accounts are paid at the closed position's amounts: 600 USDC units for all shares, above the recorded 500.
    expect((await goblinWipedOutEnumerator.sanity!(c, ledger, [...ok, p(`${FIRST}/staked`, addr('bb'), '100', 'blocked')])).ok).toBe(true);
    const over = await goblinWipedOutEnumerator.sanity!(c, ledger, [...ok, p(`${FIRST}/staked`, addr('aa'), '1', 'recoverable')]);
    expect(over.ok).toBe(false);
    expect(over.detail).toContain(`${WIPED_VAULTS.get(FIRST)!.name} token 0: counted 101 > store 100`);
  });
});

describe('collection owners', () => {
  it('pages the collection\'s token data, listing each live token under its current owner and skipping burned ones', async () => {
    const seen: string[] = [];
    const token = (n: number, owner?: string) => ({ token_data_id: addr(`7${n}`), current_token_ownerships: owner ? [{ owner_address: owner }] : [] });
    const first = Array.from({ length: 100 }, (_, i) => token(i, i === 3 ? addr(1) : i === 8 ? addr(2) : i === 9 ? addr(1) : undefined));
    const c = fakeChain({ gql: (_q, vars) => { seen.push(String(vars.after)); return { current_token_datas_v2: vars.after === '' ? first : [token(200, addr(2))] }; } });
    const r = await amnisWithdrawalsEnumerator.run(c, undefined);
    expect(r.candidates).toEqual([{ owner: addr(1), hint: { tokens: [addr('73'), addr('79')] } }, { owner: addr(2), hint: { tokens: [addr('7200'), addr('78')].sort() } }]);
    expect(seen).toEqual(['', addr('799')]);
    expect(r.pages).toBe(2);
  });
});
