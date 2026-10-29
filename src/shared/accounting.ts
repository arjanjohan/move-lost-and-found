// Position identity, aging and totals. Rules: docs/left-behind.md.
import type { AgeBasis, Amount, Position, PositionKind, SourceDef, Status } from './types.ts';

export const AGE_BUCKETS = [30, 90, 180] as const;
export const HEADLINE_AGE_DAYS = 90;
export const OWNER_MIN_USD = 10;
const DAY = 86_400;

export function positionIds(source: string, owner: string, locator: string, kind: PositionKind, asset?: string) {
  const parentId = `${source}:${owner}:${locator}`;
  return { parentId, id: `${parentId}:${kind}${asset ? `:${asset}` : ''}` };
}

export function ageDays(position: Position, nowSecs: number): number | null {
  if (position.ageBasis === 'unknown' || !position.claimableSince) return null;
  return (nowSecs - Date.parse(position.claimableSince) / 1000) / DAY;
}

/** Age counts for the headline only on bases the source documents as valid. */
export function headlineAge(source: Pick<SourceDef, 'headlineAgeBases'>, position: Position): boolean {
  return position.ageBasis !== 'unknown' && source.headlineAgeBases.includes(position.ageBasis);
}

/** Price per whole unit of an asset, with the quote time. Unpriced assets are absent. */
export type PriceBook = Record<string, { usd: number; decimals: number; at: string; source: string }>;

/** A quote older than this is not a price. */
export const PRICE_MAX_AGE_SECS = 7 * 86_400;

/** The prices still fresh at `nowSecs`; older quotes are dropped, so their assets read as unpriced. A published snapshot
 *  can be read long after it was made (a failed weekly run), so readers apply the age rule again. */
export function freshPrices(prices: PriceBook, nowSecs: number): PriceBook {
  return Object.fromEntries(Object.entries(prices).filter(([, p]) => nowSecs - Date.parse(p.at) / 1000 <= PRICE_MAX_AGE_SECS));
}

export function usd(amounts: Amount[], prices: PriceBook): number | null {
  let total = 0;
  for (const a of amounts) {
    const p = prices[a.asset];
    if (!p) return null;
    total += Number(a.raw) / 10 ** p.decimals * p.usd;
  }
  return total;
}

export interface Bucket { positions: number; owners: number; ownersMin10: number; usd: number; unpriced: number }

function bucket(positions: Position[], value: (p: Position) => number | null): Bucket {
  const perOwner = new Map<string, number>();
  let total = 0, unpriced = 0;
  for (const p of positions) {
    const v = value(p);
    if (v === null) { unpriced++; perOwner.set(p.owner, perOwner.get(p.owner) ?? 0); continue; }
    total += v;
    perOwner.set(p.owner, (perOwner.get(p.owner) ?? 0) + v);
  }
  return { positions: positions.length, owners: perOwner.size, usd: total, unpriced,
    ownersMin10: [...perOwner.values()].filter(v => v >= OWNER_MIN_USD).length };
}

export type OwnerKind = 'user' | 'resource_account' | 'object';

/** Only an ordinary account can sign the recovery itself. Positions held by resource accounts (protocol-controlled)
 *  or by objects are counted apart as contract-held (decided 2026-10-22), never in the headline. */
export function applyOwnerKind(positions: Position[], kind: OwnerKind): Position[] {
  if (kind === 'user') return positions;
  const detail = kind === 'resource_account'
    ? 'Held by a resource account (program-controlled), not by a person who can sign the recovery.'
    : 'Held by an object, not directly by an account.';
  return positions.map(p => ({ ...p, status: 'contract_held', blockers: [...p.blockers, { code: 'unsupported_owner', detail }] }));
}

/** A borrower's supply or collateral in a protocol that has closed: shown on the check page so its owner sees it, but
 *  never in a total, since a borrower's supply can be its own borrowed funds supplied again and what it gets back is
 *  supply less debt (decided 2026-10-24, R4). */
export const HAS_DEBT = 'has_debt';
export const debtBlocker = (detail: string) => ({ code: HAS_DEBT, detail });
const counted = (p: Position) => p.confidence !== 'indexer_only' && !p.blockers.some(b => b.code === HAS_DEBT);

export interface SourceTotals {
  face: Bucket;                                   // gross claim, every status
  byStatus: Record<Status, Bucket>;               // expected payout
  /** Gross claim by status: what blocked, team-gated or unknown positions are owed, which their expected payout (often
   *  none) does not show. Absent from snapshots before 2026-10-24. */
  faceByStatus?: Record<Status, Bucket>;
  /** Recoverable expected payout aged ≥ N days (cumulative), headline-eligible bases only. */
  aged: Record<string, Bucket>;
  /** Recoverable expected payout aged ≥ N days on estimated (non-eligible) bases; never in the headline. */
  agedEstimated: Record<string, Bucket>;
  byAgeBasis: Record<AgeBasis, Bucket>;
  headline: Bucket;
  /** Share of the headline held by the single largest wallet (no address published). */
  headlineTopOwnerShare: number;
  /** indexer_only positions (not verified on chain): listed, never in any total above. */
  unverified: Bucket;
}

export function sourceTotals(source: Pick<SourceDef, 'headlineAgeBases'>, all: Position[], prices: PriceBook, nowSecs: number): SourceTotals {
  assertUniqueIds(all);
  // Only positions verified on chain (or derived from verified state) count; indexer-only rows are reported apart, and
  // borrowers' supply is never counted.
  const positions = all.filter(counted);
  const payout = (p: Position) => usd(p.expectedPayout, prices), gross = (p: Position) => usd(p.grossClaim, prices);
  const recoverable = positions.filter(p => p.status === 'recoverable');
  const agedOn = (eligible: boolean, days: number) => recoverable.filter(p => {
    const age = ageDays(p, nowSecs);
    return age !== null && age >= days && headlineAge(source, p) === eligible;
  });
  const statuses: Status[] = ['recoverable', 'team_gated', 'blocked', 'contract_held', 'unknown'];
  const bases: AgeBasis[] = ['onchain_maturity', 'protocol_closure', 'position_interaction', 'unknown'];
  return {
    face: bucket(positions, gross),
    byStatus: Object.fromEntries(statuses.map(s => [s, bucket(positions.filter(p => p.status === s), payout)])) as Record<Status, Bucket>,
    faceByStatus: Object.fromEntries(statuses.map(s => [s, bucket(positions.filter(p => p.status === s), gross)])) as Record<Status, Bucket>,
    aged: Object.fromEntries(AGE_BUCKETS.map(d => [`ge${d}`, bucket(agedOn(true, d), payout)])),
    agedEstimated: Object.fromEntries(AGE_BUCKETS.map(d => [`ge${d}`, bucket(agedOn(false, d), payout)])),
    byAgeBasis: Object.fromEntries(bases.map(b => [b, bucket(recoverable.filter(p => p.ageBasis === b), payout)])) as Record<AgeBasis, Bucket>,
    headline: bucket(agedOn(true, HEADLINE_AGE_DAYS), payout),
    headlineTopOwnerShare: topOwnerShare(agedOn(true, HEADLINE_AGE_DAYS), payout),
    unverified: bucket(all.filter(p => p.confidence === 'indexer_only'), payout),
  };
}

/** An asset that counted positions hold without a price, per status: the amount a USD total would take (the payout when
 *  recoverable, what is owed otherwise, as the totals do), its positions and their owners. */
export interface UnpricedAsset { asset: string; status: Status; raw: string; positions: number; owners: number }
/** The rows a source publishes, most positions first; the rest are counted in `more`. */
export const UNPRICED_LIMIT = 25;

export function unpricedAssets(all: Position[], prices: PriceBook): { assets: UnpricedAsset[]; more: number } {
  const rows = new Map<string, { asset: string; status: Status; raw: bigint; positions: number; owners: Set<string> }>();
  for (const p of all.filter(counted)) {
    for (const a of p.status === 'recoverable' ? p.expectedPayout : p.grossClaim) {
      if (prices[a.asset]) continue;
      const key = `${p.status}|${a.asset}`;
      const row = rows.get(key) ?? { asset: a.asset, status: p.status, raw: 0n, positions: 0, owners: new Set<string>() };
      row.raw += BigInt(a.raw);
      row.positions++;
      row.owners.add(p.owner);
      rows.set(key, row);
    }
  }
  const sorted = [...rows.values()].sort((a, b) => b.positions - a.positions || (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));
  return { assets: sorted.slice(0, UNPRICED_LIMIT).map(r => ({ asset: r.asset, status: r.status, raw: r.raw.toString(), positions: r.positions, owners: r.owners.size })),
    more: Math.max(0, sorted.length - UNPRICED_LIMIT) };
}

function topOwnerShare(positions: Position[], value: (p: Position) => number | null): number {
  const perOwner = new Map<string, number>();
  for (const p of positions) perOwner.set(p.owner, (perOwner.get(p.owner) ?? 0) + (value(p) ?? 0));
  const total = [...perOwner.values()].reduce((a, b) => a + b, 0);
  return total > 0 ? Math.max(...perOwner.values()) / total : 0;
}

export function assertUniqueIds(positions: Position[]) {
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p.id)) throw new Error(`Duplicate position id ${p.id}`);
    seen.add(p.id);
  }
}

export function iso(secs: number): string {
  return new Date(secs * 1000).toISOString();
}
