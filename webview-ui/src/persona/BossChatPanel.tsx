/**
 * Chat with the boss, under the office (standalone only, pixel-agents.bossChat).
 * The owner's lines go to POST /boss/say; every message of both sides arrives on the
 * /boss/feed WebSocket as "<from>: <text>" (server/src/bossChat.ts). An answer from the
 * boss also shows as his speech bubble; a message from the owner sends him back to his
 * desk to read it. Mobile first: a collapsed pill, then a short history and one input.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { OfficeState } from '../office/engine/officeState.js';
import { isBrowserRuntime } from '../runtime.js';
import { onBossReply, onOwnerMessage } from './bossRuntime.js';
import { getPersona, onPersonaChange } from './personaState.js';

interface ChatLine {
  ts: number;
  from: string;
  text: string;
}

const HISTORY = 50;
const RECONNECT_MAX_MS = 15_000;
const OPEN_KEY = 'underlivers.bossChat.open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function parseFrame(frame: string): ChatLine | null {
  const i = frame.indexOf(': ');
  if (i <= 0) return null;
  return { ts: Date.now(), from: frame.slice(0, i), text: frame.slice(i + 2) };
}

export function BossChatPanel({
  getOfficeState,
  isMobile,
}: {
  getOfficeState: () => OfficeState;
  isMobile: boolean;
}) {
  const persona = useSyncExternalStore(onPersonaChange, getPersona);
  const enabled = isBrowserRuntime && persona.received && persona.bossChat;
  const [open, setOpen] = useState(readOpen);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [online, setOnline] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // History once, then the live feed (reconnecting with backoff).
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retry = 1_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    fetch(`/boss/history?n=${HISTORY}`)
      .then((r) => (r.ok ? (r.json() as Promise<ChatLine[]>) : []))
      .then((h) => !disposed && setLines(h))
      .catch(() => {});
    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${window.location.host}/boss/feed`);
      socket.onopen = () => {
        retry = 1_000;
        setOnline(true);
      };
      socket.onmessage = (e) => {
        const line = typeof e.data === 'string' ? parseFrame(e.data) : null;
        if (!line) return;
        setLines((prev) => [...prev, line].slice(-HISTORY));
        const os = getOfficeState();
        if (line.from === 'owner') onOwnerMessage(os);
        else onBossReply(os, line.text);
      };
      socket.onclose = () => {
        setOnline(false);
        if (disposed) return;
        timer = setTimeout(connect, retry);
        retry = Math.min(RECONNECT_MAX_MS, retry * 2);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [enabled, getOfficeState]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [lines, open]);

  const toggle = useCallback(() => {
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? '0' : '1');
      } catch {
        /* per-viewer convenience only */
      }
      return !v;
    });
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    // The feed echoes it back: no local copy, so every device shows the same history.
    fetch('/boss/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => setDraft(text));
  }, [draft]);

  if (!enabled) return null;
  const boss = persona.bossName;

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 z-30 flex flex-col items-center"
      style={{ bottom: isMobile ? 8 : 64, width: 'min(560px, calc(100% - 16px))' }}
      data-testid="boss-chat"
    >
      {open ? (
        <div className="pixel-panel w-full flex flex-col" style={{ maxHeight: '45vh' }}>
          <div className="flex items-center justify-between px-8 py-4 border-b-2 border-border">
            <span className="text-xl">
              ★ {boss}{' '}
              <span className="text-sm text-text-muted">{online ? '' : '(hors ligne)'}</span>
            </span>
            <button className="text-xl px-6 cursor-pointer" onClick={toggle} aria-label="Fermer">
              ×
            </button>
          </div>
          <div ref={listRef} className="overflow-y-auto px-8 py-4 flex flex-col gap-4 text-base">
            {lines.length === 0 && <div className="text-text-muted">Écris à {boss}…</div>}
            {lines.map((l, i) => (
              <div
                key={`${l.ts}-${i}`}
                className={l.from === 'owner' ? 'self-end text-right' : 'self-start'}
                style={{ maxWidth: '85%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                <span className="text-text-muted text-sm">
                  {l.from === 'owner' ? 'Toi' : boss}{' '}
                </span>
                {l.text}
              </div>
            ))}
          </div>
          <form
            className="flex gap-4 p-6 border-t-2 border-border"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              className="flex-1 min-w-0 bg-bg-dark border-2 border-border px-6 py-2 text-base text-text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`Message à ${boss}`}
              enterKeyHint="send"
            />
            <button type="submit" className="pixel-panel px-10 text-base cursor-pointer">
              Envoyer
            </button>
          </form>
        </div>
      ) : (
        <button
          className="pixel-panel px-10 py-2 text-lg cursor-pointer"
          onClick={toggle}
          data-testid="boss-chat-open"
        >
          ★ {boss}
        </button>
      )}
    </div>
  );
}
