/**
 * Who a character is, as the office shows it: a name, a role, which sprites it may
 * wear. Pure (no DOM, no Node), shared by the server's palette assignment and the
 * webview's name tags and sub-agent sprites.
 */

/** Which bundled characters new agents are drawn from. */
export type CharacterSet = 'all' | 'women';
export const CHARACTER_SETS: readonly CharacterSet[] = ['all', 'women'];

/**
 * Bundled sprites (assets/characters/char_N.png) that depict women: 1, 3 and 5 from
 * the Metro City cast (upstream's own wardrobe rebuild draws exactly these three on
 * its "bust" body), 6-10 rendered from upstream's wardrobe art (tools/characters/).
 */
export const BUNDLED_WOMEN: readonly number[] = [1, 3, 5, 6, 7, 8, 9, 10];
/** Bundled sprites in all: anything past this index came from an external asset directory. */
export const BUNDLED_CHARACTER_COUNT = 11;

/**
 * The palettes a set allows out of `count` loaded sprites. Sprites from external asset
 * directories (index >= BUNDLED_CHARACTER_COUNT) are always allowed: the user added them
 * on purpose and the bundle can't know what they depict. Never empty.
 */
export function allowedPalettes(count: number, set: CharacterSet): number[] {
  const all = Array.from({ length: Math.max(1, count) }, (_, i) => i);
  if (set !== 'women') return all;
  const allowed = all.filter((i) => i >= BUNDLED_CHARACTER_COUNT || BUNDLED_WOMEN.includes(i));
  return allowed.length ? allowed : all;
}

/** FNV-1a over the lower-cased name: stable across sessions, machines and restarts. */
export function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The sprite a named agent always wears: the user's explicit pick when it is a loaded,
 * allowed palette, otherwise a hash of the name into the allowed palettes.
 */
export function paletteForName(
  name: string,
  allowed: readonly number[],
  byName: Readonly<Record<string, number>> = {},
): number {
  const key = Object.keys(byName).find((k) => k.trim().toLowerCase() === name.trim().toLowerCase());
  const pick = key !== undefined ? byName[key] : undefined;
  if (pick !== undefined && allowed.includes(pick)) return pick;
  return allowed[nameHash(name) % allowed.length];
}

/** Separator of the "<Name> · <domain> · <item>" description convention. */
const LABEL_SEPARATOR = /\s+[·•|]\s+/;
/** A first field longer than this is a sentence, not a name. */
const NAME_MAX_LENGTH = 24;

export interface AgentLabel {
  /** Bold first line: the name, or the whole description when it isn't "<Name> · …". */
  name: string;
  /** Second line ("domain · item"), when the description had one. */
  role: string | null;
  /** True when `name` is a real name parsed from the convention (it picks a sprite). */
  named: boolean;
}

/**
 * Read a spawn description: "Linda · clothes · triage" -> name "Linda", role
 * "clothes · triage"; anything else -> the description itself as the name line.
 */
export function parseAgentLabel(description: string): AgentLabel {
  const text = description.trim();
  const parts = text.split(LABEL_SEPARATOR).filter(Boolean);
  if (parts.length >= 2 && parts[0].length <= NAME_MAX_LENGTH && !/\s{2,}/.test(parts[0])) {
    return { name: parts[0], role: parts.slice(1).join(' · '), named: true };
  }
  return { name: text, role: null, named: false };
}

/** Cut `text` to `max` characters on a word boundary when one is close, with an ellipsis. */
export function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
