// Protocol logos (files in public/logos, listed by `pnpm logos` in logos.json) and the registry protocol each source
// belongs to.
import manifest from './logos.json';
import { PROTOCOLS, type ProtocolEntry } from '../../shared/protocols.ts';

const LOGOS: Record<string, string> = manifest;
const BY_SOURCE = new Map(PROTOCOLS.flatMap(p => (p.sources ?? []).map(id => [id, p] as const)));

/** The registry protocol a source belongs to (each source is under exactly one). */
export const protocolOfSource = (sourceId: string): ProtocolEntry | undefined => BY_SOURCE.get(sourceId);
/** A protocol's logo path, if it has one. */
export const logoOf = (protocolId: string | undefined): string | undefined => (protocolId ? LOGOS[protocolId] : undefined);
