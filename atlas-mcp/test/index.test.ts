/**
 * Call index: incremental refresh, both note layouts, and filters that narrow before ranking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CallIndex} from '../src/call-index.ts';
import {makeBrain, A, B} from './fixtures.ts';

const note = (i: number, title: string, line: string) => `---\nfireflies_id: "01N${String(i).padStart(23, '0')}"\ntitle: "${title}"\ndate: 2026-0${1 + (i % 9)}-1${i % 10}\nattendees: ["p${i}@x.test"]\n---\n## Transcript\n\n**Rhys:** ${line}\n`;

test('client filter narrows before ranking (a low-ranked client call is still found)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-idx-'));
  for (let i = 0; i < 300; i++) writeFileSync(join(dir, `n${i}.md`), note(i, `Client ${i} x Rhys`, 'pricing pricing pricing pricing and more pricing'));
  writeFileSync(join(dir, 'jess.md'), note(999, 'Jess Example x Rhys', 'we talked briefly about pricing once'));
  const idx = new CallIndex(join(dir, 'i.sqlite'), dir);
  idx.refresh();
  const hits = idx.search({query: 'pricing', client: 'Jess', limit: 5, allowed: 'all'});
  assert.deepEqual(hits.map(h => h.title), ['Jess Example x Rhys']);
  const scoped = idx.search({query: 'pricing', client: 'Jess', limit: 5, allowed: new Set(['01N00000000000000000000001'])});
  assert.equal(scoped.length, 0, 'client filter never widens the allowed set');
  const mapped = idx.search({query: 'pricing', client: 'acme', limit: 5, allowed: 'all', clientCallIds: new Set(['01N00000000000000000000007'])});
  assert.deepEqual(mapped.map(h => h.callId), ['01N00000000000000000000007'], 'hosted client mapping counts as a client match');
});

test('incremental refresh: unchanged files skipped, changed re-indexed, deleted removed; old layout parsed', () => {
  const dir = makeBrain();
  const idx = new CallIndex(join(dir, '.i.sqlite'), dir);
  assert.equal(idx.refresh().changed, 3);
  assert.equal(idx.refresh().changed, 0);
  const f = join(dir, '2026-10-05-Zenith-x-Rhys.md');
  writeFileSync(f, '---\nfireflies_id: "01BBBBBBBBBBBBBBBBBBBBBBBB"\ntitle: "Zenith"\n---\n## Transcript\n\n**Zed:** brand new words quokka\n');
  utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.equal(idx.refresh().changed, 1);
  assert.equal(idx.search({query: 'quokka', limit: 5, allowed: 'all'})[0].callId, B);
  rmSync(join(dir, '2026-10-01-Acme-x-Rhys.md'));
  assert.equal(idx.refresh().removed, 1);
  assert.equal(idx.fileFor(A), null);
  const old = idx.search({query: 'pricing page', limit: 5, allowed: 'all'});
  assert.equal(old[0].title, 'Team Huddle');
  assert.equal(old[0].date, '2025-03-06');
  assert.deepEqual(old[0].attendees, ['rhys@example.test', 'pat@example.test']);
  assert.ok(old[0].callId.startsWith('note-'));
  assert.equal(old[0].quotes[0].speaker, 'Pat');
});
