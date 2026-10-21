/**
 * Lane G3: R14b's index-purge reproduction (laneR14-review/index-purge-R14b.mjs) as a
 * regression test. An old-policy index holding an unmasked stale term and the public test
 * card value must, after upgrade + refresh + close + reopen, leave NO raw bytes of either in
 * the active database file or any surviving sidecar/temp file, and no query access.
 * Covers both predecessor shapes: a mismatched policy marker, and no meta table at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, writeFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {setup, TEST_PAN_DIGITS} from './fixtures.ts';
import {CallIndex, INDEX_POLICY, PURGE_GENERATION} from '../src/call-index.ts';

const STALE = 'r14buniquestaleunmaskedterm';

function indexFiles(dir: string) {
  return readdirSync(dir).filter(n => n.startsWith('calls-index.sqlite')).map(n => join(dir, n));
}
function rawHits(dir: string) {
  const hits: string[] = [];
  for (const f of indexFiles(dir)) {
    const b = readFileSync(f);
    if (b.includes(Buffer.from(STALE))) hits.push(`${f.split('/').pop()}:stale`);
    if (b.includes(Buffer.from(TEST_PAN_DIGITS))) hits.push(`${f.split('/').pop()}:card`);
  }
  return hits;
}

for (const shape of ['mismatched-marker', 'no-meta'] as const) {
  test(`R14b index purge (${shape}): no stale term or card value survives in the file bytes`, () => {
    const s = setup();
    const dir = s.config.stateDir;
    const file = join(dir, 'calls-index.sqlite');
    // Emulate an old masking policy's unmasked attendee field, in content and FTS storage.
    s.index.db.prepare('update files set attendees = ?').run(JSON.stringify([STALE, TEST_PAN_DIGITS]));
    s.index.db.prepare('update fts set attendees = ?').run(`${STALE} ${TEST_PAN_DIGITS}`);
    if (shape === 'no-meta') s.index.db.exec('drop table meta');
    else s.index.db.prepare("update meta set value = 'old-policy' where key = 'policy'").run();
    s.index.db.close();
    assert.ok(rawHits(dir).length > 0, 'precondition: the seeded values are in the old file');
    // Stale sidecars and an interrupted-upgrade temp file holding the same values.
    writeFileSync(`${file}-wal`, `${STALE} ${TEST_PAN_DIGITS}`, {mode: 0o600});
    writeFileSync(`${file}-shm`, `${STALE} ${TEST_PAN_DIGITS}`, {mode: 0o600});
    writeFileSync(`${file}.rebuild-99999-deadbeef0000`, `${STALE} ${TEST_PAN_DIGITS}`, {mode: 0o600});

    const upgraded = new CallIndex(file, s.brain);
    assert.equal(upgraded.rebuilt, true);
    assert.equal(upgraded.count(), 0);
    assert.deepEqual(rawHits(dir), [], 'no stale bytes right after the upgrade');
    assert.equal(upgraded.refresh().changed, 3);
    assert.equal(upgraded.search({query: STALE, limit: 5, allowed: 'all'}).length, 0);
    upgraded.db.close();

    const reopened = new CallIndex(file, s.brain);
    assert.equal(reopened.rebuilt, false, 'a current-policy file is reused, not rebuilt again');
    assert.equal(reopened.count(), 3);
    assert.equal(reopened.search({query: STALE, limit: 5, allowed: 'all'}).length, 0);
    assert.equal(reopened.search({query: TEST_PAN_DIGITS, limit: 5, allowed: 'all'}).length, 0);
    assert.equal(String(reopened.db.prepare("select value from meta where key = 'policy'").get()?.value), INDEX_POLICY);
    assert.equal(String(reopened.db.prepare('pragma journal_mode').get()?.journal_mode), 'delete');
    assert.equal(Number(reopened.db.prepare('pragma secure_delete').get()?.secure_delete), 1);
    reopened.db.close();

    assert.deepEqual(rawHits(dir), [], 'no stale bytes in the database or any sidecar after refresh and reopen');
    assert.deepEqual(indexFiles(dir).map(f => f.split('/').pop()), ['calls-index.sqlite'], 'no sidecar or temp file left behind');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
}

test('an unreadable or non-SQLite index file is replaced, not trusted', () => {
  const s = setup();
  const file = join(s.config.stateDir, 'calls-index.sqlite');
  s.index.db.close();
  writeFileSync(file, `not a database ${STALE} ${TEST_PAN_DIGITS}`);
  const idx = new CallIndex(file, s.brain);
  assert.equal(idx.rebuilt, true);
  idx.refresh();
  idx.db.close();
  assert.deepEqual(rawHits(s.config.stateDir), []);
});

/**
 * R14c: a cache already stamped by G2's defective in-place purge (correct masking policy,
 * no purge generation) must be replaced, not reused, and so must a G3-era file (policy
 * marker only). Exact G2 purge recipe; raw-byte scan of every index-prefixed file.
 */
for (const shape of ['g2-stamped-after-defective-purge', 'g3-policy-only-marker'] as const) {
  test(`R14c predecessor (${shape}): replaced once, no stale bytes, then reused`, () => {
    const s = setup();
    const dir = s.config.stateDir;
    const file = join(dir, 'calls-index.sqlite');
    s.index.db.prepare('update files set attendees = ?').run(JSON.stringify([STALE, TEST_PAN_DIGITS]));
    s.index.db.prepare('update fts set attendees = ?').run(`${STALE} ${TEST_PAN_DIGITS}`);
    if (shape === 'g2-stamped-after-defective-purge') {
      // G2's exact logical purge and policy stamp (rows gone, FTS bytes retained).
      s.index.db.exec('begin; delete from fts; delete from files;');
      s.index.db.exec("delete from meta where key = 'purge_generation'");
      s.index.db.prepare("insert into meta(key, value) values ('policy', ?) on conflict(key) do update set value = excluded.value").run('atlas-mcp-index-v2-g2-mask');
      s.index.db.exec('commit; vacuum');
    } else {
      s.index.db.exec("delete from meta where key = 'purge_generation'");
    }
    s.index.db.close();
    assert.ok(rawHits(dir).length > 0, 'precondition: stale bytes are in the predecessor file');
    const inode = statSync(file).ino;

    const upgraded = new CallIndex(file, s.brain);
    assert.equal(upgraded.rebuilt, true);
    assert.notEqual(statSync(file).ino, inode, 'a new file replaced the predecessor');
    assert.deepEqual(rawHits(dir), []);
    assert.equal(upgraded.refresh().changed, 3);
    assert.equal(upgraded.search({query: STALE, limit: 5, allowed: 'all'}).length, 0);
    upgraded.db.close();

    const reopened = new CallIndex(file, s.brain);
    assert.equal(reopened.rebuilt, false, 'a current-generation file is reused normally');
    assert.equal(reopened.count(), 3);
    assert.equal(String(reopened.db.prepare("select value from meta where key = 'purge_generation'").get()?.value), PURGE_GENERATION);
    assert.equal(String(reopened.db.prepare("select value from meta where key = 'policy'").get()?.value), INDEX_POLICY);
    reopened.db.close();
    assert.deepEqual(rawHits(dir), []);
    assert.deepEqual(indexFiles(dir).map(f => f.split('/').pop()), ['calls-index.sqlite']);
  });
}
