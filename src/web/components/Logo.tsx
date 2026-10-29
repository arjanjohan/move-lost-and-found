// A protocol's logo on a light round backdrop (dark logos stay visible in dark mode), or, without one, its initial in a
// neutral circle with a hue derived from the name, so it is stable and entries stay apart. Never the chain's logo: that
// would read as if the chain made or endorses the protocol. Decorative: the name is always shown next to it.
import type { CSSProperties } from 'react';
import { logoOf } from '../lib/logos.ts';

export function Logo({ protocol, name, size = 20 }: { protocol?: string; name: string; size?: number }) {
  const src = logoOf(protocol);
  if (src) return <img className="logo" src={src} alt="" width={size} height={size} loading="lazy" decoding="async" />;
  let hue = 0;
  for (const c of name) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  const style = { '--h': hue, width: size, height: size, fontSize: Math.round(size * 0.5) } as CSSProperties;
  return <span className="logo mono" style={style} aria-hidden="true">{name.match(/[A-Za-z0-9]/)?.[0].toUpperCase() ?? '?'}</span>;
}
