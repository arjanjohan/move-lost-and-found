// Goblin (Aptos vaults that manage Hyperion liquidity): shares left in the vaults Goblin wiped out. On 2026-08-10 its
// admin called vaults::wipe_out on ten vaults: each vault's Hyperion position was closed and the proceeds moved into
// the vault's ClearOut stores; deposits stopped and withdrawals stayed open. Holders withdraw themselves
// (vaults::remove_as_pair), after unstaking from Goblin's MasterChef where they staked the shares. Goblin's other vaults
// and goAPT stay live.
//
// A withdrawal pays, first come, first served while the store has it (aborting after), what the shares were worth at
// the wipe-out: for most holders at the amounts the vault recorded then (get_token_amount_by_share), and for the
// accounts on the vault's name_list at the closed position's own amounts (ClearOut.position_amount_*), which are
// lower (simulated 2026-10-26, both kinds in three vaults). In most of these vaults the store holds less than all
// shares are owed, so each holder is counted for its pro-rata share of the store and the rest of the claim is blocked
// (decided 2026-10-26, as for Echo).
import { iso, positionIds } from '../accounting.ts';
import { mapLimit, normalizeAddress, once } from '../chain.ts';
import { assetId, ownedBalances } from '../owned.ts';
import type { Amount, Position, ReadContext, ReadResult, SourceDef, Step } from '../types.ts';

export const GOBLIN_VAULTS = '0x19bcbcf8e688fd5ddf52725807bc8bf455a76d4b5a6021cfdc4b5b2652e5cd55';
export const GOBLIN_CHEF = '0x1ddda82f0491ef60282a1ae8c4c82908723f945f1f10b809dcf1b5b085f77b92';
/** The MasterChef's resource account, which holds staked shares; their stakers are read through the MasterChef. */
export const GOBLIN_CHEF_ACCOUNT = '0x1fdbd7886e9c3724ee6e8bc9aa3331dd6d271e1971250bf0d22a008e03c8370c';
const SOURCE = 'goblin-wiped-out-vaults';

/** Every vault Goblin wiped out (read 2026-10-26): name, when it was wiped out (the wipe_out call, rounded up to the
 *  second; for APT-goAPT the later update of its recorded amounts, 2026-08-20), the call's version, and its MasterChef
 *  pool where it has one. */
export const WIPED_VAULTS = new Map<string, { name: string; wipedAt: string; wipedVersion: number; pid?: number }>(([
  ['0xab8fdae5dd99a4379362c01218cd7aef40758cd8111d11853ce6efd2f82b7cad', 'USDt-USDC', '2026-08-10T07:53:46Z', 6690710205],
  ['0x77d56ce63cf4d8c36a60a8a8f29e11ebbf7a1c0e22d6cd069d7f2e950d2fd0bd', 'APT-USDC', '2026-08-10T07:56:24Z', 6690735031, 0],
  ['0x588be5afa0572bfecd3fda1555eafebd8b918f8880c6ea682b4554ece4ca2210', 'APT-goAPT', '2026-08-20T14:54:07Z', 6839158578, 4],
  ['0x109a94e8449ac26fc1f2a785fb0d1ca96aa2c0af9d500333fa7a9d31d0043363', 'USD1-USDC', '2026-08-10T07:58:41Z', 6690756651, 5],
  ['0x41cfdef11efd671cbcffa66f57716ee5698308b233359481d52d6dac34b42af2', 'APT-kAPT', '2026-08-10T08:00:06Z', 6690771008, 2],
  ['0x7a6ef286a6d3f482dcb56d683678dadc7a18be133bf5f01626d5164a52e68eeb', 'APT-USDt', '2026-08-10T08:00:40Z', 6690778052, 1],
  ['0x9b72ae9cccc91591d41120df65cb85a143b57728f29d7e2c107d6c6f4cedd513', 'xBTC-aBTC', '2026-08-10T08:01:38Z', 6690788993],
  ['0x705360374b2fc0559d389e7f4cc7e2015c36ac210b2d097b2c45a62711d458db', 'sUSDe-USDC', '2026-08-10T08:02:22Z', 6690796962],
  ['0xade4dfb09967f1a7210d8a4b41eba2ae0a972407d0389bcc40f289d070fc10aa', 'APT-amAPT', '2026-08-10T08:03:07Z', 6690805285, 3],
  ['0x20cea96cdf57a57b692806a43cbf76dfbe843f405402198d93f04c644a48e4e3', 'WBTC-USDC', '2026-08-10T08:03:55Z', 6690814142],
] as [string, string, string, number, number?][]).map(([vault, name, wipedAt, wipedVersion, pid]) => [vault, { name, wipedAt, wipedVersion, pid }]));
/** The first wipe-out: MasterChef calls after it can change a stake's age. */
const FIRST_WIPED_VERSION = Math.min(...[...WIPED_VAULTS.values()].map(v => v.wipedVersion));

/** A wiped-out vault's tokens, all its shares, what its ClearOut stores hold, the closed position's amounts and the
 *  accounts paid at those (name_list), once per ledger version. */
export const vaultState = (ctx: ReadContext, vault: string) => once(ctx, `goblin-vault:${vault}:${ctx.ledger.version}`, async () => {
  const [v, clear] = await Promise.all([
    ctx.chain.resource(vault, `${GOBLIN_VAULTS}::vaults::Vault`, ctx.ledger.version),
    ctx.chain.resource(vault, `${GOBLIN_VAULTS}::vaults::ClearOut`, ctx.ledger.version),
  ]);
  if (!v || !clear) throw new Error(`Goblin vault ${vault}: ${v ? 'not wiped out' : 'missing'}`);
  const stores = await Promise.all([clear.token_a_store.inner, clear.token_b_store.inner].map(async s =>
    BigInt((await ctx.chain.view('0x1::fungible_asset::balance', [s], ['0x1::fungible_asset::FungibleStore'], ctx.ledger.version))[0])));
  return { tokens: [normalizeAddress(v.token_a.inner), normalizeAddress(v.token_b.inner)], totalShares: BigInt(v.total_shares), stores,
    position: [BigInt(clear.position_amount_a), BigInt(clear.position_amount_b)], named: new Set<string>(clear.name_list.map(normalizeAddress)) };
});

/** What `owner`'s `shares` withdraw (both tokens): the closed position's amounts for a named account, else what the
 *  vault recorded at the wipe-out. */
async function claimOf(ctx: ReadContext, vault: string, owner: string, shares: bigint): Promise<bigint[]> {
  const state = await vaultState(ctx, vault);
  if (state.named.has(owner)) return state.position.map(x => (state.totalShares ? x * shares / state.totalShares : 0n));
  return (await ctx.chain.view(`${GOBLIN_VAULTS}::vaults::get_token_amount_by_share`, [vault, shares.toString()], [], ctx.ledger.version)).map(x => BigInt(x));
}

/** A part of an owner's shares in one vault: in the wallet, or staked in the MasterChef. */
interface Part { vault: string; shares: bigint; staked: boolean; since?: string }

async function partPositions(ctx: ReadContext, owner: string, part: Part): Promise<Position[]> {
  const info = WIPED_VAULTS.get(part.vault)!;
  const state = await vaultState(ctx, part.vault);
  const claim = await claimOf(ctx, part.vault, owner, part.shares);
  // Counted: the pro-rata share of each store, up to the claim; the rest of the claim is blocked.
  const share = state.stores.map((s, i) => { const p = state.totalShares ? s * part.shares / state.totalShares : 0n; return p < claim[i] ? p : claim[i]; });
  // What one withdrawal pays now: all the shares while each store covers their claim, else the most shares it covers.
  let redeemable = part.shares;
  for (const i of [0, 1]) if (claim[i] > state.stores[i]) {
    const k = part.shares * state.stores[i] / claim[i];
    if (k < redeemable) redeemable = k;
  }
  const counted = redeemable > 0n ? share : [0n, 0n];
  const paid = redeemable === part.shares ? claim : redeemable > 0n ? await claimOf(ctx, part.vault, owner, redeemable) : [0n, 0n];
  const locator = part.staked ? `${part.vault}/staked` : part.vault;
  const amount = (i: number, raw: bigint): Amount[] => [{ asset: state.tokens[i], raw: raw.toString() }];
  const steps: Step[] = redeemable > 0n ? [
    ...(part.staked ? [{ function: `${GOBLIN_CHEF}::masterchef::withdraw`, arguments: [String(info.pid), part.shares.toString()], prerequisites: [], expectedOutputs: [] }] : []),
    { function: `${GOBLIN_VAULTS}::vaults::remove_as_pair`, arguments: [part.vault, redeemable.toString()], prerequisites: [],
      expectedOutputs: [0, 1].filter(i => paid[i] > 0n).flatMap(i => amount(i, paid[i])) },
  ] : [];
  const base = { source: SOURCE, owner, positionKind: 'principal' as const, claimableSince: part.since, ageBasis: part.since ? 'protocol_closure' as const : 'unknown' as const,
    provenance: { reader: `${GOBLIN_VAULTS}::vaults::get_token_amount_by_share`, ledgerVersion: ctx.ledger.version }, payoutBasis: 'view' as const,
    confidence: 'verified_view' as const, observedAt: iso(ctx.ledger.timestampSecs) };
  const out: Position[] = [];
  let first = true;
  for (const i of [0, 1]) {
    if (counted[i] > 0n) {
      out.push({ ...positionIds(SOURCE, owner, locator, 'principal', state.tokens[i]), ...base, locator, asset: state.tokens[i],
        grossClaim: amount(i, counted[i]), expectedPayout: amount(i, counted[i]), status: 'recoverable', blockers: [],
        // One withdrawal pays both tokens: its steps are listed once.
        steps: first ? steps : [] });
      first = false;
    }
  }
  for (const i of [0, 1]) {
    const rest = claim[i] - counted[i];
    if (rest > 0n) out.push({ ...positionIds(SOURCE, owner, `${locator}/store-short`, 'principal', state.tokens[i]), ...base, locator: `${locator}/store-short`,
      asset: state.tokens[i], grossClaim: amount(i, rest), expectedPayout: [], status: 'blocked', steps: [],
      blockers: [{ code: 'store_short', detail: `Goblin pays withdrawals from this wiped-out vault (${info.name}) first come, first served, at what the shares were worth at the wipe-out, while its store lasts. The store holds less than all shares are owed, so this account is counted for its pro-rata share of it and the rest is blocked; withdrawing early can pay more, up to the full amount.` }] });
  }
  return out;
}

/** The time of the owner's last MasterChef call after the first wipe-out, if any. */
const STAKE_CHANGE_QUERY = `query($o:String!,$v:bigint!){ user_transactions(where:{sender:{_eq:$o}, entry_function_contract_address:{_eq:"${GOBLIN_CHEF}"},
  version:{_gt:$v}}, order_by:{version:desc}, limit:1){ timestamp } }`;

const later = (a: string, b?: string) => (b && Date.parse(b) > Date.parse(a) ? b : a);

async function read(ctx: ReadContext, ownerInput: string): Promise<ReadResult> {
  const owner = normalizeAddress(ownerInput);
  const version = ctx.ledger.version;
  if (owner === normalizeAddress(GOBLIN_CHEF_ACCOUNT)) return { positions: [], complete: true, errors: [], ledgerVersion: version };
  try {
    // Shares in the wallet: the indexer names the vaults (and when each store last changed); amounts come from chain.
    const held = (await ownedBalances(ctx, owner)).filter(r => r.is_primary && WIPED_VAULTS.has(assetId(r.asset_type)));
    // Staked shares: an account that never staked has no PoolUserInfo (one request for most owners).
    const staker = await ctx.chain.resource(owner, `${GOBLIN_CHEF}::masterchef::PoolUserInfo`, version);
    const stakeChange = staker ? (await ctx.chain.gql(STAKE_CHANGE_QUERY, { o: owner, v: String(FIRST_WIPED_VERSION) })).user_transactions[0]?.timestamp : undefined;
    const parts: Part[] = [];
    await mapLimit(held, 4, async r => {
      const vault = assetId(r.asset_type), info = WIPED_VAULTS.get(vault)!;
      const [balance] = await ctx.chain.view('0x1::primary_fungible_store::balance', [owner, vault], ['0x1::fungible_asset::Metadata'], version);
      // In a closed vault the age runs from the later of the wipe-out and the store's own last change.
      if (BigInt(balance) > 0n) parts.push({ vault, shares: BigInt(balance), staked: false, since: later(info.wipedAt, iso(Date.parse(r.last_transaction_timestamp + 'Z') / 1000)) });
    });
    if (staker) await mapLimit([...WIPED_VAULTS].filter(([, v]) => v.pid !== undefined), 4, async ([vault, info]) => {
      const amount = await ctx.chain.view(`${GOBLIN_CHEF}::masterchef::get_user_info`, [String(info.pid), owner], [], version)
        .then(([a]) => BigInt(a), err => { if (/ERROR_POOL_USER_INFO_NOT_EXIST|0x1::table: 0x6507/.test(String(err))) return 0n; throw err; });
      if (amount > 0n) parts.push({ vault, shares: amount, staked: true, since: later(info.wipedAt, stakeChange ? iso(Date.parse(stakeChange + 'Z') / 1000) : undefined) });
    });
    // Each part is read on its own: one that fails leaves the others readable.
    const errors: string[] = [];
    const found = await mapLimit(parts, 4, async part => {
      try { return await partPositions(ctx, owner, part); }
      catch (err) { errors.push(`${part.vault}: ${String(err).slice(0, 200)}`); return []; }
    });
    return { positions: found.flat(), complete: errors.length === 0, errors, ledgerVersion: version };
  } catch (err) {
    return { positions: [], complete: false, errors: [String(err).slice(0, 300)], ledgerVersion: version };
  }
}

export const goblinWipedOut: SourceDef = {
  id: SOURCE,
  chain: 'aptos',
  protocol: 'Goblin',
  title: 'Goblin vaults wiped out',
  summary: 'Goblin wiped out ten of its vaults on 2026-08-10: their liquidity was closed into stores that holders withdraw from themselves. Withdrawals pay first come, first served, and most stores hold less than their shares are owed, so each holder counts for a pro-rata share.',
  category: 'closed_app',
  inclusionRule: 'R2: Goblin wiped out these vaults on 2026-08-10 (Hyperion position closed, deposits stopped, withdrawals open): the shares left are ended positions their holders withdraw themselves. Counted at each holder\'s pro-rata share of the vault\'s store (decided 2026-10-26); the rest of the claim is blocked.',
  protocolStatus: {
    state: 'deprecated',
    evidence: 'Goblin\'s admin called vaults::wipe_out on ten vaults on 2026-08-10, 07:53–08:03 UTC; each now carries vaults::ClearOut with able_to_deposit false and able_to_withdraw true. Goblin\'s other vaults and goAPT stay live.',
    checkedAt: '2026-10-26',
    effectiveAt: '2026-08-10T08:03:55Z',
  },
  // Every withdrawal changes what the store holds for everyone else: re-read weekly.
  refresh: { nonZero: 'weekly', zero: 'monthly' },
  headlineAgeBases: ['protocol_closure'],
  howTo: [
    `If the shares are staked: ${GOBLIN_CHEF}::masterchef::withdraw(pool id, amount).`,
    `Then ${GOBLIN_VAULTS}::vaults::remove_as_pair(vault, shares), or withdraw in the Goblin app (goblin.fi/vault). Withdrawals pay first come, first served while the vault's store lasts.`,
  ],
  officialUrl: 'https://goblin.fi/vault',
  read,
};
