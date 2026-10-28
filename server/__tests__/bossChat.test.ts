import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { bossHistory, feedFrame } from '../src/bossChat.js';

describe('boss chat', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('merges inbox and outbox by time, skips broken lines, keeps the last n', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-boss-'));
    fs.writeFileSync(
      path.join(dir, 'inbox.jsonl'),
      '{"ts":1,"from":"owner","text":"salut"}\n{"ts":3,"from":"owner","text":"et Linda ?"}\nnot json\n',
    );
    fs.writeFileSync(path.join(dir, 'outbox.jsonl'), '{"ts":2,"from":"aytac","text":"ça roule"}\n');
    expect(bossHistory(dir, 50).map((l) => l.text)).toEqual(['salut', 'ça roule', 'et Linda ?']);
    expect(bossHistory(dir, 2).map((l) => l.ts)).toEqual([2, 3]);
    expect(feedFrame({ from: 'aytac', text: 'ok' })).toBe('aytac: ok');
  });
});
