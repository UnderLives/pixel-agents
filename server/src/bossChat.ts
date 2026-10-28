/**
 * Boss chat (standalone only): the owner types to the lead session from the office page,
 * the session answers through a file. No Claude-specific code: two JSONL files and a feed.
 *
 *   POST /boss/say {text}   -> appends {ts, from: "owner", text} to <dir>/inbox.jsonl and
 *                              pushes "owner: <text>" to every /boss/feed socket
 *   <dir>/outbox.jsonl      <- the session appends {ts, from: "aytac", text}; each new line
 *                              is pushed as "aytac: <text>"
 *   GET /boss/history?n=50  -> the last n lines of both files, merged by ts
 *   GET /boss/feed          -> WebSocket, one text frame per message ("<from>: <text>")
 *
 * No token (the office is served on a private tailnet), but every route is refused unless
 * the Host is one the server is privileged under (the bind address, --allowed-host names),
 * like /ws: a DNS-rebound page cannot write to the boss.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

import { isAllowedWebSocketOrigin, normalizeHostname } from './wsAuth.js';

export interface BossChatOptions {
  /** Folder of inbox.jsonl / outbox.jsonl (created if missing). */
  dir: string;
  allowedHostnames: ReadonlySet<string>;
}

export interface BossChatLine {
  ts: number;
  from: string;
  text: string;
}

const MAX_TEXT = 4000;
const MAX_HISTORY = 500;
const OUTBOX_POLL_MS = 700;
const FEED_OPEN = 1;

function hostAllowed(request: FastifyRequest, allowed: ReadonlySet<string>): boolean {
  const name = normalizeHostname(request.headers.host);
  return name !== null && allowed.has(name);
}

function readLines(file: string): BossChatLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: BossChatLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Partial<BossChatLine>;
      if (typeof v.text === 'string' && typeof v.from === 'string') {
        out.push({ ts: typeof v.ts === 'number' ? v.ts : 0, from: v.from, text: v.text });
      }
    } catch {
      /* a half-written line: skipped, picked up whole next time */
    }
  }
  return out;
}

/** Last `n` lines of both files, oldest first. */
export function bossHistory(dir: string, n: number): BossChatLine[] {
  const all = [
    ...readLines(path.join(dir, 'inbox.jsonl')),
    ...readLines(path.join(dir, 'outbox.jsonl')),
  ];
  all.sort((a, b) => a.ts - b.ts);
  return all.slice(-Math.max(1, Math.min(MAX_HISTORY, n)));
}

export function feedFrame(line: Pick<BossChatLine, 'from' | 'text'>): string {
  return `${line.from}: ${line.text}`;
}

export function registerBossChatRoutes(app: FastifyInstance, options: BossChatOptions): () => void {
  const { dir, allowedHostnames } = options;
  fs.mkdirSync(dir, { recursive: true });
  const inbox = path.join(dir, 'inbox.jsonl');
  const outbox = path.join(dir, 'outbox.jsonl');
  const sockets = new Set<{ readyState: number; send: (data: string) => void }>();

  const push = (line: BossChatLine) => {
    const frame = feedFrame(line);
    for (const s of sockets) {
      if (s.readyState === FEED_OPEN) s.send(frame);
    }
  };

  const refuse = (reply: FastifyReply) => reply.code(403).send({ error: 'host not allowed' });

  app.post('/boss/say', async (request, reply) => {
    if (!hostAllowed(request, allowedHostnames)) return refuse(reply);
    const body = request.body as { text?: unknown } | undefined;
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : '';
    if (!text) return reply.code(400).send({ error: 'text required' });
    const line: BossChatLine = { ts: Date.now(), from: 'owner', text };
    fs.appendFileSync(inbox, JSON.stringify(line) + '\n', 'utf8');
    push(line);
    return { ok: true, ts: line.ts };
  });

  app.get('/boss/history', async (request, reply) => {
    if (!hostAllowed(request, allowedHostnames)) return refuse(reply);
    const n = Number((request.query as { n?: string }).n ?? 50);
    return bossHistory(dir, Number.isFinite(n) ? n : 50);
  });

  app.get('/boss/feed', { websocket: true }, (socket, request) => {
    if (
      !hostAllowed(request, allowedHostnames) ||
      !isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)
    ) {
      socket.close(1008, 'host not allowed');
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // Outbox: follow appended lines (polling: fs.watch is unreliable for appends on Windows).
  let offset = (() => {
    try {
      return fs.statSync(outbox).size;
    } catch {
      return 0;
    }
  })();
  let partial = '';
  const timer = setInterval(() => {
    let size: number;
    try {
      size = fs.statSync(outbox).size;
    } catch {
      return;
    }
    if (size < offset) {
      offset = 0; // truncated or replaced
      partial = '';
    }
    if (size === offset) return;
    const fd = fs.openSync(outbox, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const lines = (partial + buf.toString('utf8')).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          const v = JSON.parse(raw) as Partial<BossChatLine>;
          if (typeof v.text === 'string') {
            push({
              ts: typeof v.ts === 'number' ? v.ts : Date.now(),
              from: typeof v.from === 'string' ? v.from : 'aytac',
              text: v.text,
            });
          }
        } catch {
          /* not JSON: ignored */
        }
      }
      // A last line written without its newline: take it once it parses whole.
      if (partial.trim()) {
        try {
          const v = JSON.parse(partial) as Partial<BossChatLine>;
          if (typeof v.text === 'string') {
            push({
              ts: typeof v.ts === 'number' ? v.ts : Date.now(),
              from: typeof v.from === 'string' ? v.from : 'aytac',
              text: v.text,
            });
            partial = '';
          }
        } catch {
          /* still being written */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }, OUTBOX_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
