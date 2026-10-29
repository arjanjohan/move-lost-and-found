# Sources — evidence log

Every counted source passes the same gate before it is added:

1. Enumeration proven, with a named scope.
2. A sanity check against the contract's own total, where one exists.
3. A deterministic, stratified **sample simulation** of the recovery call, using `spikes/07-simulate-state.ts`, seed 20261018. Results are a sample rate, not a protocol-wide success rate.

Measurement runs use a fresh local state (`pnpm snapshot --source <id> --state <tmp>`). APT was $0.77 on 2026-10-18.

| Source | Shape | Status rule | Measured (2026-10-18) | Sample simulation |
|---|---|---|---|---|
| `native-delegation` | indexer staking table | ended position (unlock done) | $680K left behind 90+ days, 7,163 owners | 20/20 ok, payout = expected; 2 owners need gas |
| `delegation-inactive-validator` | all pools → inactive validators → active-stake delegators | ended position (validator left the set); age = last reward epoch | $7.41M left behind 90+ days, 4,017 owners (1,451 ≥ $10); top wallet 12.6% | unlock 10/10 exact; 2 need gas (withdraw step: see native-delegation early-withdraw sample) |
| `thala-unstake` | entry-function senders | ended position (request matured) | $27.5K left behind 90+ days, 925 owners | 10/10 ok, payout = expected; 3 need gas |
| `kofi-withdrawals` | entry-function senders | ended position; protocol winding down | $12.8K left behind 90+ days, 287 owners | 10/10 ok, payout = expected; 1 needs gas |
| `amnis-withdrawals` | collection owners (`Amnis Withdrawal Tokens`) | ended position (lockup passed) | $938K left behind 90+ days, 397 owners; one wallet = 88% | 10/10 ok, payout = expected; 1 needs gas |
| `thala-vethl-expired` | entry-function senders (`vetoken scripts::lock`, `farming_vesting::convert_to_vethl`) | ended position (lock expired) | $13.7K left behind 90+ days, 4,852 owners (97 ≥ $10) | 10/10 ok, payout = expected |
| `thala-vesting-matured` | entry-function senders (`farming_vesting::start_vesting`) | ended position (vesting reached end_sec) | $6.2K left behind 90+ days, 2,642 owners (16 ≥ $10) | 10/10 ok, payout = expected; 1 needs gas |
| `trufin-unlocks` | one global table (`staker::Unlocks`) | ended position (request claimable); off-whitelist → team_gated | 1 request, $1.8K, 85 days old (not yet 90 days) | 1/1 ok, payout = expected |
| `movement-native-delegation` | indexer staking table (Movement indexer) | ended position (unlock done) | $2.2K left behind 90+ days, 57 owners (MOVE $0.0073) | 10/10 ok, payout = expected |
| `movement-inactive-validator` | all pools → inactive validators (Movement) | ended position | none: no inactive Movement pool holds active stake | — |
| `kofi-receipts` | primary stores holding kAPT / stkAPT | stranded receipt only if no usable market (Panora) | 0 positions: both tokens have usable markets in every bucket (97–100% of redemption) | request step 38/38 ok; finalize = kofi-withdrawals sample |
| `merkle-mklp` | stores holding MKLP (Coin + paired FA) | wound down; exits deprecated → team_gated | 9,152 team_gated positions (9,088 owners), 4 recoverable; MKLP units, unpriced | whitelisted release 4/4 ok; every team_gated sample aborts as classified |
| `merkle-vemkl` | collection owners (veMKL) | wound down; unlock works any time → recoverable | 1,340 locks (unpriced: ~496K MKL, 74K PreMKL, 15K esMKL) | 10/10 ok, payout = expected (PreMKL paid as MKL) |
| `tortuga-tickets` | entry-function senders → per-user `TicketStore` | ended position (cooldown passed); reserve-queued tickets blocked | $12.2K left behind 90+ days, 818 owners; blocked $172 | recoverable 10/10 exact; blocked 4/4 abort `EFUND_NOT_AVAILABLE_YET` as predicted |

Native delegation and Thala are documented in [phase0-report.md](https://github.com/arjanjohan/move-lost-and-found/blob/main/docs/phase0-report.md).

**Owner rule (all sources):** after each read, the pipeline classifies the owner once and memoizes it.
- An account with a zero authentication key is a **resource account**, controlled by a program.
- An address with `ObjectCore` is an **object**, also when it carries an account resource too (objects do, to hold coins, with their own address as the key; nobody holds a key for an object address). Until 2026-10-22 such objects were taken for ordinary accounts; Canopy's rsETH pre-deposit holder was one.
- Positions held by either type stay listed and count apart as `contract_held` (decided 2026-10-22), with blocker `unsupported_owner`.
- The cost is 2 requests per owner (account and `ObjectCore`), ever.

Each source page also states the largest single wallet's share of its 90+ day total. No address is published.

**Re-read schedule (all sources):**
- Owners holding something are re-read every run (native staking, LST requests, Thala, Amnis, Tortuga, TruFin, Kofi withdrawals), or at least monthly in the newer sources, spread over four weekly runs.
- Any owner is re-read in the run after enumeration shows a change. A change is a new entry-function call since the cursor (deposits, and also withdrawals, claims and unsubscribes where a source tracks them), a changed table row or hint, or an owner with positions dropping out of a full scan.
- Owners holding nothing are re-read monthly, or never where nothing can accrue any more (PancakeSwap farms after emissions ended), unless enumeration reports them again.
- A position counts as "not re-read" only once it is older than its source's own refresh window.

## kofi-withdrawals

- **Status:** wound down.
  - `config::is_winddown` became true at version 6,429,705,721 (2026-07-24 07:55:53 UTC), set by a multisig transaction. Found by binary search over archive views.
  - Deposits and staking are paused. Withdrawals and unstaking still work.
- **Enumeration:** senders of `gateway::request_withdrawal_entry` and `gateway::unstake_and_request_withdrawal_entry`, using one version cursor per function.
  - 1,258 senders, 24 pages.
  - First full run: 24 s, 1,288 requests.
- **Read:** `withdrawal_manager::get_user_tickets(owner)`.
  - A ticket counts once `unlock_timestamp` (seconds) has passed.
  - Expected payout = `apt_amount − withdraw_fees`.
  - `GlobalConfig.gateway_config.withdrawals_paused` → `blocked` (`paused`).
- **Result:** 504 unlocked tickets never finalized. $12.9K recoverable now, $12.8K waiting ≥ 90 days. 287 owners with positions ≥ 90 days, 23 of them with ≥ $10. 443 tickets are under $1.
- **Sanity:** the matured tickets found total 16.8K APT. `vault::get_unlocked_apt_balance` holds 289.5K APT (5.8% coverage), so payout is covered.
  - This is informational, not a hard ceiling: tickets can also be paid from APT still unlocking from validators.
- **Recovery:** `gateway::finalize_withdrawals_entry([ticket_id])`. 10 of 10 sampled simulations paid exactly the expected amount into the owner's APT primary store.
- **Gotcha:** event JSON prints addresses without leading zeros. Normalize addresses before comparing stores.

## tortuga-tickets

- **Status:** contracts respond; no closure notice verified.
  - The reserve (15,867.8 APT) is ~220 APT short of outstanding claims (16,087.8 APT).
  - `stake_router` has no view functions. Claimability is derived from `stake_router::claim`: the cooldown (3,600 s) has passed, the ticket's queue position is ≤ reserve + cleared claims, and its amount is ≤ the reserve.
- **Enumeration:** senders of `stake_router::unstake`. 4,460 senders, 112 pages.
  - First full run: 1 min 56 s, 4,579 requests.
- **Read:** the per-user `stake_router::TicketStore` resource.
  - Claimable since = ticket timestamp + cooldown.
  - Funded tickets → `recoverable`; unfunded → `blocked` (`reserve_short`).
  - Confidence is `derived_math`, because the result comes from the contract's arithmetic, not a view.
- **Result:** 835 recoverable tickets, $12.2K, all aged ≥ 90 days, 818 owners (79 with ≥ $10). 4 blocked tickets, $172.
- **Sanity:** the tickets found total 16,087.83 APT, against outstanding claims of 16,087.85 APT: **99.99%**. The enumeration scope captures essentially every ticket.
- **Recovery:** `stake_router::claim(index)`, where `index` is the ticket's position in the owner's list and shifts after each claim.
  - Sample simulation: recoverable 10/10, paying exactly the expected amount.
  - Blocked 4/4 abort with `EFUND_NOT_AVAILABLE_YET(0xd0005)`, exactly as classified.
- **Not counted:** wallet-held tAPT. It has a market (quoted ~11% below redemption), so it is not stranded under the rules.

## amnis-withdrawals

- **Status:** Amnis is live. Withdrawal tokens are NFTs in the collection "Amnis Withdrawal Tokens" (`0x40fb9ce6…6b8d`), created by the Amnis package.
- **Enumeration:** current owners of that collection, via `current_token_ownerships_v2` keyset-paged on `token_data_id` (5 pages, 455 owners). The token ids are passed as the read hint.
- **Read:** for each token:
  - `ObjectCore.owner` must equal the owner, otherwise the token moved and is skipped.
  - `withdrawal::WithdrawalToken` gives `amapt.value` and `locked_until_secs`.
  - Matured tokens count, payout amAPT 1:1 in APT (confirmed by simulation).
- **Result (with the owner rule):** $944K recoverable, of which **$938K is aged ≥ 90 days**, across 397 owners (267 with ≥ $10).
  - The largest wallet, an ordinary account with 415 transactions, holds 1.08M APT matured since 2025-11-26: **88% of the value left behind 90+ days**.
  - 4 positions (~$304K, mostly one resource account at 388K APT) are held by contracts (`unsupported_owner`; `contract_held` since 2026-10-22).
- **Sanity:** matured tokens found = 1,634,658 APT, which is **99.08%** of `withdrawal::total_pending_withdrawal` (all open tokens, matured or not).
- **Recovery:** `router::withdraw_entry(token)`. 10 of 10 sampled simulations, including the largest token, paid exactly the expected amount.
- **Backlog spotted:** the same wallets hold "Amnis Season 2 Airdrop" ($AMI Claim) and "Amnis Reward Voucher" NFTs. These are possible unclaimed-airdrop sources; their status needs research.

## thala-vethl-expired

- **Read:** one `vetoken::VeTokenStore<THL>` resource per owner (locked amount, `unlockable_epoch`). Two shared views per run: `now_epoch` and `seconds_in_epoch`.
  - A lock counts when `unlockable_epoch <= now_epoch`, as in `can_unlock<THL>`.
  - Claimable since = `unlockable_epoch × seconds_in_epoch`.
  - Only THL locks are counted. Locks of LP tokens need LP pricing and are not covered.
- **Equivalence:** the resource-based read was checked against the four-view read (`is_account_registered`, `locked_coin_amount`, `can_unlock`, `unlockable_epoch`). Both give the same 4,914 positions with identical amounts. Revalidation costs 4,922 requests instead of ~20k.
- **Enumeration:** senders of `vetoken scripts::lock<T>` and `farming_vesting::convert_to_vethl`. 10,745 senders, 139 pages. The first full run took 35,288 requests with the view-based read.
- **Result:** 4,914 expired locks: $16.3K now, **$13.7K aged ≥ 90 days**, 4,852 owners.
  - Value is mostly dust: 4,317 locks are under $1, and 97 owners have ≥ $10.
  - THL was $0.0099 on 2026-10-18.
- **Sanity:** no contract total exists, because locks are held per account.
- **Recovery:** `scripts::unlock<THL>()`, after claiming veTHL dividends. Sample simulation: 10/10 paid exactly the locked THL.

## thala-vesting-matured

- **Read:** the `farming_vesting::VestingBeneficiary` resource. With no claim ids, nothing more is read. Otherwise `farming_vesting::all_claims(owner)`.
  - A claim counts once `end_sec` has passed and `claimable_amount > 0`.
  - A claim still vesting is not counted, because claiming it early forfeits the rest.
  - Escrowed THL is not counted: it is not a claim until vesting starts.
- **Enumeration:** senders of `farming_vesting::start_vesting`. 4,960 senders, 261 pages; first full run 12,826 requests.
- **Result:** 3,676 matured claims: **$6.2K aged ≥ 90 days**, 2,642 owners (16 with ≥ $10). Nearly all are under $1.
- **Sanity:** no contract total exists, because claims are stored per id.
- **Recovery:** `farming_vesting_scripts::claim(claim_id)`. Sample simulation: 10/10 paid exactly the claimable THL.

## delegation-inactive-validator

- **What:** APT still staked (active) in a delegation pool whose validator has left the set (`stake::get_validator_state = 4`).
  - Inactive validators earn no rewards.
  - With the validator out of the set, `unlock` followed by `withdraw` returns the stake immediately. `can_withdraw_pending_inactive` is true.
- **Size of the problem (2026-10-18):** 124 of 174 delegation pools have an inactive validator.
  - 43 of them still hold active stake: 15.4M APT.
  - 30 of those pools show a last `DistributeRewards` event (2025-06 to 2026-10); 13 show none in the indexer.
- **Enumeration:**
  - Every pool (`current_delegated_staking_pool_balances`, 2 pages).
  - Validator state per pool (174 views).
  - For inactive pools, the `active_shares` delegators, keyset-paged.
  - Totals: 6,822 candidates, 187 pages.
- **Read:** `delegation_pool::get_stake(pool, owner)`, with the validator state re-read once per pool per run.
- **Age (`protocol_closure`):** the pool's last `0x1::stake::DistributeRewards` event (block time), or the owner's last `AddStake` in that pool if later, since stake added to an idle pool is idle only from then.
  - Memoized per (owner, pool, amount, stop time).
  - A pool that never earned a reward (none indexed; the indexer's delegation history starts at genesis) has earned nothing since it began: its stake is dated from the pool's first indexed activity, or from a later add. Only a pool with no indexed activity at all keeps an `unknown` age.
- **Blocked:** unlock aborts with `EDELEGATOR_PENDING_INACTIVE_BALANCE_TOO_LOW` when the delegator's resulting pending_inactive would be below 10 APT (`MIN_COINS_ON_SHARES_POOL`). Such positions are `blocked` (`below_unlock_minimum`): add stake to reach 10 APT, then unlock and withdraw everything. That is 12 positions, $2.
- **Result:** $11.0M claimable now. **$7.41M has been idle ≥ 90 days**, across 4,017 owners (1,451 with ≥ $10).
  - The largest wallet holds 12.6% of the value left behind 90+ days.
  - ≥ 180 days is only $96K, because most of the value sits in pools that stopped in 2026.
  - 3 positions held by resource accounts ($359K) are `unknown`.
  - 2,123 positions ($313K) have unknown age.
- **Concentration:** the largest pool (`0x52561f4a…`, 9.76M APT, last reward 2026-06-12) has 66 delegators. 11 ordinary accounts with similar profiles (4–7 transactions each, 0.48–1.26M APT) hold 98% of it, which looks like one institution's wallets.
- **Sanity:** per pool, the delegators' active stake found does not exceed `stake::get_stake(pool).active`. 43 pools, 0 violations.
- **Recovery:** `delegation_pool::unlock(pool, amount)`, then `delegation_pool::withdraw(pool, amount)`.
  - Sample simulation of the unlock step (`spikes/08-simulate-unlock.ts`, seed 20261018): 10/10 unlocked exactly the active amount, including the largest position (2.03M APT). 2 owners need gas.
  - The withdraw step after an unlock in an inactive pool is the `pending_inactive_early` case of `native-delegation`, sampled 10/10.
- **Cost:** the first run takes 23,776 requests (ages and owner kinds). Re-reading costs 7,423.

## trufin-unlocks

- **Shape:** global table. Every TruFin unlock request sits in `staker::Unlocks`, one SmartTable read bucket by bucket at a pinned version. A read that does not reach `size` entries is an error, never "no request".
- **Read:** `staker::is_claimable(nonce)`.
  - Withdrawal requires TruFin's whitelist (`master_whitelist::is_whitelisted`). Owners off it are `team_gated` (`not_whitelisted`).
- **Age:** the moment the request's pool lockup cycle (`olc`) ended, i.e. the first version whose `DelegationPool.observed_lockup_cycle.index > olc`.
  - Found by binary search over archive reads; valid because that index only grows.
  - Memoized per (pool, olc).
- **Result (2026-10-18):** 1 pending request, 2,411.4 APT ($1.8K), claimable since 2026-07-25, whitelisted. It counts as left behind 90+ days from 2026-10-23.
- **Cost:** 49 requests on the first run, about 10 after that.
- **Recovery:** `staker::withdraw(nonce)`. Simulation 1/1, exact payout.

## Movement

- The native delegation and inactive-validator sources are the same code as on Aptos, with chain-specific endpoints and asset ids.
  - Movement reads use its public fullnode and indexer, with no credentials. The Geomi key goes to Aptos Labs hosts only.
  - Movement's fullnode keeps full history (oldest version 0), so it also serves the historical reads used for aging.
- **Asset identity:** native MOVE is FA `0xa` on Movement, the same address as APT on Aptos. It is stored as `movement:0x…0a` so prices and totals never mix. Priced via CoinGecko `movement`.
- **movement-native-delegation (2026-10-19):** 121 candidates, 112 withdrawable positions, $2.4K now, **$2.2K aged ≥ 90 days**, 57 owners.
  - 4 positions ($481) held by resource accounts are `unknown`.
  - Sanity: 4 pools, 0 violations. First run: 572 requests.
- **movement-inactive-validator:** no Movement pool with an inactive validator holds active stake. The source stays, so new cases are picked up.
- **Simulation:** Movement credits the native coin through legacy `0x1::coin::DepositEvent` handle events, identified only by the owner's event handle; the simulator accepts those for the native coin. Recoverable 10/10 exact, plus 4/4 resource-account positions (which simulate, but cannot be signed).

## canopy-ended-rewards (Movement)

- **What:** staking rewards on Canopy (`0x113a…::multi_rewards`) earned in a reward period that has ended and were never claimed. Each pool streams a reward token until its `period_finish`; what a staker earned stays in the pool until claimed. Rewards of pools still streaming are excluded.
- **Status:** live. Movement acquired Canopy in May 2026. On 2026-10-19, 22 of 56 registered pools are streaming and 34 have ended. All rewards are MOVE.
- **Enumeration:** every key of `MultiRewardsModule.user_staked_balances` (the staker's address; the indexer does not decode it), incremental by version. 7,497 stakers in 82 pages on Movement's public indexer.
- **Read:** one view per staker, `rewards_view::get_user_pool_positions`, with each pool's reward periods (`get_reward_token_details`, read once per run).
  - A staker who left a pool (`is_subscribed = false`) cannot claim its accrual through `claim_reward`: `blocked` (`unsubscribed`). None found.
- **Result (2026-10-19):** 5,620 `recoverable` positions, 4,925 stakers, **$4.8K** (MOVE at $0.0072), all aged ≥ 90 days; 15 stakers with ≥ $10. Sanity: the ended pools hold 669K MOVE; the earned amounts are part of that.
- **Recovery:** `multi_rewards::claim_reward(staking token)`. It claims every subscribed pool of that staking token, live ones included. Sample simulation: 12/12, paying exactly the expected MOVE; 1 needs gas.
- **Re-read schedule:** monthly, or when a stake changes or the staker claims or unsubscribes. First run: 12.6K requests, all to Movement's public endpoints.

## canopy-frozen-vaults (Movement)

- **What:** shares left in Canopy vaults that Canopy closed to deposits, held in the wallet or staked in Canopy's rewards pools.
- **Rule:** a vault whose deposit limit is 0 or that is paused counts as frozen (decided 2026-10-21), like Echelon's frozen markets. Both close deposits; withdrawals stay open by design.
- **Wind-down (checked 2026-10-28):** Canopy is in maintenance-only mode (app.canopyhub.xyz/maintenance-mode).
  - New deposits are closed as of 2026-10-19.
  - The app and active support retire on 2026-12-22.
  - The vault contracts stay live and withdraw-capable, with no withdrawal deadline.
  - A self-custody guide (app.canopyhub.xyz/withdrawal-guide) gives the router call for each vault. It still carries draft `[CONFIRM: …]` notes, one saying Canopy may move the MovePosition vaults' assets back to idle before 2026-12-22, so they would no longer need a packet. Re-check after that date.
- **Status (checked 2026-10-21):** all 47 vaults are frozen, by deposit limit; none is paused. Canopy's admin multisig set the limit to 0 on 42 vaults in one transaction on 2026-10-16 14:40 UTC (`SetDepositLimit` events), on one more that afternoon, and on four (two rsETH vaults, the rsETH-WETH LP vault, a Meridian LP vault) on 2026-06-16. Before that the vaults had no limit. Movement acquired Canopy in May 2026. Aged from the vault's freeze, or from the owner's own later change of that vault's shares: the share store's last change, or its last stake or withdrawal of those shares after the freeze (multi_rewards' `StakeEvent` / `WithdrawEvent` / `EmergencyWithdrawEvent`, scanned from 2026-06-16; ~1.1K events, 11 pages, on 2026-10-22). The staking table has one row per staker, so its version alone would re-date every vault the staker holds. Shares that differ from those at the lowest of the fungible-asset, default (staking table) and events processors' watermarks (taken before the scans) changed after them, and a stake whose transaction is not indexed yet has no time: either way the age stays unknown for that run.
- **Positions:** per frozen vault, the owner's wallet shares (`primary_fungible_store::balance`) and staked shares (`multi_rewards::get_user_staked_balance`) as separate parts (locators `vault` and `vault/staked`), each valued with `vault::shares_to_amount` and aged on its own: wallet shares from the store's last change, a stake from its last stake or withdrawal. The staking pool's own store is left out: its shares are the stakers'. Those are the only share stores that are not primary (26, all held by the rewards state account `0x9ffd…7ee0`, 2026-10-23), so wallet shares are read from the primary store. Shares an owner holds in a secondary store would be shown as `unknown` (`secondary_store`, not counted): withdrawing them takes a transfer into the primary store first. Each vault is read on its own, so one failing leaves the others readable (the read is then incomplete). Without an enumeration hint (the check page) there is no history to date the shares, so the age is unknown.
- **Recovery (Canopy's guide):** `multi_rewards::withdraw(shares token, amount)` for staked shares. Then `router::withdraw_fa_with_coin_type<0x1::aptos_coin::AptosCoin>(vault, [], [], shares, some(100), some(0))`; the guide lists the exceptions, which the source holds as a table: `withdraw_coin<MOVE, MOVE>` for two MOVE lending vaults, `withdraw_coin<LP, LP>` for the Liquidswap rsETH-WETH vault, and Meridian placeholder coin types for nine Meridian pool vaults.
- **Withdrawal check (simulated 2026-10-28 with the guide's call, each vault's largest wallet holder, all its shares):**
  - Works for 16 vaults: sUSDa, rsETH-32, MOVE-2 (LayerBank), the Liquidswap rsETH-WETH vault, WETH.e-9 (not in the guide; its default call), and 11 Meridian pool vaults (MER-LP-19, 24, 31, 33, 36, 37, 39, 40, 41, 42, 44). `recoverable`.
  - Aborts, `blocked` (`withdrawal_aborts`):
    - `EINVALID_SHARES_FACTORS`: MOVE-0, MOVE-45, USDC.e-11, USDT.e-12, WBTC.e-14 (Echelon lending) and MOVE-15, USDC.e-3, USDT.e-4 (MovePosition).
    - `EINSUFFICIENT_BALANCE`: LBTC-21, SolvBTC-27, WETH.e-13 and MER-LP-16, 18, 29, 30.
  - `EOPTION_NOT_SET` without a packet: ezETH-20, rsETH-26, WETH.e-5 (MovePosition). `team_gated`.
  - No wallet holder: MER-LP-38 and stBTC-25 keep their 2026-10-21 result; the 11 vaults outside the guide other than WETH.e-9 hold no shares.
  - Compared with 2026-10-21 (the earlier call, `router::withdraw_fa` with the vault's withdrawal map and a 0.1% loss cap): seven Meridian vaults that aborted `EUNKNOWN_STRATEGY` now work, MER-LP-16 aborts `EINSUFFICIENT_BALANCE` instead, and four vaults never simulated before (MOVE-2, rsETH-32, WETH.e-9 work; SolvBTC-27 aborts) have a result.
- **Withdrawal check (2026-10-21, superseded; a real holder's shares, the vault's own withdrawal map):**
  - Works: sUSDa, the rsETH-WETH LP vault and five Meridian LP vaults. Unstaking works too (a MOVE-0 staker). sUSDa (`0xe699…9258`) has no price bound to its identity (CoinGecko lists no Movement sUSDa, 2026-10-23), so its payout is counted as unpriced.
  - Needs a MovePosition price packet that the Canopy app supplies (rsETH, ezETH, WETH.e-5): `team_gated` (a packet from the operator, per the status rule in left-behind.md), with the payout kept; not simulated end to end.
  - Aborts in the vault (`EINVALID_SHARES_FACTORS`), also for 1 MOVE of shares and with any option values: every MOVE vault, the USDC.e and USDT.e vaults, WBTC.e-14. Their strategies report a fraction of what the vault lent them (MOVE-0: ~8,990 of 833K MOVE); a keeper script pulled funds out of ~170 strategy positions at 08:07 that day, before the freeze. The last successful MOVE-0 withdrawal was 2026-10-15. `blocked` (`withdrawal_aborts`).
  - Aborts in the strategy: `EINSUFFICIENT_BALANCE` (WETH.e-13, LBTC, four Meridian LP vaults), `EUNKNOWN_STRATEGY` (seven Meridian LP vaults, not supported by the router). `blocked`.
  - Vaults with no holder to simulate with (MOVE-1, SolvBTC, rsETH-32 and other dust vaults): `unknown`.
  - The check is a table in the source; re-simulate when Canopy changes anything.
- **Held by a contract:** the rsETH vault's shares (233.5 rsETH, ~$635K) and the rsETH-WETH LP vault's are held by Canopy's pre-deposit contract (`0xbc59…::single_asset_base_deployer` / dual-asset), on behalf of contributors who claim with `claim_relevant_assets_with_move_address`. Counted as `contract_held` (decided 2026-10-22): shown with the vault's other holdings. rsETH is priced with CoinGecko's `kelp-dao-restaked-eth`, whose Movement platform address is this asset. Contributions never claimed there are a separate lead.
- **Rehearsal (2026-10-21, Movement's public endpoints):**
  - Sized from aggregates (staked shares in the staking pool's stores plus wallet shares, valued with `shares_to_amount`): stakers and wallets hold **~1.22M MOVE (~$9.2K at $0.00755)**, all in vaults whose withdrawal aborts, so `blocked`. Recoverable and priced: ~$15 (sUSDa). The rest is Meridian and LS05 LP tokens, which have no price here.
  - The source's read on every wallet holder plus 200 stakers: positions in 30 vaults, each with the status above; owners that are contracts (the pre-deposit holders) are `contract_held` through the owner check.
- **Cost:** enumeration is ~80 indexer pages (the staking table in 16 key ranges, plus share holders). A read is one positions view, one staked-balance view per subscribed vault token and one wallet view per held token, then two views per position; ~7.5K stakers, refreshed monthly, all on Movement's public endpoints.

## Sized and not added

- **Wapal (Aptos NFT marketplace and launchpad, by Mokshya):** a collection or token offer is an object owned by its creator, escrowing the price in `CoinOffer<coin>`; past `expiration_time` only the creator's `cancel` returns it, so an expired, uncancelled offer is an ended position. The marketplace package (`0x584b…58c9`, from mokshyaprotocol/marketplace) took 253,159 offers (86,943 + 86,577 collection, 14,492 + 65,147 token; 2023-08 to 2026-05-12). Sample of every 200th (1,267, 2026-10-22): each offer's object from its transaction's touched accounts (`account_transactions`, the one its sender owns in `current_objects`), then on chain. 936 still hold coins, all expired (2023-11 to 2025-11), 13.8 APT in all: ~2,750 APT (~$2.1K) over ~187K offers, ~0.015 APT each; 900 creators among the 936, the largest 5.5 APT. Nearly all under the 0.25 APT dust line per creator, and a full read would take ~250K requests: too small. wapal.io's origin no longer answers (Cloudflare 522, 2026-10-22; last archived 2026-04-30).
- **Aptos Foundation's 2024 project list (aptos-foundation/ecosystem-projects, README before 2024-09):** compared with this list. Sites gone, checked 2026-10-23 (see the registry): SeaShrine (too small: no offers ever; ~105 APT of creators' launchpad proceeds), Metaspacecy (testnet only), Seam Money (never deployed), Aptopad (never launched), Proton Sale (too small). Meeiro's launchpad contract is still not located: the archived site is a landing page naming no contract, and its MEE token has no market. Live or holding no user claims: the rest (bridges, wallets, games, tooling).
- **Streamflow (Aptos token streams, live):** a stream that ended with funds the recipient never withdrew is an ended position (`protocol::withdraw` by the recipient). The package (`0x9009…51b0`) keeps each stream as a `protocol::Contract<coin>` at its own escrow address, named in the create transaction's `ContractCreated` event (2,869 streams by 423 senders, 2022-12 to 2025-11). Sample of every 5th stream (574, 2026-10-22): 219 ended 90+ days ago, not closed, with funds left; 176 of them stream a test coin. The rest: 11.25 APT, ~4,780 PROPS, dust USDC and two memecoins with no route anywhere (Panora). Scaled up: ~56 APT and ~23.9K PROPS (Panora: ~191 APT), ~$190. Too small.
- **Aptos ecosystem directory (aptosnetwork.com/ecosystem/directory, downloaded 2026-10-22):** its 128 featured projects (up to 6 per category) were compared with this list. DeFi, bridges, marketplaces, stablecoins and payments are covered or hold no user claims: Ekiden is live (added); the rest are exchanges, custodians, on/off ramps, asset managers' tokenized funds, wallets, tooling and media. Circle's CCTP is in the bridges table. Movement's own ecosystem page (movementnetwork.xyz/ecosystem, 2026-10-22) features Avant, Canopy, Circle, Echelon, Juicyway and KAST: Avant's savUSD on Movement is a bridged wallet token; Juicyway and KAST are payment infrastructure.
- **Movement's AirdropSystem (`0x4500…7f01`, 8.1M MOVE):** an operator pushes airdrops to recipients (`process_airdrop`, admin only); nothing waits for a claim, so the balance is the distributor's own.
- **Echelon farming rewards (Aptos):** 5 of 7 reward programs have ended: USDC 2025-08-23, Amnis amAPT 2025-10-13, Kofi kAPT 2026-02-21, Goblin stAPT 2026-04-12, Thala sthAPT 2026-08-17. Unclaimed amounts are bounded by what the package holds to pay them: 3,540 USDC and 95 kAPT (~$3.6K). Reading every Echelon supplier for that is not worth it. Skipped.
- **Echelon farming rewards (Movement):** the only reward ("Move Coin") last ran 2026-05-18 → 06-02, so every unclaimed reward is from an ended period. But Echelon holds only 296K MOVE (~$2.1K) to pay them, which caps the total. Too small for a new enumerator (stakers are senders of Echelon's `scripts::supply*`).
- **Meridian farming (Movement):** staked LP is live principal; the extra rewards are MOVE. Not sized further.
- **AUX Exchange:** the team ceased development on 2023-03-17 (status update in its GitHub repo), but aux.exchange still loads. Its 69 AMM pools hold ~2,400 APT plus small stablecoin and meme-coin reserves (~$5K in total), and the CLOB vault took only 2,796 deposits ever. LP stays withdrawable and the site is up, so it is not stranded. Skipped.
- **Mirage Protocol (Aptos and Movement, mUSD vaults):** the team reportedly announced its closure (Cryptorank, pointing to mirage.money/vaults). DefiLlama shows ~$714 of TVL left. Skipped.
- **Yuzu (Movement):** the only whitelisted reward token is MOVE; incentives are worth too little to track.
- **Echelon frozen markets (Movement, 2026-10-20):** 3 of 11 markets in the core package (`0x6a01…`) are frozen (collateral factor 0, borrow cap 0): Lombard LBTC, SolvBTC and KelpDao rsETH. Together they hold ~0.01 rsETH (~$40). Not worth a source. The isolated-pairs package (`0x452b…`) has no frozen-market concept.
- **MovePosition (Movement) and Superposition (Aptos):** withdrawals need a packet signed by the protocol's service, and both services still issue packets (aptos-script, 2026-10-08). Live protocols, not left behind.
- **Fliq (Aptos prediction markets):** winnings on a settled question that were never redeemed are an ended position (R2), and `connector::redeem` needs no operator. But the collateral wrapper's account holds 4,200 USDt in total (2026-10-20). That backs every open position, free collateral and unredeemed winning together, so unredeemed winnings are only a part of ~$4.2K. Skipped.
- **Joule:** live. Withdrawals need fresh Pyth price updates, which require a paid Pyth key; that is a cost of using it, not a closure.
- **No closure notice found (web search, 2026-10-20):** Abel Finance, BlueMove (its Sei marketplace closed in 2023; Aptos was not affected).
- **Auro Finance (Aptos CDP):** closed; now a source (`auro-closed-positions`).
- **DefiLlama "dead" flags (checked 2026-10-20):**
  - ABEL Finance (~$206K TVL) is still used: mints, borrows and redemptions until 2026-10-17 (checked 2026-10-21).
  - Meso Finance is still used: deposits until 2026-09-23, withdrawals until 2026-09-14, every pool unpaused and accruing interest.
  - Emojicoin.fun: closed. The team decommissioned the frontend on 2025-09-04 (21:00 UTC); the repository was archived on 2025-08-29 and emojicoin.fun no longer resolves. The contract still works and its markets still trade; under the closed-frontend rule its LP and Arena escrows count (decided 2026-10-21). Too small (2026-10-22): LP from 764 providers sits in 62 markets; every holder per market (paginated) gives 438 holdings of 332 owners, whose share of each pool removes for 350.0 APT (`simulate_remove_liquidity` over the providers' holdings agrees: 349.8 APT). Their emojicoins sell for 335.8 APT on Panora (all 58 markets with any; no quote above pool price), so the LP is worth ~686 APT (~$530). The 2026-10-21 figure (~748 APT, one holder 423 APT) did not reproduce, and no liquidity was added or removed since 2026-10-20. The markets' own LP, locked when they left the bonding curve (58 markets, ~34K APT of reserves), has no signer. Arena escrows hold ~182 APT of emojicoins at spot (285 escrows, 173 owners).
  - Earnium: closed (frontend gone); now a source (`earnium-closed-lp`).
  - Arche Protocol (Movement, MSD stablecoin, checked 2026-10-21): closed. archeprotocol.xyz, the site OneKey lists, is for sale; Wayback last shows it served on 2026-04-12, and the contract's last call was on 2025-09-28. But its 501.3K MOVE (~$3.8K) backs open MSD loans: 538 of 564 positions with collateral carry debt (R4); the 26 debt-free ones hold 39 MOVE. Too small. Movement's indexer leaves `entry_function_contract_address` empty, so depositors came from the Arche account's transactions (4,011) looked up by version.
  - Dead AMMs, bounded on every side (2026-10-22): coins Panora prices are valued at its quote for 1% of the reserve, scaled up (about pool price, so an upper bound on a sale); a coin with no route anywhere sells only into the DEX's own pools, whose APT and stablecoins are counted already. Too small: BaptSwap (closed, no domain resolves; 12 pools, 91 APT, $38 of stablecoins, ~5 APT priced; ~$115), AtoDEX (8 pools, 15 APT, $7, ADXT ~115 APT; ~$110), Jujube (expired domain; 10 pools, 17 APT, $2, JUJUBE ~12 APT; ~$25). HoustonSwap (concentrated liquidity, ~$8.2K in user positions) is now a source (`houston-closed-lp`). Small or not left behind (on chain, 2026-10-21): AptosLaunch is closed and its lock-bond pools hold ALT, but every market for ALT together pays at most ~84 APT (~$65) however much is sold (Panora, 2026-10-22); Lotto Run's pots hold 14 APT; MoveGPT's staking pools hold ~$6 of MGPT. MovePump's 175 bonding curves hold 757.5 APT, but holders keep their tokens in their wallets and the curve is their market.
  - Live (frontend serving its app, 2026-10-21), so their liquidity, vaults and positions are in live use: LiquidSwap, Cetus CLMM, Sushi (Aptos), Obric, TsunamiX (despite DefiLlama's dead flag), Decibel, AGDEX, Yield AI, KAIO, GoAPT, MoneyFi, Eternal Finance, NewrlRWA, Bridgers.
  - Ended but small: Propbase's fixed-term "Summer 2025" staking pool ended 2026-05-13 with ~139K PROPS (~$860) of principal unclaimed; the pool holds 439K PROPS (~$2.7K) in all, principal and rewards (its membership staking has no end); MoveFlow's stream escrow holds ~$3.
  - Collex (Aptos, card packs; checked 2026-10-21): collex.fun no longer resolves (served until at least 2026-02). Its treasury holds 19,484 USDt, but users' claims are its USD token (supply 1,135) and the cash-out value of their cards (total card value $1,229, 15% fee): at most ~$2.3K. Too small.
  - AnimeSwap: closed (frontend gone); now a source (`animeswap-closed-lp`).
  - Aptoswap: live. aptoswap.net is up and its APT pool last traded 2026-10-20.
  - Thetis Perps: thetis.market is parked for sale; AptosLaunch: aptoslaunch.io redirects to an unrelated site (2026-10-21). Both closed under the rule, both too small (2026-10-22): Thetis's account and pools hold $931 of USDt and ~1 amAPT (its own T_APT, T_WETH and T_WBTC have no route anywhere and nothing on Thetis backs them); AptosLaunch's ALT is worth at most ~$65 (above).
  - BlueMove staking: ~16.5M of BlueMove's own MOVE token sells for ~405 APT (~$315; every market together pays at most ~460 APT; Panora, 2026-10-22). Too small whether or not its stakes have ended.
- **Mole** (Aptos leveraged yield farming, checked 2026-10-21): app.mole.fi is empty in Wayback's 2026-10-20 capture (200s until 2026-02-18) and does not respond; its GitHub repository is gone. No notice found, so closure dates from 2026-10-20 at the earliest.
  - Lending vaults (`0x3d16…703d::vault`) hold ~51 APT and ~400 USDC in all; interest last accrued between 2024-03 and 2024-12.
  - DefiLlama's $203K sums the workers' `total_balance` counters, several of which exceed their pool's whole LP supply (up to 44×), so it is not a measure. The one plausible holding is ~3.7% of PancakeSwap APT/USDC: ~9,400 APT + 7,700 USDC (~$15K).
  - Positions (`PositionStore` table: worker, owner, debt_share) with debt are excluded (R4). Whether closing one needs Pyth (stopped on Aptos 2026-04-30) is not checked. Not built yet.
- **Movement DEXes** (2026-10-21): Interest Protocol's 11 pools hold ~1.5 MOVE plus dust (too small); Mosaic's frontend is up (live).
- **Argo, Laminar Markets:** no closure notice found (Laminar was merged into Econia in 2023).
- **Amnis AMI vesting** (`0xbc99…::token_vesting`, buckets airdrop / KOL / seed / private / team / …): vested AMI that claimers never took (e.g. the KOL bucket, 156 claimers, fully vested 2025-12-23) would count. But AMI trades at $0.00084 (market cap ~$515K), so even millions of unclaimed AMI are worth a few thousand dollars. Skipped. The AMI lock pools from the June 2025 campaign were not found on chain.
- **ThalaSwap v1:** no deprecation notice and still trading, so v1 LP is live liquidity (R4).
- **Hyperion fridge** (delayed LP withdrawals): `fridge::asset_unclaimed_all()` reports 4.70 APT in total across all users, about $3.50. Too small to maintain.
- **Superposition** (Aptos lending): not left behind. Its markets are unpaused and still used (last deposit 2026-10-14). Operator-signed packets are its normal app flow, not closure evidence.
- **Validator-owned stake pools** (not delegation pools; re-sized 2026-10-20, 378 pools):
  - Two resource-account pools outside the validator set hold **14.4M and 4.1M APT** of active stake, with lockups ending 2026-10-31 and 10-22. They look like institutional `staking_contract`/vesting pools between validator setups, not abandoned funds, and would roughly double the value left behind 90+ days. Not counted without evidence of abandonment.
  - Active validators hold small withdrawable inactive stakes (334–3,410 APT each): normal operator flow.
  - About 30 small pools outside the set hold 1.5–855 APT each, with lockups that ended in 2023–2026. Owners are `staking_contract` or vesting resource accounts (the owner rule makes them `contract_held`); tracing each to its staker or shareholders is not worth it at this size.
- **Moar farming rewards:** paid in Moar's own token, which has no CoinGecko price, so the value would be unpriced. Skipped.
- **Amnis "$AMI Claim" NFTs:** a marker with an `is_claimed` flag; the tokens were paid through an off-chain claim portal. No on-chain claim exists.
- **"Amnis Reward Voucher" NFTs:** phishing. They point to `pamnis.com`, and the creator account has no contract.

- **Tapp Exchange** (wound down; reported full operation until 2026-05-31): the router has every hook paused (`paused_hooks = 0x020304`), so liquidity removal is blocked.
  - Of 5,022 pools, most are meme-token launch pools.
  - The main stable and APT pools hold under $20 (USDt/USDC ~$4; APT/USDC ~10 APT + 8 USDC).
  - A full sizing needs ~5,000 single-pool reads, because the paginated view hits the read limit, and could only ever add to `blocked`. Skipped.
- **Econia:** now a source (`econia-idle-accounts`), after new closure evidence on 2026-10-20.

- **Echo lending:** reports describe Echo moving BTC-bridge liquidity off Aptos, but no closure or withdrawal deadline was found. Not R2.
- **Kana perps** (`blocked`, payout $0): every market is deprecated and the collateral stores hold no USDt, so recorded balances are face value only. There are 13,408 depositors (senders of `perpetual_scripts::deposit*`), and sizing them needs ~3 reads each (~40K requests) for value that never reaches a total besides "may not work". Skipped; Aptin is treated the same way.

## kofi-receipts

- **Market test (2026-10-19, Panora public API key):** quotes into APT per value bucket (quoted at each bucket's lower bound; cached per run; valid 7 days; since 2026-10-20 in 3× steps from $0.10 to $1k). Every bucket was usable for both tokens:
  - kAPT: 99.91–99.99% of redemption value.
  - stkAPT: 97.0–99.93%.
- Under the rules, a wallet token with a usable market is not left behind, so the source currently yields **0 positions**.
- When every bucket is usable, the run skips reading holders altogether: 124 requests instead of ~11.7K. If the markets dry up, holders are read again and those without a usable market become `recoverable` (stranded).
- The verdicts are published in `snapshot.markets`; the check page applies them without calling Panora.
- **History:** before the market test, every position was `unknown` (`market_check_unavailable`).
- **Why it was added before the test:** Kofi is winding down (evidenced). kAPT and stkAPT can still be redeemed for APT through a withdrawal ticket. They count as left behind only if stranded, and no quote provider is configured, so every position is `unknown` (`market_check_unavailable`) and not counted. Holders who check an address still see that they must redeem.
- **Enumeration:** primary stores (the only stores entry functions spend) holding kAPT or stkAPT, keyset-paged on `storage_id`. 117 pages, 8,063 owners. The hint carries each store's last change version.
- **Read:** `primary_fungible_store::balance`.
  - Redemption value: kAPT 1:1 in APT; stkAPT × `rewards_manager::get_exchange_rate` / 1e8 (1.0856 on 2026-10-19).
- **Age (`protocol_closure`):** the later of the wind-down (2026-07-24 07:55:53 UTC) and the holder's last balance change. A holder who bought after the wind-down is dated from the purchase.
- **Result (2026-10-19):** 11,619 positions, ~$98K redemption value. Sanity: user primary stores hold 89.11% of the kAPT supply and 99.77% of the stkAPT supply.
- **Re-read schedule:** every run (owners with positions) and weekly (others), because positions rest on market quotes that are valid for 7 days. While every bucket has a usable market, holders are not read at all; once a market dries up, a run reads ~11.6K holders.
- **Recovery:** `gateway::request_withdrawal_entry(amount)` for kAPT, or `gateway::unstake_and_request_withdrawal_entry(amount)` for stkAPT. Then `finalize_withdrawals_entry([ticket])` after 14 days.
  - Request step sample: 38/38 succeed across the four variants.
  - The finalize step is the `kofi-withdrawals` sample (10/10 exact).
- **To count it:** a market test, Panora per the rules, which needs the owner's decision on a key.

## merkle-mklp

- **Status:** Merkle Trade wound down.
  - Announced 2026-02-03: new positions disabled 02-06, force-closed 02-10, final distribution 02-12 (secondary reports: Whale Alert, The Defiant).
  - On chain (simulated 2026-10-19): `managed_house_lp::withdraw` and `redeem` abort `E_DEPRECATED`. The last user `withdraw` was on 2026-03-06.
- **Routes left:**
  - MKLP (USDC, `fa_box::W_USDC`): `release_mklp<W_USDC>` works only for wallets the team whitelisted (`house_lp::get_release_mklp_whitelist_amount > 0`). It succeeded in 4/4 whitelisted samples and aborted for every non-whitelisted one.
  - MKLP (lzUSDC): no user route. `release_mklp<lzUSDC>` aborts `E_DEPRECATED`, and both conversions to the USDC MKLP (`convert_mklp_type`, `migrate_all_zmklp_to_mklp`) are admin-only (`E_NOT_AUTHORIZED`). Always `team_gated` (`admin_migration_required`).
- **Value:** MKLP units only, unpriced. The protocol's `highest_price` is a historical high-water mark, not current backing. `release_mklp` pays native USDC from a store the team funds (`0xecea…b0e0`): the last two releases (June and July 2026) paid 1.0457 USDC per MKLP, but the store held 3.62 USDC on 2026-10-29 against a supply of 136.5K MKLP (USDC) and 443.5K MKLP (lzUSDC). Nothing on chain backs a price (checked 2026-10-29).
- **Enumeration:** stores holding either MKLP type, in Coin or paired-FA form. 93 pages, 9,132 owners.
- **Result (2026-10-19):**
  - 9,152 `team_gated` positions (9,088 owners). 4 `recoverable` (whitelisted). 41 `unknown` (contract-held).
  - Sanity: holders hold 99.89% of the MKLP (lzUSDC) supply but only 10.47% of the MKLP (USDC) supply; the rest is held elsewhere.
- **Re-read schedule:** monthly, or when a holder's store changes. The first run took 45.8K requests; a re-read takes 10K.

## merkle-vemkl

- **Status:** Merkle Trade wound down (see merkle-mklp). The announcement says staked MKL can be redeemed after the final distribution (2026-02-12).
  - On chain, `managed_staking::unlock` succeeds even for a lock whose `unlock_time` is still in the future (one due 2026-12-03, simulated 2026-10-19). Every remaining lock is recoverable now.
- **Enumeration:** owners in the veMKL collection (`0xe101e80f…3216`), keyset-paged on token id. 14 pages, 1,366 locks, one per owner.
- **Read:** `staking::VoteEscrowedMKL` per token (owner checked through ObjectCore), and the lock's two fungible stores.
  - Locked PreMKL is paid out 1:1 as MKL from Merkle's community pool (`mkl_token::MklClaimEve`). The gross claim stays in PreMKL; the expected payout is in MKL.
- **Value:** unpriced. CoinGecko's MKL quote was last updated 2026-05-04, older than the 7-day rule.
- **Result (2026-10-19):** 1,340 `recoverable` locks. 26 contract-held locks are `unknown`. They hold about 496K MKL, 74K PreMKL and 15K esMKL.
- **Age:** from the wind-down (2026-02-12), or the lock time if later.
- **Recovery:** `managed_staking::unlock(token)`. Sample simulation: 10/10, paying exactly the expected MKL (and esMKL); 2 owners need gas.
- **Re-read schedule:** monthly, or when the collection's owner list changes. The first run took 6.8K requests.

- **Aave on Aptos:** see `aave-frozen-reserves` (dormant until a reserve freezes).
- **Ditto (stAPT):** no closure notice; last social activity in Dec 2023. stAPT is backed by 45.7K APT (`DittoPool.total_aptos`). The delayed-unstake queue is empty: 13 requests ever, `total_pending_claim` 0, 0.22 APT in `claim_pool`. Redemption still works through `delayed_unstake` plus permissionless `update_ditto_state`/`distribute_unstaked_coins`, so stAPT is not stranded under R2.
- **Cellana (veCELL):** CELL is quoted at $0.00006 (stale), so expired locks are worth nothing. Skipped.
- **Celer cBridge tokens:** no closure evidence found; the peg bridge still mints.

- **Merkle protocol rewards** (`protocol_reward::EpochReward<T>` tables, read through `current_table_items`): only 1,003 MKLP (USDC) units are unclaimed across 3 epochs (Jan–Feb 2026), paid in MKLP, which itself needs the team. Too small to add.
- **Thala MOD** (CDP vaults and stability pool): no deprecation notice found.

## layerzero-claimable

- **What:** LayerZero v1 transfers to Aptos that arrived while the receiver could not take the coin (no CoinStore registered). The app credits a claimable table instead; the receiver collects with a claim call.
  - LayerZero Aptos Bridge (`0xf22b…::coin_bridge`): lzUSDC, lzUSDT, lzWETH, lzWBTC, lzUSDD. Table `CoinStore<T>.claimable_amt_ld`; claim `coin_bridge::claim_coin<T>()`.
  - Shared OFT module (`0x43d8…::oft`): CAKE and BTC.b. Table `oft::CoinStore<T>.claimable_amount` at the coin's address; claim `oft::claim<T>()`.
- **Status:** live. Claims still work (see simulation).
- **Enumeration:** every entry of the 7 claimable tables (`current_table_items`), incremental per table by version. 254,920 receivers, 3,135 pages; the first full scan takes ~15 min (16 key ranges in parallel).
  - The indexer stores table handles zero-padded to 64 hex digits; the fullnode returns them without leading zeros. Unpadded, CAKE's table looked empty.
  - The indexer keeps some claimed entries as live (2 of the top 20 BTC.b entries were already claimed on chain), so every counted entry is re-read on chain.
- **Dust:** entries under ~$1 (`verifyMin` per coin) are not read on chain. They are listed as `indexer_only` and stay out of every total: $31.6K across ~213K entries.
- **Age:** the time the bridge wrote the entry (`onchain_maturity`). Write times are fetched 100 versions per query. All verified entries were written 2022–2025.
- **Published (CI run, 2026-10-19):** complete. **$263.7K** recoverable and left behind 90+ days, 41,461 receivers, 3,772 with ≥ $10. Top receiver: 0.8%. Not verified (dust): 215,187 entries, $31.8K. First run: 89,849 requests.
- **Per coin (local run on the same day, 99% of receivers read):**

  | Coin | Positions | Value |
  |---|---|---|
  | lzUSDC | 15,576 | $79.5K |
  | lzUSDT | 12,277 | $60.5K |
  | lzWETH | 9,202 | $92.3K (38.6 WETH) |
  | BTC.b | 5,043 | $24.4K (0.30 BTC.b) |
  | CAKE | 199 | $4.5K (2,092 CAKE) |
  | lzUSDD | 4 | unpriced (320 USDD) |

  - 1 position is held by a resource account (`unknown`).
- **Simulation (anonymous fullnode, seed 20261018):** 48/48 recoverable samples succeed and pay exactly the expected amount, across all 6 coins. 28 need gas. The resource-account position aborts (no signer), as expected.
- **Re-read schedule:** monthly, or when an entry changes (a claim always rewrites it).

## pancake-syrup-ended

- **What:** PancakeSwap (Aptos) CAKE syrup pools (`0xfd1d…::smart_chef`). All 10 pools the contract created ended between 2023-01-19 and 2024-04-16; the 6 CAKE pools by 2024-02-09. Stakers who never withdrew still have their stake and the final reward in the pool.
- **Status:** PancakeSwap Aptos is live; the pools are not. Each pool's reward accumulator was last updated at or after its end, so the pending reward is final.
- **Size (pool totals, 2026-10-19):**
  - CAKE staked in the 6 CAKE pools: **60,052 CAKE (~$130K at $2.17)**, 49,547 of it in the MoveCoin-reward pool that ended 2024-02-09.
  - Gui Inu staked in the 4 GUI pools: 441.7M GUI (~$66; CoinGecko's quote is stale) with ~2.75 APT of rewards. Those pools are left out: not worth 4 reads per depositor.
  - Rewards left in the CAKE pools: unpriced Blt, ETERN, MoveCoin (BlueMove), Ditto stAPT and Celer USDC.
- **Enumeration:** senders of `smart_chef::deposit` (incremental by version), plus senders of `withdraw` and `emergency_withdraw` at any time, so a staker who exits drops out in the next run.
- **Read:** the staker's `UserInfo<stake, reward, pool id>` for each CAKE pool (6 reads the first time, then only the pools the staker was found in, kept in memo), and `PoolInfo` once per run. Pending reward = `amount × acc_token_per_share / precision_factor − reward_debt` (`derived_math`; smart_chef has no views).
  - When a pool holds less reward than the staker is owed, `withdraw` would abort, so the step is `emergency_withdraw` (stake only) and the reward is `blocked` (`reward_unfunded`).
  - A staker who deposits into a pool not in their memo after the first read would be missed. The pools are over, so nobody has a reason to join one.
- **Sanity:** stake found per pool ≤ the pool's `total_staked_token`.
- **Spot check (anonymous public endpoint, 2026-10-19):** of 14 depositors sampled from older deposits, 11 still hold CAKE in pool U2 (0.02–8.2 CAKE each). Simulated `withdraw` for 3 of them: 3/3 succeed and pay exactly the derived stake and reward.
- **Enumeration size (anonymous indexer, 2026-10-19):** 32,900 deposits by 14,589 depositors up to version 444,552,000, when the last CAKE pool ended. Later deposits only went to the Gui Inu pools. The first run reads 6 `UserInfo` per depositor (~88K requests), so it needs its own run; later runs read only the pools each depositor was found in.
- **Sample (the earliest 400 depositors):** 40 still hold CAKE (10%), 1,720 CAKE in total, median 1.5 CAKE, 13 of 40 with ≥ $10. That suggests ~1,500 stakers across all depositors; the sample leans to the early pools.
- **Published (CI run, 2026-10-19):** complete. **$130.3K** of CAKE, 3,781 stakers, 377 with ≥ $10; the largest holds 28%. 7,675 positions: 3,844 stakes plus 3,831 pending rewards in unpriced tokens. Sanity: stake found per pool = 99.98–100% of each pool's `total_staked_token`. First run: ~93.8K requests (330 indexer pages, 14,589 depositors).

## pancake-farm-ended-rewards

- **What:** PancakeSwap (Aptos) farm rewards never harvested. MasterChef (`0x7968…::masterchef`) stopped CAKE emissions on 2025-03-16 (`end_timestamp`; every pool's alloc point is 0). The CAKE a staked LP earned until then, and the APT incentive paid with it, wait in MasterChef until the farmer harvests.
  - Only the rewards count. The staked LP is live liquidity (R4).
- **Read:** the farmer's `PoolUserInfo` (pids and a `UserInfo` table), then per staked pool:
  - pending CAKE = `amount × acc_cake_per_share / 1e12 − reward_debt` (`derived_math`; `pending_cake` is public but not a view). The 1e12 precision checks out: farmers who harvested after the end come out at exactly 0.
  - the APT incentive from the `get_pending_apt<LP>` view.
  - A reward MasterChef cannot pay (more than its CAKE or APT balance) is `blocked` (`reward_unfunded`).
- **Recovery:** `masterchef::withdraw<LP>(0)` harvests and leaves the LP staked. Simulated: it paid exactly the computed 78,858 raw CAKE and the 33,565 raw APT from `get_pending_apt`.
- **Enumeration:** senders of `masterchef::deposit`, `withdraw` and `emergency_withdraw` at any time. A deposit or withdrawal after the end harvests (a harvest is `withdraw(0)`), so the farmer is re-read in the next run. A depositor with nothing pending is read once and never again.
- **Size:** bounded by what MasterChef holds: 5,771 CAKE (~$12.5K) and 12,988 APT (~$9.9K).
  - Sample (394 depositors across its history, 2026-10-19): 57 (14%) have rewards, 57.5 CAKE + 111.3 APT. Scaled to an estimated ~25K depositors, that's roughly 3,600 CAKE and 7,000 APT (~$13K).
- **Cost:** ~3.9 requests per depositor for those with LP staked (fewer for the rest), so the first run is ~100K+ requests and needs its own run. Nothing accrues after the end, so an owner with nothing pending is never re-read (`zero: 'never'`); owners with rewards are re-read monthly.
- **Published (CI run, 2026-10-20):** complete. **$16.1K** (CAKE plus the APT incentive) in 13,126 positions, 5,581 farmers, 165 with ≥ $10. Sanity: pending CAKE found = 5,526 of the 5,771 CAKE MasterChef holds (95.8%). First run: 45.8K requests (14,219 depositors, 1,090 indexer pages).

## echelon-frozen-markets

- **What:** supply left in Echelon's (Aptos) lending markets that Echelon froze. A frozen market has collateral factor 0 and borrow cap 0: no new borrowing, no use as normal collateral. Its supply earns little or nothing and waits on Echelon winding the market down.
- **Rules (decided 2026-10-20):**
  - Every frozen market counts (issue #10, option (b)), not only the bridged-asset ones with a public sunset notice (Aptos Foundation: Echelon "helped sunset bridge-wrapped assets"). The supply sits idle, and a frozen market is likelier to be shut down than a live one. The freeze is the effective date and the age (`protocol_closure`). A market Echelon reopens stops counting.
  - A supplier with any Echelon debt, even dust or interest only, is a live borrower: none of its supply counts (R4); it is shown on the check page as `blocked` (`has_debt`, naming the markets it owes). Frozen markets can still be collateral in an efficiency mode: stAPT and sthAPT sit behind leveraged APT borrows (one sampled account: 49K stAPT and 7.9K sthAPT against 51.9K APT of debt).
- **Markets (21 of 30, 2026-10-20):** the freeze date is the first collateral-factor / borrow-cap admin transaction from which the market is frozen (archive node).
  - 2025-05: lzUSDC, lzUSDT, Wormhole USDC (05-03); Wormhole WETH, STONE (05-17).
  - 2025-07 to 2025-11: SBTC (07-26), MOD (09-03), Thala staked LPT 1 (09-03), THL and CAKE (09-26), aBTC (10-15), truAPT (11-10), stAPT, stkAPT and amAPT (11-21).
  - 2026: gstAPT (01-11), Thala staked LPT 2 and 3 (01-18), sthAPT (04-09), kAPT (04-24), sYUSD (10-04).
- **Read:** the supplier's `lending::Vault` (one resource: every market's shares, the debts and the efficiency mode). Without debt, `account_coins` per frozen market held.
  - Payout = min(coins, the lender's pro-rata share of the market's cash). The share is coins × cash / supply when the market is short, so all lenders' payouts together never exceed the cash. A share that rounds to nothing (a few raw units) is not a position. No cash at all means `blocked` (`insufficient_cash`).
  - **Prices:** a withdrawal prices every market the account still holds afterwards. Echelon has no valid price for THL, Wormhole WETH, STONE or SBTC (`lending::asset_price` aborts with `ERR_ORACLE_INVALID_PRICE`; the Thala LPT oracles are uninitialized), so holding any of them blocks withdrawals from every other market. The market itself can still be withdrawn: `withdraw_all` removes it from the vault (simulated).
    - One such market held: it is withdrawn directly, and every other position gets the prerequisite "withdraw your THL first". Both need its cash to cover the whole claim: a partial withdrawal leaves it in the vault, so otherwise the account is `blocked` (`stale_oracle`).
    - Two or more: no withdrawal order works, so all of the account's positions are `blocked` (`stale_oracle`).
- **Recovery:** `scripts::withdraw_all<coin type>(market)` for a Coin market, `scripts::withdraw_all_fa(market)` for a fungible-asset market (truAPT, the Thala LPTs, kAPT, stkAPT, amAPT, gstAPT, sYUSD). `withdraw_all` takes the whole claim and aborts when the market's cash is short of it (simulated: `ERR_LENDING_INSUFFICIENT_UNDERLYING_BALANCE`); then the step is `withdraw` / `withdraw_fa` with the share amount for the payout (the amount is in shares, simulated).
- **Enumeration:** senders of `scripts::supply` and `supply_fa` at any time (a frozen market still accepts supply), plus `withdraw*` senders as change events. `borrow*` and `repay*` senders are change events too (a supplier that borrows stops counting; one that repays starts), scanned from version 7,694,000,000 (2026-10-20): every supplier's first read comes after that, so earlier calls cannot matter. A supplier with nothing counted is read once and never again. Known gap: a borrower whose debt is cleared by a liquidation (the liquidator sends that transaction) is not re-read.
- **Sanity:** supply found per market ≤ the market's supply, with coverage shown. Coverage stays well below 100%: suppliers in debt are left out, and so is supply held by contracts that never call `scripts::supply*` themselves.
- **Prices:** CoinGecko ids checked against the exact asset: THL, CAKE, lzUSDC, lzUSDT, Wormhole USDC, MOD (`move-dollar`), kAPT (`kofi-aptos`), amAPT (`amnis-aptos`, listed for the amAPT coin; the market holds its paired fungible asset). stAPT has an id (`amnis-staked-aptos-coin`), but its last quote is from 2026-09-03, older than 7 days; stAPT and sthAPT are valued at redemption instead (on-chain rate × APT: 1 stAPT = 1.2171 amAPT, 1 sthAPT = 1.278 thAPT less Thala's 0.15% unstake fee, on 2026-10-20). The other tokens have no verified id and are unpriced.
- **Upper bound (on chain, 2026-10-20, debt included):** cash in the largest markets: 1.85M THL (~$18K), 662K stAPT, 69K sthAPT, 61.8K lzUSDC, 21.7K lzUSDT, 7.9K MOD, 5.9K stkAPT, 1.7K CAKE; sYUSD 998K, frozen only since 2026-10-04 (under 30 days).
- **Sample (2026-10-20, seeded):** 20 evenly spaced pages each of `supply` and `supply_fa` calls (by offset), 4,000 calls from 2,085 suppliers, every supplier read with this source.
  - 346 suppliers (17%) have counted positions: $195 priced (whUSDC $125, lzUSDC $63, THL $3, MOD $3), plus 3,205 stAPT (2,805 of it one holder), 280 sthAPT and 16 stkAPT unpriced. 41 positions need "withdraw THL first"; none is blocked by two unpriced markets.
  - Before the debt rule the same sample counted 8.9K stAPT, 10.8K sthAPT and 17.4K THL: most frozen-market supply sits in accounts that borrow.
- **Simulation (Geomi fullnode, unsigned, 2026-10-20):** per market the smallest, median and largest sampled position. All 26 direct withdrawals succeed and pay between the read payout and the claim (the claim when the cash covers it). All 6 positions that need THL out first abort with `ERR_ORACLE_INVALID_PRICE`, as expected; withdrawing the THL first succeeds and empties it from the vault.
- **Cost:** ~1M supply and withdraw calls (supply ~370K, withdraw ~270K, supply_fa ~150K, the rest smaller), so the first run is ~10K indexer pages (~2.2 h at 0.8 s/page). Scanning the ~520K borrow and repay calls from the start would add ~5K pages for nothing. `distinct_on: sender` puts `supply` alone at ~114K distinct senders (300 senders cover the first 0.26% of the address space). Reads take ~1.5 requests per supplier, so the first full pass is ~200K+ requests: one run at CI's 300K cap (local runs default to 100K). Later runs read only suppliers with new calls.

## aave-frozen-reserves (dormant)

- **What:** supply left in Aave v3's Aptos reserves once Aave freezes them. An Aave governance proposal (ARFC, filed 2026-07-29) winds down the Aptos deployment by freezing every reserve. A frozen reserve takes no new supply or borrows; lenders can still withdraw.
- **State (2026-10-20):** all 4 reserves (USDt, APT, sUSDe, USDC) are live, so the source counts nothing. Each run reads the reserve flags first (one view) and does nothing else while none is frozen. Supplied: ~456K APT (~6K borrowed), ~21K USDC, ~18.6K USDt, ~2K sUSDe.
- **Rules (decided 2026-10-20, option A):** same as `echelon-frozen-markets`. A frozen reserve counts, aged from its freeze. A supplier with any Aave debt (`user_logic::get_user_account_data` total debt > 0) counts for nothing (R4); its frozen supply is shown on the check page as `blocked` (`has_debt`).
- **Freeze date:** the indexer's `events` table is deprecated, so the first version with the frozen bit (bit 57 of the reserve configuration) is found by binary search on the archive node, from version 7,694,000,000 (every reserve live), and dated by that transaction. ~30 archive reads once per reserve: the enumerator dates it, keeps the date in its cursor and passes it to each holder in the hint. If it cannot be dated, or the archive lookup fails, the amount still counts but the age is unknown until then. The date is then null in the hint and retried each run; the run that dates it changes the hints, so its holders are re-read at once. Assumes a reserve stays frozen once frozen.
- **Read:** `a_token_factory::balance_of(owner, aToken)` per frozen reserve. Payout = min(balance, pro-rata share of the reserve's cash: balance × available liquidity / aToken total supply). Paused or inactive reserves are `blocked`. The APT reserve pays fungible APT (0xa), the paired asset of the APT coin, so it is valued as APT.
- **Recovery:** `supply_logic::withdraw(asset, 2^256 − 1, owner)` withdraws everything (simulated on a live reserve: paid exactly `balance_of`) while the reserve's cash covers the balance; the position still counts only the pro-rata share. When the cash is short of the balance, the step withdraws the pro-rata amount instead.
- **Enumeration:** holders of frozen reserves' aTokens, from each aToken's `token_base` user table (a SmartTable) read bucket by bucket from the fullnode. The indexer's copy misses buckets (sUSDe: 0 of 5). A run fails unless every holder is read. Each holder's hint is its scaled balances in the frozen aTokens and in every debt token, so supply, withdrawals, borrows and repayments trigger a re-read, and accruing interest does not.
- **Prices:** CoinGecko `tether`, `usd-coin`, `ethena-staked-usde`, each listed with this exact Aptos address; APT as APT.
- **Rehearsal (2026-10-20, all reserves treated as frozen):** 921 holders, 385 requests to enumerate (95 also owe). Every tenth holder read: 93/93 complete, 94 positions. The 4 largest simulated withdrawals succeed and pay the full balance.
- **Cost once frozen:** ~400 requests per run to enumerate, plus ~2 per changed holder.

## econia-idle-accounts

- **What:** coins left in Econia market accounts, idle or resting in open orders. Econia is an on-chain order book on Aptos.
- **Status (checked 2026-10-20):** deprecated, counted from the archive date (decided 2026-10-20). Until then the docs listed it as "no public closure notice". The new evidence:
  - Econia Labs archived the repository: "This repository was archived by the owner on Sep 8, 2025" (github.com/econia-labs/econia; emojicoin's repo is archived too). PitchBook lists the company as out of business.
  - On chain: last limit order 2025-07-25, last market order 2025-09-01, last deposit 2025-07-24. Since then the only activity is users withdrawing (latest 2026-09-24) and one swap.
- **Age:** from 2025-09-08 23:59:59 UTC. The banner gives only the date, so the end of that day is used and the age is never overstated. A balance the owner changed later (its own deposit, withdrawal or order) is aged from the run that saw that call. The indexer does not say which market a call touched, so this applies to all the owner's balances. The check page reads without the enumeration's history, so it shows the age as unknown.
- **Rules:** only accounts the owner controls (custodian 0) count. Custodian accounts (Fliq, Kana) need their custodian to withdraw. Since Econia is closed, coins resting in open orders count too (R4, decided 2026-10-21). A market with a generic (non-coin) base counts only its quote.
- **Read:** `user::get_market_accounts(owner)` (one view per owner), plus `registry::get_market_info` once per market for the coin types. Payout = each side's available amount. The APT coin is recorded as APT (0xa). Every coin of the coin markets has display metadata (EchoCoin002 is Gui Inu, GUI).
  - **Large accounts:** the view builds every market account with its orders. For an owner with many it exceeds the view's execution limit (`EXECUTION_LIMIT_REACHED`, 2026-10-26, #55), and so does `get_all_market_account_ids_for_user`. One such owner is a Fliq bettor with 1,106 accounts, 1,104 of them Fliq question markets under Fliq's custodian (id 6). Then only its own (custodian 0) accounts are read, the only ones counted. The indexer lists their keys in `MarketAccounts.map`: the u128 id in BCS, so an own account's key starts with 8 zero bytes. Each is then read from that table on chain. The totals match the view (checked on 6 accounts of 3 owners); coins locked on a side (total above available) stand for open orders there.
- **Recovery:** with open orders, first `market::cancel_all_orders_user(market id, side)` for each side with orders (asks: true, bids: false; 6 of 6 simulated cancels across markets 7, 8 and 11 succeed). Then `user::withdraw_to_coinstore<coin type>(market id, amount)` for the account's total, per coin and market. The order is (market id, amount): simulated, and the reverse aborts (Kana's integration README lists it the other way round).
- **Enumeration:** senders of `user::register_market_account` and `register_market_account_generic_base` (Phase 0: 52,040 calls, 48,776 senders, 522 pages), plus senders of Kana Labs' Econia wrapper (`0x9538…::wrapper`), whose `deposit_and_register_*` and deposit-and-order entries register the caller's own accounts (used until mid-2025). Known gap: an integration that registers accounts through other entry functions is missed until it is listed.
  - **Makers:** a fill of a resting order is sent by the taker, so the maker would never be re-read. Each run reads the open orders of the 13 coin markets (from market 14 on every base is generic: Kana perps, then Fliq's 130K question markets) and re-reads current makers and last run's makers. A fill moves coins between base and quote, so when a maker's open orders (order id and remaining size) changed since last run without its own call, its balances in that market are aged from the run that saw the change. On 2026-10-20: 185 owner-controlled orders from 142 makers. Generic-base markets (14 and up) are not scanned: of the 50,109 market accounts Phase 0 read (all accounts of 48.8K registrants), none in those markets is owner-controlled (they are run by custodians: Kana perps, Fliq), and Econia has not traded since September 2025. An owner-controlled account there whose order fills later would be missed.
- **Size (Phase 0, 2026-10-18):** 25,354 idle owner-controlled accounts. Market 7 (APT/lzUSDC) holds nearly all of it: 25,012 accounts, 3,329 APT and 29,076 lzUSDC (~$31.6K, ~$1.25 per account; it looks like campaign farming). The other 9 markets hold a few dollars each, plus Echo's unpriced EchoCoin002.
- **Rehearsal (2026-10-20):** 104 owners (the 3 largest plus every 250th): 104/104 reads complete, 128 positions. 12 of 12 withdrawals simulated with the generated steps succeed and pay exactly the counted amount. Before building, 19 of 19 direct simulations across 10 markets also succeeded.
- **Cost:** first run ~522 indexer pages + ~48.8K views + an owner-kind lookup per owner with value (~25K): ~75K requests. Later runs read only owners with new calls.

## auro-closed-positions

- **What:** collateral left in debt-free Auro Finance CDP positions after the team shut the website down.
- **Status (checked 2026-10-21):** closed under the closed-frontend rule (decided 2026-10-21). The team's notice on X told users to "withdraw all funds before April 30" (2026) and to expect the website to be "permanently shut down by the end of April", because Pyth deprecated its push feeds on Aptos. auro.finance and app.auro.finance no longer resolve; the last archived capture of the app is from 2025-12-04. Aged from 2026-04-30 23:59:59 UTC.
- **Positions:** NFTs in Auro's CDP collection (`0x0bc8…`); each holds a `lending_pool::UserPosition` with deposit and debt shares. A position with any debt does not count (R4; shown on the check page as `blocked`, `has_debt`); its rewards cannot be claimed either (the claim aborts on a stale Pyth price) and are left out.
- **Read:** the position's `ObjectCore` owner must be the wallet. The amount comes from share accounting: shares × (reserves + debt − fees) / total shares, which is the amount a full withdrawal pays.
- **Reserves are short:** every pool keeps its reserves with the DAO account `0xafe4…`, as the fungible asset recorded in `LendingPool.fungible_asset` (Auro wraps a coin pool's coin in its own asset). Most pools hold 99.9% of their books. The stkAPT pool holds 2,061 of 5,611 stkAPT (~37%); the DAO also holds a Kofi withdrawal manager, so part is probably in Kofi's unstake queue. Each position is counted for its pro-rata share of what the pool really holds.
- **Recovery:** `auro_router::withdraw_coin_entry<coin>(position, amount)` for a coin pool, `withdraw_entry(position, amount)` for a fungible-asset pool, with the exact full amount (rounded up so it burns every share). A partial withdrawal checks the position's health with a Pyth price that no longer updates, so it aborts (simulated). A position whose full amount exceeds what its pool holds is therefore `blocked` (`insufficient_cash`), with nothing payable now: today, one stkAPT position of 5,131 stkAPT.
- **Age:** from the latest of 2026-04-30 23:59:59 UTC, the position's own `last_deposited_times`, a change of the NFT's owner after the shutdown (the ownership row's last transaction), and any router call on the position after the shutdown (a repayment, a withdrawal from one of its pools, an exit, a reward claim). The contract still takes deposits and repayments, and a position that still had debt at the shutdown only qualifies once repaid; liquidations need a Pyth price, which stopped on 2026-04-30. The enumerator scans `auro_router` calls on positions from the shutdown on (25 by 2026-10-21: 12 reward claims, 7 withdrawals, 4 repayments, 2 exits; filtered by function, since an unfiltered scan times out), up to the lower of the user-transactions and account-transactions processors' watermarks, and takes the accounts each one touched (`account_transactions` at its version), so a call dates the position it touched, whoever sent it; one not yet indexed by both is picked up by a later run. A position whose state or owner at that watermark differs from now changed by a call or transfer the scans have not seen yet: its age stays unknown for that run. The hint carries the date per position. The check page reads without that history, so it shows the age as unknown.
- **Enumeration:** current owners of the collection (4 indexer pages, 298 owners). Withdrawals, repayments and the pools' shared reserves change positions without changing who holds the NFTs, so every owner is re-read every run (~715 requests). The run is degraded when any of the three indexer processors it reads (`token_v2_processor`, `user_transaction_processor`, `account_transactions_processor`) lags, so a recent repayment can't be missed silently.
- **Prices:** stAPT and stkAPT at redemption (on-chain rate × APT; stkAPT uses Kofi's `get_exchange_rate` less its withdrawal fee, 0 bps today), kAPT and amAPT from CoinGecko (amAPT's coin type maps to `amnis-aptos`), USDt and USDC from CoinGecko.
- **Rehearsal (full, 2026-10-21):** 229 debt-free positions of 209 owners, all reads complete. On the books: 4,696 stAPT, 5,459 stkAPT, 485 kAPT, 164 amAPT, ~9 USDt, 0.4 USDC. Pro-rata shares: 4,693 stAPT, 2,005 stkAPT, 484 kAPT, 164 amAPT (about $6.6K). Of that, the blocked stkAPT position's ~1,885 stkAPT is not payable now (its only withdrawal aborts), so ~120 stkAPT counts as recoverable (about $5K in all; derived from the same run, not re-read). Simulations, per token the smallest, median and largest: 15 of 15 recoverable positions paid exactly their claim, and the one blocked position aborted (`EINSUFFICIENT_BALANCE`).
- **Cost:** ~715 requests a run.

## animeswap-closed-lp

- **What:** liquidity left in AnimeSwap V1 pools (Aptos AMM) after its frontend went away.
- **Status (checked 2026-10-21):** closed under the closed-frontend rule (decided 2026-10-21). animeswap.org and app.animeswap.org have no address record, though the domain was renewed on 2026-09-24 (its name servers still answer). Wayback's captures show the app served unchanged until at least 2026-08; DefiLlama marks AnimeSwap dead. No closure notice was found, so the effective date is the day it was found down: 2026-10-21 23:59:59 UTC.
- **Contract still works:** pools are not paused (`AdminData.is_pause = false`), and aggregators still route swaps through them (the APT/USDC pool last traded 2026-10-20). Removal (`burn`) does not check the pause flag, only the pool's reentrancy lock.
- **Positions:** LP is a Coin, `0x7969…2cbf::LPCoinV1::LPCoin<X, Y>`, held in a CoinStore or its paired fungible-asset store; `coin::balance` reads both. One position per side of each LP, so the priced side counts when the other coin has no price; one removal pays both.
- **Payout:** as `burn` computes it. The DAO fee is first minted in LP when √(reserve x × reserve y) grew since `k_last` (fee on, `dao_fee` 5): supply × (√k − √k_last) / (√k × 5 + √k_last). Then each side pays LP × reserve / supply, rounded down, where supply is `coin::supply` (the Coin and its paired fungible asset; `CoinInfo` alone misses migrated LP). Removal aborts when either side rounds to zero: such LP is `blocked` (`below_minimum`).
- **Recovery:** `AnimeSwapPoolV1::remove_liquidity_entry<X, Y>(liquidity, min X, min Y)`, with minimums 1% below the computed payout.
- **Age:** from the later of 2026-10-21 23:59:59 UTC and the LP store's last change (the indexer's `last_transaction_timestamp`): the pools still take liquidity, so LP added or received after the closure is aged from then. Each read looks the owner's LP stores up again, so LP received after the enumeration's scan is read too. When the indexer's amount differs from the on-chain balance, the store changed after the time the indexer shows: the age stays unknown until the indexer catches up. A matching amount does not prove the store was untouched in the indexer's lag (seconds): LP sent away and the same amount received back inside that window would keep its earlier time. Accepted: closing that gap means pinning every read to the indexer's watermark.
- **Enumeration:** all 340 pairs from `PairInfo.pair_list`, then every store holding each LP coin (`current_fungible_asset_balances`, filed under the coin type also after migration). The pool account (`0x7969…2cbf`) is left out: it holds the DAO fee minted in LP (4.5% of APT/USDC), the protocol's own, with no signer. LP staked in AnimeSwap's MasterChef (`AnimeMasterChefV1`, held inside its `PoolInfo` resources at `0x8615…66ef`, so no store lists it) is not read: too small. On 2026-10-23 it paid out ~236 APT + 182 USDC (APT/USDC) and ~192 APT + 3M ANI (APT/ANI, ANI unpriced), ~$540 over every staker.
- **Value:** pools hold ~$7.9K in all (APT at $0.82, stable sides at $1); 20 pools hold 99% of it, APT/USDC alone $4.4K.
- **Rehearsal (2026-10-21, anonymous API, the 20 largest pools):**
  - Indexer: 6,782 holdings of 5,762 owners, ~$5.9K on their priced sides (APT, lzUSDC, lzUSDT, whUSDC). 83 owners hold ≥ $10, 3 hold ≥ $100 (largest ~$270).
  - On chain, through the source, for the 60 largest owners: 190 positions, all `recoverable`, all reads complete; $2,561 counted against the indexer's $2,567 estimate.
  - Simulated removal for 6 of them (smallest to largest): 6 of 6 succeeded and paid exactly the computed amounts (`BurnEvent`), DAO fee mint included.
- **Cost:** ~400 indexer pages a run to enumerate (one query per pair, plus pages; APT/USDC alone 34). Holders with positions are re-read every run, others monthly or when their LP changes (the hint carries each store's last change): swaps shift the split between a pool's sides, and the reserve check compares positions with the reserves at the run's version (re-read monthly, they tripped it on 2026-10-26). A first full read is ~6K owners × ~2 requests.

## earnium-closed-lp

- **What:** liquidity left in Earnium pools (Aptos AMM), in the wallet or staked in Earnium's liquidity staking, after its frontend went away.
- **Status (checked 2026-10-21):** closed under the closed-frontend rule (decided 2026-10-21). earnium.io and app.earnium.io have no address record; Wayback shows the site served until 2026-02 and the app until 2026-01. DefiLlama marks Earnium dead from 2026-10-10 (a lead, not evidence). No closure notice found, so the effective date is the day it was found down: 2026-10-21 23:59:59 UTC.
- **Contract still works:** removal and unstaking simulate fine (2026-10-21). Staking rewards have ended (`reward_per_sec` 0 in the main pools); unstaking pays what accrued.
- **Positions:** `liquidity_stake_pool::user_info(owner, pools)` gives, per pool, the owner's wallet LP, staked LP and unlock time (read 20 pools a call; longer lists abort). Wallet LP and staked LP that is unlocked are separate parts, each one position per side of the pool (so each part keeps its own age), valued with `router::redeemable_liquidity` (what removal pays, exactly). A stake still locked is `blocked` (`locked`) until its unlock time (none today). LP locked forever (`stake_and_lock` with no end: 14 position NFTs, mostly launch liquidity such as APT/CATTOS's ~4,677 APT) can never come out and is not counted.
- **Recovery:** `liquidity_stake_pool::unstake(pool, amount)` when staked, then `router::remove_liquidity_entry(asset 1, asset 2, is_stable, liquidity, min 1, min 2, owner)` with minimums 1% below the payout. Earnium wraps coins in its own assets; payouts are valued as the original (APT as APT).
- **Age:** per part. Wallet LP: from the later of 2026-10-21 23:59:59 UTC and its store's last change (every wallet move updates it: adding, removing, unstaking, a transfer in). An unlocked stake: from the latest of the closure, the owner's last staking call in the pool after the closure began (staking, unstaking, adding and staking; reward claims move no LP), and its unlock time when that came after the closure. A stake still locked has no age. Without an enumeration hint (the check page) neither part has history to date it, so the age is unknown.
- **Enumeration:** senders of the router's add-liquidity entry functions and of `stake` / `stake_and_lock`, ever (incremental), plus every wallet holding LP: each pool's primary stores (`current_fungible_asset_balances`, one query a pool; staked LP sits in the staking pools' own non-primary stores), with each store's last change. Staking calls after the closure began are scanned up to the lower of the user-transactions and fungible-asset processors' watermarks; each call's LP activities (`fungible_asset_activities` at its version) name the pools it moved. A full scan every run, so a wallet that sent all its LP away drops out and is re-read. The read compares each pool's holdings (`user_info`) at that watermark with now: a part (wallet or stake) that changed after the scans has an unknown age for that run.
- **Rehearsal (full, 2026-10-21, keyed):** 563 candidates, all reads complete: 683 positions, all `recoverable`, of 283 owners (22 with ≥ $10). Recoverable: 10,998 APT, 7,833 kAPT, 6,899 USDt, 5,637 USDC (~$28K at APT $0.82) plus 24 unpriced tokens. Two accounts hold ~89% of it (~$17.5K and ~$7.5K; ordinary accounts, neither the package owner nor the treasury). Simulated first steps for 6 positions, smallest to largest: 6 of 6 succeeded (removals paid exactly the computed amounts; unstakes returned the LP and accrued rewards).
- **Cost:** every run ~50 indexer pages for the senders plus ~85 for the LP holders (83 pools), plus one per staking call after the closure; ~3.6K requests for a full read (5 `user_info` calls per owner, one more for the pools held at the watermark, plus one payout view per part held).

## houston-closed-lp

- **What:** liquidity positions left in HoustonSwap pools (Aptos, concentrated liquidity) after its app went away.
- **Status (checked 2026-10-22):** closed under the closed-frontend rule (decided 2026-10-21). houstonswap.io (HoustonSwap's site, as OneKey's dapp listing gives it) and app.houstonswap.io have no address record; Wayback shows the site served until 2026-05 and the app until at least 2026-06-10. (houstonswap.xyz is a parked domain with no captures; DefiLlama lists no URL.) No closure notice found, so the effective date is the day it was found down: 2026-10-22 23:59:59 UTC. The pools still trade: routers and arbitrage bots swap through them daily.
- **Positions:** each owner's own account holds one `position::PositionWallet<X, Y>` per pair, a list of tick ranges with liquidity (read with one call listing the account's resources). No view computes amounts, so the source computes what burning a range pays, exactly as the pool does: √price at each tick from √1.0001 in Q128 (by squaring), then the standard amounts in Q64 at the fee tier's current tick and √price, rounded down. Fees already credited to the position are added: `tokens_owed` (paid by the pool) to the `principal` position, `tokens_stored` (coins held in the position itself) as a separate `fees` position; fees accrued since its last update (no view) are left out, so payouts are slightly understated (simulated removals paid up to ~4% more in fees on active ranges). One position per side and kind; ticks are stored as u64 with the sign in the top bit. The sanity check compares only `principal` (what the pool pays) with the pool's reserves.
- **Blocked:** a removal the fee tier's reserves cannot cover (the burn plus owed fees; coins stored in the position are paid from the position itself) aborts (`EINSUFFICIENT_BALANCE`, simulated): `reserve_short`. On 2026-10-22 that is one ceUSDT/USDC tier (2 positions, ~$20).
- **Recovery:** `liquidity_manager::remove_liquidity<X, Y>(recipient, lower tick, upper tick, fee tier, liquidity, min X, min Y, deadline)`, with minimums 1% below the burn amounts and deadline u64 max (the contract only checks that it has not passed). It also pays the fees earned.
- **Age:** from the later of 2026-10-22 23:59:59 UTC and the owner's last liquidity call after the closure day began that changed that pair's positions (the sender's position wallets just before and at the call, compared). A pair whose positions differ from those at the user-transactions processor's watermark (taken before the scans) changed after them: its age stays unknown for that run. The check page reads without that history: its age is unknown.
- **Enumeration:** senders of `liquidity_manager::add_liquidity`, ever (22 pages; 2,181 calls from 1,720 accounts), every run in full. A position can only move to another account through another contract; none is known. Liquidity calls after the closure (none by 2026-10-23) are scanned once, from a cursor that also keeps the dates found: comparing wallets reads history the fullnode keeps for ~11 days, and runs are weekly. A call whose history is pruned anyway dates every pair its sender holds.
- **Rehearsal (full, 2026-10-22, keyed):** 1,720 candidates, all reads complete: 1,534 positions of 1,378 owners. Recoverable: 395.5 APT, 1,338 whUSDC, 999 USDt and 942 USDC (LayerZero), plus unpriced 2,169 ceUSDT, 1,756 whUSDT, 395 ceUSDC, 4.3 tAPT, 1.46M ETERN (Panora: ~290 APT) and 4.4M HOU (no route); ~$8.2K at APT $0.78 with the bridged dollars at $1. One account, which registered pools and added liquidity on launch day (2022-10-20), holds ~$6.7K of it in stablecoin ranges. Simulated 8 removals, smallest to largest plus every blocked one: the 6 recoverable ones succeeded and burned exactly the computed amounts; the 2 blocked ones aborted.
- **Cost:** every run ~23 indexer pages; a full read ~1,720 resource listings plus one pool read per pair (~4.9K requests with owner checks). Owners with positions are re-read every run (swaps shift the split between a pair's sides; the reserve check compares them with the reserves at the run's version), others monthly.

## topaz-bids

- **What:** APT escrowed in expired Topaz NFT bids. Topaz ceased operations on 2024-08-21 (homepage notice; aptos.dev lists it as deprecated). A bid's APT stays in Topaz's tables, also after its deadline, until the bidder cancels.
  - Collection bids: `collection_marketplace::Bids<APT>` (bid → coins, deadline, buyer); `cancel<APT>(bid id)`.
  - Token bids: `bid_any::CoinEscrow<APT>` (bid → coins), with buyer and deadline in `bid_any::Bids`; `cancel_bid<APT>(bid id)`.
- **Rule:** every funded bid counts (R4, decided 2026-10-21). Topaz is closed, so a bid that has not expired, an open order, counts too; it could only be filled by calling the contract directly.
  - **Age:** an expired bid from its deadline. An open one from the end of the shutdown day (2024-08-21 23:59:59 UTC; the notice gives a date only) when placed before the shutdown: bid ids come from each module's `MarketplaceData.nonce`, which stood at 312,038 (collection bids) and 271,091 (token bids) at the shutdown's version 1,642,611,992. Ids from there on (~150 bids) were placed later; their age is unknown.
  - **Deadlines:** most are microseconds; some bids store milliseconds, which read as 1970. A deadline before 2022 (before Topaz existed) is treated as none: the bid counts as open, aged from the shutdown.
  - **Size of the change (sample, 2026-10-21):** six 1/256 slices of the collection-bid table (by the bid id's low byte, ~1,220 rows each) hold 3 to 9 funded open bids each, with ~0 APT. The value stays in expired bids. Open bids add next to nothing; the rule matters for consistency, and the deadline fix for ages.
- **Enumeration:** the three bid tables themselves (~850K rows, 16 key ranges in parallel; 8,576 indexer pages). Rows are never deleted (a cancel or fill empties the coins), so later runs only fetch changed rows.
  - Indexer `key: {_in: …}` lookups on these tables take 6–46 s (no key index), so they are used only for the few token bids an incremental run cannot join.
- **Read:** with the enumeration hint, only the bids it lists as funded and expired are read on chain (one table read each).
  - Without a hint (the check page), the bidder's ids come from Topaz's per-bidder `Index`. That index lists some ids under the wrong bidder (ids 1, 4 and 9 appear under several), so a bid counts only when its own record names the owner as buyer. Walking the index without that check counted 32 bids twice.
- **Dust:** a bidder whose expired bids total under 0.25 APT (~$0.20) is not read on chain: `indexer_only`, out of totals.
- **Published (CI run, 2026-10-20):** complete. $3.9K left behind 90+ days, 1,736 bidders; 203,617 dust bids not counted. First run: 16.8K requests (8,576 indexer pages, 67,290 bidders).
- **Result (2026-10-19, local run with the pipeline code):** complete. **5,120 APT (~$3.9K) in 4,155 expired bids, 1,736 bidders**, 71 with ≥ $10; the largest holds 138 APT. Dust: 203,617 bids, 1,002 APT. Most of the 30.5K APT in collection bids sits in bids whose deadlines are years away (R4).
- **Cost:** first run 8.6K indexer pages + ~6.6K table reads. The first version walked every bidder's index and used 176K requests; reading only hinted expired bids gives the same result (minus the 32 double counts) for 6.7K.
- **Simulation (anonymous fullnode, seed 20261018):** 18/18 sampled cancels succeed and return exactly the escrowed APT, across both bid kinds; 9 need gas.
- **Re-read schedule:** monthly (spread over four weekly runs), or when a bid row changes.

## wormhole-unredeemed (check-only, opt-in)

- **What:** tokens sent to Aptos through Wormhole's Portal token bridge whose VAA was never submitted on Aptos. Read on the check page only, and only when the visitor switches on third-party lookups: the address goes to Wormholescan (decided 2026-10-22).
- **Read:** Wormholescan's operations for the address (`/api/v1/operations?address=`, up to 1,000). Each signed VAA is decoded: Portal transfers (payload 1) to Aptos (chain 22) whose recipient is the address count, if their emitter is the token bridge registered on Aptos for the source chain (`State.registered_emitters`, what `complete_transfer` checks; read through the indexer's `current_table_items`, since the fullnode's table API cannot parse the `u16::U16` key type). Redemption is checked on chain, not taken from Wormholescan: the token bridge's `State.consumed_vaas` set is keyed by the double keccak of the VAA body (verified on a redeemed transfer), so a VAA whose digest is absent was never redeemed. The coin paid is resolved on chain: `native_infos` for tokens native to Aptos, `wrapped_infos` (origin chain and address) for wrapped ones. Amounts travel with 8 decimals and are scaled up for coins with more.
- **Statuses:** recoverable when the VAA's guardian set is still active (the current set, or a superseded one before its `expiration_time`, a day after the rotation: the core contract's `guardian_set_is_active`); `team_gated` (`guardian_set_expired`) when it has expired: Aptos rejects it (`E_GUARDIAN_SET_EXPIRED`, simulated) until Wormhole's guardians sign the transfer again (the payout is kept: re-signed, it pays in full); `unknown` (`not_attested`) when the token has no wrapped coin on Aptos.
- **Recovery:** `complete_transfer::submit_vaa_and_register_entry<coin>(VAA)` from the recipient.
- **Sample (2026-10-22):** among recipients of Portal transfers to Aptos in seven 7-day windows from 2022 to 2025, 8 checked: 6 had transfers never redeemed (1.5 APT; 0.25 + 0.035 APT; wrapped coins), all signed by guardian sets 3 or 4, now expired (current set: 7). Two redemptions simulated: both abort with `E_GUARDIAN_SET_EXPIRED`. Wormholescan's listings show no target transaction for most early transfers to Aptos even when they were redeemed, so its status is not used.

## Other bridges and NFT marketplaces checked

- **TradePort** (left Aptos): every bid is gone. v1 has 1 collection bid left; v2 inserted 128,323 collection bids, and 92,113 were deleted plus 36,210 accepted, leaving 0. Token bids also net to 0.
- **Souffl3:** no closure evidence found.

## Bridges (Aptos and Movement)

Bridges listed for Aptos (official directory, 2026-10-19): Wormhole (Portal), NEAR Intents, Meson, CashmereLabs, Gas.zip, Panora, ChangeNOW, Swapspace. Also used: the LayerZero Aptos Bridge (zUSDC/zUSDT/zWETH), Celer cBridge, Circle CCTP (native USDC) and Stargate. Movement's canonical bridge is LayerZero-powered (MOVE, USDC, USDT, WETH, WBTC to and from Ethereum).

A bridge leaves funds behind when a transfer arrived but was never claimed or completed. Per bridge:

| Bridge | What can be left behind | Where it is recorded | Status |
|---|---|---|---|
| LayerZero Aptos Bridge (v1 `coin_bridge`: lzUSDC, lzUSDT, lzWETH, lzWBTC, lzUSDD) | coins credited to a receiver that could not take them, waiting for `claim_coin<T>` | on Aptos: `coin_bridge::CoinStore<T>.claimable_amt_ld` | **source `layerzero-claimable`** |
| LayerZero v1 OFTs on the shared `0x43d8…::oft` module (CAKE, BTC.b) | same, waiting for `oft::claim<T>` | on Aptos: `oft::CoinStore<T>.claimable_amount` at the coin's address | **source `layerzero-claimable`**. The other coins named `oft::…` are copies with under 3 tokens claimable; the older `0x54ad…::oft` module has one send ever |
| LayerZero v1 blocked messages (`lzapp::StoredPayload`) | a delivery that failed and waits for a retry | on Aptos | empty for the bridge, CAKE and BTC.b (2026-10-19) |
| Wormhole Portal → Aptos | transfers never redeemed on Aptos (VAA not submitted) | off-chain (Wormholescan), checked on Aptos against the token bridge's consumed VAAs | **source `wormhole-unredeemed`** (check page, opt-in) |
| Celer cBridge (`0x8d87…::peg_bridge`, `vault`) | large transfers held 6 hours (`delayed_transfer` map), then executed by anyone | on Aptos | delay map has never held an entry; peg bridge live (last mint 2026-10-16), vault paused. Refunds of failed transfers go through cBridge's API: not built |
| Circle CCTP → Aptos | USDC burned on another chain, never minted on Aptos | Aptos: `message_transmitter::is_nonce_used(keccak256(bcs(source domain) ‖ "-" ‖ bcs(nonce)))`; transfers relayed by Wormhole's executor are listed on Wormholescan with their domain and nonce | not left behind: 811 executor-relayed transfers to Aptos in 11 weekly windows (2025-03 to 2026-10) were all received (2026-10-22). Direct transfers have no per-recipient listing (Circle's API takes a source transaction) |
| LayerZero v2 OFTs and Stargate (Aptos, Movement) | messages that failed delivery | on chain: the endpoint (`0xe600…f43c`, same address on both chains) keeps each verified message's payload hash until it executes | too small (2026-10-22), see below |
| Movement canonical bridge (LayerZero) | inbound credits arrive directly; outbound transfers wait out a security delay on Ethereum | Ethereum | needs EVM support; not built |
| Movement framework bridges (`atomic_bridge`, `native_bridge`) | — | on Movement | never used on mainnet: all event counters 0, transfer tables empty (2026-10-19) |
| NEAR Intents | balances held in NEAR's intents contract | NEAR | needs NEAR support; not built |
| Meson, Gas.zip, ChangeNOW, Swapspace, Panora, CashmereLabs | swaps settled by liquidity providers; nothing held for the user on Aptos | — | nothing to claim |

- **LayerZero v2 inbound failures (checked 2026-10-22):** a message that is verified but never executes leaves its payload hash in the endpoint's store (`OAppStore` → `channels` → `inbound_hashes`); executing removes it. LayerZero Scan cannot find these per address (its wallet endpoint lists messages a wallet *sent*).
  - Movement: 30,098 `PacketVerified` events against 30,076 `PacketDelivered` (none burnt or nilified): 22 never executed, all still stored on chain and all with an `LzReceiveAlert`. 19 are the Movement Name Service proxy's messages from Aptos, 1 a 1-unit compose message, and 2 are MOVE bridged from Base to one address (123.86 and 12.39 MOVE; MOVE's shared decimals are 8) that failed while the MOVE adapter was paused (`EPAUSED`, 2026-04-19). It is unpaused now: a retry (`oapp_receive::lz_receive`, permissionless, with the alert's message) simulates fine and pays exactly. Movement's indexer keeps ~27K deleted `inbound_hashes` rows as current; the fullnode is the authority.
  - Aptos: 54 stored hashes (the Aptos indexer marks deletions): 46 are the name-service proxy's, 8 are integration tests or stale (duplicate orders, an overflow, unregistered composers, one actually delivered).
  - About $1 in all: too small.

## echo-wound-down

- **What:** supply left in Echo Protocol's lending reserves (Aptos; an Aave v3 fork at `0xeab7…39ed`) after its wind-down.
- **Status (checked 2026-10-24):** closed. Echo announced its wind-down on 2026-10-19 (reported by TokenPost, CryptoBriefing and KuCoin News): new deposits, loans and stakes stopped; repayments, withdrawals and unstaking stay open until 2026-11-19 23:59 UTC (the notice also gives 2026-11-14 for borrowers); unpaid loans are then liquidated, with the proceeds repaying lenders, and "remaining positions move into liquidation and settlement" (no process published). aBTC redemption through the B² bridge stays open. Aged from the notice (decided 2026-10-24): 2026-10-19 23:59:59 UTC. What counts after the deadline is open (#36).
- **Positions:** per reserve held, a supplier's balance with interest (`pool_data_provider::get_user_reserve_data`; `a_token_factory::balance_of` is the scaled balance, without interest). The reserve's cash (the underlying token held by the aToken's account) is shared by all lenders, so each is counted for its pro-rata share of it as `recoverable`, and the rest as a separate `blocked` part (`insufficient_cash`, locator `<reserve>/lent-out`). A supplier with any Echo debt is not counted (R4; `user_logic::get_user_account_data`): its supply is shown on the check page as `blocked` (`has_debt`), with what it owes (`get_user_reserve_data`, for each reserve whose debt token it holds). Echo's own wallets (`0xe751…965b`, `0x3b9a…1bb8`: they supply nearly all the aBTC and borrow the APT reserve against it; DefiLlama's adapter leaves them out too) are left out. Payouts are the coin the reserve wraps (APT as APT); the reserves' layout is a table in the source. Echo's own wrapper coins (`fa_coin`: eAPT, USDt, USDC, TruAPT, xBTC) are paid as the token each wraps (`asset_wrapper::AssetList`: native USDt and USDC, TruFin truAPT, OKX xBTC, and eAPT `0x8a74…bdae`), since `router_fa::withdraw` unwraps them in the same call. The wrapper's account (`0x6420…ae59`) held exactly each coin's supply in its token on 2026-10-29; a read fails if it ever holds less (decided 2026-10-29).
- **Recovery:** `router::withdraw_simple<coin>(reserve token, amount, owner, false)`, with u256 max for the whole balance while the cash covers it (simulated 2026-10-24: a lzUSDT lender was paid its 1,130.89 with interest). For a wrapper coin, `router_fa::withdraw<coin>(token, reserve token, amount, owner, false)`: `withdraw_simple` would pay Echo's coin (simulated 2026-10-29: the source's steps for an xBTC, a TruAPT and a USDt lender, pro rata, paid exactly the expected amount of OKX xBTC, truAPT and native USDt). Where the cash is short, a withdrawal of the whole balance aborts (APT: `Subtraction overflow` in the interest-rate update).
- **Enumeration:** every store holding an Echo aToken (aTokens cannot be transferred, so holders are suppliers) of about $1 or more, one indexer scan per reserve (~30 pages). Smaller holdings are dust: 47,870 of 48,460 APT holders hold 587 APT of the reserve's 297,679 (scaled, 2026-10-24). The check page reads any address in full.
- **Sized (2026-10-24, keyed, 235 requests):** 2,343 owners hold about $1 or more. APT: 317,000 owed to 590 lenders against 0.013 APT of cash (the reserve is lent out, mostly to Echo's own wallet). The 40 largest APT lenders (98.7% of it) were read through the source: 13 have debt and are left out; the rest are owed 284,146 APT, all `blocked` (~$233K at APT $0.82). Also owed: lzUSDT 7,795 and lzUSDC 6,867 (partly lent out), eAPT 3,197, Echo-wrapped USDt 4,729 and USDC 2,324, aBTC 72.8 to users (unpriced; the cash covers it), TruAPT 101, xBTC 0.91.
- **Not read yet (#36):** eAPT liquid staking (unstake requests) and Echo's strategy vaults (`0xf52c…ca7f`).

## goblin-wiped-out-vaults

- **What:** shares left in the ten Goblin vaults that Goblin wiped out. Goblin is an Aptos protocol whose vaults manage Hyperion liquidity (`0x19bc…cd55`).
- **Status (checked 2026-10-26):** these vaults are deprecated.
  - On 2026-08-10, 07:53–08:03 UTC, Goblin's admin (`0xf3e2…`) called `vaults::wipe_out` on ten vaults. The APT-goAPT vault's recorded amounts were updated on 2026-08-20.
  - Each wipe-out closed the vault's Hyperion position and moved the proceeds into the vault's `ClearOut` stores (`able_to_deposit: false`, `able_to_withdraw: true`).
  - No notice was found; the on-chain wipe-out is the evidence. Goblin's other vaults and goAPT stay live.
  - Aged from each vault's wipe-out (APT-goAPT: 2026-08-20), or from the holding's own later change: the share store's last change, or a staker's last MasterChef call.
- **DefiLlama (#40):** Goblin's TVL fell to ~$42 for two reasons.
  - Its adapter skips vaults whose Hyperion position aborts, which is every wiped-out vault.
  - Owners withdrew from the other vaults (2026-09-26, 2026-10-08/09).
  - A private xBTC-aBTC vault (`0xb77d…`) still holds ~1.75 aBTC in a live position, which DefiLlama can't price.
- **Payout (simulated 2026-10-26):** `remove_as_pair(vault, shares)` pays from the ClearOut stores, first come, first served. It aborts (`EINSUFFICIENT_BALANCE`) once a store is short of the claim.
  - Most holders are paid what the vault recorded at the wipe-out: `get_token_amount_by_share`, which is `actual_token_*_amount` × shares / total shares.
  - Accounts on the vault's `name_list` (1–7 per vault) are paid at the closed position's own amounts, `position_amount_*` × shares / total shares, which are mostly lower. Listed and unlisted holders were simulated in three vaults; each was paid exactly as computed.
  - The recorded amounts stay fixed as holders withdraw. So in most vaults the store now holds less than all shares are owed. APT-USDC, for example, holds 238.6 APT against 18,532 APT of claims.
- **Positions:**
  - Per vault, the wallet's shares (primary store) and the shares staked in Goblin's MasterChef (`0x1ddd…7b92`; `get_user_info(pool, owner)`) are separate parts.
  - Each part is counted as `recoverable` for its pro-rata share of each store, up to its claim (decided 2026-10-26, as for Echo).
  - The rest of the claim is a separate `blocked` part (`store_short`, locator `<part>/store-short`). Where one token's store is empty, nothing can be withdrawn, so the whole claim is blocked.
  - The MasterChef's own account (`0x1fdb…370c`), which holds the staked shares, is left out.
- **Recovery:**
  - For staked shares, call `masterchef::withdraw(pool, amount)` first.
  - Then call `vaults::remove_as_pair(vault, shares)` with as many shares as the stores cover now (all of them while they cover the claim). The step lists what that pays.
  - Withdrawing early can pay more than the counted share, up to the full claim.
  - 13 simulated withdrawals (2026-10-26) all succeeded and paid exactly the step's outputs: per vault the largest wallet part, two named accounts, and the largest stake's unstake.
- **Enumeration:**
  - Every holder of the ten vaults' shares (`current_fungible_asset_balances`). Pages are keyed on `last_transaction_version`, because ordering by store or owner times out for the APT-USDt vault's 840 stores.
  - Every sender of `masterchef::deposit` and `zap::zap_in_*` (stakers). Together they cover each MasterChef pool's `total_amount` (checked 2026-10-26).
  - Holders are re-read every run: every withdrawal changes what the stores hold for everyone else, and the store check needs positions and stores at the same version.
- **Sanity:** per vault and token, the counted amount stays ≤ the store, and what the positions are owed stays ≤ what all shares are owed (at the recorded amounts, or at the position's amounts where those are higher).
- **Rehearsal (2026-10-26, keyed, 30,455 requests):**
  - 4,190 candidates, all complete; sanity ok.
  - 10,116 positions of 3,587 owners. **$9.8K is recoverable** across 3,475 owners, 104 of them with ≥ $10; 759 of those positions hold unpriced goAPT, USD1, xBTC, aBTC or WBTC. The rest is `blocked`.
  - Owed in all (face): $32.6K.
  - Nothing is 90+ days old yet: the wipe-outs were on 2026-08-10, so positions count from 2026-11-08.

## aries-wound-down (check-only)

- **What:** deposits left in Aries Markets (Aptos lending) after its wind-down, read on the check page only: no dashboard totals (decided 2026-10-22). Re-reading its ~455K profiles each run would cost ~285K reads.
- **Status:** closed. app.ariesmarkets.xyz serves only "Aries Markets was wound down in July 2026" (read 2026-10-07); the notice gives only the month, so the effective date is 2026-07-31 23:59:59 UTC. Aries's admin multisig moved most reserves' cash out in 26 transactions between 2026-06-26 and 2026-08-17 (`controller::admin_withdraw_all_coins`; see the Aries notes in aptos-script, `docs/ARIES_DECIBEL_VIEWS.md` §3.5.1).
- **Positions:** the owner's `profile::Profiles` names its profiles; each profile's `deposited_reserves` and `borrowed_reserves` are linked tables walked head to tail. Each supplied reserve is valued with `profile::profile_deposit<T>(owner, name)`: the protocol's current quote, which after the drain is a fraction of what was deposited for most reserves (stAPT ~1%, lzUSDC ~1%, APT ~97% on 2026-10-07). Aries's own wrapper coins are paid as the fungible asset they wrap (`fa_to_coin_wrapper::WrapperCoinInfo`). R4: a profile with any nonzero `profile_loan` share is left out. Accrued rewards are not read.
- **Borrowers:** a profile with any loan (`profile_loan` > 0) is not counted (R4); its deposits are shown as `blocked` (`has_debt`, naming the reserves it borrows), with no step until the loan is repaid.
- **Blocked:** a reserve that cannot redeem (`paused`), whose cash is below the quote (`reserves_removed`), or, when the profile still supplies another reserve, whose other reserves' oracle prices are stale (`stale_oracle`: the contract values what is left after a withdrawal, and nobody updates Aries's prices). A reserve whose quote overflows (it records more than its loans plus cash; phase 0 found 2 such users of ~200) cannot be quoted or withdrawn: `reserve_accounting_negative`, with no amount. Each reserve is read on its own, so one failing leaves the others readable.
- **Age:** from the wind-down (2026-07-31 23:59:59 UTC), unless the owner deposited into Aries after it: Aries still takes deposits (several in 2026-10), so then the age is unknown. The owner's transactions since version 6,554,002,069 (the first block of 2026-08-01, from the archive) are read newest first, 100 a page (filtering by function times out; by sender and version it takes ~1 s); more than 10 pages leaves the age unknown, and so does an indexer that has not reached the read's version within ~10 s (it usually trails the fullnode by about a second).
- **Recovery:** `controller::withdraw<T>(profile name, u64 max, false)` (`withdraw_fa<T>` for wrapped assets); u64 max withdraws everything the profile supplies to the reserve.
- **Sample (2026-10-22):** depositors from three eras (2024, 2025, 2026; 215 accounts): 22 positions, all recoverable at the quote (the quote already reflects the drain, so reserve cash covers it); most depositors had withdrawn. 3 simulated withdrawals succeeded and paid the quote (one 1 unit more: interest between versions).
