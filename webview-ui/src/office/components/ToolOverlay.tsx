import { Fragment, useEffect, useRef, useState } from 'react';

import { parseAgentLabel, truncateLabel } from '../../../../core/src/persona.js';
import { Button } from '../../components/ui/Button.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
  NAME_TAG_BG,
  NAME_TAG_NAME_COLOR,
  NAME_TAG_NAME_MAX,
  NAME_TAG_ROLE_MAX,
  OVERLAY_BUBBLE_Z_INDEX,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  SPEECH_BUBBLE_MAX_WIDTH_PX,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import { getPersona } from '../../persona/personaState.js';
import { bubbleFor, pinnedBubbles } from '../../persona/speechRuntime.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import type { ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
}

/** Name shown for a lead session with no name of its own. */
const BOSS_NAME = 'Boss';
/** Marker in front of a lead's name, so the boss reads at a glance. */
const BOSS_MARKER = '\u2605';

interface NameTag {
  name: string;
  role: string | null;
  boss: boolean;
}

/**
 * Who a character is, for its name tag: a sub-agent by its spawn description
 * ("<Name> · <domain> · <item>" -> name + "domain · item"), a teammate by its team
 * name, and a lead session ("boss") by its name if it has one.
 */
function nameTagFor(
  ch: { isSubagent: boolean; agentName?: string; leadAgentId?: number; directoryName?: string },
  subLabel: string | undefined,
): NameTag {
  if (ch.isSubagent) {
    const parsed = parseAgentLabel(subLabel || 'Subtask');
    return { name: parsed.name, role: parsed.role, boss: false };
  }
  if (ch.leadAgentId !== undefined && ch.agentName) {
    const parsed = parseAgentLabel(ch.agentName);
    return { name: parsed.name, role: parsed.role, boss: false };
  }
  return { name: ch.agentName || BOSS_NAME, role: ch.directoryName ?? null, boss: true };
}

/** One line of a name tag / panel: "★ Name — role" cut to fit. */
function tagLine(tag: NameTag): string {
  const name = `${tag.boss ? `${BOSS_MARKER} ` : ''}${truncateLabel(tag.name, NAME_TAG_NAME_MAX)}`;
  return tag.role ? `${name} \u2014 ${truncateLabel(tag.role, NAME_TAG_ROLE_MAX)}` : name;
}

/** A small pixel speech bubble (persona lines). */
function SpeechBubble({ text }: { text: string }) {
  return (
    <div
      className="pixel-panel px-6 pt-2 pb-3 leading-tight text-center"
      style={{
        fontSize: '15px',
        maxWidth: SPEECH_BUBBLE_MAX_WIDTH_PX,
        width: 'max-content',
        whiteSpace: 'normal',
        marginBottom: 4,
      }}
      data-testid="speech-bubble"
    >
      {text}
    </div>
  );
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

function getFuelColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL_THRESHOLD) return CONTEXT_GAUGE_COLOR_CRITICAL;
  if (ratio >= CONTEXT_DANGER_THRESHOLD) return CONTEXT_GAUGE_COLOR_DANGER;
  if (ratio >= CONTEXT_WARN_THRESHOLD) return CONTEXT_GAUGE_COLOR_WARN;
  return CONTEXT_GAUGE_COLOR_OK;
}

/** A speech-bubble sprite blitted into a DOM canvas. Bubbles live in the DOM
 *  (not the office canvas) so they can stack ABOVE the status label panels —
 *  canvas content can never out-paint the DOM overlay. */
function OverlayBubble({ cached, dpr }: { cached: HTMLCanvasElement; dpr: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [cached]);
  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: cached.width / dpr, height: cached.height / dpr }}
    />
  );
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;
        const persona = getPersona();
        const subLabel = isSub ? subagentCharacters.find((s) => s.id === id)?.label : undefined;
        const tag = persona.showNameLabels ? nameTagFor(ch, subLabel) : null;
        const spoken = bubbleFor(id);

        // Speech bubble (permission dots / done checkmark) — rendered here in
        // the DOM, above the label panels (OVERLAY_BUBBLE_Z_INDEX over the label panels), for every
        // character regardless of label visibility. Mirrors the geometry the
        // canvas renderer used. The idle "Waiting for input" state speaks
        // through its label, not a bubble.
        let bubbleNode = null;
        if (ch.bubbleType && !(ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)) {
          const cachedBubble = getCachedSprite(
            ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
            zoom,
          );
          const bubbleSittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
          const alpha =
            ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
              ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
              : 1;
          bubbleNode = (
            <div
              className="absolute -translate-x-1/2 pointer-events-none"
              style={{
                left: project.toScreenX(ch.x),
                // Bubble bottom sits one sprite pixel above the character's
                // anchor: project the anchor, then lift by the bubble's own
                // device-pixel height plus one zoomed pixel, in CSS px.
                top:
                  project.toScreenY(ch.y + bubbleSittingOff - BUBBLE_VERTICAL_OFFSET_PX) -
                  (cachedBubble.height + zoom) / dpr,
                opacity: alpha,
                zIndex: OVERLAY_BUBBLE_Z_INDEX,
              }}
            >
              <OverlayBubble cached={cachedBubble} dpr={dpr} />
            </div>
          );
        }

        // Only show the label for hovered or selected agents (unless
        // always-show is on) — the bubble renders regardless.
        // Name tag (and whatever she is saying) above the head: the persona's
        // always-on label, shown whenever the activity panel is not.
        const headX = project.toScreenX(ch.x);
        const headY = project.toScreenY(
          ch.y +
            (ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0) -
            TOOL_OVERLAY_VERTICAL_OFFSET,
        );
        const tagNode =
          tag || spoken ? (
            <div
              className="absolute flex flex-col items-center pointer-events-none"
              style={{
                left: headX,
                top: headY + 14,
                transform: 'translate(-50%, -100%)',
                zIndex: OVERLAY_LABEL_Z_INDEX,
              }}
              data-testid="name-tag"
              data-agent-id={id}
            >
              {spoken && <SpeechBubble text={spoken} />}
              {tag && (
                <div
                  className="flex flex-col items-center px-4 pb-1 whitespace-nowrap"
                  style={{ background: NAME_TAG_BG }}
                >
                  <span
                    className="leading-none"
                    style={{
                      fontSize: '15px',
                      fontWeight: 'bold',
                      color: tag.boss ? TEAM_LEAD_COLOR : NAME_TAG_NAME_COLOR,
                    }}
                  >
                    {tag.boss ? `${BOSS_MARKER} ` : ''}
                    {truncateLabel(tag.name, tag.role ? NAME_TAG_NAME_MAX : NAME_TAG_ROLE_MAX)}
                  </span>
                  {tag.role && (
                    <span
                      className="leading-none"
                      style={{ fontSize: '12px', color: TEAM_ROLE_COLOR }}
                    >
                      {truncateLabel(tag.role, NAME_TAG_ROLE_MAX)}
                    </span>
                  )}
                </div>
              )}
            </div>
          ) : null;

        if (!alwaysShowOverlay && !isSelected && !isHovered) {
          if (!bubbleNode && !tagNode) return null;
          return (
            <Fragment key={id}>
              {bubbleNode}
              {tagNode}
            </Fragment>
          );
        }

        // Position above character
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);

        // A "Done" agent (finished turn: waiting bubble without awaitingInput)
        // shows ONLY its floating green checkmark bubble, never the label panel
        // (the panel would cover the bubble). Render an empty positioned marker
        // so overlay counts stay stable and hover/select can still bring the
        // panel back. When always-show is off, the early return above already
        // keeps the panel hidden for idle agents.
        const isDone = ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput;
        if (isDone && !isSelected && !isHovered) {
          return (
            <Fragment key={id}>
              {bubbleNode}
              {tagNode}
              <div
                className="absolute"
                style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
                data-testid="agent-overlay"
                data-agent-id={id}
              />
            </Fragment>
          );
        }

        // Get activity text
        const hasWaitingBubble = ch.bubbleType === 'waiting';
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        let activityText: string;
        if (hasWaitingBubble && ch.waitingAwaitingInput) {
          // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
          // shows only the checkmark and falls through to the normal idle text.
          activityText = WAITING_INPUT_ACTIVITY_TEXT;
        } else if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval';
          } else {
            // Hover shows the subtask title; SELECTING the sub reveals its live
            // tool activity (watched sub-agents stream it via subagentToolStart).
            const sub = subagentCharacters.find((s) => s.id === id);
            const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
            const activeRow =
              isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
            activityText = activeRow?.status ?? (sub?.label || 'Subtask');
          }
        } else {
          activityText = getActivityText(
            id,
            agentTools,
            ch.isActive,
            ch.bubbleType,
            ch.waitingAwaitingInput ?? false,
          );
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;
        const hasWaiting = ch.bubbleType === 'waiting';

        let dotColor: string | null = null;
        if (hasPermission || hasWaiting) {
          dotColor = 'var(--color-status-permission)';
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--color-status-active)';
        }

        // Team info
        // With name tags on, the panel's first line is the persona name tag.
        const teamRoleLabel = tag ? tagLine(tag) : ch.isTeamLead ? 'LEAD' : ch.agentName || null;
        const roleIsLead = tag ? tag.boss : !!ch.isTeamLead;
        const hasExtraLines = !!(ch.directoryName || teamRoleLabel);

        // Context gauge. Every agent gets one — lead, teammate, adopted,
        // headless — as soon as it has taken a turn. Sub-agents never do: they
        // have no session of their own, so contextTokens stays 0.
        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        const showContextGauge = !isSub && ch.contextTokens > 0;

        return (
          <Fragment key={id}>
            {bubbleNode}
            {spoken && (
              <div
                className="absolute pointer-events-none"
                style={{
                  left: screenX,
                  top: screenY - (hasExtraLines ? 34 : 28),
                  transform: 'translate(-50%, -100%)',
                  zIndex: OVERLAY_LABEL_SELECTED_Z_INDEX,
                }}
              >
                <SpeechBubble text={spoken} />
              </div>
            )}
            <div
              className="absolute flex flex-col items-center -translate-x-1/2"
              style={{
                left: screenX,
                top: screenY - (hasExtraLines ? 34 : 28),
                pointerEvents: isSelected ? 'auto' : 'none',
                opacity: alwaysShowOverlay && !isSelected && !isHovered ? (isSub ? 0.5 : 0.75) : 1,
                zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
              }}
              data-testid="agent-overlay"
              data-agent-id={id}
            >
              <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
                {dotColor && (
                  <span
                    className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                    style={{ background: dotColor }}
                  />
                )}
                <div className="flex flex-col gap-0 overflow-hidden">
                  {teamRoleLabel && (
                    <span
                      className="overflow-hidden text-ellipsis block leading-none"
                      style={{
                        fontSize: '18px',
                        color: roleIsLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                        fontWeight: roleIsLead || tag ? 'bold' : undefined,
                      }}
                    >
                      {teamRoleLabel}
                    </span>
                  )}
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: isSub ? '20px' : '22px',
                      fontStyle: isSub ? 'italic' : undefined,
                    }}
                  >
                    {activityText}
                  </span>
                  {ch.directoryName && (
                    <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                      {ch.directoryName}
                    </span>
                  )}
                </div>
                {isSelected && !isSub && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseAgent(id);
                    }}
                    title="Close agent"
                    className="ml-2 shrink-0 leading-none"
                  >
                    ×
                  </Button>
                )}
              </div>
              {showContextGauge && (
                <div
                  style={{
                    width: CONTEXT_GAUGE_WIDTH_PX,
                    height: CONTEXT_GAUGE_HEIGHT_PX,
                    background: CONTEXT_GAUGE_BG,
                    marginTop: 2,
                  }}
                  title={`${Math.round(contextRatio * 100)}% context used (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens)`}
                  data-testid="context-gauge"
                  data-context-pct={Math.round(contextRatio * 100)}
                >
                  <div
                    style={{
                      width: `${Math.min(contextRatio * 100, 100)}%`,
                      height: '100%',
                      background: getFuelColor(contextRatio),
                    }}
                  />
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
      {pinnedBubbles().map((b) => (
        <div
          key={`pinned-${b.id}`}
          className="absolute pointer-events-none"
          style={{
            left: project.toScreenX(b.x),
            top: project.toScreenY(b.y - TOOL_OVERLAY_VERTICAL_OFFSET),
            transform: 'translate(-50%, -100%)',
            zIndex: OVERLAY_LABEL_Z_INDEX,
          }}
        >
          <SpeechBubble text={b.text} />
        </div>
      ))}
    </>
  );
}
