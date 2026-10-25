/**
 * Authoritative brain-note metadata for sensitivity decisions (R16 finding 1), independent of
 * the search index. The search index is a cache that may be empty (exposure), stale or
 * rebuilding; a security decision must not depend on it.
 *
 * snapshot() lists atlas-brain/content/calls on every call (readdir + stat; the call id is
 * read from each new or changed file's front matter only) and returns callId -> relative
 * paths. It returns null when the directory or any note cannot be read, and callers then
 * withhold (fail closed). note() returns one parsed, card-masked note, cached by mtime/size.
 */
import {closeSync, openSync, readFileSync, readSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {callIdFor, parseNote, type ParsedNote} from './notes.ts';

type Entry = {mtimeMs: number; size: number; callId: string};

/** The fireflies_id exactly as parseNote's front-matter reader would see it. */
function firefliesIdFromHead(head: string): string | null {
  if (!head.startsWith('---')) return null;
  const end = head.indexOf('\n---', 3);
  if (end < 0) return null;
  for (const line of head.slice(3, end).split('\n')) {
    const m = /^fireflies_id:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v: unknown = m[1].trim();
    if (typeof v === 'string' && /^["[]/.test(v)) { try { v = JSON.parse(v); } catch { /* keep text */ } }
    return typeof v === 'string' && v ? v : null;
  }
  return null;
}

function readHead(file: string, size: number): string {
  // Front matter is at the top; read 64 KiB, or the whole file if the block is not closed there.
  const fd = openSync(file, 'r');
  try {
    const n = Math.min(size, 65536);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    const head = buf.toString('utf8');
    if (n < size && head.startsWith('---') && head.indexOf('\n---', 3) < 0) return readFileSync(file, 'utf8');
    return head;
  } finally { closeSync(fd); }
}

export class BrainFiles {
  readonly dir: string;
  private entries = new Map<string, Entry>();
  private notes = new Map<string, {mtimeMs: number; size: number; note: ParsedNote}>();
  constructor(dir: string) { this.dir = dir; }

  /** callId -> relative note paths, or null if the brain cannot be read completely. */
  snapshot(): Map<string, string[]> | null {
    let names: string[];
    try { names = readdirSync(this.dir).filter(n => n.endsWith('.md')); } catch { return null; }
    const out = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const name of names) {
      const file = join(this.dir, name);
      let st;
      try { st = statSync(file); } catch (e) { if ((e as {code?: string}).code === 'ENOENT') continue; return null; }
      if (!st.isFile()) continue;
      seen.add(name);
      let ent = this.entries.get(name);
      if (!ent || ent.mtimeMs !== st.mtimeMs || ent.size !== st.size) {
        let head: string;
        try { head = readHead(file, st.size); } catch { return null; }
        ent = {mtimeMs: st.mtimeMs, size: st.size, callId: callIdFor(file, firefliesIdFromHead(head))};
        this.entries.set(name, ent);
      }
      const list = out.get(ent.callId) ?? [];
      list.push(name);
      out.set(ent.callId, list);
    }
    for (const k of [...this.entries.keys()]) if (!seen.has(k)) this.entries.delete(k);
    for (const k of [...this.notes.keys()]) if (!seen.has(k)) this.notes.delete(k);
    return out;
  }

  /** One parsed (card-masked) note by relative path, or null if unreadable. */
  note(rel: string): ParsedNote | null {
    const file = join(this.dir, rel);
    let st;
    try { st = statSync(file); } catch { return null; }
    const c = this.notes.get(rel);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.note;
    let note: ParsedNote;
    try { note = parseNote(file, readFileSync(file, 'utf8')); } catch { return null; }
    this.notes.set(rel, {mtimeMs: st.mtimeMs, size: st.size, note});
    return note;
  }
}
