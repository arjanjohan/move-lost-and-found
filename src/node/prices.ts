// Identity-bound USD prices. A quote older than 7 days is not a price.
import { PRICE_MAX_AGE_SECS, type PriceBook } from '../shared/accounting.ts';
import { SUSDE, USDC, USDT } from '../shared/sources/aave-frozen.ts';
import { AMNIS } from '../shared/sources/amnis-withdrawals.ts';
import { AMAPT_COIN } from '../shared/sources/auro-closed.ts';
import { RSETH } from '../shared/sources/canopy-frozen.ts';
import { APT, MOVE } from '../shared/sources/delegation.ts';
import { ECHO, ECHO_WRAPPED } from '../shared/sources/echo-wound-down.ts';
import { AMAPT_FA, MOD, STAPT, STHAPT, WH_USDC } from '../shared/sources/echelon-frozen.ts';
import { KAPT, STKAPT } from '../shared/sources/kofi-receipts.ts';
import { KOFI } from '../shared/sources/kofi-withdrawals.ts';
import { BTCB, CAKE, LZ_BRIDGE } from '../shared/sources/layerzero-claimable.ts';
import { THL } from '../shared/sources/thala-thl.ts';
import { THALA_LSD } from '../shared/sources/thala-unstake.ts';
import type { ChainReader } from '../shared/types.ts';

const USD1 = '0x05fabd1b12e39967a3c24e91b7b8f67719a6dacee74f3c8b9fb7d93e855437d2';

const COINGECKO = [
  { asset: APT, id: 'aptos', decimals: 8 },
  { asset: THL, id: 'thala', decimals: 8 },
  { asset: MOVE, id: 'movement', decimals: 8 },
  // LayerZero Aptos Bridge coins have their own ids; bridged USDD has none and stays unpriced.
  { asset: `${LZ_BRIDGE}::asset::USDC`, id: 'layerzero-bridged-usdc-aptos', decimals: 6 },
  { asset: `${LZ_BRIDGE}::asset::USDT`, id: 'layerzero-bridged-usdt-aptos', decimals: 6 },
  { asset: `${LZ_BRIDGE}::asset::WETH`, id: 'layerzero-bridged-weth-aptos', decimals: 6 },
  { asset: `${LZ_BRIDGE}::asset::WBTC`, id: 'layerzero-bridged-wbtc-aptos', decimals: 6 },
  // CAKE and BTC.b on Aptos are the tokens' own LayerZero OFTs (mint/burn, redeemable 1:1), priced as the token.
  { asset: CAKE, id: 'pancakeswap-token', decimals: 8 },
  { asset: BTCB, id: 'bitcoin-avalanche-bridged-btc-b', decimals: 8 },
  { asset: WH_USDC, id: 'usd-coin-wormhole-from-ethereum', decimals: 6 },
  { asset: MOD, id: 'move-dollar', decimals: 8 },
  { asset: KAPT, id: 'kofi-aptos', decimals: 8 },
  // CoinGecko lists the amAPT coin; this is its paired fungible asset.
  { asset: AMAPT_FA, id: 'amnis-aptos', decimals: 8 },
  { asset: AMAPT_COIN, id: 'amnis-aptos', decimals: 8 },
  // Native fungible assets of the Aave reserves; each id's Aptos contract is this exact address.
  { asset: USDT, id: 'tether', decimals: 6 },
  { asset: USDC, id: 'usd-coin', decimals: 6 },
  { asset: SUSDE, id: 'ethena-staked-usde', decimals: 6 },
  // USD1 (Goblin and Earnium pools) and OKX's xBTC (what Echo's wrapped xBTC pays): the ids list these exact Aptos
  // addresses (checked 2026-10-29).
  { asset: USD1, id: 'usd1-wlfi', decimals: 6 },
  { asset: ECHO_WRAPPED[`${ECHO}::fa_coin::XBTC`], id: 'okx-wrapped-btc', decimals: 8 },
  // Kelp's rsETH on Movement (Canopy's rsETH vaults); CoinGecko lists this exact address under its Movement platform.
  { asset: `movement:${RSETH}`, id: 'kelp-dao-restaked-eth', decimals: 8 },
  // Movement assets MovePosition's markets (and Canopy's vaults) pay; each id's Movement platform lists this exact
  // address (checked 2026-10-29). savUSD's id does too, but its last quote is from 2026-08-09.
  { asset: 'movement:0x83121c9f9b0527d1f056e21a950d6bf3b9e9e2e8353d0e95ccea726713cbea39', id: 'movement-bridged-usdc-movement', decimals: 6 },
  { asset: 'movement:0x447721a30109c662dde9c73a0c2c9c9c459fb5e5a9c92f03c50fa69737f5d08d', id: 'movement-bridged-usdt-movement', decimals: 6 },
  { asset: 'movement:0x908828f4fb0213d4034c3ded1630bbd904e8a3a6bf3c63270887f0b06653a376', id: 'movement-bridged-weth-movement', decimals: 8 },
  { asset: 'movement:0xba11833544a2f99eec743f41a228ca6ffa7f13c3b6b04681d5a79a8b75ff225e', id: 'usdcx-movement', decimals: 6 },
  { asset: 'movement:0x0658f4ef6f76c8eeffdc06a30946f3f06723a7f9532e2413312b2a612183759c', id: 'lombard-staked-btc', decimals: 8 },
  { asset: 'movement:0x2f6af255328fe11b88d840d1e367e946ccd16bd7ebddd6ee7e2ef9f7ae0c53ef', id: 'renzo-restaked-eth', decimals: 8 },
];

export async function fetchPrices(nowSecs: number, aptos: ChainReader): Promise<{ prices: PriceBook; errors: string[] }> {
  const prices: PriceBook = {};
  const errors: string[] = [];
  try {
    const ids = COINGECKO.map(c => c.id).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`,
      { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    for (const c of COINGECKO) {
      const q = body[c.id];
      if (!q?.usd || q.usd <= 0) { errors.push(`no quote for ${c.id}`); continue; }
      if (nowSecs - q.last_updated_at > PRICE_MAX_AGE_SECS) { errors.push(`quote for ${c.id} older than 7 days`); continue; }
      prices[c.asset] = { usd: q.usd, decimals: c.decimals, at: new Date(q.last_updated_at * 1000).toISOString(), source: 'coingecko simple/price' };
    }
  } catch (err) {
    errors.push(`coingecko: ${String(err).slice(0, 200)}`);
  }
  if (prices[APT]) await redemptionPrices(prices, errors, aptos);
  return { prices, errors };
}

/** Staked-APT receipts whose market quote is stale (stAPT's last CoinGecko quote is from 2026-09-03; sthAPT has no
 *  verified id), valued at redemption: the on-chain exchange rate x the APT quote, dated like that quote.
 *  - stAPT unstakes to amAPT at stapt_price (1e8 scale); amAPT redeems 1:1 for APT (simulated, amnis-withdrawals).
 *  - sthAPT unstakes to thAPT at thAPT_sthAPT_exchange_rate (thAPT staked / sthAPT supply); thAPT redeems for APT
 *    less unstake_APT_fee_bps. */
async function redemptionPrices(prices: PriceBook, errors: string[], aptos: ChainReader) {
  const apt = prices[APT];
  // Each protocol's rate is read on its own, so one failing view leaves only that receipt unpriced.
  const derive = async (asset: string, name: string, source: string, rate: () => Promise<number>) => {
    try {
      prices[asset] = { usd: apt.usd * await rate(), decimals: 8, at: apt.at, source };
    } catch (err) {
      errors.push(`${name} redemption rate: ${String(err).slice(0, 200)}`);
    }
  };
  await Promise.all([
    // stkAPT unstakes to kAPT at Kofi's exchange rate (1e8 scale); kAPT redeems 1:1 for APT less Kofi's withdrawal fee
    // (basis points; 0 on 2026-10-21).
    derive(STKAPT, 'stkAPT', 'derived: Kofi get_exchange_rate less get_withdrawal_fee x APT (coingecko)', async () => {
      const [[rate], [feeBps]] = await Promise.all([
        aptos.view(`${KOFI}::rewards_manager::get_exchange_rate`, []),
        aptos.view(`${KOFI}::config::get_withdrawal_fee`, []),
      ]);
      return Number(rate) / 1e8 * (1 - Number(feeBps) / 10_000);
    }),
    derive(STAPT, 'stAPT', 'derived: Amnis stapt_price x APT (coingecko)', async () =>
      Number((await aptos.view(`${AMNIS}::stapt_token::stapt_price`, []))[0]) / 1e8),
    derive(STHAPT, 'sthAPT', 'derived: Thala thAPT_sthAPT_exchange_rate less unstake_APT_fee_bps x APT (coingecko)', async () => {
      const [[thApt, sthApt], [feeBps]] = await Promise.all([
        aptos.view(`${THALA_LSD}::staking::thAPT_sthAPT_exchange_rate`, []),
        aptos.view(`${THALA_LSD}::staking::unstake_APT_fee_bps`, []),
      ]);
      return Number(thApt) / Number(sthApt) * (1 - Number(feeBps) / 10_000);
    }),
  ]);
}
