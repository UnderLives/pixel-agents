/**
 * Speech in the office: who speaks for which character, the bubbles on screen,
 * the voice files, and the idle fillers. Fed by useExtensionMessages (the same
 * hook-driven events that animate the characters), read by ToolOverlay.
 */

import { bankFor, bankSpeaker, getPersona } from './personaState.js';
import {
  bubbleDurationMs,
  type Situation,
  situationForTool,
  SpeechDirector,
} from './speechDirector.js';

const director = new SpeechDirector();
/** Character id -> speaker name (named sub-agents and teammates). */
const speakers = new Map<number, string>();
/** Character id -> the bubble on screen. */
const bubbles = new Map<number, { text: string; until: number }>();
/** Characters that went silent since: when their speaker last spoke or appeared. */
const lastHeard = new Map<number, number>();
/** Bubbles left behind by characters that despawned, at the world position they stood. */
const pinned = new Map<number, { text: string; until: number; x: number; y: number }>();
let currentAudio: HTMLAudioElement | null = null;

/** Who speaks for a character (undefined = silent). */
export function setSpeaker(charId: number, name: string | undefined): void {
  if (name) {
    speakers.set(charId, name);
    lastHeard.set(charId, Date.now());
  } else {
    speakers.delete(charId);
  }
}

export function forgetCharacter(charId: number): void {
  speakers.delete(charId);
  bubbles.delete(charId);
  lastHeard.delete(charId);
}

/** Who speaks for characters with no explicit speaker (the boss). */
let speakerResolver: ((charId: number) => string | undefined) | null = null;
export function setSpeakerResolver(resolve: (charId: number) => string | undefined): void {
  speakerResolver = resolve;
}

export function speakerOf(charId: number): string | undefined {
  return speakers.get(charId) ?? speakerResolver?.(charId);
}

/** Leave a character's current bubble at (x, y) after the character is gone. */
export function pinBubble(charId: number, x: number, y: number): void {
  const b = bubbles.get(charId);
  if (b) pinned.set(charId, { ...b, x, y });
}

/** Bubbles of departed characters still on screen. */
export function pinnedBubbles(
  now = Date.now(),
): { id: number; text: string; x: number; y: number }[] {
  const out: { id: number; text: string; x: number; y: number }[] = [];
  for (const [id, b] of pinned) {
    if (now > b.until) pinned.delete(id);
    else out.push({ id, text: b.text, x: b.x, y: b.y });
  }
  return out;
}

/** The bubble a character shows now, if any. */
export function bubbleFor(charId: number, now = Date.now()): string | null {
  const b = bubbles.get(charId);
  if (!b) return null;
  if (now > b.until) {
    bubbles.delete(charId);
    return null;
  }
  return b.text;
}

export interface SpeakOptions {
  /** Placeholders filled in the line: "{name}" -> vars.name. */
  vars?: Record<string, string>;
  /** Skip the gaps and odds (a scripted moment, e.g. the boss at a desk). */
  force?: boolean;
  now?: number;
}

/** Make a character speak in a situation (if it has a speaker, a bank, and the director agrees). */
export function speak(charId: number, situation: Situation, opts: SpeakOptions = {}): boolean {
  const now = opts.now ?? Date.now();
  const persona = getPersona();
  if (persona.speech === 'off') return false;
  const name = speakerOf(charId);
  if (!name) return false;
  const line = director.say(name, situation, bankFor(name), now, opts.force);
  if (!line) return false;
  const text = line.text.replace(/\{(\w+)\}/g, (m, key: string) => opts.vars?.[key] ?? m);
  bubbles.set(charId, { text, until: now + bubbleDurationMs(text) });
  lastHeard.set(charId, now);
  if (persona.speech === 'voice' && persona.audioBase && line.audio) {
    playVoice(
      `${persona.audioBase}/${encodeURIComponent((bankSpeaker(name) ?? name).toLowerCase())}/${encodeURIComponent(line.audio)}`,
      persona.speechVolume,
    );
  }
  return true;
}

/** A tool started on a character: maybe a line about it. */
export function speakForTool(charId: number, toolName: string, status: string): void {
  const situation = situationForTool(toolName, status);
  if (situation) speak(charId, situation);
}

/**
 * Called every few seconds: the named character silent the longest, past the
 * filler delay, says a filler or (one time in three) a word of encouragement.
 */
export function tickFillers(present: ReadonlySet<number>, now = Date.now()): void {
  const minutes = getPersona().speechFillerMinutes;
  if (!minutes || getPersona().speech === 'off') return;
  let quietest: number | null = null;
  let quietSince = Infinity;
  for (const [charId, at] of lastHeard) {
    if (!present.has(charId)) continue;
    if (at < quietSince) {
      quietSince = at;
      quietest = charId;
    }
  }
  if (quietest === null || now - quietSince < minutes * 60_000) return;
  // Count it as heard either way, so a speaker with no filler lines doesn't block the others.
  lastHeard.set(quietest, now);
  speak(quietest, Math.random() < 1 / 3 ? 'motivation' : 'filler', { now });
}

function playVoice(url: string, volume: number): void {
  try {
    currentAudio?.pause();
    const audio = new Audio(url);
    audio.volume = Math.min(1, Math.max(0, volume));
    currentAudio = audio;
    void audio.play().catch(() => {
      /* autoplay blocked or file missing: the bubble still shows */
    });
  } catch {
    /* no Audio in this runtime */
  }
}
