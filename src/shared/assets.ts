// Display identity for assets that sources pay out. Identity is the exact id, never a ticker.
import type { ChainReader } from './types.ts';
import { SUSDE, USDC, USDT } from './sources/aave-frozen.ts';
import { ANIMESWAP_COINS } from './sources/animeswap-closed.ts';
import { AMAPT_COIN } from './sources/auro-closed.ts';
import { CANOPY_ASSETS } from './sources/canopy-frozen.ts';
import { APT, MOVE } from './sources/delegation.ts';
import { EDOG, GUI } from './sources/econia-idle.ts';
import { ECHO_RESERVES, ECHO_WRAPPED } from './sources/echo-wound-down.ts';
import { HOUSTON_COINS } from './sources/houston-closed.ts';
import { FROZEN_MARKETS } from './sources/echelon-frozen.ts';
import { KAPT, STKAPT } from './sources/kofi-receipts.ts';
import { LZ_COINS } from './sources/layerzero-claimable.ts';
import { MKLP } from './sources/merkle-mklp.ts';
import { ESMKL, MKL, PREMKL } from './sources/merkle-vemkl.ts';
import { THL } from './sources/thala-thl.ts';

export const ASSETS: Record<string, { symbol: string; decimals: number }> = {
  ...Object.fromEntries(FROZEN_MARKETS.map(m => [m.asset, { symbol: m.label, decimals: m.decimals }])),
  ...Object.fromEntries(LZ_COINS.map(c => [c.coin, { symbol: c.display, decimals: c.decimals }])),
  [APT]: { symbol: 'APT', decimals: 8 },
  [THL]: { symbol: 'THL', decimals: 8 },
  [MOVE]: { symbol: 'MOVE', decimals: 8 },
  [AMAPT_COIN]: { symbol: 'amAPT', decimals: 8 },
  [GUI]: { symbol: 'GUI', decimals: 6 },
  [EDOG]: { symbol: 'EDOG', decimals: 6 },
  [USDT]: { symbol: 'USDt', decimals: 6 },
  [USDC]: { symbol: 'USDC', decimals: 6 },
  [SUSDE]: { symbol: 'sUSDe', decimals: 6 },
  [KAPT]: { symbol: 'kAPT', decimals: 8 },
  [STKAPT]: { symbol: 'stkAPT', decimals: 8 },
  [MKLP[0].coin]: { symbol: 'MKLP', decimals: 6 },
  [MKLP[1].coin]: { symbol: 'MKLP', decimals: 6 },
  [MKL]: { symbol: 'MKL', decimals: 6 },
  [ESMKL]: { symbol: 'esMKL', decimals: 6 },
  [PREMKL]: { symbol: 'PreMKL', decimals: 6 },
  // Coins in the AnimeSwap pools that hold ~99% of its value (whUSDC, APT and LayerZero coins are above).
  ...Object.fromEntries(ANIMESWAP_COINS.map(c => [c.coin, { symbol: c.symbol, decimals: c.decimals }])),
  // Coins in HoustonSwap's pools.
  ...Object.fromEntries(HOUSTON_COINS.map(c => [c.coin, { symbol: c.symbol, decimals: c.decimals }])),
  // Coins Echo's lending reserves pay that no other source lists (APT and the LayerZero coins are above; Echo's wrapper
  // coins pay the token they wrap, which the chain describes).
  ...Object.fromEntries(ECHO_RESERVES.filter(r => !r.coin.startsWith('0x1::') && !r.coin.startsWith('0xf22bede2') && !ECHO_WRAPPED[r.coin]).map(r => [r.coin, { symbol: r.symbol, decimals: r.decimals }])),
  // Assets of Canopy's vaults (Movement).
  ...Object.fromEntries(CANOPY_ASSETS.map(c => [c.asset, { symbol: c.symbol, decimals: c.decimals }])),
};

export type AssetDisplay = { symbol: string; decimals: number };

/** An asset's symbol and decimals as its chain records them, for an asset `ASSETS` does not list: a coin type through
 *  `coin::symbol`/`decimals`, a fungible asset (its metadata address) through `fungible_asset::symbol`/`decimals`.
 *  Null for an id the chain cannot describe (a token not on chain yet, such as an unattested Wormhole transfer). */
export async function assetDisplay(chain: ChainReader, id: string, version?: string): Promise<AssetDisplay | null> {
  const coin = id.includes('::');
  if (!coin && !/^0x[0-9a-f]{1,64}$/i.test(id)) return null;
  const [module, args, typeArgs] = coin ? ['0x1::coin', [], [id]] : ['0x1::fungible_asset', [id], ['0x1::fungible_asset::Metadata']];
  const [[symbol], [decimals]] = await Promise.all([chain.view(`${module}::symbol`, args, typeArgs, version), chain.view(`${module}::decimals`, args, typeArgs, version)]);
  return { symbol: String(symbol), decimals: Number(decimals) };
}
