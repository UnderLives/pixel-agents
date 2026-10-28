import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { SpeechLine } from '../../core/src/messages.js';
import {
  bubbleDurationMs,
  pickLine,
  situationForTool,
  SpeechDirector,
} from '../src/persona/speechDirector.js';

const lines = (n: number): SpeechLine[] =>
  Array.from({ length: n }, (_, i) => ({ id: `l${i}`, text: `line ${i}` }));

test('tools map to situations; plain shell commands stay silent', () => {
  assert.equal(situationForTool('Read', 'Reading a.ts'), 'reading');
  assert.equal(situationForTool('Grep', 'Searching code'), 'reading');
  assert.equal(situationForTool('Edit', 'Editing a.ts'), 'editing');
  assert.equal(
    situationForTool('Bash', 'Running: sh Tools/editor_lock.sh build nora "dll"'),
    'building',
  );
  assert.equal(
    situationForTool('Bash', 'Running: sh Tools/run_game.sh nora package "x"'),
    'running_game',
  );
  assert.equal(situationForTool('Bash', 'Running: sh Tools/editor_lock.sh status'), 'waiting_lock');
  assert.equal(situationForTool('Bash', 'Running: ls -la'), null);
  assert.equal(situationForTool('TodoWrite', 'Using TodoWrite'), null);
});

test('pickLine never repeats a recent line while fresh ones remain', () => {
  const bank = lines(5);
  const recent = ['l0', 'l1', 'l2', 'l3'];
  for (let i = 0; i < 20; i++) assert.equal(pickLine(bank, recent, Math.random).id, 'l4');
});

test('pickLine falls back to the line said longest ago when all are recent', () => {
  const bank = lines(3);
  assert.equal(pickLine(bank, ['l2', 'l0', 'l1'], () => 0).id, 'l2');
});

test('a speaker cycles through 20 distinct lines before repeating', () => {
  const director = new SpeechDirector({ speakerGapMs: 0, officeGapMs: 0, random: Math.random });
  const bank = { done: lines(25) };
  const said: string[] = [];
  for (let i = 0; i < 21; i++) said.push(director.say('Linda', 'done', bank, i * 1000)!.id);
  assert.equal(new Set(said.slice(0, 21)).size, 21);
});

test('chatter waits for the speaker gap; milestones do not', () => {
  const director = new SpeechDirector({ speakerGapMs: 20_000, officeGapMs: 0, random: () => 0 });
  const bank = { reading: lines(5), done: lines(5) };
  assert.ok(director.say('Maya', 'reading', bank, 0));
  assert.equal(director.say('Maya', 'reading', bank, 5_000), null);
  assert.ok(director.say('Maya', 'done', bank, 6_000));
  assert.ok(director.say('Maya', 'reading', bank, 30_000));
});

test('no bank, no line', () => {
  const director = new SpeechDirector({ random: () => 0 });
  assert.equal(director.say('Nobody', 'done', undefined, 0), null);
  assert.equal(director.say('Nobody', 'done', { reading: lines(2) }, 0), null);
});

test('bubbles stay long enough to read, within bounds', () => {
  assert.equal(bubbleDurationMs('ok'), 3_000);
  assert.equal(bubbleDurationMs('x'.repeat(500)), 9_000);
});

test('a forced line skips the gaps and the odds', () => {
  const director = new SpeechDirector({
    speakerGapMs: 60_000,
    officeGapMs: 60_000,
    random: () => 0.99,
  });
  const bank = { reading: lines(3) };
  assert.equal(director.say('Aytaç', 'reading', bank, 0), null);
  assert.ok(director.say('Aytaç', 'reading', bank, 1, true));
  assert.ok(director.say('Aytaç', 'reading', bank, 2, true));
});
