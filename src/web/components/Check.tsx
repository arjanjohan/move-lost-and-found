// Live check: reads Aptos mainnet from the browser, anonymously. Nothing is sent to this site.
import { useRef, useState } from 'react';
import { freshPrices, usd as toUsd, type PriceBook } from '../../shared/accounting.ts';
import { createReader, mapLimit, NETWORKS, normalizeAddress, withOwnResources } from '../../shared/chain.ts';
import { ASSETS, assetDisplay, type AssetDisplay } from '../../shared/assets.ts';
import { tableProvider, type MarketTable } from '../../shared/market.ts';
import { readClassified } from '../../shared/owners.ts';
import { APT } from '../../shared/sources/delegation.ts';
import { SOURCES } from '../../shared/sources/index.ts';
import type { Memo, Position, ReadContext, ReadResult } from '../../shared/types.ts';
import { date, short, units, usd } from '../lib/format.ts';
import { protocolOfSource } from '../lib/logos.ts';
import { Logo } from './Logo.tsx';

/** Wallets the public Aptos API serves one browser in one 5-minute rate-limit window, so a check never waits. The
 *  fullnode decides it: 40,000 compute units per IP per window, and a wallet's reads cost ~17–27K (21–43 calls at ~680
 *  each, measured 2026-10-22); the indexer's three shared lookups (~2K a wallet) allow ~22. */
const MAX_ANONYMOUS = 2;
/** With the visitor's own Geomi key the limit is the key's, far above the public one. */
const MAX_WITH_KEY = 50;
const KEY_STORE = 'geomi-api-key';
/** Sources read at once per address: keeps each burst small against the public per-IP limit. */
const SOURCE_CONCURRENCY = 4;
/** Enough retries to outlast the public API's 5-minute rate-limit window (2+4+…+60 s ≈ 5 min). */
const RETRIES = 9;
/** Sources that send the address to a third party: read only when the visitor opts in. */
const THIRD_PARTIES = [...new Set(SOURCES.flatMap(s => (s.thirdParty ? [s.thirdParty] : [])))];
const OPT_IN_KEY = 'check:third-party';
const STATUS: Record<Position['status'], string> = {
  recoverable: 'You can claim', team_gated: 'Needs the team', blocked: 'May not work', contract_held: 'Held by a contract', unknown: 'Unknown',
};

type Row = { address: string; results: { sourceId: string; result: ReadResult }[] };

function parse(text: string): { addresses: string[]; invalid: string[] } {
  const addresses = new Set<string>(), invalid: string[] = [];
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    try { addresses.add(normalizeAddress(token)); } catch { invalid.push(token); }
  }
  return { addresses: [...addresses], invalid };
}

/** A short reason for an error: rate limits and a rejected key by name, anything else truncated. */
function readable(error: string): string {
  if (/HTTP 40[13]/.test(error)) return 'the API key was rejected';
  return /429|rate limit/i.test(error) ? 'the API rate limit was reached' : error.slice(0, 120);
}

// The key lives in this browser only. Storage can be unavailable (private windows, blocked site data).
function loadKey(): string {
  try { return localStorage.getItem(KEY_STORE) ?? ''; } catch { return ''; }
}
function storeKey(key: string) {
  try { if (key) localStorage.setItem(KEY_STORE, key); else localStorage.removeItem(KEY_STORE); } catch { /* kept for this visit only */ }
}
const keyHeaders = (key: string): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

/** Null when Aptos accepts the key; otherwise why not. */
async function checkKey(key: string): Promise<string | null> {
  try {
    await createReader({ network: 'aptos', headers: keyHeaders(key), retries: 0 }).ledger();
    return null;
  } catch (err) {
    return /HTTP 40[13]/.test(String(err)) ? 'Geomi rejected this key.' : `Could not check the key: ${readable(String(err))}.`;
  }
}

function memory(): Memo {
  const data = new Map<string, string>();
  return { get: async k => data.get(k), set: async (k, v) => { data.set(k, v); } };
}

export default function Check({ prices: published, markets }: { prices: PriceBook; markets?: MarketTable }) {
  // The snapshot's prices may be old when its weekly run failed; stale quotes are dropped, never shown as values.
  const prices = freshPrices(published, Date.now() / 1000);
  const stalePrices = Object.keys(published).length - Object.keys(prices).length;
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  // Symbols and decimals read from the chain for payout assets the site does not list (null: not describable).
  const [displays, setDisplays] = useState<Record<string, AssetDisplay | null>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const running = useRef(false);   // blocks a second click before the disabled button renders
  const [key, setKey] = useState(loadKey);
  // Remembered in this browser only; storage can be unavailable (private windows), so it falls back to off.
  const [thirdParty, setThirdParty] = useState(() => { try { return localStorage.getItem(OPT_IN_KEY) === '1'; } catch { return false; } });
  const sources = SOURCES.filter(s => !s.thirdParty || thirdParty);
  const { addresses, invalid } = parse(text);
  const limit = key ? MAX_WITH_KEY : MAX_ANONYMOUS;

  async function run() {
    if (running.current) return;
    setError(''); setNotice(''); setRows([]); setDisplays({});
    if (!addresses.length) return setError('Paste at least one Aptos address.');
    if (addresses.length > limit) return setError(key ? `Check at most ${limit} addresses at a time.`
      : `Without an API key, check at most ${limit} addresses at a time. Add your own API key to check up to ${MAX_WITH_KEY}.`);
    // Busy before the first request: connecting can wait out a rate limit for minutes, and the button must stay off.
    running.current = true;
    setBusy('Connecting…');
    try {
      // One anonymous reader and ledger pin per network; sources read on their own chain. A network that cannot be
      // reached only fails its own sources.
      const contexts = new Map<string, ReadContext>(), unreachable = new Map<string, string>();
      for (const network of new Set(sources.map(s => s.chain))) {
        // The visitor's key goes to the Aptos Labs API only, never to Movement.
        const keyed = network === 'aptos' && !!key;
        const chain = createReader({ network, retries: RETRIES, headers: keyed ? keyHeaders(key) : {}, onWait: (_label, ms, status) => {
          if (status === 429) setNotice(`${keyed ? 'Your API key\'s rate limit was reached' : `The public ${NETWORKS[network].name} API is rate-limiting this browser`}; continuing in ${Math.ceil(ms / 1000)} s…`);
        } });
        try {
          contexts.set(network, { chain, ledger: await chain.ledger(), memo: memory(), scratch: new Map(),
            market: tableProvider(markets, prices[APT]?.usd ?? null) });
        } catch (err) {
          unreachable.set(network, `could not reach ${NETWORKS[network].name}: ${readable(String(err))}`);
        }
      }
      if (!contexts.size) throw new Error([...unreachable.values()].join('; '));
      const out: Row[] = [];
      const found: Record<string, AssetDisplay | null> = {};
      for (const [i, address] of addresses.entries()) {
        setBusy(`Checking ${i + 1} of ${addresses.length}…`);
        // Each source reads some of the wallet's own resources: one read of all of them serves those.
        const own = new Map([...contexts].map(([network, c]) => [network, { ...c, chain: withOwnResources(c.chain, address, c.ledger.version) }]));
        // A source that fails is reported on its own; the others still answer.
        const results = await mapLimit(sources, SOURCE_CONCURRENCY, async s => {
          const ctx = own.get(s.chain);
          if (!ctx) return { sourceId: s.id, result: { positions: [], complete: false, errors: [unreachable.get(s.chain)!], ledgerVersion: '0' } };
          // Same read and owner classification as the pipeline: a resource account or object cannot sign a claim.
          try { return { sourceId: s.id, result: await readClassified(s, ctx, address) }; }
          catch (err) { return { sourceId: s.id, result: { positions: [], complete: false, errors: [String(err)], ledgerVersion: ctx.ledger.version } }; }
        });
        // Unlisted payout assets: read once per check from their own chain; a failure leaves them in raw units.
        const unlisted = [...new Set(results.flatMap(r => r.result.positions.flatMap(p => [...p.expectedPayout, ...p.grossClaim].map(a => a.asset))))]
          .filter(a => !ASSETS[a] && !(a in found));
        await Promise.all(unlisted.map(async a => {
          const network = a.startsWith('movement:') ? 'movement' : 'aptos', ctx = contexts.get(network);
          found[a] = ctx ? await assetDisplay(ctx.chain, a.replace(/^movement:/, ''), ctx.ledger.version).catch(() => null) : null;
        }));
        setDisplays({ ...found });
        out.push({ address, results });
        setRows([...out]);
        setNotice('');
      }
    } catch (err) {
      setError(`Could not reach the chain: ${readable(String(err))}`);
    } finally {
      running.current = false;
      setBusy(''); setNotice('');
    }
  }

  return (
    <div>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={5} placeholder="0x… one address per line"
        style={{ width: '100%', font: '14px ui-monospace, monospace', padding: 10, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--fg)' }} />
      {invalid.length > 0 && <p className="muted">Not an Aptos address: {invalid.slice(0, 3).join(', ')}{invalid.length > 3 ? '…' : ''}</p>}
      {THIRD_PARTIES.length > 0 && <p className="muted"><label>
        <input type="checkbox" checked={thirdParty} disabled={!!busy} onChange={e => {
          setThirdParty(e.target.checked);
          try { localStorage.setItem(OPT_IN_KEY, e.target.checked ? '1' : '0'); } catch { /* not remembered */ }
        }} /> Also look up bridge transfers with {THIRD_PARTIES.join(' and ')}. This sends the addresses you check to them.
      </label></p>}
      <ApiKey current={key} onChange={k => { storeKey(k); setKey(k); }} disabled={!!busy} />
      <p><button className="button" onClick={run} disabled={!!busy}>{busy || `Check ${addresses.length || ''} wallet${addresses.length === 1 ? '' : 's'}`}</button></p>
      {notice && <p className="muted" role="status">{notice}</p>}
      {error && <p style={{ color: 'var(--bad)' }}>{error}</p>}
      {rows.length > 0 && stalePrices > 0 && <p className="muted">{stalePrices} price{stalePrices === 1 ? ' is' : 's are'} older than 7 days and not shown; amounts are still exact.</p>}
      {rows.map(row => <AddressResult key={row.address} row={row} prices={prices} displays={displays} />)}
    </div>
  );
}

function ApiKey({ current, onChange, disabled }: { current: string; onChange: (key: string) => void; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  async function save() {
    const key = draft.trim();
    if (!key) return;
    setStatus('Checking the key…');
    const problem = await checkKey(key);
    if (problem) return setStatus(problem);
    onChange(key); setDraft(''); setStatus('');
  }
  if (current) return (
    <p className="muted">
      Using your API key (…{current.slice(-4)}): up to {MAX_WITH_KEY} wallets at a time.{' '}
      <button className="link" onClick={() => onChange('')} disabled={disabled}>Remove key</button>
    </p>
  );
  return (
    <div className="api-key">
      <p style={{ margin: 0 }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="API key (optional)" aria-label="Geomi API key" autoComplete="off"
          style={{ font: '14px ui-monospace, monospace', padding: 8, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--fg)', width: 'min(100%, 420px)' }} />{' '}
        <button className="button ghost" onClick={save} disabled={disabled || !draft.trim()}>Use key</button>
      </p>
      {status && <p className="muted" role="status">{status}</p>}
      <p className="muted" style={{ fontSize: 14 }}>
        Without a key, the public Aptos API serves one browser about {MAX_ANONYMOUS} wallets per 5 minutes, so you can check {MAX_ANONYMOUS} at
        a time. With your own free key you can check up to {MAX_WITH_KEY}: create one for Aptos mainnet
        at <a href="https://geomi.dev" target="_blank" rel="noopener">geomi.dev</a> (Aptos Labs' developer platform){typeof location === 'undefined' ? '' : <>; if
        you limit it to websites, add <code>{location.origin}</code></>}. The key stays in this browser and is sent only to the Aptos Labs API,
        never to this site or to Movement.
      </p>
    </div>
  );
}

function AddressResult({ row, prices, displays }: { row: Row; prices: PriceBook; displays: Record<string, AssetDisplay | null> }) {
  const positions = row.results.flatMap(r => r.result.positions);
  const incomplete = row.results.filter(r => !r.result.complete);
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <b style={{ fontSize: 16 }}><code>{short(row.address)}</code></b>
      {positions.length === 0 && <p className="muted">Nothing found in {row.results.length - incomplete.length} of {row.results.length} sources.</p>}
      {positions.map(p => <PositionRow key={p.id} p={p} prices={prices} displays={displays} />)}
      {incomplete.map(r => (
        <p key={r.sourceId} style={{ color: 'var(--bad)' }}>
          {SOURCES.find(s => s.id === r.sourceId)?.title}: could not be read completely ({readable(r.result.errors[0] ?? '')}). Try again later.
        </p>
      ))}
    </section>
  );
}

function PositionRow({ p, prices, displays }: { p: Position; prices: PriceBook; displays: Record<string, AssetDisplay | null> }) {
  const source = SOURCES.find(s => s.id === p.source)!;
  // What it pays now; when it pays nothing now (blocked, or waiting on the team), what it is owed.
  const owedOnly = p.expectedPayout.length === 0;
  const shown = owedOnly ? p.grossClaim : p.expectedPayout;
  const value = toUsd(shown, prices);
  // Listed assets, then what the chain says; an asset neither describes is shown in raw units.
  const amount = shown.map(a => {
    const d = ASSETS[a.asset] ?? displays[a.asset];
    return d ? `${units(a.raw, d.decimals)} ${d.symbol}` : `${a.raw} raw units of ${short(a.asset)}`;
  }).join(' + ');
  return (
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 12 }}>
      <div><b style={{ display: 'inline', fontSize: 16 }}>{amount}</b>{value !== null && <span className="muted"> ≈ {usd(value)}</span>}{owedOnly && amount && <span className="muted"> owed</span>} · {STATUS[p.status]}</div>
      <div><span className="named"><Logo protocol={protocolOfSource(source.id)?.id} name={source.protocol} size={18} />{source.title}</span> <span className="muted">· {NETWORKS[source.chain].name}</span></div>
      <div className="muted">
        {p.ageBasis === 'unknown' ? 'Claimable since: unknown' : `Claimable since ${date(p.claimableSince)}${p.ageBasis === 'position_interaction' ? ' (estimate)' : ''}`}
        {p.blockers.map(b => ` · ${b.detail}`)}
      </div>
      {p.steps.map((s, i) => <div key={i} className="muted">Call <code>{s.function}({s.arguments.join(', ')})</code></div>)}
      <details><summary className="muted">How to recover</summary><ol>{source.howTo.map(h => <li key={h}>{h}</li>)}</ol></details>
    </div>
  );
}
