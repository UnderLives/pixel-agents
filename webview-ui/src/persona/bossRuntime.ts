/**
 * The boss's rounds: a lead session works in its own office and, while active,
 * walks over to one of its named employees (sub-agents) from time to time: when
 * it hands her a task, when it messages her, or at least every
 * `bossVisitMinutes`. It says a short line at her desk ("Ça avance, Linda ?"),
 * she answers, and it walks back. Purely presentational: driven by the same
 * messages that animate the office.
 */

import type { OfficeState } from '../office/engine/officeState.js';
import { foldName, getPersona } from './personaState.js';
import { speak, speakerOf } from './speechRuntime.js';

/** Seconds the boss stands at a desk. */
const VISIT_STAY_MIN_SEC = 4;
const VISIT_STAY_RANGE_SEC = 3;
/** Delay before the employee answers the boss. */
const REPLY_DELAY_MS = 1_600;
/** A new employee gets her first visit once she has reached her desk. */
const NEW_EMPLOYEE_VISIT_DELAY_MS = 6_000;
/** Never two visits closer than this, whatever triggers them. */
const MIN_VISIT_GAP_MS = 45_000;

const lastVisitAt = new Map<number, number>();

/** A lead session: not a sub-agent, not a teammate. */
export function isBoss(os: OfficeState, id: number): boolean {
  const ch = os.characters.get(id);
  return !!ch && !ch.isSubagent && ch.leadAgentId === undefined && !ch.isGreeter;
}

/** The boss's named employees present in the office (sub-agents with a speaker). */
function employeesOf(os: OfficeState, bossId: number): number[] {
  const out: number[] = [];
  for (const [subId, meta] of os.subagentMeta) {
    const ch = os.characters.get(subId);
    if (meta.parentAgentId === bossId && ch && !ch.matrixEffect && speakerOf(subId))
      out.push(subId);
  }
  return out;
}

/** Send the boss to an employee (respecting the gap unless `urgent`). */
export function visit(
  os: OfficeState,
  bossId: number,
  employeeId: number,
  urgent = false,
): boolean {
  const now = Date.now();
  if (!urgent && now - (lastVisitAt.get(bossId) ?? -Infinity) < MIN_VISIT_GAP_MS) return false;
  const stay = VISIT_STAY_MIN_SEC + Math.random() * VISIT_STAY_RANGE_SEC;
  if (!os.startVisit(bossId, employeeId, stay)) return false;
  lastVisitAt.set(bossId, now);
  return true;
}

/** Wire the arrival line + the employee's answer. Call once per OfficeState. */
export function attachBossRounds(os: OfficeState): void {
  os.onVisitArrive = (bossId, employeeId) => {
    const name = speakerOf(employeeId);
    if (!name) return;
    speak(bossId, 'visit', { vars: { name }, force: true });
    setTimeout(() => {
      if (os.characters.has(employeeId)) {
        speak(employeeId, 'motivation', { force: true, vars: { name: getPersona().bossName } });
      }
    }, REPLY_DELAY_MS);
  };
}

/** A named employee was just created: the boss hands over the task in person. */
export function onEmployeeHired(os: OfficeState, bossId: number, employeeId: number): void {
  if (!isBoss(os, bossId)) return;
  speak(bossId, 'start_item', { vars: { name: speakerOf(employeeId) ?? '' } });
  setTimeout(() => visit(os, bossId, employeeId), NEW_EMPLOYEE_VISIT_DELAY_MS);
}

/** The boss messaged someone ("-> Linda"): go and see her if she is here. */
export function onBossMessage(os: OfficeState, bossId: number, recipient: string): void {
  if (!isBoss(os, bossId)) return;
  const staff = employeesOf(os, bossId);
  const wanted = foldName(recipient);
  const match = staff.find((id) => foldName(speakerOf(id) ?? '') === wanted);
  const pick = match ?? staff[Math.floor(Math.random() * staff.length)];
  if (pick !== undefined) visit(os, bossId, pick, match !== undefined);
}

/** An employee finished (her report is in): the boss congratulates her from his desk. */
export function onEmployeeDone(os: OfficeState, bossId: number, employeeName: string): void {
  if (!isBoss(os, bossId)) return;
  speak(bossId, 'praise', { vars: { name: employeeName }, force: true });
}

/** Periodic: an active boss who has not been round for a while visits someone. */
export function tickBossRounds(os: OfficeState, now = Date.now()): void {
  const minutes = getPersona().bossVisitMinutes;
  if (!minutes) return;
  for (const ch of os.characters.values()) {
    if (!isBoss(os, ch.id) || !ch.isActive || ch.visit) continue;
    if (now - (lastVisitAt.get(ch.id) ?? 0) < minutes * 60_000) continue;
    const staff = employeesOf(os, ch.id);
    if (staff.length === 0) continue;
    visit(os, ch.id, staff[Math.floor(Math.random() * staff.length)]);
  }
}
