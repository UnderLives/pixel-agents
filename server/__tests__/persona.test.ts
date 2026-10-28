import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  allowedPalettes,
  BUNDLED_WOMEN,
  nameHash,
  paletteForName,
  parseAgentLabel,
  truncateLabel,
} from '../../core/src/persona.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  assignPaletteIfNeeded,
  setCharacterPolicy,
  setPaletteCount,
} from '../src/paletteAssigner.js';
import {
  loadSpeechBanks,
  normalizePersonaConfig,
  PERSONA_DEFAULTS,
  personaSettingsMessage,
  speechLineId,
} from '../src/personaSettings.js';
import type { AgentState } from '../src/types.js';

describe('parseAgentLabel', () => {
  it('reads the "<Name> · <domain> · <item>" convention', () => {
    expect(parseAgentLabel('Linda · vêtements · triage')).toEqual({
      name: 'Linda',
      role: 'vêtements · triage',
      named: true,
    });
  });
  it('falls back to the whole description', () => {
    expect(parseAgentLabel('Fork Pixel Agents: names, roles, women only')).toEqual({
      name: 'Fork Pixel Agents: names, roles, women only',
      role: null,
      named: false,
    });
  });
  it('does not take a long sentence before the dot for a name', () => {
    expect(parseAgentLabel('a very long first field that is a sentence · x').named).toBe(false);
  });
});

describe('truncateLabel', () => {
  it('keeps short text and cuts long text on a word with an ellipsis', () => {
    expect(truncateLabel('Linda', 18)).toBe('Linda');
    const cut = truncateLabel('Wardrobe in-game capture and triage', 20);
    expect(cut.length).toBeLessThanOrEqual(20);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('character sets', () => {
  it("'all' allows every loaded sprite, 'women' only the women plus external ones", () => {
    expect(allowedPalettes(11, 'all')).toHaveLength(11);
    expect(allowedPalettes(11, 'women')).toEqual([...BUNDLED_WOMEN]);
    expect(allowedPalettes(13, 'women')).toEqual([...BUNDLED_WOMEN, 11, 12]);
    // Upstream's 6-sprite bundle: still only the women of it.
    expect(allowedPalettes(6, 'women')).toEqual([1, 3, 5]);
  });
  it('a name always maps to the same allowed sprite; explicit picks win', () => {
    const allowed = allowedPalettes(11, 'women');
    expect(paletteForName('Linda', allowed)).toBe(paletteForName('linda', allowed));
    expect(allowed).toContain(paletteForName('Someone', allowed));
    expect(paletteForName('Léa', allowed, { Léa: 8 })).toBe(8);
    // A pick outside the set falls back to the hash.
    expect(paletteForName('Léa', allowed, { Léa: 0 })).toBe(
      allowed[nameHash('Léa') % allowed.length],
    );
  });
});

function agent(overrides: Partial<AgentState>): AgentState {
  return {
    id: 1,
    sessionId: 's',
    isExternal: false,
    projectDir: '/p',
    jsonlFile: '/p/s.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

describe('palette assignment under a character policy', () => {
  afterEach(() => {
    setCharacterPolicy({ characterSet: 'all', characterByName: {} });
    setPaletteCount(6);
  });

  it('the lead wears the boss sprite, outside the women set, even over a saved palette', () => {
    setPaletteCount(11);
    setCharacterPolicy(PERSONA_DEFAULTS);
    const lead = agent({ id: 1, palette: 2, hueShift: 40 });
    assignPaletteIfNeeded(lead, new AgentStateStore());
    expect(lead.palette).toBe(0);
    expect(lead.hueShift).toBe(0);
    const teammate = agent({ id: 3, leadAgentId: 1 });
    assignPaletteIfNeeded(teammate, new AgentStateStore());
    expect(BUNDLED_WOMEN).toContain(teammate.palette);
  });

  it('without a boss sprite, only women, and the lead gets the face no name reserved', () => {
    setPaletteCount(11);
    setCharacterPolicy({
      characterSet: 'women',
      characterByName: PERSONA_DEFAULTS.characterByName,
    });
    const store = new AgentStateStore();
    const lead = agent({ id: 1 });
    assignPaletteIfNeeded(lead, store);
    expect(lead.palette).toBe(9);
    for (let i = 0; i < 30; i++) {
      const a = agent({ id: 100 + i });
      assignPaletteIfNeeded(a, store);
      expect(BUNDLED_WOMEN).toContain(a.palette);
      store.set(a.id, a);
    }
  });

  it('a named agent wears its own sprite', () => {
    setPaletteCount(11);
    setCharacterPolicy({ characterSet: 'women', characterByName: { Maya: 6 } });
    const a = agent({ id: 2, agentName: 'Maya' });
    assignPaletteIfNeeded(a, new AgentStateStore());
    expect(a.palette).toBe(6);
    expect(a.hueShift).toBe(0);
  });
});

describe('persona settings', () => {
  it('coerces junk onto the defaults', () => {
    expect(normalizePersonaConfig(undefined)).toEqual(PERSONA_DEFAULTS);
    const c = normalizePersonaConfig({
      characterSet: 'aliens',
      speech: 'voice',
      speechVolume: 7,
      characterByName: { A: 2, B: -1, C: 'x' },
    });
    expect(c.characterSet).toBe('women');
    expect(c.speech).toBe('voice');
    expect(c.speechVolume).toBe(1);
    expect(c.characterByName).toEqual({ A: 2 });
  });

  it('speech off sends no banks; voice sends the audio base', () => {
    const banks = { Linda: { done: [{ id: 'a', text: 'Fini !' }] } };
    expect(
      personaSettingsMessage({ ...PERSONA_DEFAULTS, speech: 'off' }, banks, '/x').speechBanks,
    ).toEqual({});
    expect(
      personaSettingsMessage({ ...PERSONA_DEFAULTS, speech: 'voice' }, banks, '/x').audioBase,
    ).toBe('/x');
    expect(
      personaSettingsMessage({ ...PERSONA_DEFAULTS, speech: 'text' }, banks, '/x').audioBase,
    ).toBeUndefined();
  });
});

describe('loadSpeechBanks', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads bundled banks, lets user banks replace a speaker, and finds voice files', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-speech-'));
    const bundled = path.join(dir, 'bundled');
    const user = path.join(dir, 'user');
    fs.mkdirSync(bundled);
    fs.mkdirSync(path.join(user, 'léa'), { recursive: true });
    fs.writeFileSync(
      path.join(bundled, 'linda.json'),
      JSON.stringify({
        speaker: 'Linda',
        situations: { done: ['Fini !', { id: 'x1', text: 'Voilà.' }, 3] },
      }),
    );
    fs.writeFileSync(
      path.join(bundled, 'lea.json'),
      JSON.stringify({ speaker: 'Léa', situations: { done: ['old'] } }),
    );
    fs.writeFileSync(
      path.join(user, 'lea.json'),
      JSON.stringify({ speaker: 'Léa', situations: { done: ['Terminé !'] } }),
    );
    fs.writeFileSync(path.join(user, 'léa', `${speechLineId('Terminé !')}.ogg`), '');
    fs.writeFileSync(path.join(bundled, 'broken.json'), '{not json');

    const banks = loadSpeechBanks(bundled, user);
    expect(banks.Linda.done.map((l) => l.text)).toEqual(['Fini !', 'Voilà.']);
    expect(banks.Linda.done[0].id).toBe(speechLineId('Fini !'));
    expect(banks.Linda.done[1].id).toBe('x1');
    expect(banks['Léa'].done).toEqual([
      {
        id: speechLineId('Terminé !'),
        text: 'Terminé !',
        audio: `${speechLineId('Terminé !')}.ogg`,
      },
    ]);
  });
});
