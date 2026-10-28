/**
 * Server-side palette assignment helper.
 *
 * Assigns palette and hueShift to agents when they're created, ensuring
 * consistent character appearance across all connected clients.
 */

import { pickDiversePalette } from '../../core/src/paletteUtils.js';
import { allowedPalettes, type CharacterSet, paletteForName } from '../../core/src/persona.js';
import type { AgentStateStore } from './agentStateStore.js';
import { PALETTE_COUNT } from './constants.js';
import type { AgentState } from './types.js';

/**
 * Runtime palette count. External asset directories can add char_N.png
 * beyond the bundled 6 (loadExternalCharacterSprites accepts any N), so the
 * count is dynamic. Defaults to PALETTE_COUNT until setPaletteCount is
 * called after assets load. Mirrors the setHookProvider / setTeamSwitch
 * module-level setter pattern in transcriptParser.ts.
 */
let currentPaletteCount = PALETTE_COUNT;

/** Set the palette count after asset loading (standalone + VS Code). */
export function setPaletteCount(count: number): void {
  currentPaletteCount = Math.max(1, Math.floor(count));
}

/**
 * Which sprites new agents may wear (`characterSet`) and the fixed sprite of a named
 * agent (`characterByName`). Set by the host from its settings; 'all' and no names
 * reproduce upstream's behaviour.
 */
export interface CharacterPolicy {
  characterSet: CharacterSet;
  characterByName: Record<string, number>;
  /** char_N every lead session wears, outside the set (-1 / absent = none). */
  bossCharacter?: number;
}
let currentPolicy: CharacterPolicy = { characterSet: 'all', characterByName: {} };

export function setCharacterPolicy(policy: CharacterPolicy): void {
  currentPolicy = policy;
}

export function getCharacterPolicy(): CharacterPolicy {
  return currentPolicy;
}

/**
 * Assign palette and hueShift to an agent if not already set.
 * Uses the diversity algorithm to pick a palette that's least used among
 * existing agents.
 *
 * @param agent - The agent to assign a palette to (mutated in place)
 * @param store - The agent state store (used to count existing palettes)
 */
export function assignPaletteIfNeeded(agent: AgentState, store: AgentStateStore): void {
  const count = currentPaletteCount;
  // A lead session (no name, no lead of its own) is the boss: one fixed sprite,
  // even over a palette persisted before the policy existed.
  const boss = currentPolicy.bossCharacter;
  if (
    boss !== undefined &&
    boss >= 0 &&
    boss < count &&
    !agent.agentName &&
    agent.leadAgentId === undefined
  ) {
    agent.palette = boss;
    agent.hueShift = 0;
    return;
  }
  if (agent.palette !== undefined) return;

  const allowed = allowedPalettes(count, currentPolicy.characterSet);
  // A named agent (teammate) always wears the same sprite, session after session.
  if (agent.agentName) {
    agent.palette = paletteForName(agent.agentName, allowed, currentPolicy.characterByName);
    agent.hueShift = 0;
    return;
  }

  // Diversity over the allowed palettes only. Sprites reserved for named agents
  // count as used once, so an unnamed agent (the lead) gets a face of its own first.
  const counts = allowed.map(() => 0);
  const reserved = new Set(Object.values(currentPolicy.characterByName));
  allowed.forEach((p, i) => {
    if (reserved.has(p)) counts[i]++;
  });
  for (const existing of store.values()) {
    const i = existing.palette === undefined ? -1 : allowed.indexOf(existing.palette);
    if (i >= 0) counts[i]++;
  }

  const pick = pickDiversePalette(allowed.length, counts);
  agent.palette = allowed[pick.palette];
  agent.hueShift = pick.hueShift;
}
