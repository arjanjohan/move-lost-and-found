# What counts as "left behind"

This is the contract every source and every total follows. A source that cannot meet it is not counted.

## Inclusion rules

A position counts only if **all** hold:

- **R1 Action required.** Value reaches the owner as a spendable standard asset only through a transaction (owner or team). Liquid balances already in the wallet do not count.
- **R2 Not ordinary active.** Either:
  - the protocol is closed, wound down or deprecated, with written evidence and an effective date; or
  - the position has ended: stake cooled down, request matured, lock expired, vesting released, stream or rewards ended.

  A protocol whose official frontend has shut down counts as closed (decided 2026-10-21), even when its contract still works. The effective date is the shutdown date the team announced, taken at the end of that day; without a notice, the earliest date it can be shown to be down. Since such a contract can still take new positions, a position is aged from the later of the effective date and its own last change (deposit, order) where the source can read it; a source that cannot says why the effective date is still a safe bound.
- **R3 Recoverable to the owner.** Payout goes to the owner, not to a strategy or third party.
- **R4 No debt, no live use.** No outstanding borrow and not posted as collateral, in any protocol. In a protocol that is not closed, also: not deployed in a live strategy and no open orders. A borrower's supply or collateral in a closed or frozen protocol is still shown on the check page (`blocked`, blocker `has_debt`, with what it owes where the source can read it) so its owner sees it, but it never enters a total: a borrower's supply can be its own borrowed funds supplied again, and what it gets back is supply less debt (decided 2026-10-24).

  So in a closed protocol, positions it holds for the user count even if they are still live on chain: LP in pools that still trade, escrows, deposits, open orders. A position that backs a loan still does not count. The protocol's own tokens in the wallet are not positions and do not count.

Excluded: in a protocol that is not closed, active stake and live LP or lending (in a closed one they count, as above); anywhere, requests that have not matured yet (they count from maturity) and wallet tokens that have a market.

### Stranded liquid receipt tokens

A wallet-held receipt token counts only if all of these hold:

- Its protocol is closed or deprecated.
- Redemption needs an owner action.
- It has no usable market.

It is valued at redemption payout.

The market test:

- Provider: Panora quote API.
- Input: the exact asset identity (FA metadata address or Coin type), never a ticker. Output: APT.
- Reference input = min($1k, the holder's redemption value). Holders fall into buckets with lower bounds $0.10 / $0.30 / $1 / $3 / $10 / $30 / $100 / $300 / $1k. Each bucket is quoted once per run at its lower bound: a smaller amount has less price impact, so a market that is usable for some holder in the bucket is never called unusable (stranded value is never over-counted). The flip side: a holder near the top of a bucket trades up to ~3.3× the quoted amount and may not clear 80%, so it can be missed. Each quote stores its time and is valid for 7 days; an older verdict reads as `unknown`, and a run whose positions lack a fresh quote is `degraded`.
- Usable market = a well-formed quote with output ≥ 80% of the input's redemption value.
- No usable market = a well-formed "no route" response, or output < 80%.
- An error, timeout or malformed response → `unknown`, never "no market".

## Aging

Each position has a `claimableSince` and an `ageBasis`, taken from the first one available:

| `ageBasis` | Meaning | Counts toward left behind 90+ days |
|---|---|---|
| `onchain_maturity` | On-chain unlock, maturity, lock expiry or vesting release time | yes |
| `protocol_closure` | Effective time of protocol closure or deprecation, with evidence | yes |
| `position_interaction` | Last protocol interaction **with this position** (its object, ticket or profile); never general wallet activity | no — estimated; shown separately unless the source documents it as a conservative bound |
| `unknown` | None of the above | no — excluded from all age buckets |

The age buckets are cumulative: **≥ 30, ≥ 90, ≥ 180 days**.

## Accounting

Per position:

| Field | Meaning |
|---|---|
| `id` | `source:owner:locator:positionKind[:asset]` |
| `parentId` | `source:owner:locator`, used for grouping |
| `owner` | 32-byte address that can sign recovery. Objects resolve through the ObjectCore owner chain (cycle detection, depth ≤ 8). An owner with no signer path → `contract_held` with blocker `unsupported_owner` (decided 2026-10-22). |
| `positionKind` | `principal`, `fees`, `reward` or `request` |
| `grossClaim[]` | What the contract records as owed, raw units per asset |
| `expectedPayout[]` | What recovery pays now (reserve-limited, net of fees); `payoutBasis` is `view`, `derived` or `simulated` |
| `recoverableUsd` | expectedPayout × price. `priceSource` and `priceAt` are stored; quotes older than 7 days are unpriced; unpriced value is counted separately, never as 0. Prices are CoinGecko quotes checked against the exact asset, except staked-APT receipts without a fresh quote (stAPT, sthAPT): those are valued at redemption, the on-chain exchange rate (less any unstake fee) × the APT quote, dated like the APT quote and labeled `derived`. |
| `status` | Exactly one of `recoverable`, `team_gated` (needs an operator signature or packet), `blocked` (with `blockers[{code, detail}]`), `contract_held` (held by a resource account or an object: counted apart), `unknown` |
| `confidence` | `verified_view`, `derived_math` or `indexer_only`. `indexer_only` never enters totals. |

**Dedupe:**

- Asset rows use the key `canonicalAssetId + storageId`. A Coin row and its paired-FA row for the same store count once. Different stores of the same asset are summed.
- A receipt and its underlying are counted once, at the position.
- Owners are counted per source and globally.

**What the site counts:**

- **Claimable now:** `recoverableUsd` of every `recoverable` position, any age.
- **Left behind 90+ days:** the claimable positions aged ≥ 90 days on an `ageBasis` that counts (table above).

Face value, `blocked`, `team_gated`, estimated-age and unpriced value are reported separately.

## Snapshots

Snapshots are not atomic. Each source records:

- The indexer processor and its watermark.
- Enumeration start and end.
- The fullnode ledger range used for verification.
- Verification start and end.
- Completeness.

"Complete" means complete within a **named enumeration scope**, never chain-wide.

A known non-zero position is re-read in the run after its on-chain record changes, and in any case at least monthly. Most sources (native staking, LST requests, Thala) re-read every run. A change is anything the source's enumeration sees: a new entry-function call (including exits, claims and withdrawals), a changed table row or hint, or an owner that drops out of a full scan. The monthly re-reads are spread over four weekly runs. A position that changes without any on-chain record (for example a value that drifts with a price) can therefore be up to 35 days old; each source page shows when it was read. Recent activity only sets the order of reads, never whether a position is correct.
