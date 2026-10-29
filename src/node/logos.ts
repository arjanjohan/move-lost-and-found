// Protocol logos: downloads each registry protocol's logo from DefiLlama's icon CDN (by its DefiLlama slug, 48×48 WebP)
// into public/logos/<protocol id>.webp, keeping files already there (a logo added by hand wins; delete a file to fetch
// it again), then writes src/web/lib/logos.json: protocol id → path, for every logo file in public/logos. Logos belong
// to their owners and only identify the protocol. Never matched by name: a protocol without a slug keeps the monogram
// unless a logo was picked by hand (below). Run: pnpm logos
//
// Added as files, from each project's own site (2026-10-29): kana-perps (kanalabs.io), tradeport (tradeport.xyz),
// ekiden (ekiden.fi), topaz (topaz.so), gui-lottery (guiinu.com). Not used: fliq.xyz is for sale and souffl3.com now
// serves an unrelated site.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { PROTOCOLS } from '../shared/protocols.ts';

const DIR = new URL('../../public/logos/', import.meta.url);
const MANIFEST = new URL('../web/lib/logos.json', import.meta.url);
const IMAGE = /\.(webp|png|svg|jpg)$/;
/** Picked by hand (2026-10-29) for protocols without their own DefiLlama slug: the same project's DefiLlama entry (matched
 *  by project and website, not by name), or the chain's icon for its native staking and framework bridges. */
const BY_HAND: Record<string, string> = {
  'layerzero-aptos-bridge': 'protocols/layerzero-v2', 'layerzero-v2': 'protocols/layerzero-v2', 'celer-cbridge': 'protocols/cbridge',
  'echelon-farming': 'protocols/echelon-market', 'amnis-ami': 'protocols/amnis-finance', avant: 'protocols/avant-avusd',
  'aptos-native-staking': 'chains/rsz_aptos', 'validator-owned-pools': 'chains/rsz_aptos',
  'movement-native-staking': 'chains/rsz_movement', 'movement-framework-bridges': 'chains/rsz_movement',
};

mkdirSync(DIR, { recursive: true });
const files = () => readdirSync(DIR).filter(f => IMAGE.test(f)).sort();
const have = new Set(files().map(f => f.replace(IMAGE, '')));
const without: string[] = [];
for (const p of PROTOCOLS) {
  if (have.has(p.id)) continue;
  const icon = p.defillama ? `protocols/${p.defillama}` : BY_HAND[p.id];
  if (!icon) { without.push(p.id); continue; }
  const res = await fetch(`https://icons.llamao.fi/icons/${icon}?w=48&h=48`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok || res.headers.get('content-type') !== 'image/webp') { without.push(`${p.id} (HTTP ${res.status})`); continue; }
  writeFileSync(new URL(`${p.id}.webp`, DIR), new Uint8Array(await res.arrayBuffer()));
}

const ids = new Set(PROTOCOLS.map(p => p.id));
const stray = files().filter(f => !ids.has(f.replace(IMAGE, '')));
const manifest = Object.fromEntries(files().filter(f => ids.has(f.replace(IMAGE, ''))).map(f => [f.replace(IMAGE, ''), `/logos/${f}`]));
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${Object.keys(manifest).length} of ${PROTOCOLS.length} protocols have a logo.`);
if (without.length) console.log(`Without one (monogram): ${without.join(', ')}`);
if (stray.length) console.log(`Files for no registry protocol (not listed): ${stray.join(', ')}`);
