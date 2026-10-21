/**
 * Parser for atlas-brain call notes (content/calls/*.md). Read only. Two layouts exist:
 *  - ingest-all.mjs / fireflies-ingest notes: front matter with fireflies_id, title, date,
 *    attendees (JSON), optional transcript_url; "## Overview" and "## Transcript" sections;
 *  - older notes: tag-only front matter, "# Title", "**Date:**", "**Participants:**".
 * Transcript turns are "**Speaker:** text" lines. Brain notes carry no timestamps.
 * Everything returned here is already card-masked.
 */
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {maskText, maskTurns, type MaskCounter} from './mask.ts';

export type Turn = {speaker: string; text: string; start: number | null};
export type ParsedNote = {
  callId: string; firefliesId: string | null; file: string; title: string; date: string | null;
  attendees: string[]; link: string | null; summary: string; analysis: string; turns: Turn[];
};

const FIREFLIES_ID = /^[A-Za-z0-9_-]{6,64}$/;
const TURN = /^\*\*([^*\n]{1,80}?):\*\*\s?(.*)$/;

function frontMatter(raw: string): {fm: Record<string, unknown>; rest: string} {
  if (!raw.startsWith('---')) return {fm: {}, rest: raw};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {fm: {}, rest: raw};
  const fm: Record<string, unknown> = {};
  for (const line of raw.slice(3, end).split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v: unknown = m[2].trim();
    if (typeof v === 'string' && /^["[]/.test(v)) { try { v = JSON.parse(v); } catch { /* keep text */ } }
    fm[m[1]] = v;
  }
  return {fm, rest: raw.slice(end + 4)};
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function callIdFor(file: string, firefliesId: string | null) {
  return firefliesId && FIREFLIES_ID.test(firefliesId) ? firefliesId : 'note-' + createHash('sha256').update(basename(file)).digest('hex').slice(0, 16);
}

export function parseNote(file: string, raw: string, counter?: MaskCounter): ParsedNote {
  const {fm, rest} = frontMatter(raw);
  const fid = typeof fm.fireflies_id === 'string' && fm.fireflies_id ? fm.fireflies_id : null;
  const heading = /^# (.+)$/m.exec(rest);
  const rawTitle = typeof fm.title === 'string' && fm.title ? fm.title : heading ? heading[1].trim() : basename(file, '.md');
  const fmDate = typeof fm.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fm.date) ? fm.date : null;
  const fileDate = /(\d{4}-\d{2}-\d{2})/.exec(basename(file));
  let attendees: string[] = Array.isArray(fm.attendees) ? fm.attendees.filter((x): x is string => typeof x === 'string') : [];
  if (!attendees.length) {
    const line = /^\*\*(?:Participants|Attendees):\*\*\s*(.+)$/m.exec(rest);
    if (line) attendees = line[1].split(',').map(s => s.trim()).filter(Boolean);
  }
  // Attendees are free text from the note: masked like every other note-derived field.
  attendees = attendees.slice(0, 40).map(a => maskText(a.replace(/\s+/g, ' ').trim().toLowerCase(), counter).slice(0, 200));
  // URLs are not masked; they are validated to the exact Fireflies view shape instead.
  const url = typeof fm.transcript_url === 'string' && /^https:\/\/app\.fireflies\.ai\/view\/[A-Za-z0-9_-]{6,64}$/.test(fm.transcript_url) ? fm.transcript_url : null;
  const link = url ?? (fid && FIREFLIES_ID.test(fid) ? `https://app.fireflies.ai/view/${fid}` : null);

  // Transcript section: from "## Transcript" to the next rule, H2 or tag block.
  const tIdx = rest.search(/^## Transcript\s*$/m);
  let pre = tIdx >= 0 ? rest.slice(0, tIdx) : rest;
  const turns: Turn[] = [];
  if (tIdx >= 0) {
    let tail = rest.slice(tIdx).replace(/^## Transcript\s*\n/, '');
    const stop = tail.search(/^(?:---\s*$|## |# auto-generated)/m);
    if (stop >= 0) tail = tail.slice(0, stop);
    for (const line of tail.split('\n')) {
      const m = TURN.exec(line);
      if (m) turns.push({speaker: m[1].trim(), text: m[2].trim(), start: null});
      else if (line.trim() && turns.length) turns[turns.length - 1].text += ' ' + line.trim();
    }
  }
  // Drop the generated link sections from the analysis part.
  const cut = pre.search(/^#{2,3} (?:Connections|Related)\b|^# auto-generated/m);
  if (cut >= 0) pre = pre.slice(0, cut);
  const overview = /^## Overview\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(pre);
  const analysis = pre
    .split('\n')
    .filter(l => !/^(?:# |\*\*(?:Date|Duration|Participants|Attendees|Host|Fireflies link):\*\*|---\s*$)/.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const summarySource = (overview ? overview[1] : analysis).replace(/[#*>`_]/g, '').replace(/\s+/g, ' ').trim();

  // Masking: turns as one ordered sequence (read-outs span turns), then speakers, title, prose.
  const maskedText = maskTurns(turns.map(t => t.text), counter);
  const maskedSpeakers = maskTurns(turns.map(t => t.speaker), counter);
  turns.forEach((t, i) => { t.text = maskedText[i]; t.speaker = maskedSpeakers[i]; });
  return {
    callId: callIdFor(file, fid), firefliesId: fid, file,
    // Mask first, clip after: clipping first could cut a number below the mask's thresholds.
    title: clip(maskText(rawTitle.replace(/\s+/g, ' ').trim(), counter), 200),
    date: fmDate ?? (fileDate ? fileDate[1] : null),
    attendees, link,
    summary: clip(maskText(summarySource, counter), 400),
    analysis: clip(maskText(analysis, counter), 8000),
    turns,
  };
}
