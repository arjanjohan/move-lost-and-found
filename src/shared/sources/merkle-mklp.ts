// Merkle Trade house-LP tokens (MKLP) still held after Merkle's wind-down. withdraw and redeem now abort
// E_DEPRECATED; the only exit is release_mklp, which the team must whitelist per wallet. Amounts are MKLP units, left
// unpriced: release_mklp pays USDC from a store the team funds (1.0457 USDC per MKLP in June and July 2026), which held
// 3.62 USDC on 2026-10-29 against 136.5K MKLP (USDC); nothing on chain backs a price.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, transactionTime } from '../chain.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';

export const MERKLE = '0x5ae6789dd2fec1a9ec9cccfb3acaf12e93d432f0a3a42c92fe1a9d490b7bbc06';
const LZUSDC = '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC';
/** Collateral type → its MKLP coin type. The old lzUSDC MKLP has no user exit at all: release aborts E_DEPRECATED and
 *  conversion to the USDC MKLP (convert_mklp_type, migrate_all_zmklp_to_mklp) is admin-only (E_NOT_AUTHORIZED). */
export const MKLP = [
  { collateral: LZUSDC, label: 'MKLP (lzUSDC)', coin: `${MERKLE}::house_lp::MKLP<${LZUSDC}>`, userRelease: false },
  { collateral: `${MERKLE}::fa_box::W_USDC`, label: 'MKLP (USDC)', coin: `${MERKLE}::house_lp::MKLP<${MERKLE}::fa_box::W_USDC>`, userRelease: true },
] as const;
const SOURCE = 'merkle-mklp';
/** Final revenue distribution of the wind-down (announced 2026-02-03): positions were force-closed on 02-10. */
const WINDDOWN_SECS = Date.parse('2026-02-12T00:00:00Z') / 1000;

export type MklpHint = { versions: Record<string, number> };

async function read(ctx: ReadContext, ownerInput: string, hint?: MklpHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    // With an enumeration hint, only the MKLP types this owner holds are read; the whitelist only when something is held.
    let whitelisted: string | undefined;
    const types = hint ? MKLP.filter(m => hint.versions[m.coin] !== undefined) : [...MKLP];
    const found = await mapLimit(types, 2, async (m): Promise<Position | null> => {
      // coin::balance covers both the CoinStore and the paired fungible-asset store.
      const held = BigInt((await ctx.chain.view('0x1::coin::balance', [owner], [m.coin], version))[0]);
      if (held === 0n) return null;
      const changed = hint?.versions[m.coin];
      const memo = `${SOURCE}:since:${owner}:${m.coin}:${changed ?? 'none'}`;
      let since = Number(await ctx.memo.get(memo) ?? NaN);
      if (Number.isNaN(since)) {
        since = Math.max(WINDDOWN_SECS, changed !== undefined ? await transactionTime(ctx.chain, changed) ?? 0 : 0);
        await ctx.memo.set(memo, String(since));
      }
      if (m.userRelease) whitelisted ??= String((await ctx.chain.view(`${MERKLE}::house_lp::get_release_mklp_whitelist_amount`, [owner], [], version))[0]);
      const release = m.userRelease && BigInt(whitelisted ?? 0) > 0n;
      const blocker = m.userRelease
        ? { code: 'release_whitelist_required', detail: 'Merkle wound down: withdraw and redeem abort E_DEPRECATED. Only release_mklp works, after the Merkle team whitelists this wallet.' }
        : { code: 'admin_migration_required', detail: 'Old lzUSDC MKLP: release aborts E_DEPRECATED and conversion to the USDC MKLP is admin-only. The Merkle team must migrate it before any release.' };
      const units = [{ asset: m.coin, raw: held.toString() }];
      return {
        ...positionIds(SOURCE, owner, m.label, 'principal', m.coin), source: SOURCE, owner, locator: m.label, positionKind: 'principal', asset: m.coin,
        claimableSince: iso(since), ageBasis: 'protocol_closure',
        provenance: { reader: '0x1::coin::balance', ledgerVersion: version },
        grossClaim: units, expectedPayout: units, payoutBasis: 'view',
        status: release ? 'recoverable' : 'team_gated',
        blockers: release ? [] : [blocker],
        confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
        steps: [{ function: `${MERKLE}::managed_house_lp::release_mklp<${MKLP[1].collateral}>`, arguments: [],
          prerequisites: m.userRelease ? ['The Merkle team must whitelist this wallet (house_lp::get_release_mklp_whitelist_amount > 0).']
            : ['The Merkle team must first migrate this lzUSDC MKLP to the USDC MKLP, then whitelist the wallet.'], expectedOutputs: [] }],
      };
    });
    return { positions: found.filter((p): p is Position => p !== null), complete: true, errors: [], ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const merkleMklp: SourceDef<MklpHint> = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Merkle Trade',
  title: 'Merkle Trade LP (MKLP) left after the wind-down',
  summary: 'Merkle Trade wound down in February 2026. MKLP can no longer be withdrawn or redeemed; only the Merkle team can enable a release for your wallet.',
  category: 'closed_app',
  inclusionRule: 'Protocol wound down (positions force-closed 2026-02-10); MKLP exits abort E_DEPRECATED on chain.',
  protocolStatus: {
    state: 'wound_down',
    evidence: 'Wind-down announced 2026-02-03 (new positions disabled 02-06, force-closed 02-10, final distribution 02-12); managed_house_lp withdraw and redeem abort E_DEPRECATED (simulated 2026-10-19).',
    checkedAt: '2026-10-19',
    effectiveAt: '2026-02-12T00:00:00Z',
  },
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    'Contact the Merkle Trade team: old lzUSDC MKLP must be migrated by them first; then they whitelist your wallet for an MKLP release.',
    `Once whitelisted, call ${MERKLE}::managed_house_lp::release_mklp<collateral>() from the holding account.`,
  ],
  officialUrl: 'https://app.merkle.trade',
  read,
};
