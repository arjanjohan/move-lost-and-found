// Canopy (Movement) vaults that Canopy froze: deposits closed (deposit limit 0, or the vault paused), so shares left in
// them count (decided 2026-10-21). Canopy's admin multisig set the limit to 0 on 42 vaults on 2026-10-16 (one more
// later that day) and on four (two rsETH, rsETH-WETH LP, a Meridian LP) on 2026-06-16. A vault's shares are held in the
// wallet or staked in Canopy's rewards pools (multi_rewards); both count. Withdrawal works through Canopy's router,
// except where the vault or its strategy aborts (simulated 2026-10-21, below): those positions are blocked.
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once, transactionTime } from '../chain.ts';
import { assetId, ownedBalances } from '../owned.ts';
import type { Position, ReadContext, ReadResult, SourceDef } from '../types.ts';
import { CANOPY_REWARDS, CANOPY_REWARDS_VIEWS } from './canopy-rewards.ts';

export const CANOPY_VAULTS = '0xb10bd32b3979c9d04272c769d9ef52afbc6edc4bf03982a9e326b96ac25e7f2d';
export const CANOPY_ROUTER = '0x717b417949cd5bfa6dc02822eacb727d820de2741f6ea90bf16be6c0ed46ff4b';
const SOURCE = 'canopy-frozen-vaults';

/** What a withdrawal simulated as on 2026-10-28, with the call Canopy's self-custody withdrawal guide gives (the
 *  vault's largest wallet holder, all its shares): 'ok'; 'packet' when the strategy is MovePosition's, which needs an
 *  off-chain price packet from its operator (team-gated; aborts EOPTION_NOT_SET without one); else the abort.
 *  undefined: no holder to simulate with (then or on 2026-10-21, with router::withdraw_fa, for the two vaults that had
 *  one then and none now). */
type Check = 'ok' | 'packet' | 'EINVALID_SHARES_FACTORS' | 'EINSUFFICIENT_BALANCE' | undefined;

/** Every Canopy vault: address, name, when its deposit limit was set to 0 (SetDepositLimit), at which version, and
 *  how a withdrawal simulated. */
export const FROZEN_VAULTS = new Map<string, { name: string; frozenAt: string; frozenVersion: number; check: Check }>(([
  ['0x58739edcac2f86e62342466f20809b268430aedf32937eba32eaac7e0bbf5233', 'CV MOVE-0', '2026-10-16T14:40:46Z', 228593609, 'EINVALID_SHARES_FACTORS'],
  ['0xd686eeb2bc110e74fe6e62e66b1247fedc4a909f4ca8188a640aa7b5098bcb42', 'CV MOVE-1', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0x574ecf25ca263b4d9cbd43ded90bba6a52309e0cba2213f9606e4b4a3a20ffae', 'CV MOVE-2', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0x3cc354520ef157b12ba7c7b1363ca220991332908c408b083aed5604bca63d10', 'CV USDC.e-3', '2026-10-16T14:40:46Z', 228593609, 'EINVALID_SHARES_FACTORS'],
  ['0x11cbcaebab975f843c47cfbd0aea69a0deae1577f53232287dff8d248c752f5d', 'CV USDT.e-4', '2026-10-16T14:40:46Z', 228593609, 'EINVALID_SHARES_FACTORS'],
  ['0x784c340abf9e3cf32a08af449d66f2f2f0977f2ac21cd63722e7ab8e0e8af34f', 'CV WETH.e-5', '2026-10-16T14:40:46Z', 228593609, 'packet'],
  ['0xbf58771707c581cb70d1495f85c7700d798ccab567335f655f0162f1b7ac67c9', 'CV WBTC.e-6', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0x539fd8eae0e2d7f1e6ae963fa0d0691efa91f40602dc96339367aeb64b3bf6fc', 'CV USDC.e-7', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0x709e32224f041e6309f502dcaf9b03d8dde6dd0c207dd24f9468c356aca0c4e8', 'CV USDT.e-8', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0xeb049cc70ed0be8f9bf7c8ef69bba952a363d1e539892ceb5112b8f7e5413048', 'CV WETH.e-9', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0x40224c58f26e4bd40adfc66ce77d99a9d492bc7b7702f7d15002e125d1487040', 'CV WBTC.e-10', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0x60ea4bbbbfa2cf715bef9c7187a90813d39aedfe9cf17c47c3d385b26bf7ee5b', 'CV USDC.e-11', '2026-10-16T14:40:46Z', 228593609, 'EINVALID_SHARES_FACTORS'],
  ['0xa08ca1f51e8ebfe5b6bdebf992ddf3c13d68591ee4ea23078c2c1e87fab22e1b', 'CV USDT.e-12', '2026-10-16T14:40:46Z', 228593609, 'EINVALID_SHARES_FACTORS'],
  ['0xedbf4a1913354a8340be89af3c75bdd0ce69f5b008548c6e46135b41d3ad28f2', 'CV WETH.e-13', '2026-10-16T14:40:46Z', 228593609, 'EINSUFFICIENT_BALANCE'],
  ['0x48d5b71948d7d45c816832a55cd2f018b41ddbe977fa90efaf69de1b5c705f45', 'CV WBTC.e-14', '2026-10-16T14:40:46Z', 228593609, 'EINVALID_SHARES_FACTORS'],
  ['0x31d0a30ae53e2ae852fcbdd1fce75a4ea6ad81417739ef96883eba9574ffe31e', 'CV MOVE-15', '2026-10-16T14:40:46Z', 228593609, 'EINVALID_SHARES_FACTORS'],
  ['0x71c789d396157a54a71e0fe42f82cfee7d210370290a4c14550a13662e4ce75f', 'CV MER-LP-16', '2026-10-16T14:40:46Z', 228593609, 'EINSUFFICIENT_BALANCE'],
  ['0xcc1bb5caea6b6becf4ae4781104a1ed9bcc2c9339aaf3b2a087d7b7134197cf2', 'CV USDC-USDTS-17', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0x6a5d6effbc15cf96c326e49d05cbb750c21ddf57d5e2a463ef39aa8dbaf2435a', 'CV MER-LP-18', '2026-10-16T14:40:46Z', 228593609, 'EINSUFFICIENT_BALANCE'],
  ['0x3d5cff19ee139afc1350b337eeb200c1baed91ab8a79d3bacf81512f84054b07', 'CV MER-LP-19', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0x0dc3c0315028cf50bc243b8b8847930a433d099fb4717496d1144c989cb80c8c', 'CV ezETH-20', '2026-10-16T15:08:32Z', 228605198, 'packet'],
  ['0xad6103a43ba677bebbdbc27f48015af7049d71cbcc4684d1654254cf718932a8', 'CV LBTC-21', '2026-10-16T14:40:46Z', 228593609, 'EINSUFFICIENT_BALANCE'],
  ['0xcb363e52f231e35a90022f1c9fe3f0ee9b93a63d61cb190a9f50f85ef7fea298', 'CV weET-WETHS-22', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0xefa4b39d3cd87b5f24d53d4d54879c90787f282e05d701dfe66942378deeba61', 'CV rsET-WETHS-23', '2026-06-16T13:11:34Z', 156181625, 'ok'],
  ['0x6d3b732d7219431d600668b46dfe79c626c5982f314952ceeafc49e3a3b94262', 'CV MER-LP-24', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0xee7f4d809125fac4cb901a6af97926083628981d4a1e6df9bf44246175ab8c6b', 'CV stBTC-25', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0x15f8246d948a5d60d4875a6fac472d69a2f80d3a98fb0676cf5edc34ef2b5743', 'CV rsETH-26', '2026-06-16T13:09:26Z', 156180617, 'packet'],
  ['0x1add335785489b1694db14df964790904058ee71c776589a2d35b948f0c679ec', 'CV SolvBTC-27', '2026-10-16T14:40:46Z', 228593609, 'EINSUFFICIENT_BALANCE'],
  ['0x74e1c6603eeab113f7f631bf2354ec71d01ff0771ab26dfe1ffe1777a841c158', 'CV stBT-WBTCS-28', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0xbf3d146537360df8b888a7d4cbd1221574c65fca5bb32a85ef958e217fab4c89', 'CV MER-LP-29', '2026-10-16T14:40:46Z', 228593609, 'EINSUFFICIENT_BALANCE'],
  ['0x3e64c7be706cf44d53a5bec6890e03b5ee30dbeeb19f54a562ee839423c48259', 'CV MER-LP-30', '2026-10-16T14:40:46Z', 228593609, 'EINSUFFICIENT_BALANCE'],
  ['0x2dfa9bedad8967951a9400b3f97678fd716e0718899417794940cac7ee2a802f', 'CV MER-LP-31', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0xf8e39a8e9f492f4e0e2b5e79d4a17f0358ca01165372a0bb2642023ca2c21971', 'CV rsETH-32', '2026-06-16T13:10:56Z', 156181311, 'ok'],
  ['0x24b7a15cce2a31e7f9c09811f5596b6a1d3a84325a3f224f30f7cb16b7006307', 'CV MER-LP-33', '2026-06-16T13:11:15Z', 156181489, 'ok'],
  ['0xe4dad3f75faf1ee66bd54679c7abf5c1a55089a293fc94a9cbc4964b20ababde', 'CV MOVE-34', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0x72eb144e97967ecc11d24806f5130a2da9821e61334fabcd6c06ffd51c939b80', 'CV MOVE-35', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0xf2e70628de8505d7d72e47af7f46ee45b42183ef4aaf7a32d112e0e7d7c4af12', 'CV MER-LP-36', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0x43bdf6df8b54d12a5e4429fda160b8265e15268c385e4f6ebe553b428a86e65a', 'CV MER-LP-37', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0xbe3380ced659824ebe840dcefbd0e002c697f2a118f4183b623d66b25e42eb7a', 'CV MER-LP-38', '2026-10-16T14:40:46Z', 228593609, 'EINSUFFICIENT_BALANCE'],
  ['0xf25b5b551e5081e4ff1e3a24077d2286f5155cd15cd4f35d5c088713cfc31ee9', 'CV MER-LP-39', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0x5dba2d26e1d25288662611aadc63d99ff42010d34f45c28b7a17240d4f4e8861', 'CV MER-LP-40', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0xf6abb5549cf0f3ed31b3e16f884e403b56633141a9c48e8757f67c56c222b5c6', 'CV MER-LP-41', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0x5429dc9f5cb95fdf3cfd3c6529a8ae786e6e93ccd33a2f83ef122b45867c9451', 'CV MER-LP-42', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0xbbaa131e8926757ce2ddccf0d806e32e71eeb78185f03f2aaec41f691abc3751', 'CV MER-LP-43', '2026-10-16T14:40:46Z', 228593609, undefined],
  ['0x58eb34c4c995168f69f355b0eb9fb8ca6f4d06d1891fef082877317c38f5edca', 'CV MER-LP-44', '2026-10-16T14:40:46Z', 228593609, 'ok'],
  ['0xf1f5f765dd5c5254712e5cb35b87fd04526bc316a20bc6bea6f16746780da80a', 'CV MOVE-45', '2026-10-16T14:40:46Z', 228593609, 'EINVALID_SHARES_FACTORS'],
  ['0x3ed219ff18a736c4452a71132dd0b1f16911afe2a37ccad9daabb596b8c3d074', 'CV sUSDa-46', '2026-10-16T14:40:46Z', 228593609, 'ok'],
] as [string, string, string, number, Check][]).map(([address, name, frozenAt, frozenVersion, check]) => [address, { name, frozenAt, frozenVersion, check }]));

/** The router call Canopy's self-custody withdrawal guide gives per vault (app.canopyhub.xyz/withdrawal-guide, read
 *  2026-10-28): router::withdraw_fa_with_coin_type<0x1::aptos_coin::AptosCoin> unless listed here; every call takes
 *  (vault, strategies [], packets [], shares, max loss some(100) bps, min out some(0)). */
const APT_COIN = '0x1::aptos_coin::AptosCoin';
const LS_RSETH_WETH_LP = '0x3851f155e7fc5ec98ce9dbcaf04b2cb0521c562463bd128f9d1331b38c497cf3::lp_coin::LP<0x4763c5cfde8517f48e930f7ece14806d75b98ce31b0b4eab99f49a067f5b5ef2::wrapped::RSETH, 0x4763c5cfde8517f48e930f7ece14806d75b98ce31b0b4eab99f49a067f5b5ef2::wrapped::WETHe, 0xd5367fdfa219cb0a108c7751cdbfbb02bfcb71ea932c33007b10a05ae5502500::curves::Stable>';
/** The Meridian package whose placeholder coin types the guide gives for Meridian pool vaults. */
const MERIDIAN_COINS = '0xf73752aa1c98d49c611db48b4e77618c5b1ff7d0819d50c28d30838ad5a55a91';
const DEFAULT_CALL = { fn: 'withdraw_fa_with_coin_type', types: [APT_COIN] };
const WITHDRAW_CALLS = new Map<string, { fn: string; types: string[] }>(([
  ['0xf2e70628de8505d7d72e47af7f46ee45b42183ef4aaf7a32d112e0e7d7c4af12', 'withdraw_fa_with_coin_type', [`${MERIDIAN_COINS}::coins::Coin4`]],   // USDC-wETH
  ['0x5429dc9f5cb95fdf3cfd3c6529a8ae786e6e93ccd33a2f83ef122b45867c9451', 'withdraw_fa_with_coin_type', [`${MERIDIAN_COINS}::coins::Coin7`]],   // USDa-USDT
  ['0xf25b5b551e5081e4ff1e3a24077d2286f5155cd15cd4f35d5c088713cfc31ee9', 'withdraw_fa_with_coin_type', [`${MERIDIAN_COINS}::coins::Coin2`]],   // MOVE-USDC
  ['0xbe3380ced659824ebe840dcefbd0e002c697f2a118f4183b623d66b25e42eb7a', 'withdraw_fa_with_coin_type', [`${MERIDIAN_COINS}::coins::Coin8`]],   // sUSDa-USDa
  ['0xefa4b39d3cd87b5f24d53d4d54879c90787f282e05d701dfe66942378deeba61', 'withdraw_coin', [LS_RSETH_WETH_LP, LS_RSETH_WETH_LP]],   // LS rsETH-wETH
  ['0x71c789d396157a54a71e0fe42f82cfee7d210370290a4c14550a13662e4ce75f', 'withdraw_fa_with_coin_type', [`${MERIDIAN_COINS}::coins::Coin1`]],   // USDC.e-USDT.e
  ['0x43bdf6df8b54d12a5e4429fda160b8265e15268c385e4f6ebe553b428a86e65a', 'withdraw_fa_with_coin_type', [`${MERIDIAN_COINS}::coins::Coin5`]],   // USDC-WBTC
  ['0xf1f5f765dd5c5254712e5cb35b87fd04526bc316a20bc6bea6f16746780da80a', 'withdraw_coin', [APT_COIN, APT_COIN]],   // Korean Blockchain Week MOVE Lending
  ['0x5dba2d26e1d25288662611aadc63d99ff42010d34f45c28b7a17240d4f4e8861', 'withdraw_fa_with_coin_type', [`${MERIDIAN_COINS}::coins::Coin6`]],   // MOVE-WETH
  ['0xf6abb5549cf0f3ed31b3e16f884e403b56633141a9c48e8757f67c56c222b5c6', 'withdraw_fa_with_coin_type', [`${MERIDIAN_COINS}::coins::Coin3`]],   // MOVE-USDT
  ['0x58eb34c4c995168f69f355b0eb9fb8ca6f4d06d1891fef082877317c38f5edca', 'withdraw_fa_with_coin_type', [`${MERIDIAN_COINS}::coins::Coin9`]],   // LBTC-WBTC
  ['0x58739edcac2f86e62342466f20809b268430aedf32937eba32eaac7e0bbf5233', 'withdraw_coin', [APT_COIN, APT_COIN]],   // MOVE Simple Lending
] as [string, string, string[]][]).map(([vault, fn, types]) => [vault, { fn, types }]));

const BLOCKED: Record<string, string> = {
  EINVALID_SHARES_FACTORS: 'Withdrawing aborts in the vault (EINVALID_SHARES_FACTORS, simulated 2026-10-28 with the call Canopy\'s withdrawal guide gives): its strategy reports far less than the vault lent it.',
  EINSUFFICIENT_BALANCE: 'Withdrawing aborts: the vault\'s strategy cannot pay it out (EINSUFFICIENT_BALANCE, simulated 2026-10-28 with the call Canopy\'s withdrawal guide gives).',
};

/** Display identity of the vaults' assets other than MOVE (symbol from the vault's name, decimals from the vault). */
/** Kelp's rsETH on Movement (priced: CoinGecko lists this address). */
export const RSETH = '0x51ffc9885233adf3dd411078cad57535ed1982013dc82d9d6c433a55f2e0035d';

export const CANOPY_ASSETS = ([
  ['0x83121c9f9b0527d1f056e21a950d6bf3b9e9e2e8353d0e95ccea726713cbea39', 'USDC.e', 6],
  ['0x447721a30109c662dde9c73a0c2c9c9c459fb5e5a9c92f03c50fa69737f5d08d', 'USDT.e', 6],
  ['0x908828f4fb0213d4034c3ded1630bbd904e8a3a6bf3c63270887f0b06653a376', 'WETH.e', 8],
  ['0xb06f29f24dde9c6daeec1f930f14a441a8d6c0fbea590725e88b340af3e1939c', 'WBTC.e', 8],
  ['0x78f3de4897720dbf03ada5c018c35a5ea41f9351bb5a80405091d18bb4fe7d1a', 'Meridian LP', 8],
  ['0x671c5d54d3531ef12d619247793d6ee103457071b4be03ab96865dfee37a7754', 'LS05 USDC.e-USDT.e LP', 6],
  ['0x5b3bfb03dfb8d61e7e4279a34ef45abc90603f5d464886c1367026b1a92351c8', 'Meridian LP', 8],
  ['0xd8aa9dedce07099f587420841aea25130a302c4d123a723a681d79a0139be3b5', 'Meridian LP', 8],
  ['0x2f6af255328fe11b88d840d1e367e946ccd16bd7ebddd6ee7e2ef9f7ae0c53ef', 'ezETH', 8],
  ['0x0658f4ef6f76c8eeffdc06a30946f3f06723a7f9532e2413312b2a612183759c', 'LBTC', 8],
  ['0x61c8744e0065689cfbf192a2bd6b3a69f52f0fb868d5350d6e3098a6f328aa42', 'LS05 weETH-WETH.e LP', 6],
  ['0x45b2cdc62b15d11965fdd89862cf70d7ee1445306fd3c99e6a898a44aa686721', 'LS05 rsETH-WETH.e LP', 6],
  ['0x93c7d3d7804a3c564078e17129c6aec69a0ab38465bd407da17f1243d8a57164', 'Meridian LP', 8],
  ['0x95c0fd13373299ada1b9f09ff62473ab8b3908e6a30011730210c141dffdc990', 'stBTC', 8],
  ['0x51ffc9885233adf3dd411078cad57535ed1982013dc82d9d6c433a55f2e0035d', 'rsETH', 8],
  ['0x527c43638a6c389a9ad702e7085f31c48223624d5102a5207dfab861f482c46d', 'SolvBTC', 8],
  ['0xc860b41cbce2092655b4eb1c43361779c8ead693def1802dd9d8155ee5f3c4cc', 'LS05 stBTC-WBTC.e LP', 6],
  ['0x9db5a11cb31c4b4f6a4be35c49f56be88d9a22216b57b8a7ce6690543ef1db34', 'Meridian LP', 8],
  ['0x94948aaa238e410dbe70a9c2947cfd326438227937fd28520627fdc4bd766f62', 'Meridian LP', 8],
  ['0x5953bc8c2af5895a6b0ab8e3f28bb7610731eed4a8b84919797f84f6167de6a0', 'Meridian LP', 8],
  ['0xf044e1e300b47a3a81a0410b22003a11da05bbe2cf20c83d915accf9f4d97f29', 'Meridian LP', 8],
  ['0xdf63eb2ddc6821f0ab126f8f056cc346172c4079daa84c343e41bccda0838231', 'Meridian LP', 8],
  ['0xe47eb94c4b08a101730b73e71b8213891e8764d8afd39b1e801679b262c9fbce', 'Meridian LP', 8],
  ['0x8026a78385367f4e445d663146953614f26f6e6888f67c328be683c878f083a4', 'Meridian LP', 8],
  ['0xa0454b18a94f9d0276176ba3ceba900fb28d179aa9bc276c07b2116b5e6d962a', 'Meridian LP', 8],
  ['0x4525e62437f8928b5d68e2a239861e609b229f887c21ad3e4617e13eaa6c67ae', 'Meridian LP', 8],
  ['0xc24fd6702b84b2524b3c708a48524297294ed022d9c2f30222a743ef3773b2b9', 'Meridian LP', 8],
  ['0x26bafc66520d8becbd3279e4eabcb569eba669d0b167ec7eccb62d63ffcd2096', 'Meridian LP', 8],
  ['0xde5adb83b6f4fa8c0bd9172fc287e66f85716dd5367f29fb1cda2944cb7f5dab', 'Meridian LP', 8],
  ['0xe699e6c1733462632821b6e5b954c0ed3aa9ad1efb70b6ce92616952ade89258', 'sUSDa', 8],
] as [string, string, number][]).map(([address, symbol, decimals]) => ({ asset: `movement:${address}`, symbol, decimals }));

/** Enumeration hint, by shares token: when the owner's share store last changed (`at`, indexer), and the version of its
 *  last stake or withdrawal of those shares in Canopy's rewards pools (`v`); and the version the enumeration's scans
 *  reached (`w`). */
export type CanopyFrozenHint = { at?: Record<string, string>; v?: Record<string, string>; w?: string };

interface VaultInfo { address: string; shares: string; asset: string }

/** Every vault (paged view), keyed by its shares token. */
export const canopyVaults = (ctx: ReadContext) => once(ctx, `canopy-vaults:${ctx.ledger.version}`, async () => {
  const out = new Map<string, VaultInfo>();
  for (let offset = 0; ; offset += 100) {
    const [page] = await ctx.chain.view(`${CANOPY_VAULTS}::vault::vaults_view`, [String(offset), '100'], [], ctx.ledger.version);
    for (const v of (page as any).vaults) {
      const shares = normalizeAddress(v.shares_address);
      out.set(shares, { address: normalizeAddress(v.vault_address), shares, asset: normalizeAddress(v.asset_address) });
    }
    if ((page as any).vaults.length < 100) return out;
  }
});

/** Frozen now: deposit limit 0, or paused (both close deposits). */
const frozen = (ctx: ReadContext, vault: string) => once(ctx, `canopy-frozen:${vault}:${ctx.ledger.version}`, async () => {
  const v = await ctx.chain.resource(vault, `${CANOPY_VAULTS}::vault::Vault`, ctx.ledger.version);
  if (!v) throw new Error(`Canopy vault ${vault} missing`);
  return v.is_paused === true || v.deposit_limit?.vec?.[0] === '0';
});

async function read(ctx: ReadContext, ownerInput: string, hint?: CanopyFrozenHint): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  try {
    const vaults = await canopyVaults(ctx);
    // Shares staked in Canopy's rewards pools: the staking tokens the owner ever subscribed with.
    const [rows] = await ctx.chain.view(`${CANOPY_REWARDS_VIEWS}::rewards_view::get_user_pool_positions`, [owner, { vec: [] }, { vec: [] }], [], version);
    const stakedTokens = new Set((rows as any[]).map(r => normalizeAddress(r.pool_staking_token.inner)).filter(t => vaults.has(t)));
    // Shares in the wallet: from the indexer, checked on chain below. Looked up again also with a hint, so shares received
    // after the enumeration's scan are read too (their age stays unknown until a scan has seen them).
    const held = (await ownedBalances(ctx, owner)).filter(r => vaults.has(assetId(r.asset_type)));
    const inWallet = new Set(held.map((r: any) => normalizeAddress(r.asset_type)));
    // A stake or withdrawal's time, looked up only when it came after the vault's freeze (rare).
    const stakedAt = (v: string) => once(ctx, `canopy-tx:${v}`, () => transactionTime(ctx.chain, v));
    // Each vault is read on its own: one that fails leaves the others readable.
    const errors: string[] = [];
    const found = await mapLimit([...new Set([...stakedTokens, ...inWallet])], 4, async (token): Promise<Position[]> => {
      try {
        const vault = vaults.get(token)!;
        if (!(await frozen(ctx, vault.address))) return [];
        // The wallet is read for every token, also one the indexer shows no store for: it may trail the chain (shares
        // just withdrawn from staking into the wallet).
        const [[wallet], [staked]] = await Promise.all([
          ctx.chain.view('0x1::primary_fungible_store::balance', [owner, token], ['0x1::fungible_asset::Metadata'], version),
          stakedTokens.has(token) ? ctx.chain.view(`${CANOPY_REWARDS}::multi_rewards::get_user_staked_balance`, [owner, token], [], version) : ['0'],
        ]);
        // Shares in a secondary store the owner holds (none known, 2026-10-23: only the staking pool's own stores are
        // secondary): shown, but withdrawing them takes a transfer into the primary store first, so not counted.
        const secondary = (await Promise.all(held.filter((r: any) => !r.is_primary && normalizeAddress(r.asset_type) === token).map(async (r: any) => {
          const store = normalizeAddress(r.storage_id);
          const [[storeOwner], [balance]] = await Promise.all([
            ctx.chain.view('0x1::object::owner', [store], ['0x1::fungible_asset::FungibleStore'], version),
            ctx.chain.view('0x1::fungible_asset::balance', [store], ['0x1::fungible_asset::FungibleStore'], version),
          ]);
          return normalizeAddress(String(storeOwner)) === owner && BigInt(balance) > 0n ? [{ store, shares: String(balance) }] : [];
        }))).flat();
        if (BigInt(wallet) + BigInt(staked) === 0n && !secondary.length) return [];
        const info = FROZEN_VAULTS.get(vault.address);
        // Frozen, so no new deposits: aged from the freeze, or from the owner's own later change where it is known. The
        // wallet and the stake are separate positions with their own histories. A part that differs from its balance at
        // the version the enumeration's scans reached changed after them, and a stake or withdrawal whose transaction is
        // not indexed yet has no time: either way its age is unknown until a later run. Without a hint (the check page)
        // there is no history to date the shares: unknown too.
        const then = hint?.w && Number(hint.w) < Number(version) ? await Promise.all([
          ctx.chain.view('0x1::primary_fungible_store::balance', [owner, token], ['0x1::fungible_asset::Metadata'], hint.w),
          stakedTokens.has(token) ? ctx.chain.view(`${CANOPY_REWARDS}::multi_rewards::get_user_staked_balance`, [owner, token], [], hint.w) : ['0'],
        ]).then(([[w], [s]]) => ({ wallet: String(w), staked: String(s) }), () => null) : undefined;
        const changed = (part: 'wallet' | 'staked', now: string) => then !== undefined && (then === null || then[part] !== now);
        const stakeChange = hint?.v?.[token];
        const restaked = BigInt(staked) > 0n && stakeChange && Number(stakeChange) > (info?.frozenVersion ?? Infinity) ? await stakedAt(stakeChange) : undefined;
        const latest = (...dates: (string | undefined)[]) => dates.filter((d): d is string => !!d).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
        const parts: { shares: string; locator: string; unstake: boolean; since?: string; secondary?: boolean }[] = [
          ...(BigInt(wallet) > 0n ? [{ shares: String(wallet), locator: vault.address, unstake: false,
            since: info && hint && !changed('wallet', String(wallet)) ? latest(info.frozenAt, hint.at?.[token]) : undefined }] : []),
          ...(BigInt(staked) > 0n ? [{ shares: String(staked), locator: `${vault.address}/staked`, unstake: true,
            since: info && hint && !changed('staked', String(staked)) && restaked !== null ? latest(info.frozenAt, restaked !== undefined ? iso(restaked) : undefined) : undefined }] : []),
          ...secondary.map(s => ({ shares: s.shares, locator: `${vault.address}/store/${s.store}`, unstake: false, secondary: true })),
        ];
        const check = info?.check;
        const blocked = check && check !== 'ok' && check !== 'packet' ? BLOCKED[check] : undefined;
        // A withdrawal that needs the operator's price packet is team-gated (left-behind.md), with its payout kept.
        const status = blocked ? 'blocked' : check === 'packet' ? 'team_gated' : check ? 'recoverable' : 'unknown';
        return await Promise.all(parts.map(async (part): Promise<Position> => {
          const [assets] = await ctx.chain.view(`${CANOPY_VAULTS}::vault::shares_to_amount`, [vault.address, part.shares], [], version);
          const call = WITHDRAW_CALLS.get(vault.address) ?? DEFAULT_CALL;
          const value = [{ asset: `movement:${vault.asset}`, raw: String(assets) }];
          if (part.secondary) return {
            ...positionIds(SOURCE, owner, part.locator, 'principal', value[0].asset), source: SOURCE, owner, locator: part.locator, positionKind: 'principal',
            asset: value[0].asset, ageBasis: 'unknown', provenance: { reader: '0x1::fungible_asset::balance', ledgerVersion: version },
            grossClaim: value, expectedPayout: [], payoutBasis: 'view', status: 'unknown',
            blockers: [{ code: 'secondary_store', detail: 'Shares in a secondary store: move them into the wallet\'s primary store (fungible_asset::transfer), then withdraw.' }],
            confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs), steps: [],
          };
          return {
            ...positionIds(SOURCE, owner, part.locator, 'principal', value[0].asset), source: SOURCE, owner, locator: part.locator, positionKind: 'principal',
            asset: value[0].asset, claimableSince: part.since, ageBasis: part.since ? 'protocol_closure' : 'unknown',
            provenance: { reader: `${CANOPY_VAULTS}::vault::shares_to_amount`, ledgerVersion: version },
            grossClaim: value, expectedPayout: status === 'recoverable' || status === 'team_gated' ? value : [], payoutBasis: 'view', status,
            blockers: blocked ? [{ code: 'withdrawal_aborts', detail: blocked }]
              : status === 'team_gated' ? [{ code: 'price_packet', detail: 'Withdrawing needs a MovePosition price packet for the vault\'s strategy, which the Canopy app supplies; the call alone, with empty strategy data, aborts.' }]
              : status === 'unknown' ? [{ code: 'not_simulated', detail: 'No withdrawal from this vault has been simulated.' }] : [],
            confidence: 'verified_view', observedAt: iso(ctx.ledger.timestampSecs),
            steps: [
              ...(part.unstake ? [{ function: `${CANOPY_REWARDS}::multi_rewards::withdraw`, arguments: [token, part.shares], prerequisites: [], expectedOutputs: [] }] : []),
              { function: `${CANOPY_ROUTER}::router::${call.fn}<${call.types.join(', ')}>`,
                arguments: [vault.address, '[]', '[]', part.shares, 'some(100)', 'some(0)'],
                prerequisites: check === 'packet' ? ['A MovePosition price packet for the strategy (the Canopy app supplies it).'] : [], expectedOutputs: value },
            ],
          };
        }));
      } catch (err) {
        errors.push(`${token}: ${String(err).slice(0, 200)}`);
        return [];
      }
    });
    return { positions: found.flat(), complete: errors.length === 0, errors, ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const canopyFrozenVaults: SourceDef<CanopyFrozenHint> = {
  id: SOURCE,
  chain: 'movement',
  protocol: 'Canopy',
  title: 'Canopy vaults closed to deposits',
  summary: 'Canopy (Movement) closed its vaults to new deposits and is retiring its app on 2026-12-22. Shares left in them, in the wallet or staked for rewards, count; withdrawing works for most vaults, but aborts for some.',
  category: 'closed_app',
  inclusionRule: 'R2: Canopy froze the vault (deposit limit set to 0, or paused; decided 2026-10-21 to count as closed). R4: a vault share carries no debt.',
  protocolStatus: {
    state: 'wound_down',
    evidence: 'Canopy\'s admin multisig set every vault\'s deposit limit to 0: 42 vaults on 2026-10-16 (one transaction), 4 on 2026-06-16, 1 later on 2026-10-16 (SetDepositLimit events). Canopy\'s notice (app.canopyhub.xyz/maintenance-mode, read 2026-10-28): maintenance-only mode, new deposits closed as of 2026-10-19, the app and active support retire on 2026-12-22; the vault contracts stay live and withdraw-capable, with no withdrawal deadline, and a self-custody withdrawal guide gives the calls. Movement acquired Canopy in May 2026.',
    checkedAt: '2026-10-28',
  },
  refresh: { nonZero: 'monthly', zero: 'monthly' },
  // 2: statuses and steps follow the withdrawal guide's call (simulated 2026-10-28); every owner is re-read once.
  version: 2,
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `If your shares are staked: ${CANOPY_REWARDS}::multi_rewards::withdraw(shares token, amount).`,
    `Then ${CANOPY_ROUTER}::router::withdraw_fa_with_coin_type<0x1::aptos_coin::AptosCoin>(vault, [], [], shares, some(100), some(0)); some vaults take another call (Canopy\'s guide lists it per vault: app.canopyhub.xyz/withdrawal-guide). Or withdraw in the Canopy app until 2026-12-22.`,
  ],
  read,
};
