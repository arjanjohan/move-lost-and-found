// Every Aptos and Movement protocol we know of, with what we did about it. Seeded from DefiLlama's protocol list
// (2026-10-20: 91 on Aptos, 8 on Movement) plus protocols DefiLlama does not list. Evidence for implemented sources and
// sized candidates lives in docs/sources.md; this is the index. `not_checked` means nobody has looked yet.

export type ProtocolStatus =
  | 'implemented'     // has sources (listed)
  | 'dormant'         // a source exists but counts nothing until a trigger
  | 'needs_decision'  // waiting on a rule decision (issue)
  | 'blocked'         // funds may be left behind, but cannot be read or recovered usefully
  | 'too_small'       // sized; below what is worth a source
  | 'not_left_behind' // checked; nothing qualifies (live protocol, nothing ended, or nothing held for users)
  | 'out_of_scope'    // not a protocol that holds users' on-chain positions (custodial exchanges)
  | 'not_checked';

export interface ProtocolEntry {
  id: string;
  name: string;
  chains: ('aptos' | 'movement')[];
  category: string;
  status: ProtocolStatus;
  /** One sentence: why this status. */
  reason: string;
  /** When the status was last checked (absent while not checked). */
  checkedAt?: string;
  sources?: string[];
  issue?: number;
  /** DefiLlama slug, for its page. */
  defillama?: string;
  /** DefiLlama marks the protocol dead (with its date when it gives one). */
  dead?: string;
}

const A = ['aptos'] as const, M = ['movement'] as const;
const cex = (id: string, name: string): ProtocolEntry => ({ id, name, chains: [...A], category: 'CEX', status: 'out_of_scope',
  reason: 'Custodial exchange: balances are held by the exchange, not in an on-chain position.', checkedAt: '2026-10-20', defillama: id });

export const PROTOCOLS: ProtocolEntry[] = [
  // Implemented
  { id: 'aptos-native-staking', name: 'Aptos native staking', chains: [...A], category: 'Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Unstaked APT whose lockup ended, and stake left with validators that left the set.', sources: ['native-delegation', 'delegation-inactive-validator'] },
  { id: 'thala-lsd', name: 'Thala LSD', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Matured unstake requests never claimed.', sources: ['thala-unstake'], defillama: 'thala-lsd' },
  { id: 'thala-vethl', name: 'Thala veTHL', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Expired veTHL locks never unlocked.', sources: ['thala-vethl-expired'], defillama: 'thala-vethl' },
  { id: 'thalaswap', name: 'ThalaSwap', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Vested farm rewards never claimed. v1 LP itself still trades (live liquidity).', sources: ['thala-vesting-matured'], defillama: 'thalaswap' },
  { id: 'kofi-finance', name: 'Kofi Finance', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Wound down: matured withdrawal tickets, and kAPT/stkAPT still held without a market.', sources: ['kofi-withdrawals', 'kofi-receipts'], defillama: 'kofi-finance' },
  { id: 'tortuga', name: 'Tortuga', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Unstake tickets never claimed.', sources: ['tortuga-tickets'], defillama: 'tortuga', dead: 'yes' },
  { id: 'amnis-finance', name: 'Amnis Finance', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Withdrawal NFTs whose lockup ended, never redeemed.', sources: ['amnis-withdrawals'], defillama: 'amnis-finance' },
  { id: 'trustake', name: 'TruStake (TruFin)', chains: [...A], category: 'Liquid Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Unlock requests claimable, never withdrawn.', sources: ['trufin-unlocks'], defillama: 'trustake' },
  { id: 'merkle-trade', name: 'Merkle Trade', chains: [...A], category: 'Derivatives', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Wound down in February 2026: LP left behind, and staked MKL never unlocked.', sources: ['merkle-mklp', 'merkle-vemkl'], defillama: 'merkle-trade', dead: '2026-02-03' },
  { id: 'layerzero-aptos-bridge', name: 'LayerZero Aptos Bridge', chains: [...A], category: 'Bridge', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Tokens bridged in that arrived but were never claimed.', sources: ['layerzero-claimable'] },
  { id: 'pancakeswap-amm', name: 'PancakeSwap', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'CAKE left in syrup pools that ended in 2023-2024, and farm rewards never harvested after emissions ended.', sources: ['pancake-syrup-ended', 'pancake-farm-ended-rewards'], defillama: 'pancakeswap-amm' },
  { id: 'topaz', name: 'Topaz', chains: [...A], category: 'NFT Marketplace', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Closed in August 2024: APT escrowed in expired bids.', sources: ['topaz-bids'] },
  { id: 'echelon-market', name: 'Echelon (Aptos)', chains: [...A], category: 'Lending', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Supply left in the 21 frozen markets, by suppliers without debt.', sources: ['echelon-frozen-markets'], defillama: 'echelon-market' },
  { id: 'econia', name: 'Econia', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Repository archived 2025-09-08 and no trading since: coins left idle in market accounts.', sources: ['econia-idle-accounts'], defillama: 'econia', dead: '2025-09-08' },
  { id: 'movement-native-staking', name: 'Movement native staking', chains: [...M], category: 'Staking', status: 'implemented', checkedAt: '2026-10-20',
    reason: 'Unstaked MOVE whose lockup ended, and stake left with validators that left the set.', sources: ['movement-native-delegation', 'movement-inactive-validator'] },
  { id: 'canopy', name: 'Canopy', chains: [...M], category: 'Yield Aggregator', status: 'implemented', checkedAt: '2026-10-28',
    reason: 'Maintenance-only mode: deposits closed 2026-10-19, app retiring 2026-12-22, contracts stay withdraw-capable. Staking rewards from reward periods that ended, never claimed; and shares left in vaults Canopy closed to deposits (2026-06 and 2026-10).', sources: ['canopy-ended-rewards', 'canopy-frozen-vaults'], defillama: 'canopy' },

  // Dormant
  { id: 'aave-aptos', name: 'Aave (Aptos)', chains: [...A], category: 'Lending', status: 'dormant', checkedAt: '2026-10-20',
    reason: 'Aave is winding down Aptos by freezing every reserve; the source counts supply once a reserve freezes. None is frozen yet.', sources: ['aave-frozen-reserves'], defillama: 'aave-aptos' },

  // Waiting on a decision
  { id: 'aries-markets', name: 'Aries Markets', chains: [...A], category: 'Lending', status: 'implemented', checkedAt: '2026-10-22',
    reason: 'Wound down in July 2026 and most reserve cash moved out: deposits are read on the check page only (decided 2026-10-22), at the protocol\'s current quote; no dashboard totals (re-reading ~455K profiles would cost ~285K reads a run).', sources: ['aries-wound-down'], defillama: 'aries-markets' },
  { id: 'portal', name: 'Wormhole (Portal)', chains: [...A], category: 'Bridge', status: 'implemented', checkedAt: '2026-10-22',
    reason: 'Transfers to Aptos never redeemed: found through Wormholescan on the check page when the visitor opts in (decided 2026-10-22), checked on chain against the bridge\'s consumed VAAs; no dashboard totals.', sources: ['wormhole-unredeemed'], defillama: 'portal' },
  { id: 'layerzero-v2', name: 'LayerZero v2 OFTs and Stargate', chains: [...A, ...M], category: 'Bridge', status: 'too_small', checkedAt: '2026-10-22',
    reason: 'Deliveries that never executed, read on chain (the endpoint\'s stored inbound payload hashes): on Movement 22 of 30,098 verified packets, of which only 2 carry tokens (136 MOVE on the MOVE adapter, retryable by anyone now); on Aptos 54, all name-service proxy messages or integration tests. About $1 in all.' },

  // Blocked
  { id: 'aptin-finance', name: 'Aptin Finance', chains: [...A], category: 'Lending', status: 'blocked', checkedAt: '2026-10-07',
    reason: 'Every withdrawal aborts on stale prices (operator prices not updated since 2026-07-25); value could only show as "may not work".', defillama: 'aptin-finance-v2' },
  { id: 'kana-perps', name: 'Kana perps', chains: [...A], category: 'Derivatives', status: 'blocked', checkedAt: '2026-10-19',
    reason: 'Every market is deprecated and the collateral stores hold no USDt: recorded balances are face value only.' },
  { id: 'tapp-exchange', name: 'Tapp Exchange', chains: [...A], category: 'Dexs', status: 'blocked', checkedAt: '2026-10-19',
    reason: 'Wound down 2026-05-31; every router hook is paused, so liquidity cannot be removed.', defillama: 'tapp-exchange', dead: '2026-05-31' },
  { id: 'gui-lottery', name: 'GUI lottery', chains: [...A], category: 'Yield Lottery', status: 'blocked', checkedAt: '2026-10-07',
    reason: 'A claim needs a voucher signed by the operator.' },

  // Too small
  { id: 'fliq', name: 'Fliq', chains: [...A], category: 'Prediction market', status: 'too_small', checkedAt: '2026-10-20',
    reason: 'Unredeemed winnings would count, but all Fliq collateral is 4,200 USDt.' },
  { id: 'mirage-protocol', name: 'Mirage Protocol', chains: [...A, ...M], category: 'Derivatives', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Reportedly closed; ~$714 of TVL left.', defillama: 'mirage-protocol' },
  { id: 'aux-exchange', name: 'AUX Exchange', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Development ceased 2023-03-17; about $5K left in its pools.', defillama: 'aux-exchange' },
  { id: 'hyperion', name: 'Hyperion', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Live DEX; its delayed LP withdrawals (fridge) hold 4.70 APT unclaimed in total.', defillama: 'hyperion' },
  { id: 'cellana-finance', name: 'Cellana Finance', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'CELL is quoted at $0.00006 (stale): expired veCELL locks are worth nothing.', defillama: 'cellana-finance', dead: 'yes' },
  { id: 'moar-market', name: 'Moar Market', chains: [...A], category: 'Leveraged Farming', status: 'too_small', checkedAt: '2026-10-20',
    reason: 'About $0 TVL; farming rewards are paid in a token without a price.', defillama: 'moar-market' },
  { id: 'yuzu-finance', name: 'Yuzu Finance', chains: [...M], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Rewards are MOVE only, worth too little to track; LP is live liquidity.', defillama: 'yuzu-finance' },
  { id: 'echelon-movement', name: 'Echelon (Movement)', chains: [...M], category: 'Lending', status: 'too_small', checkedAt: '2026-10-20',
    reason: 'The 3 frozen markets (LBTC, SolvBTC, rsETH) hold ~$40 in total.', defillama: 'echelon-market' },
  { id: 'echelon-farming', name: 'Echelon farming rewards', chains: [...A, ...M], category: 'Lending', status: 'too_small', checkedAt: '2026-10-19',
    reason: 'Ended reward programs; Echelon holds only ~$3.6K (Aptos) and ~$2.1K of MOVE (Movement) to pay them.' },

  // Not left behind
  { id: 'superposition', name: 'Superposition', chains: [...A], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Markets unpaused and still used; withdrawals take a packet its service still signs.', defillama: 'superposition' },
  { id: 'moveposition', name: 'MovePosition', chains: [...M], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-20',
    reason: 'Live: its service still signs withdrawal packets.', defillama: 'moveposition' },
  { id: 'joule-finance', name: 'Joule Finance', chains: [...A, ...M], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-22',
    reason: 'Live on both chains (app.joule.finance serves both; on Movement, joule-core deposits until 2026-09-27); withdrawals need paid Pyth price updates, a cost of using it, not a closure.', defillama: 'joule-finance' },
  { id: 'ditto', name: 'Ditto', chains: [...A], category: 'Liquid Staking', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Unstake queue empty and redemption still works, so stAPT is not stranded.', defillama: 'ditto', dead: 'yes' },
  { id: 'thalaswap-v2', name: 'ThalaSwap V2', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Live DEX: LP is live liquidity.', defillama: 'thalaswap-v2' },
  { id: 'thalaswap-v3', name: 'ThalaSwap V3', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Live DEX: LP is live liquidity.', defillama: 'thalaswap-v3' },
  { id: 'meridian-amm', name: 'Meridian', chains: [...M], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Live DEX; staked LP is live principal and extra rewards are MOVE.', defillama: 'meridian-amm' },
  { id: 'near-intents', name: 'NEAR Intents', chains: [...A], category: 'Bridge', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Swaps settled by solvers: nothing is held for the user on Aptos.', defillama: 'near-intents' },
  { id: 'bridges-settled', name: 'Meson, Gas.zip, ChangeNOW, Swapspace, Panora, CashmereLabs', chains: [...A], category: 'Bridge', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Swaps settled by liquidity providers: nothing is held for the user on Aptos.' },
  { id: 'movement-framework-bridges', name: 'Movement framework bridges', chains: [...M], category: 'Bridge', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'atomic_bridge and native_bridge were never used on mainnet: event counters 0, transfer tables empty.' },
  { id: 'tradeport', name: 'TradePort', chains: [...A], category: 'NFT Marketplace', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Left Aptos; every bid is gone.' },
  { id: 'validator-owned-pools', name: 'Validator-owned stake pools', chains: [...A], category: 'Staking', status: 'not_left_behind', checkedAt: '2026-10-20',
    reason: 'The large pools (14.4M and 4.1M APT) look institutional, between validator setups; no evidence of abandonment.' },
  { id: 'amnis-ami', name: 'Amnis AMI vesting and claims', chains: [...A], category: 'Liquid Staking', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'Vesting buckets belong to the team and investors; "AMI Claim" NFTs were paid off chain.' },

  // No closure evidence found (checked, nothing ended)
  { id: 'thala-cdp', name: 'Thala CDP (MOD)', chains: [...A], category: 'CDP', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'No closure notice found.', defillama: 'thala-cdp' },
  { id: 'auro-finance', name: 'Auro Finance', chains: [...A], category: 'CDP', status: 'implemented', checkedAt: '2026-10-21',
    reason: 'Website shut down by 2026-04-30 (team notice): collateral left in debt-free positions.', sources: ['auro-closed-positions'], defillama: 'auro-finance' },
  { id: 'echo', name: 'Echo (lending, liquid staking, strategy)', chains: [...A], category: 'Lending', status: 'implemented', checkedAt: '2026-10-24', issue: 36,
    reason: 'Winding down (notice 2026-10-19; withdrawals until 2026-11-19 23:59 UTC). Lending supply counts, aged from the notice (decided 2026-10-24); most of the APT reserve is lent out, so its lenders wait on repayment or liquidation. eAPT staking and strategy positions are not read yet, and how what is left after the deadline counts is open (#36). aBTC redemption stays open.', sources: ['echo-wound-down'], defillama: 'echo-lending' },
  { id: 'souffl3', name: 'Souffl3', chains: [...A], category: 'NFT Marketplace', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'No closure evidence found.' },
  { id: 'celer-cbridge', name: 'Celer cBridge', chains: [...A], category: 'Bridge', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'No closure evidence; the peg bridge still mints.' },
  { id: 'argo', name: 'Argo', chains: [...A], category: 'CDP', status: 'not_left_behind', checkedAt: '2026-10-19',
    reason: 'No closure notice found.', defillama: 'argo', dead: 'yes' },
  { id: 'goblin', name: 'Goblin', chains: [...A], category: 'Yield Aggregator', status: 'implemented', checkedAt: '2026-10-26',
    reason: 'Wiped out ten vaults on 2026-08-10 (vaults::wipe_out): their Hyperion positions were closed into stores holders withdraw from themselves, first come, first served (#40). Its other vaults and goAPT stay live. DefiLlama\'s drop to ~$42 is its adapter skipping the wiped-out vaults plus owner withdrawals from the others.',
    sources: ['goblin-wiped-out-vaults'], defillama: 'goblin' },
  { id: 'animeswap', name: 'AnimeSwap', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-21',
    reason: 'Frontend gone (no address record for animeswap.org, 2026-10-21): LP left in its pools, which still work.', sources: ['animeswap-closed-lp'], defillama: 'animeswap', dead: 'yes' },
  { id: 'abel-finance', name: 'ABEL Finance', chains: [...A], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-21',
    reason: 'Still used despite DefiLlama\'s dead flag: mints, borrows and redemptions until 2026-10-17, liquidations 2026-10-16.', defillama: 'abel-finance', dead: 'yes' },
  { id: 'meso-finance', name: 'Meso Finance', chains: [...A], category: 'Lending', status: 'not_left_behind', checkedAt: '2026-10-20',
    reason: 'Still used despite DefiLlama\'s dead flag: deposits until 2026-09-23, withdrawals until 2026-09-14, all pools unpaused and accruing.', defillama: 'meso-finance', dead: 'yes' },
  { id: 'emojicoin.fun', name: 'Emojicoin.fun', chains: [...A], category: 'Launchpad', status: 'too_small', checkedAt: '2026-10-22',
    reason: 'Closed (frontend decommissioned 2025-09-04), so its LP and Arena escrows count, but they are small: LP in 438 holdings of 332 owners (62 markets) removes for 350 APT plus emojicoins that Panora quotes at 336 APT (every market; no quote above pool price), ~686 APT (~$530); Arena escrows ~182 APT of emojicoins at spot. The markets\' own locked LP (~34K APT) has no signer.', defillama: 'emojicoin.fun', dead: 'yes' },
  { id: 'earnium', name: 'Earnium', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-21',
    reason: 'Frontend gone (no address record for earnium.io, 2026-10-21): LP left in its pools and liquidity staking, which still work.', sources: ['earnium-closed-lp'], defillama: 'earnium', dead: '2026-10-10' },
  { id: 'arche-protocol', name: 'Arche Protocol (MSD)', chains: [...M], category: 'CDP', status: 'too_small', checkedAt: '2026-10-21', defillama: 'arche-protocol', dead: 'yes',
    reason: 'Closed: archeprotocol.xyz (its listed site) is for sale; last served 2026-04 (Wayback), last contract call 2025-09-28. Its 501K MOVE (~$3.8K) back open MSD loans (538 positions, R4); the 26 debt-free positions hold 39 MOVE.' },

  { id: 'mole', name: 'Mole', chains: [...A], category: 'Yield', status: 'too_small', checkedAt: '2026-10-21', defillama: 'mole',
    reason: 'Frontend down (app.mole.fi empty from 2026-10-20) and repository deleted, but nothing counts: the one material holding (~$15.5K of PancakeSwap APT/USDC LP) is in two farm positions that carry debt (R4); the debt-free positions are dust and its lending vaults hold ~51 APT and ~400 USDC.' },
  { id: 'aptoswap', name: 'Aptoswap', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'aptoswap', dead: 'yes',
    reason: 'Live despite DefiLlama\'s dead flag: aptoswap.net is up and its APT pool last traded 2026-10-20.' },
  { id: 'mosaic-amm', name: 'Mosaic', chains: [...M], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'mosaic-amm',
    reason: 'Frontend up (app.mosaic.ag) and no closure evidence; DefiLlama TVL $3.5K.' },
  { id: 'interest-protocol', name: 'Interest Protocol (Curve, DEX)', chains: [...M], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-21', defillama: 'interest-curve',
    reason: 'Frontend up, and its 11 pools hold ~1.5 MOVE plus dust (lens::getAllPools).' },
  { id: 'thetis-perps', name: 'Thetis Perps', chains: [...A], category: 'Derivatives', status: 'too_small', checkedAt: '2026-10-22', defillama: 'thetis-perps', dead: 'yes',
    reason: 'Frontend gone (thetis.market parked for sale, 2026-10-21), but small: its account and pools hold $931 of USDt and ~1 amAPT in all; its own T_APT, T_WETH and T_WBTC have no route anywhere and nothing on Thetis backs them.' },

  { id: 'collex', name: 'Collex', chains: [...A], category: 'Physical TCG', status: 'too_small', checkedAt: '2026-10-21', defillama: 'collex', dead: 'yes',
    reason: 'collex.fun no longer resolves (served until at least 2026-02). Users can claim at most ~$2.3K: its USD token supply is 1,135 and cards are valued at $1,229 (15% cash-out fee); the rest of the treasury\'s 19.5K USDt is the protocol\'s.' },

  { id: 'baptswap', name: 'BaptSwap (V1, V2, V2.1)', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-22', defillama: 'baptswap-v2.1', dead: 'yes',
    reason: 'Closed (none of its domains resolve, 2026-10-21), but small: its 12 pools hold 91 APT, $38 of stablecoins and ~5 APT of coins Panora prices, ~$115 in all. Its other coins (WarCoin, MAU, BaptLabs) have no route anywhere, so they sell only into these pools, whose APT and stablecoins are counted.' },
  { id: 'atodex', name: 'AtoDEX', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-22', defillama: 'atodex', dead: 'yes',
    reason: 'Its 8 pools hold 15 APT, $7 of stablecoins and ADXT that Panora prices at ~115 APT (pool price, an upper bound), ~$110 in all; ARC and Aptoge have no route anywhere, so they sell only into these pools.' },
  { id: 'aptoslaunch', name: 'AptosLaunch', chains: [...A], category: 'Launchpad', status: 'too_small', checkedAt: '2026-10-22', defillama: 'aptoslaunch', dead: 'yes',
    reason: 'Closed (aptoslaunch.io redirects to an unrelated site), but small: its lock-bond pools hold its own ALT, and every market for ALT together pays at most ~84 APT (~$65) however much is sold (Panora, 2026-10-22).' },
  { id: 'lotto-run', name: 'Lotto Run', chains: [...A], category: 'Yield Lottery', status: 'too_small', checkedAt: '2026-10-21', defillama: 'lotto-run', dead: 'yes',
    reason: 'Its 4 lottery pots hold 14 APT.' },
  { id: 'movepump', name: 'MovePump', chains: [...A], category: 'Launchpad', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'movepump', dead: 'yes',
    reason: 'Bonding curves (175, 757.5 APT): holders keep the tokens in their wallets, and the curve is their market (R1).' },
  { id: 'movegpt', name: 'MoveGPT', chains: [...A], category: 'Launchpad', status: 'too_small', checkedAt: '2026-10-21', defillama: 'movegpt', dead: '2026-03-05',
    reason: 'Its two staking pools hold ~477K MGPT, ~$6 at CoinGecko\'s price.' },

  { id: 'liquidswap', name: 'LiquidSwap', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'liquidswap',
    reason: 'Live: liquidswap.com serves the app (2026-10-21); its liquidity is in live use (R4).' },
  { id: 'cetus-clmm', name: 'Cetus CLMM', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'cetus-clmm',
    reason: 'Live: app.cetus.zone serves the app (2026-10-21); its liquidity is in live use (R4).' },
  { id: 'sushi-aptos', name: 'Sushi (Aptos)', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-26', defillama: 'sushi-aptos',
    reason: 'Live: sushi.com serves its Aptos app (2026-10-21); its liquidity is in live use (R4). The TVL drop of 2026-10-01 is one liquidity provider removing its USDC/WETH position (162,317 USDC and 60.16 WETH); pairs still trade (checked 2026-10-26, #41).' },
  { id: 'obric', name: 'Obric', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'obric',
    reason: 'Live: obric.xyz is up (2026-10-21); its liquidity is in live use (R4).' },
  { id: 'tsunamix', name: 'TsunamiX (Tsunami Finance)', chains: [...A], category: 'Derivatives', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'tsunamix', dead: 'yes',
    reason: 'Live despite DefiLlama\'s dead flag: tsunami.finance/trade serves the app (2026-10-21).' },
  { id: 'wapal', name: 'Wapal', chains: [...A], category: 'NFT Marketplace', status: 'too_small', checkedAt: '2026-10-22',
    reason: 'Expired offers never cancelled still escrow APT (an ended position: the creator cancels to get it back), but in dust. Its marketplace (`0x584b…58c9`, Mokshya) took 253,159 collection and token offers from 2023-08 to 2026-05-12; in a sample of every 200th, 74% are still open, all expired, holding 13.8 APT: ~2,750 APT (~$2.1K) over ~187K offers, ~0.015 APT each, nearly all under 0.25 APT per creator. wapal.io\'s origin is down (Cloudflare 522, 2026-10-22; last archived 2026-04-30).' },
  { id: 'seashrine', name: 'SeaShrine', chains: [...A], category: 'NFT Marketplace', status: 'too_small', checkedAt: '2026-10-23',
    reason: 'seashrine.io does not answer (2026-10-22, last archived 2023-10). Its marketplace (`0xd543…5548`, from the archived app) never took an offer (0 created), so nothing of buyers\' is escrowed; listings hold the sellers\' NFTs, which have no price here. Its launchpad (`0xcf32…1370`) escrows creators\' sale proceeds, not buyers\' funds: ~105 APT (~$86) in its resource account.' },
  { id: 'metaspacecy', name: 'Metaspacecy', chains: [...A], category: 'NFT Marketplace', status: 'not_left_behind', checkedAt: '2026-10-23',
    reason: 'Never on mainnet: its archived Aptos app (aptos.metaspacecy.com, 2023-04) points at testnet (`fullnode.testnet.aptoslabs.com`, test coins `metaspacecy_coin_test`), and its contract addresses publish no modules on mainnet.' },
  { id: 'seam-money', name: 'Seam Money', chains: [...A], category: 'Yield Aggregator', status: 'not_left_behind', checkedAt: '2026-10-23',
    reason: 'Its vaults never shipped on mainnet: the contracts (github.com/SeamMoney/seam-contracts, last pushed 2023-05) name no deployed address, and no mainnet transaction calls their modules (`SeamStaker`, `cpu`). seam.money does not answer (2026-10-22); the team moved on to other Aptos apps.' },
  { id: 'meeiro', name: 'Meeiro', chains: [...A], category: 'Launchpad', status: 'not_checked',
    reason: 'Listed in the Aptos Foundation\'s 2024 project list; meeiro.xyz does not answer (2026-10-22, last archived 2025-03). Contract not located: the archived site (2022-08 to 2024-07) is a landing page whose scripts name no Aptos contract, and its token\'s package (`0xe9c1…60d9::mee_coin`) holds only the coin. MEE has no market; its largest holder (~41.5M of 50M) is a plain account.' },
  { id: 'aptopad', name: 'Aptopad', chains: [...A], category: 'Launchpad', status: 'not_left_behind', checkedAt: '2026-10-23',
    reason: 'Never launched on chain: its token (`0x4c11…::aptopadtoken::Aptopad`) has its whole supply in the deployer\'s account, and the package holds only the token module (no sale contract). aptopad.io redirects to an unrelated site (2026-10-22).' },
  { id: 'proton-sale', name: 'Proton Sale', chains: [...A], category: 'Launchpad', status: 'too_small', checkedAt: '2026-10-22',
    reason: 'protonsale.io redirects to an unrelated site (2026-10-22). Its token (`0x837a…::prt_cointype::ProtonCoin`) sits in one table on chain, a locker (`0xf422…::locker`) holding a single lock of 1,000 raw units by the token\'s own creator (2023).' },
  { id: 'avant', name: 'Avant (savUSD)', chains: [...M], category: 'Stablecoin', status: 'not_left_behind', checkedAt: '2026-10-22',
    reason: 'On Movement only its staked avUSD (savUSD, `0xde6e…5642`) exists, created by a plain account with no modules: a bridged token held in wallets, with no withdrawal requests or cooldowns on Movement. Featured on Movement\'s ecosystem page.' },
  { id: 'vibrantx', name: 'VibrantX', chains: [...A], category: 'Yield Aggregator', status: 'not_left_behind', checkedAt: '2026-10-22',
    reason: 'Holds nothing itself: it acts from users\' own accounts, so its positions are their own lending profiles (Aries profiles named "vibrantx::aries_lending", read by aries-wound-down on the check page). vibrantx.finance redirects to vibrantxapp.finance, which answers 400 (2026-10-22).' },
  { id: 'ekiden', name: 'Ekiden', chains: [...A], category: 'Derivatives', status: 'not_left_behind', checkedAt: '2026-10-22',
    reason: 'Live: app.ekiden.fi serves its trading app (2026-10-22); listed in the Aptos ecosystem directory.' },
  { id: 'decibel', name: 'Decibel', chains: [...A], category: 'Derivatives', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'decibel',
    reason: 'Live: app.decibel.trade serves the app (2026-10-21).' },
  { id: 'yield-ai', name: 'Yield AI', chains: [...A], category: 'AI Agents', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'yield-ai',
    reason: 'Live: yieldai.app is up (2026-10-21); its vaults are in live use (R4).' },
  { id: 'kaio', name: 'KAIO', chains: [...A], category: 'RWA', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'kaio',
    reason: 'Live: kaio.xyz is up (2026-10-21); fund positions are live.' },
  { id: 'goapt', name: 'GoAPT', chains: [...A], category: 'Liquid Staking', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'goapt',
    reason: 'Live: goblin.fi/goAPT is up (2026-10-21); goAPT is a liquid staking token with a live app.' },
  { id: 'moneyfi-v1', name: 'MoneyFi', chains: [...A], category: 'Yield Aggregator', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'moneyfi-v1',
    reason: 'Live: app.moneyfi.fund is up (2026-10-21); its vaults are in live use (R4).' },
  { id: 'eternal-finance', name: 'Eternal Finance', chains: [...A], category: 'Yield', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'eternal-finance',
    reason: 'Live: app.eternalfinance.io serves the app (2026-10-21).' },
  { id: 'newrlrwa', name: 'NewrlRWA', chains: [...A], category: 'RWA', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'newrlrwa',
    reason: 'Live: newrl.net is up (2026-10-21); its carbon-credit tokens sit in wallets (R1).' },
  { id: 'bridgers', name: 'Bridgers', chains: [...A], category: 'Dexs', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'bridgers',
    reason: 'Live: bridgers.ai is up (2026-10-21); a swap router that holds no user positions.' },
  { id: 'propbase', name: 'Propbase', chains: [...A], category: 'RWA', status: 'too_small', checkedAt: '2026-10-21', defillama: 'propbase',
    reason: 'Its fixed-term "Summer 2025" staking pool ended 2026-05-13; everything it still holds, unclaimed principal (~139K PROPS) and rewards together, is 439K PROPS (~$2.7K). Its membership staking is live (no end).' },
  { id: 'moveflow', name: 'MoveFlow', chains: [...A], category: 'Payments', status: 'too_small', checkedAt: '2026-10-21', defillama: 'moveflow',
    reason: 'Its stream escrow holds ~2.1 USDt, 0.2 USDC and 0.28 APT (stream::get_fa_tvl, get_coin_tvl).' },
  { id: 'jujube-finance', name: 'Jujube Finance', chains: [...A], category: 'Dexs', status: 'too_small', checkedAt: '2026-10-22', defillama: 'jujube-finance', dead: 'yes',
    reason: 'jujube.finance is listed as an expired domain (2026-10-21); its 10 pools hold 17 APT, $2 of stablecoins and ~12 APT of JUJUBE at Panora price, ~$25 in all; DLC and four MEME coins have no route anywhere, so they sell only into these pools.' },
  { id: 'mosquitos-finance', name: 'Mosquitos Finance', chains: [...A], category: 'Yield', status: 'too_small', checkedAt: '2026-10-22', defillama: 'mosquitos-finance', dead: '2023-03-09',
    reason: 'No domain answers (2026-10-21). Its masterchef (`0x4db7…5832`, which ships a `drain` module) is empty but for its own SUCKR token (no route anywhere) and LiquidSwap LP worth dust (215 octas of APT; 0.014 APT and 0.007 tAPT): every other pool\'s reserve is 0.' },
  { id: 'bluemove-staking', name: 'BlueMove Staking', chains: [...A], category: 'NFT Marketplace', status: 'too_small', checkedAt: '2026-10-22', defillama: 'bluemove-staking', dead: 'yes',
    reason: 'Its staking holds ~16.5M of BlueMove\'s own MOVE token (staking_move_earn_move / _nft), which sells for ~405 APT (~$315; Panora, 2026-10-22; every market together pays at most ~460 APT), so small whether or not stakes have ended.' },
  { id: 'poly-network', name: 'Poly Network', chains: [...A], category: 'Bridge', status: 'not_left_behind', checkedAt: '2026-10-22', defillama: 'poly-network', dead: '2024-09-30',
    reason: 'Never used on Aptos: its package (`0x4a98…2eb3`, from polynetwork/aptos-contracts) was published 2022-10-20/21 and no entry function was ever called; its bridged coin (`coins::ETH`) was never initialized and its lock proxy holds nothing.' },
  { id: 'streamflow', name: 'Streamflow', chains: [...A], category: 'Payments', status: 'too_small', checkedAt: '2026-10-22', defillama: 'streamflow',
    reason: 'Live, but streams that ended and were never withdrawn (an ended position) are small: in a 1-in-5 sample of its 2,869 Aptos streams (`0x9009…51b0::protocol`), 219 ended 90+ days ago with funds left, 176 of them a test coin; scaled up ~56 APT plus PROPS that Panora quotes at ~191 APT, ~$190, and two memecoins with no route anywhere.' },
  { id: 'movefast', name: 'MoveFast', chains: [...A], category: 'Launchpad', status: 'not_left_behind', checkedAt: '2026-10-22', defillama: 'movefast',
    reason: 'Live and new (DefiLlama tracks it from 2026-10-14; $2.5K of bonding-curve reserves on 2026-10-22): holders keep their tokens and the curve is their market. Its trading-tax rewards are paid in Merkle-snapshot epochs; unclaimed ones could age into a source later.' },

  { id: 'agdex', name: 'AGDEX', chains: [...A], category: 'Derivatives', status: 'not_left_behind', checkedAt: '2026-10-21', defillama: 'agdex',
    reason: 'Live: agdex.io/trade serves the app (2026-10-21).' },
  { id: 'houstonswap', name: 'HoustonSwap', chains: [...A], category: 'Dexs', status: 'implemented', checkedAt: '2026-10-22', defillama: 'houstonswap', dead: 'yes',
    reason: 'Frontend gone (houstonswap.io has no address record, 2026-10-22; the app was served until at least 2026-06-10): liquidity positions left in its pools, which still work.', sources: ['houston-closed-lp'] },

  // Out of scope: custodial exchanges DefiLlama lists with Aptos reserves
  ...([['binance-cex', 'Binance'], ['bybit', 'Bybit'], ['okx', 'OKX'], ['gate', 'Gate'], ['mexc', 'MEXC'], ['kucoin', 'KuCoin'],
    ['hashkey-exchange', 'HashKey Exchange'], ['flipster', 'Flipster'], ['backpack', 'Backpack'], ['weex', 'WEEX'], ['bitfinex', 'Bitfinex'],
    ['blofin', 'BloFin'], ['bitkub', 'Bitkub'], ['gate-us', 'Gate US'], ['fastex', 'Fastex'], ['bitlo', 'Bitlo']] as const).map(([id, name]) => cex(id, name)),
];
