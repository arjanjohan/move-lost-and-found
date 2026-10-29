// Published snapshot format: aggregates only, never owner addresses.
import type { PriceBook, SourceTotals, UnpricedAsset } from './accounting.ts';
import type { MarketTable } from './market.ts';
import type { SourceDef } from './types.ts';

export interface Sanity { check: string; ok: boolean | null; detail: string }

export interface SourceRun {
  processor: string | null;
  scope: string;
  watermarkBefore?: { version: string; timestamp: string };
  watermarkAfter?: { version: string; timestamp: string };
  enumeration: { start?: string; end?: string; pages: number; newCandidates: number; candidates: number; cursor?: string };
  verification: { start?: string; end?: string; ledgerFrom?: string; ledgerTo?: string; read: number; incomplete: number; notReread: number };
  sanity?: Sanity;
  completeness: 'complete' | 'degraded';
  degradedReasons: string[];
  errors: string[];
}

export interface SnapshotSource {
  id: string; chain: string; title: string; summary: string; category: string; inclusionRule: string;
  protocolStatus: SourceDef['protocolStatus']; howTo: string[]; officialUrl?: string; headlineAgeBases: string[];
  run: SourceRun;
  /** The owner rule (`OWNER_RULES`) the positions were classified under. */
  ownerRules?: number;
  lastSuccessAt?: string;
  totals: SourceTotals;
  /** Recoverable positions by expected payout (USD) band: < 1, 1–10, …, ≥ 10k. */
  sizeBands: { upTo: number | null; positions: number }[];
  /** What counted positions hold without a price, per asset and status, with the asset's display identity where known
   *  (absent before 2026-10-29). */
  unpriced?: { assets: (UnpricedAsset & { symbol?: string; decimals?: number })[]; more: number };
}

export interface Snapshot {
  schema: 1;
  generatedAt: string;
  prices: PriceBook;
  priceErrors: string[];
  /** Market-test verdicts for receipt tokens (asset → value bucket → verdict). */
  markets?: MarketTable;
  sources: SnapshotSource[];
  global: { headlineUsd: number; headlineOwners: number; headlineOwnersMin10: number; recoverableUsd: number; requests: number; requestCap: number;
    /** Headline wallets per chain, unique within it (absent before 2026-10-24). */
    byChain?: Record<string, { headlineOwners: number; headlineOwnersMin10: number }> };
}

