// Weekly snapshot: enumerate → revalidate → price → aggregate. Publishes aggregates only, never addresses.
//
// Usage: node src/node/snapshot.ts [--source id] [--limit N] [--cap N] [--state path] [--out path] [--anonymous]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ageDays, HEADLINE_AGE_DAYS, headlineAge, sourceTotals, usd, type PriceBook } from '../shared/accounting.ts';
import { OWNER_RULES, readClassified } from '../shared/owners.ts';
import { mapLimit } from '../shared/chain.ts';
import { SOURCES } from '../shared/sources/index.ts';
import type { ChainReader, Ledger, Position, ReadContext, SourceDef } from '../shared/types.ts';
import { processorWatermark, readers, RequestCapReached } from './client.ts';
import { ENUMERATORS, type Enumerator } from './enumerators.ts';
import type { Snapshot, SnapshotSource, SourceRun } from '../shared/snapshot.ts';
import { fetchPrices } from './prices.ts';
import { panoraProvider } from './panora.ts';
import { freshMarkets, MARKET_MAX_AGE_SECS, type MarketProvider, type MarketTable } from '../shared/market.ts';
import { APT } from '../shared/sources/delegation.ts';
import { AGE_LIMIT_MS, State } from './state.ts';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ONLY = opt('--source');
const LIMIT = opt('--limit') ? Number(opt('--limit')) : Infinity;
const CAP = Number(opt('--cap') ?? process.env.REQUEST_CAP ?? 100_000);
const STATE = opt('--state') ?? 'state/state.sqlite';
const OUT = opt('--out') ?? 'snapshot/latest.json';
const CONCURRENCY = 8;
const WATERMARK_MAX_LAG_MS = 60 * 60_000;

const SIZE_BANDS = [1, 10, 100, 1_000, 10_000];

export function sizeBands(positions: Position[], prices: PriceBook) {
  const counts = new Array(SIZE_BANDS.length + 1).fill(0);
  for (const p of positions) {
    if (p.status !== 'recoverable') continue;
    const v = usd(p.expectedPayout, prices);
    if (v === null) continue;
    const i = SIZE_BANDS.findIndex(b => v < b);
    counts[i === -1 ? SIZE_BANDS.length : i]++;
  }
  return counts.map((positions, i) => ({ upTo: SIZE_BANDS[i] ?? null, positions }));
}

/** The reader as sources see it: a request that hits the cap flags the run at once, even when the source catches the
 *  error and returns an incomplete read (sources treat any read error that way). */
function capFlagging(chain: ChainReader, capHit: { hit: boolean }): ChainReader {
  return new Proxy(chain, {
    get(target, key) {
      const value = (target as any)[key];
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        try { return await value.apply(target, args); }
        catch (err) { if (err instanceof RequestCapReached) capHit.hit = true; throw err; }
      };
    },
  });
}

export async function runSource(def: SourceDef<any>, en: Enumerator, state: State, rawChain: ChainReader, capHit: { hit: boolean }, market?: MarketProvider): Promise<{ run: SourceRun; ledger?: Ledger }> {
  const chain = capFlagging(rawChain, capHit);
  const run: SourceRun = { processor: en.processor, scope: en.scope, enumeration: { pages: 0, newCandidates: 0, candidates: 0 },
    verification: { read: 0, incomplete: 0, notReread: 0 }, completeness: 'complete', degradedReasons: [], errors: [] };
  const runStart = new Date().toISOString();
  let ledger: Ledger | undefined;
  try {
    if (en.processor) run.watermarkBefore = await processorWatermark(chain, en.processor);
    run.enumeration.start = new Date().toISOString();
    const before = state.candidateCount(def.id);
    const result = await en.run(chain, state.cursor(def.id));
    state.upsertCandidates(def.id, result.candidates, runStart, result.incremental);
    if (!result.incremental) state.markGone(def.id, new Set(result.candidates.map(c => c.owner)), runStart);
    if (result.cursor) state.setCursor(def.id, result.cursor);
    Object.assign(run.enumeration, { end: new Date().toISOString(), pages: result.pages, cursor: result.cursor,
      candidates: state.candidateCount(def.id), newCandidates: state.candidateCount(def.id) - before });
    if (en.processor) run.watermarkAfter = await processorWatermark(chain, en.processor);
    for (const processor of [en.processor, ...(en.alsoProcessors ?? [])].filter((p): p is string => !!p)) {
      const mark = processor === en.processor ? run.watermarkAfter! : await processorWatermark(chain, processor);
      const lagMs = Date.now() - Date.parse(mark.timestamp);
      if (lagMs > WATERMARK_MAX_LAG_MS) run.degradedReasons.push(`indexer ${processor} is ${Math.round(lagMs / 60_000)} min behind`);
    }

    // A changed source version means changed rules: stored positions must not survive until their next refresh.
    const rules = String(def.version ?? 1);
    if (state.cursor(`rules:${def.id}`) !== rules) {
      if (state.cursor(`rules:${def.id}`) !== undefined || state.candidateCount(def.id) > 0) state.markAllChanged(def.id, runStart);
      state.setCursor(`rules:${def.id}`, rules);
    }
    // So does a changed owner rule, for every owner with stored positions.
    if (state.cursor(`owner-rules:${def.id}`) !== String(OWNER_RULES)) {
      state.markNonzeroChanged(def.id, runStart);
      state.setCursor(`owner-rules:${def.id}`, String(OWNER_RULES));
    }
    ledger = await chain.ledger();
    const ctx: ReadContext = { chain, ledger, memo: state.memo(), scratch: new Map(), market };
    const enumerated = new Set(result.candidates.map(c => c.owner));
    const due = state.due(def, Date.now(), enumerated, !!result.incremental);
    const batch = due.slice(0, LIMIT);
    if (batch.length < due.length) run.degradedReasons.push(`limited to ${batch.length} of ${due.length} due owners`);
    run.verification.start = new Date().toISOString();
    run.verification.ledgerFrom = ledger.version;
    let done = 0;
    await mapLimit(batch, CONCURRENCY, async ({ owner, hint }) => {
      if (capHit.hit) return;
      try {
        const r = await readClassified(def, ctx, owner, hint);
        state.recordRead(def.id, owner, r.positions, r.complete, runStart);
        run.verification.read++;
        if (!r.complete) run.verification.incomplete++;
        run.errors.push(...r.errors.slice(0, 2));
      } catch (err) {
        if (err instanceof RequestCapReached) { capHit.hit = true; return; }
        state.recordRead(def.id, owner, [], false, runStart);
        run.verification.incomplete++;
        run.errors.push(String(err).slice(0, 200));
      }
      if (++done % 1000 === 0) console.error(`${def.id}: read ${done}/${batch.length}`);
    });
    run.verification.end = new Date().toISOString();
    run.verification.ledgerTo = (await chain.ledger()).version;
    if (capHit.hit) run.degradedReasons.push('request cap reached during verification');
  } catch (err) {
    if (err instanceof RequestCapReached) capHit.hit = true;
    run.degradedReasons.push(`run failed: ${String(err).slice(0, 200)}`);
  }
  run.verification.notReread = state.staleCount(def.id, new Date(Date.parse(runStart) - AGE_LIMIT_MS[def.refresh.nonZero]).toISOString());
  if (run.verification.incomplete) run.degradedReasons.push(`${run.verification.incomplete} owners read incompletely; their previous positions are kept`);
  // A receipt counts only without a usable market; without a quote that cannot be decided, which is not "complete".
  const noMarket = state.positionsOf(def.id).filter(p => p.blockers.some(b => b.code === 'market_check_unavailable')).length;
  if (noMarket) run.degradedReasons.push(`${noMarket} positions without market evidence (no fresh Panora quote)`);
  if (run.verification.notReread) run.degradedReasons.push(`${run.verification.notReread} positions not re-read this run`);
  run.errors = [...new Set(run.errors)].slice(0, 20);
  return { run, ledger };
}

/** The owner rule a source's stored positions are all classified under, once every owner with positions has been
 *  re-read since the rule last changed (a run that hit the cap or read some incompletely leaves it pending); undefined
 *  before that. Published with the source, so a single-source run never copies positions from before the change. */
export function reclassifiedUnder(state: State, sourceId: string): number | undefined {
  const done = `owner-rules-done:${sourceId}`;
  if (state.cursor(`owner-rules:${sourceId}`) === String(OWNER_RULES) && state.cursor(done) !== String(OWNER_RULES) && state.pendingNonzero(sourceId) === 0)
    state.setCursor(done, String(OWNER_RULES));
  const v = state.cursor(done);
  return v === undefined ? undefined : Number(v);
}

/** In a run limited to one source (`--source`), whether another source's previous result can be copied unchanged.
 *  Not when it was classified under an older owner rule, nor when its positions rest on market quotes and the oldest
 *  quote the previous snapshot published has expired (quotes are taken during a run, before it ends): then it is re-run
 *  too. */
export function keepPrevious(def: SourceDef<any>, prev: SnapshotSource | undefined, only: string | undefined, nowSecs: number, markets?: MarketTable): boolean {
  if (!only || def.id === only) return false;
  if (prev?.ownerRules !== OWNER_RULES) return false;
  if (!def.usesMarketQuotes) return true;
  const quoted = Object.values(markets ?? {}).flatMap(b => Object.values(b).map(v => Date.parse(v.quotedAt) / 1000));
  return !!prev && quoted.length > 0 && nowSecs - Math.min(...quoted) <= MARKET_MAX_AGE_SECS;
}

/** Run order: the source a single-source run names, then sources with nothing read yet, then the rest in their usual
 *  order. A backlog or re-read in an earlier source must not use up the request cap before a newer source gets its
 *  first read. */
export function runOrder<T extends { id: string }>(sources: T[], only: string | undefined, known: (id: string) => boolean): T[] {
  const rank = (s: T) => (s.id === only ? 0 : known(s.id) ? 2 : 1);
  return [...sources].sort((a, b) => rank(a) - rank(b));
}

async function main() {
  const state = new State(STATE);
  const { chains, usage } = readers(CAP, { anonymous: args.includes('--anonymous') });
  const previous: Snapshot | undefined = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : undefined;
  const capHit = { hit: false };
  const now = Math.floor(Date.now() / 1000);
  const { prices, errors: priceErrors } = await fetchPrices(now, chains.aptos);
  // Market test for receipt tokens; without a key, receipt verdicts stay unknown.
  const panora = process.env.PANORA_API_KEY ? panoraProvider(process.env.PANORA_API_KEY, prices[APT]?.usd ?? null) : undefined;

  const sources: SnapshotSource[] = [];
  for (const def of runOrder(SOURCES.filter(s => !s.checkOnly), ONLY, id => state.candidateCount(id) > 0)) {
    const en = ENUMERATORS.find(e => e.sourceId === def.id);
    if (!en) throw new Error(`No enumerator for ${def.id}`);
    const prev = previous?.sources.find(s => s.id === def.id);
    if (ONLY && def.id !== ONLY && keepPrevious(def, prev, ONLY, now, previous?.markets)) { if (prev) sources.push(prev); continue; }
    console.error(`${def.id}: start`);
    // The cap only limits keyed Aptos requests, so Movement sources still run after it is hit.
    const { run, ledger } = capHit.hit && def.chain === 'aptos'
      ? { run: { processor: en.processor, scope: en.scope, enumeration: { pages: 0, newCandidates: 0, candidates: state.candidateCount(def.id) },
          verification: { read: 0, incomplete: 0, notReread: state.positionsOf(def.id).length }, completeness: 'degraded' as const,
          degradedReasons: ['skipped: request cap reached earlier in the run'], errors: [] }, ledger: undefined }
      : await runSource(def, en, state, chains[def.chain], def.chain === 'aptos' ? capHit : { hit: false }, panora?.provider);
    const positions = state.positionsOf(def.id);
    if (en.sanity && ledger) {
      try { run.sanity = await en.sanity(chains[def.chain], ledger, positions); if (run.sanity.ok === false) run.degradedReasons.push('sanity check failed'); }
      catch (err) { run.sanity = { check: 'sanity', ok: null, detail: String(err).slice(0, 200) }; }
    }
    if (Object.keys(prices).length === 0) run.degradedReasons.push('no prices');
    run.completeness = run.degradedReasons.length ? 'degraded' : 'complete';
    sources.push({
      id: def.id, chain: def.chain, title: def.title, summary: def.summary, category: def.category, inclusionRule: def.inclusionRule,
      protocolStatus: def.protocolStatus, howTo: def.howTo, officialUrl: def.officialUrl, headlineAgeBases: def.headlineAgeBases,
      run, ownerRules: reclassifiedUnder(state, def.id), lastSuccessAt: run.completeness === 'complete' ? run.verification.end : prev?.lastSuccessAt,
      totals: sourceTotals(def, positions, prices, now), sizeBands: sizeBands(positions, prices),
    });
    console.error(`${def.id}: ${run.completeness} ${run.degradedReasons.join('; ')}`);
  }
  // Published in the usual order, whatever order they ran in.
  sources.sort((a, b) => SOURCES.findIndex(s => s.id === a.id) - SOURCES.findIndex(s => s.id === b.id));

  // Global owners are unique across sources, and per chain across its sources.
  const headlineOwners = new Map<string, number>();
  const chainOwners = new Map<string, Map<string, number>>();
  for (const def of SOURCES) for (const p of state.positionsOf(def.id)) {
    const age = ageDays(p, now);
    if (p.status !== 'recoverable' || p.confidence === 'indexer_only' || !headlineAge(def, p) || age === null || age < HEADLINE_AGE_DAYS) continue;
    const value = usd(p.expectedPayout, prices) ?? 0;
    headlineOwners.set(p.owner, (headlineOwners.get(p.owner) ?? 0) + value);
    const chain = chainOwners.get(def.chain) ?? new Map<string, number>();
    chain.set(p.owner, (chain.get(p.owner) ?? 0) + value);
    chainOwners.set(def.chain, chain);
  }
  const snapshot: Snapshot = {
    schema: 1, generatedAt: new Date().toISOString(), prices, priceErrors, markets: freshMarkets({ ...previous?.markets, ...panora?.table }, now), sources,
    global: {
      headlineUsd: sources.reduce((s, x) => s + x.totals.headline.usd, 0),
      headlineOwners: headlineOwners.size,
      headlineOwnersMin10: [...headlineOwners.values()].filter(v => v >= 10).length,
      recoverableUsd: sources.reduce((s, x) => s + x.totals.byStatus.recoverable.usd, 0),
      byChain: Object.fromEntries([...chainOwners].map(([chain, owners]) => [chain,
        { headlineOwners: owners.size, headlineOwnersMin10: [...owners.values()].filter(v => v >= 10).length }])),
      requests: usage.requests, requestCap: CAP,
    },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
  state.close();
  console.error(`requests ${usage.requests} ${JSON.stringify(usage.byLabel)} → ${OUT}`);
}

if (import.meta.main) await main();
