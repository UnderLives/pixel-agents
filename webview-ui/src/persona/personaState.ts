/**
 * The persona settings the host sent (personaSettingsLoaded): name tags, the
 * character set, and the speech banks. Module state, like the sprite templates:
 * the overlay re-renders every frame and reads it directly.
 */

import type { PersonaSettingsLoaded, SpeechLine } from '../../../core/src/messages.js';
import { allowedPalettes, type CharacterSet, paletteForName } from '../../../core/src/persona.js';

export type SpeechMode = 'off' | 'text' | 'voice';

interface PersonaState {
  showNameLabels: boolean;
  characterSet: CharacterSet;
  characterByName: Record<string, number>;
  speech: SpeechMode;
  speechVolume: number;
  speechFillerMinutes: number;
  speechBanks: Record<string, Record<string, SpeechLine[]>>;
  audioBase?: string;
  /** False until the host sent personaSettingsLoaded: upstream behaviour until then. */
  received: boolean;
}

/** Until the host speaks: upstream behaviour (no tags, every character, silent). */
let state: PersonaState = {
  showNameLabels: false,
  characterSet: 'all',
  characterByName: {},
  speech: 'off',
  speechVolume: 0.8,
  speechFillerMinutes: 0,
  speechBanks: {},
  received: false,
};
const listeners = new Set<() => void>();

export function setPersonaSettings(msg: PersonaSettingsLoaded): void {
  state = {
    showNameLabels: msg.showNameLabels,
    characterSet: msg.characterSet,
    characterByName: msg.characterByName,
    speech: msg.speech,
    speechVolume: msg.speechVolume,
    speechFillerMinutes: msg.speechFillerMinutes,
    speechBanks: msg.speechBanks,
    audioBase: msg.audioBase,
    received: true,
  };
  for (const l of listeners) l();
}

export function getPersona(): Readonly<PersonaState> {
  return state;
}

export function onPersonaChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The palettes new agents may wear out of `count` loaded sprites. */
export function allowedPalettesNow(count: number): number[] {
  return allowedPalettes(count, state.characterSet);
}

/**
 * The sprite a named character always wears; undefined before the host's persona
 * settings arrived (then sub-agents and teammates wear their lead's, as upstream).
 */
export function paletteForNameNow(name: string, count: number): number | undefined {
  if (!state.received) return undefined;
  return paletteForName(name, allowedPalettesNow(count), state.characterByName);
}

/** A speaker's bank, matched case- and accent-insensitively ("Lea" finds "Léa"). */
export function bankFor(name: string): Record<string, SpeechLine[]> | undefined {
  const key = foldName(name);
  const found = Object.keys(state.speechBanks).find((k) => foldName(k) === key);
  return found ? state.speechBanks[found] : undefined;
}

/** The bank's own spelling of a speaker (voice files live under its lower-case form). */
export function bankSpeaker(name: string): string | undefined {
  const key = foldName(name);
  return Object.keys(state.speechBanks).find((k) => foldName(k) === key);
}

export function foldName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}
