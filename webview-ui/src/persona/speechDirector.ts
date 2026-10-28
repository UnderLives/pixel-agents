/**
 * Which line a character says, and when. Pure (clock and dice injected) so the
 * choice rules are unit-tested: situations from tool activity, an anti-repeat
 * window per speaker, and gaps so the office chats instead of shouting.
 */

import type { SpeechLine } from '../../../core/src/messages.js';

export const SITUATIONS = [
  'start_item',
  'building',
  'waiting_lock',
  'reading',
  'editing',
  'running_game',
  'done',
  'permission',
  'error',
  'filler',
  'motivation',
  // The boss's own: walking over to an employee, and congratulating one who finished.
  'visit',
  'praise',
] as const;
export type Situation = (typeof SITUATIONS)[number];

/** Odds of speaking up when a situation comes round (frequent tools rarely, milestones always). */
const CHANCE: Record<Situation, number> = {
  start_item: 1,
  building: 0.7,
  waiting_lock: 0.7,
  reading: 0.15,
  editing: 0.2,
  running_game: 0.7,
  done: 1,
  permission: 1,
  error: 1,
  filler: 1,
  motivation: 1,
  visit: 1,
  praise: 1,
};
/** Milestones may interrupt the per-speaker gap; chatter may not. */
const MILESTONE: ReadonlySet<Situation> = new Set([
  'start_item',
  'done',
  'permission',
  'error',
  'visit',
  'praise',
]);

const BUILD_RE =
  /editor_lock\.sh\s+build|Build\.bat|\bnpm run (build|package|compile)\b|vsce package|package\.sh|\bmsbuild\b|\bcmake --build\b/i;
const GAME_RE = /run_game\.sh|UnrealEditor(-Cmd)?(\.exe)?\b|\b-game\b/i;
const LOCK_RE = /editor_lock\.sh|wt\.sh\s+(take|new)\b/i;
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS']);
const EDITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** The situation a tool start puts its character in, or null (nothing worth a line). */
export function situationForTool(toolName: string, status: string): Situation | null {
  if (READING_TOOLS.has(toolName)) return 'reading';
  if (EDITING_TOOLS.has(toolName)) return 'editing';
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = status.replace(/^Running:\s*/, '');
    if (BUILD_RE.test(cmd)) return 'building';
    if (GAME_RE.test(cmd)) return 'running_game';
    if (LOCK_RE.test(cmd)) return 'waiting_lock';
  }
  return null;
}

export interface SpeechDirectorOptions {
  /** Lines a speaker won't repeat (the last N said). */
  recentWindow?: number;
  /** Least time between two lines of one speaker (milestones excepted). */
  speakerGapMs?: number;
  /** Least time between any two lines in the office. */
  officeGapMs?: number;
  random?: () => number;
}

/** One speaker's memory: what was said recently and when. */
interface Memory {
  recent: string[];
  lastAt: number;
}

export class SpeechDirector {
  private readonly memory = new Map<string, Memory>();
  private lastOfficeAt = -Infinity;
  private readonly recentWindow: number;
  private readonly speakerGapMs: number;
  private readonly officeGapMs: number;
  private readonly random: () => number;

  constructor(opts: SpeechDirectorOptions = {}) {
    this.recentWindow = opts.recentWindow ?? 20;
    this.speakerGapMs = opts.speakerGapMs ?? 20_000;
    this.officeGapMs = opts.officeGapMs ?? 3_000;
    this.random = opts.random ?? Math.random;
  }

  /** When `speaker` last said anything (-Infinity if never). */
  lastSpokeAt(speaker: string): number {
    return this.memory.get(speaker)?.lastAt ?? -Infinity;
  }

  /**
   * The line `speaker` says now in `situation`, or null (no lines, too soon, or
   * the dice said no). Saying it is recorded.
   */
  say(
    speaker: string,
    situation: Situation,
    bank: Readonly<Record<string, readonly SpeechLine[]>> | undefined,
    now: number,
    force = false,
  ): SpeechLine | null {
    const lines = bank?.[situation];
    if (!lines?.length) return null;
    const mem = this.memory.get(speaker) ?? { recent: [], lastAt: -Infinity };
    const milestone = force || MILESTONE.has(situation);
    if (!milestone && now - mem.lastAt < this.speakerGapMs) return null;
    if (now - this.lastOfficeAt < (milestone ? 0 : this.officeGapMs)) return null;
    if (!force && this.random() >= CHANCE[situation]) return null;

    const line = pickLine(lines, mem.recent, this.random);
    mem.recent = [...mem.recent.filter((id) => id !== line.id), line.id].slice(-this.recentWindow);
    mem.lastAt = now;
    this.memory.set(speaker, mem);
    this.lastOfficeAt = now;
    return line;
  }
}

/**
 * A random line not among `recent`; when every line is recent (a small bank), the
 * one said longest ago.
 */
export function pickLine(
  lines: readonly SpeechLine[],
  recent: readonly string[],
  random: () => number = Math.random,
): SpeechLine {
  const fresh = lines.filter((l) => !recent.includes(l.id));
  if (fresh.length) return fresh[Math.floor(random() * fresh.length)];
  return lines.reduce((best, l) => (recent.indexOf(l.id) < recent.indexOf(best.id) ? l : best));
}

/** How long a bubble stays up: long enough to read it. */
export function bubbleDurationMs(text: string): number {
  return Math.min(9_000, Math.max(3_000, 2_000 + text.length * 60));
}
