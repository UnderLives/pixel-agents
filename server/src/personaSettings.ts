/**
 * Persona settings: name tags, the character set new agents draw from, and the
 * speech banks characters talk from. Host-neutral: the VS Code adapter feeds it
 * from `pixel-agents.*` settings, the standalone CLI from the `persona` block of
 * ~/.pixel-agents/config.json.
 *
 * Speech banks are JSON files, one per speaker:
 *   { "speaker": "Linda", "situations": { "done": ["line", {"id": "x", "text": "line"}] } }
 * Bundled banks ship in dist/speech/; files in ~/.pixel-agents/speech/ replace a
 * bundled speaker of the same name. A line's id is its own (`{id, text}`) or a hash
 * of its text, so voice files keep their name when lines are reordered. Voice files
 * live beside the user banks: ~/.pixel-agents/speech/<speaker lower-case>/<id>.(ogg|wav|mp3).
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PersonaSettingsLoaded, SpeechLine } from '../../core/src/messages.js';
import { CHARACTER_SETS, type CharacterSet } from '../../core/src/persona.js';
import { SERVER_JSON_DIR } from './constants.js';

export type SpeechMode = 'off' | 'text' | 'voice';
const SPEECH_MODES: readonly SpeechMode[] = ['off', 'text', 'voice'];

export interface PersonaConfig {
  showNameLabels: boolean;
  characterSet: CharacterSet;
  /** Speaker/agent name -> char_N index it always wears. */
  characterByName: Record<string, number>;
  speech: SpeechMode;
  /** 0..1 */
  speechVolume: number;
  /** Minutes of silence before an idle named character says a filler line; 0 = never. */
  speechFillerMinutes: number;
}

/**
 * Defaults. Name tags on, the women-only set, text speech and the named cast below
 * are this fork's choices (upstream behaviour: `characterSet: 'all'`, `speech: 'off'`,
 * no names). Every name gets its own face; the one women sprite left over (9) goes
 * to whoever is unnamed, i.e. the lead session.
 */
export const FORK_CAST: Record<string, number> = {
  Linda: 1,
  Maya: 6,
  Nora: 5,
  Sacha: 10,
  Iris: 7,
  Léa: 8,
  Zoé: 3,
};

export const PERSONA_DEFAULTS: PersonaConfig = {
  showNameLabels: true,
  characterSet: 'women',
  characterByName: FORK_CAST,
  speech: 'text',
  speechVolume: 0.8,
  speechFillerMinutes: 4,
};

/** Coerce untrusted values (settings.json, config.json) onto PERSONA_DEFAULTS. */
export function normalizePersonaConfig(raw: unknown): PersonaConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  let byName: Record<string, number> = {};
  if (r.characterByName === undefined) byName = { ...PERSONA_DEFAULTS.characterByName };
  else if (r.characterByName && typeof r.characterByName === 'object') {
    for (const [k, v] of Object.entries(r.characterByName as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) byName[k] = v;
    }
  }
  return {
    showNameLabels:
      typeof r.showNameLabels === 'boolean' ? r.showNameLabels : PERSONA_DEFAULTS.showNameLabels,
    characterSet: CHARACTER_SETS.includes(r.characterSet as CharacterSet)
      ? (r.characterSet as CharacterSet)
      : PERSONA_DEFAULTS.characterSet,
    characterByName: byName,
    speech: SPEECH_MODES.includes(r.speech as SpeechMode)
      ? (r.speech as SpeechMode)
      : PERSONA_DEFAULTS.speech,
    speechVolume: num(r.speechVolume, 0, 1, PERSONA_DEFAULTS.speechVolume),
    speechFillerMinutes: num(r.speechFillerMinutes, 0, 240, PERSONA_DEFAULTS.speechFillerMinutes),
  };
}

/** speaker -> situation -> lines */
export type SpeechBanks = Record<string, Record<string, SpeechLine[]>>;

/** ~/.pixel-agents/speech: user banks and every speaker's voice files. */
export function userSpeechDir(): string {
  return path.join(os.homedir(), SERVER_JSON_DIR, 'speech');
}

const AUDIO_EXTENSIONS = ['.ogg', '.wav', '.mp3'];
/** Cap per situation, so a hand-edited bank can't flood the wire. */
const MAX_LINES_PER_SITUATION = 500;
const MAX_LINE_LENGTH = 280;

/** A line's stable id: 10 hex of sha1(text). Mirrored by tools/speech/*.py. */
export function speechLineId(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 10);
}

function readBankFile(
  file: string,
): { speaker: string; situations: Record<string, SpeechLine[]> } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const speaker =
      typeof raw.speaker === 'string' && raw.speaker.trim()
        ? raw.speaker.trim()
        : path.basename(file, '.json');
    const situations: Record<string, SpeechLine[]> = {};
    const src = (raw.situations ?? {}) as Record<string, unknown>;
    for (const [situation, list] of Object.entries(src)) {
      if (!Array.isArray(list)) continue;
      const lines: SpeechLine[] = [];
      for (const item of list.slice(0, MAX_LINES_PER_SITUATION)) {
        const text =
          typeof item === 'string'
            ? item
            : item &&
                typeof item === 'object' &&
                typeof (item as { text?: unknown }).text === 'string'
              ? (item as { text: string }).text
              : null;
        if (!text || !text.trim()) continue;
        const ownId = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
        const id =
          typeof ownId === 'string' && /^[\w-]{1,64}$/.test(ownId)
            ? ownId
            : speechLineId(text.trim());
        lines.push({ id, text: text.trim().slice(0, MAX_LINE_LENGTH) });
      }
      if (lines.length) situations[situation] = lines;
    }
    return { speaker, situations };
  } catch (err) {
    console.warn(
      `[Pixel Agents] Speech bank ${file} skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function readBankDir(dir: string): SpeechBanks {
  const banks: SpeechBanks = {};
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch {
    return banks;
  }
  for (const f of files.sort()) {
    const bank = readBankFile(path.join(dir, f));
    if (bank) banks[bank.speaker] = bank.situations;
  }
  return banks;
}

/**
 * Bundled banks, overridden speaker by speaker by the user's, each line tagged with
 * its voice file when one exists under `audioDir`.
 */
export function loadSpeechBanks(
  bundledDir: string,
  userDir: string = userSpeechDir(),
): SpeechBanks {
  const banks: SpeechBanks = { ...readBankDir(bundledDir), ...readBankDir(userDir) };
  for (const [speaker, situations] of Object.entries(banks)) {
    let audioFiles: Set<string>;
    try {
      audioFiles = new Set(fs.readdirSync(path.join(userDir, speaker.toLowerCase())));
    } catch {
      continue;
    }
    for (const lines of Object.values(situations)) {
      for (const line of lines) {
        const file = AUDIO_EXTENSIONS.map((ext) => line.id + ext).find((f) => audioFiles.has(f));
        if (file) line.audio = file;
      }
    }
  }
  return banks;
}

export function personaSettingsMessage(
  config: PersonaConfig,
  banks: SpeechBanks,
  audioBase?: string,
): PersonaSettingsLoaded {
  return {
    type: 'personaSettingsLoaded',
    ...config,
    speechBanks: config.speech === 'off' ? {} : banks,
    audioBase: config.speech === 'voice' ? audioBase : undefined,
  };
}
