/**
 * Masking: the vendored module is byte-identical to Lane P's, and no card digits reach the
 * index file, search results, the model request, tool results or the audit log.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {A, TEST_PAN, TEST_PAN_DIGITS, setup, fakeModel} from './fixtures.ts';
import {CARD_MASK_SHA256, maskText, maskTurns} from '../src/mask.ts';
import {parseNote} from '../src/notes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vendored = join(here, '..', 'vendor', 'card-mask.mjs');
const LANE_P = '/Users/atlasai/.openclaw/workspace/services/fireflies-bridge/card-mask.mjs';
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const hasCard = (s: string) => s.includes(TEST_PAN) || s.replace(/\D/g, '').includes(TEST_PAN_DIGITS);

test('vendored card-mask.mjs is pinned and equal to the Lane P module when present', () => {
  assert.equal(sha(vendored), CARD_MASK_SHA256);
  if (existsSync(LANE_P)) assert.equal(sha(LANE_P), CARD_MASK_SHA256, 'Lane P module changed: re-vendor and re-review');
});

test('turn sequences and free text are masked; counts only', () => {
  const c = {spans: 0};
  const out = maskTurns(['Read me the card number please.', `${TEST_PAN}.`, 'And the expiry?', '12/29.', 'Security code on the back?', '123.'], c);
  assert.ok(!hasCard(out.join(' ')));
  assert.ok(c.spans >= 1);
  assert.ok(!hasCard(maskText(`Luhn run ${TEST_PAN} in a summary`)));
});

test('parsed notes are masked in turns, title and summary (mask before clipping)', () => {
  const raw = `---\nfireflies_id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ"\ntitle: "Card ${TEST_PAN}"\ndate: 2026-10-01\n---\n## Overview\n\n${'x '.repeat(190)}${TEST_PAN}\n\n## Transcript\n\n**A:** card number?\n\n**B:** ${TEST_PAN}\n`;
  const n = parseNote('/tmp/x.md', raw);
  assert.ok(!hasCard(JSON.stringify(n)));
});

test('no card digits in the index file, search results, model request, answers or audit', async () => {
  const model = fakeModel(() => ({supported: true, answer: 'The renewal was paid by card.', quotes: [{turn: 3, text: 'read me the card number for the renewal'}]}));
  const s = setup({}, undefined, model);
  const search = await s.server.callTool('rhys', 'search_calls', {query: 'card number renewal expiry'}, 'test');
  assert.ok(!hasCard(JSON.stringify(search.structured)));
  assert.ok((search.structured.calls as {callId: string}[]).some(c => c.callId === A));
  const ask = await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'How was the renewal paid?'}, 'test');
  assert.equal(ask.isError, false);
  assert.equal(model.bodies.length, 1);
  assert.ok(!hasCard(model.bodies[0]), 'model request must be masked');
  assert.ok(model.bodies[0].includes('[REDACTED-CARD]'));
  assert.ok(!hasCard(JSON.stringify(ask.structured)));
  const task = await s.server.callTool('rhys', 'get_task', {id: 'task-a'}, 'test');
  assert.ok(!hasCard(JSON.stringify(task.structured)));
  const db = readFileSync(join(s.config.stateDir, 'calls-index.sqlite'));
  assert.ok(!db.includes(Buffer.from(TEST_PAN)) && !db.includes(Buffer.from(TEST_PAN_DIGITS)), 'index file must not contain card digits');
  const audit = readFileSync(join(s.config.stateDir, 'audit.jsonl'), 'utf8');
  assert.ok(!hasCard(audit));
  for (const phrase of ['renewal', 'pricing', 'card number', 'How was']) assert.ok(!audit.includes(phrase), 'audit holds no transcript or question text');
  const rows = audit.trim().split('\n').map(l => JSON.parse(l));
  assert.ok(rows.every(r => /^[0-9a-f]{64}$/.test(r.argsSha256) && typeof r.maskSpans === 'number'));
  assert.ok(rows.find(r => r.tool === 'ask_call').maskSpans >= 1);
});
