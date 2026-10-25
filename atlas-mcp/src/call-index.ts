/**
 * Cheap local call search: SQLite FTS5 (porter + unicode61) over masked atlas-brain call
 * notes, rebuilt incrementally by file mtime and size. No embeddings, no network.
 *
 * Scope is applied INSIDE the SQL query, before ranking and before any text is read back,
 * so a caller limited to some calls never receives a title, summary or quote from another.
 */
import {DatabaseSync} from 'node:sqlite';
import {readdirSync, readFileSync, statSync, mkdirSync, chmodSync, existsSync, openSync, closeSync, fsyncSync, unlinkSync, renameSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {basename, dirname, join} from 'node:path';
import {parseNote, type ParsedNote} from './notes.ts';
import type {MaskCounter} from './mask.ts';

export type CallHit = {
  callId: string; title: string; date: string | null; attendees: string[]; link: string | null;
  summary: string; turns: number; quotes: {turn: number; speaker: string; text: string}[];
};
export type SearchInput = {
  query: string; from?: string; to?: string; limit: number; client?: string;
  /** Calls whose hosted task client matches `client` (they pass the client filter too). */
  clientCallIds?: Set<string>;
  /** 'all' for the owner scope; otherwise the exact call ids the hosted service allows. */
  allowed: 'all' | Set<string>;
};

const SCHEMA = `
create table if not exists files(id integer primary key, file text unique not null, mtime_ms integer not null, size integer not null,
  call_id text not null, title text not null, date text, attendees text not null, link text, summary text not null, nturns integer not null);
create index if not exists files_call on files(call_id);
create virtual table if not exists fts using fts5(title, attendees, analysis, body, tokenize='porter unicode61');
`;
const META = `create table if not exists meta(key text primary key, value text not null);
`;

export function queryTerms(query: string): string[] {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length > 1).slice(0, 12);
  return [...new Set(terms)];
}
const ftsQuery = (terms: string[]) => terms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
const stem = (t: string) => t.slice(0, Math.max(4, Math.min(t.length, 5)));

/** Bump whenever masking or parsing of indexed fields changes (G2: attendees masked, strict URLs). A change replaces the index file. */
export const INDEX_POLICY = 'atlas-mcp-index-v2-g2-mask';
/**
 * Purge generation, separate from the masking policy. It is written ONLY into a file created by
 * replaceWithFresh(). A file without exactly this generation (no marker, G2 in-place purge stamp,
 * G3 file) may hold bytes from an older purge method and is replaced, never reused (R14c).
 */
export const PURGE_GENERATION = 'atlas-mcp-purge-g4-fresh-file';

const SIDECARS = ['-wal', '-shm', '-journal'];
const fsyncPath = (p: string) => { const fd = openSync(p, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const removeIfPresent = (p: string) => { try { unlinkSync(p); } catch (e) { if ((e as {code?: string}).code !== 'ENOENT') throw e; } };

/** Markers recorded in an existing index file, via a read-only handle; nulls if absent or unreadable. */
function recordedMarkers(dbFile: string): {policy: string | null; generation: string | null} {
  const none = {policy: null, generation: null};
  if (!existsSync(dbFile)) return none;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, {readOnly: true});
    const get = (k: string) => { const r = db!.prepare('select value from meta where key = ?').get(k); return typeof r?.value === 'string' ? r.value : null; };
    return {policy: get('policy'), generation: get('purge_generation')};
  } catch { return none; } finally { try { db?.close(); } catch { /* ignore */ } }
}

/**
 * Replace the index with a brand-new empty database (never reusing the old file's pages or
 * FTS segments): build it in a fresh owner-only temp file in the same directory, stamp the
 * policy, fsync it, remove the old sidecars, atomically rename it over the old path, fsync
 * the directory. Any crash leaves either the old file (re-detected next open, temp removed)
 * or the new empty, policy-stamped file (refresh() fills it).
 */
function replaceWithFresh(dbFile: string, parent: string) {
  const tmp = `${dbFile}.rebuild-${process.pid}-${randomBytes(6).toString('hex')}`;
  closeSync(openSync(tmp, 'wx', 0o600));
  const fresh = new DatabaseSync(tmp);
  try {
    fresh.exec('pragma journal_mode = delete');
    fresh.exec('pragma secure_delete = on');
    fresh.exec(SCHEMA);
    fresh.exec(META);
    fresh.prepare("insert into meta(key, value) values ('policy', ?), ('purge_generation', ?)").run(INDEX_POLICY, PURGE_GENERATION);
  } finally { fresh.close(); }
  for (const s of SIDECARS) removeIfPresent(tmp + s);
  fsyncPath(tmp);
  for (const s of SIDECARS) removeIfPresent(dbFile + s);
  renameSync(tmp, dbFile);
  fsyncPath(parent);
}

export class CallIndex {
  readonly db: DatabaseSync;
  readonly dir: string;
  rebuilt = false;
  constructor(dbFile: string, brainCallsDir: string) {
    const parent = dirname(dbFile);
    if (!existsSync(parent)) mkdirSync(parent, {recursive: true, mode: 0o700});
    // Leftovers of an interrupted upgrade may hold old-policy data: remove them first.
    const base = basename(dbFile);
    for (const n of readdirSync(parent)) if (n.startsWith(`${base}.rebuild-`)) removeIfPresent(join(parent, n));
    // A masking/parsing policy change (or a predecessor file with no policy marker) means the
    // file may hold old-policy text. DELETE + VACUUM does not reliably purge FTS segments
    // (R14b), so the file is replaced, never reused.
    if (existsSync(dbFile)) {
      const m = recordedMarkers(dbFile);
      if (m.policy !== INDEX_POLICY || m.generation !== PURGE_GENERATION) { replaceWithFresh(dbFile, parent); this.rebuilt = true; }
    }
    if (!existsSync(dbFile)) replaceWithFresh(dbFile, parent);
    this.db = new DatabaseSync(dbFile);
    chmodSync(dbFile, 0o600);
    // Normal operation: rollback journal deleted after each commit (no lingering -wal/-shm),
    // and deleted content overwritten in freed pages.
    this.db.exec('pragma journal_mode = delete');
    this.db.exec('pragma secure_delete = on');
    this.db.exec(SCHEMA);
    this.db.exec(META);
    this.dir = brainCallsDir;
  }

  /** Incremental refresh. Returns counts only; the mask span total never includes text. */
  refresh(counter: MaskCounter = {spans: 0}) {
    const seen = new Set<string>();
    let changed = 0, removed = 0, scanned = 0;
    const names = readdirSync(this.dir).filter(n => n.endsWith('.md'));
    const get = this.db.prepare('select id, mtime_ms, size from files where file = ?');
    const del = this.db.prepare('delete from files where id = ?');
    const delFts = this.db.prepare('delete from fts where rowid = ?');
    const ins = this.db.prepare('insert into files(file, mtime_ms, size, call_id, title, date, attendees, link, summary, nturns) values (?,?,?,?,?,?,?,?,?,?)');
    const insFts = this.db.prepare('insert into fts(rowid, title, attendees, analysis, body) values (?,?,?,?,?)');
    this.db.exec('begin');
    try {
      for (const name of names) {
        const file = join(this.dir, name);
        let st;
        try { st = statSync(file); } catch { continue; }
        if (!st.isFile()) continue;
        scanned++; seen.add(name);
        const row = get.get(name);
        if (row && row.mtime_ms === Math.floor(st.mtimeMs) && row.size === st.size) continue;
        if (row) { delFts.run(row.id); del.run(row.id); }
        let note: ParsedNote;
        try { note = parseNote(file, readFileSync(file, 'utf8'), counter); } catch { continue; }
        const r = ins.run(name, Math.floor(st.mtimeMs), st.size, note.callId, note.title, note.date, JSON.stringify(note.attendees), note.link, note.summary, note.turns.length);
        insFts.run(r.lastInsertRowid, note.title, note.attendees.join(' '), note.analysis, note.turns.map(t => `${t.speaker}: ${t.text}`).join('\n'));
        changed++;
      }
      for (const row of this.db.prepare('select id, file from files').all()) {
        if (!seen.has(row.file as string)) { delFts.run(row.id); del.run(row.id); removed++; }
      }
      this.db.exec('commit');
    } catch (e) { this.db.exec('rollback'); throw e; }
    return {scanned, changed, removed, maskSpans: counter.spans};
  }

  count() { return Number((this.db.prepare('select count(distinct call_id) n from files').get() ?? {n: 0}).n); }

  /** Every indexed record of a call (all searchable text), for whole-record eligibility checks. */
  recordsFor(callId: string): {title: string; attendees: string; summary: string; analysis: string; body: string}[] {
    return this.db.prepare('select f.title, f.attendees, f.summary, fts.analysis, fts.body from files f join fts on fts.rowid = f.id where f.call_id = ?').all(callId)
      .map(r => ({title: String(r.title), attendees: String(r.attendees), summary: String(r.summary), analysis: String(r.analysis ?? ''), body: String(r.body ?? '')}));
  }

  /** Best file for a call id (most turns), or null. */
  fileFor(callId: string): string | null {
    const row = this.db.prepare('select file from files where call_id = ? order by nturns desc, size desc limit 1').get(callId);
    return row ? join(this.dir, row.file as string) : null;
  }

  search(input: SearchInput): CallHit[] {
    const terms = queryTerms(input.query);
    if (!terms.length) return [];
    if (input.allowed !== 'all' && input.allowed.size === 0) return [];
    const fetch = Math.min(250, Math.max(input.limit * 5, 25));
    const stmt = this.db.prepare(`
      select f.id, f.call_id, f.title, f.date, f.attendees, f.link, f.summary, f.nturns, bm25(fts, 6.0, 3.0, 1.5, 1.0) score
      from fts join files f on f.id = fts.rowid
      where fts match ?
        and (? is null or f.date >= ?) and (? is null or f.date <= ?)
        and (? is null or f.call_id in (select value from json_each(?)))
      order by score, f.date desc limit ?`);
    const run = (match: string, allowed: 'all' | Set<string>) => {
      const j = allowed === 'all' ? null : JSON.stringify([...allowed]);
      return stmt.all(match, input.from ?? null, input.from ?? null, input.to ?? null, input.to ?? null, j, j, fetch);
    };
    const client = input.client ? queryTerms(input.client) : [];
    let rows;
    if (!client.length) rows = run(ftsQuery(terms), input.allowed);
    else {
      // The client filter is part of the FTS query (prefix match on title/attendees), so it
      // narrows BEFORE ranking; calls mapped to the client by a hosted task are added from a
      // second query restricted to those ids (and still to the caller's allowed set).
      rows = run(`(${ftsQuery(terms)}) AND ({title attendees} : (${client.map(t => `"${t}"*`).join(' AND ')}))`, input.allowed);
      const mapped = [...(input.clientCallIds ?? [])].filter(id => input.allowed === 'all' || input.allowed.has(id));
      if (mapped.length) rows = [...rows, ...run(ftsQuery(terms), new Set(mapped))].sort((a, b) => Number(a.score) - Number(b.score));
    }
    const out: CallHit[] = [];
    const seen = new Set<string>();
    const body = this.db.prepare('select body from fts where rowid = ?');
    for (const r of rows) {
      const callId = r.call_id as string;
      if (seen.has(callId)) continue;
      const attendees = JSON.parse(r.attendees as string) as string[];
      if (client.length) {
        const hay = `${r.title} ${attendees.join(' ')}`.toLowerCase();
        if (!client.every(t => hay.includes(t)) && !input.clientCallIds?.has(callId)) continue;
      }
      seen.add(callId);
      out.push({
        callId, title: r.title as string, date: (r.date as string) ?? null, attendees, link: (r.link as string) ?? null,
        summary: r.summary as string, turns: Number(r.nturns),
        quotes: matchingQuotes(String(body.get(r.id)?.body ?? ''), terms),
      });
      if (out.length >= input.limit) break;
    }
    return out;
  }
}

/** Up to three transcript turns with the most query-term hits, clipped around the first hit. */
export function matchingQuotes(body: string, terms: string[]) {
  const stems = terms.filter(t => t.length > 2).map(stem);
  if (!stems.length || !body) return [];
  const scored: {turn: number; score: number; line: string}[] = [];
  body.split('\n').forEach((line, turn) => {
    const lower = line.toLowerCase();
    const score = stems.reduce((n, s) => n + (lower.includes(s) ? 1 : 0), 0);
    if (score) scored.push({turn, score, line});
  });
  scored.sort((a, b) => b.score - a.score || a.turn - b.turn);
  return scored.slice(0, 3).sort((a, b) => a.turn - b.turn).map(({turn, line}) => {
    const sep = line.indexOf(': ');
    const speaker = sep > 0 ? line.slice(0, sep) : '';
    const text = sep > 0 ? line.slice(sep + 2) : line;
    const lower = text.toLowerCase();
    const at = Math.max(0, Math.min(...stems.map(s => { const i = lower.indexOf(s); return i < 0 ? Infinity : i; })) - 80);
    const snippet = text.slice(at, at + 240);
    return {turn, speaker, text: (at > 0 ? '…' : '') + snippet + (at + 240 < text.length ? '…' : '')};
  });
}
