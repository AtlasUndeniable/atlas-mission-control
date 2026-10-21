// card-mask.mjs — Lane P (2026-10-20). Masks payment-card read-outs in Fireflies sentences
// BEFORE anything is written to atlas-brain or sent to a model.
//
// Fireflies splits a spoken card number into short digit groups across several speaker
// turns ("So 1234-5678.", "9012.", ...), and mishears the cue words ("car details",
// "fiery" for expiry, "CBC"/"CDC" for CVC). This module finds the payment exchange
// (number cue -> digits -> expiry cue -> digits -> security-code cue -> digits) and
// replaces the digits with [REDACTED-CARD] / [REDACTED-EXPIRY] / [REDACTED-CVC].
// Safety net: any Luhn-valid 13-19 digit run, and any 15+ digit grouped run near a
// card cue, is masked even outside a detected exchange.
//
// maskCardReadouts(sentences) -> { sentences: newArray, spans: number }
// Input objects are not mutated. Never logs or returns the original digits.

const DW1 = "zero|oh|one|two|three|four|five|six|seven|eight|nine";
const DWALL = DW1 + "|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|double|triple";
const DWRE = () => new RegExp(`\\b(?:${DWALL})\\b`, "gi");
const ORD = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth";
const MON = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

const NUMCUE = /card number|card details|car details|card that you want|card you want|read (?:it|me|them) out|read me your|read me the number|(?:master ?card|visa|amex) number|long number|number is|grab (?:the|those|your) (?:card|car|number|details)|give you the numbers|the card numbers|got the card|card numbers|number first/i;
const EXPCUE_SRC = String.raw`\bexpired\.?\s*$|\bexpiry\b|\bexpiration\b|\bfiery\b|month (?:and|in|from) the year|expires on|valid until`;
const CVCCUE_SRC = String.raw`\bc[vbd][vcb](?![a-z])|\bccv\b|\bcv\b(?= is)|security code|(?:numbers?|digits?) (?:on|at) the (?:back|front)|little (?:numbers|digits)|\bthe (?:three|four|3|4) (?:digits|numbers)\b|\b(?:three|four) digit code|\bthe digits\b|\bdigits is\b`;
const EXPCUE = new RegExp(EXPCUE_SRC, "i");
const CVCCUE = new RegExp(CVCCUE_SRC, "i");
const STOP = /zip|post ?code|\bpin\b|phone|mobile|email|address|weeks?\b|bucks|dollars?|\bfee|payment of|birthday|\$|cents|gst|o.?clock/i;
const UNIT = /^\s*(?:%|percent|o.?\s?clock|am\b|pm\b|bucks|dollars?|cents|weeks?\b|months?\b|days?\b|people|k\b|grand|minutes?|hours?|years? old|kilos?)/i;
const CARDCTX = /card|visa|master ?card|amex|american express|\bc[vbd][vcb]\b|expir|security code/i;

const countMatches = (re, s) => (s.match(re) || []).length;
const lettersWoDigits = t => countMatches(/[A-Za-z]/g, t.replace(DWRE(), ""));
const numish = t => (countMatches(/\d/g, t) + countMatches(DWRE(), t)) >= 2 && lettersWoDigits(t) <= 40;
const pure = t => (/\d/.test(t) || DWRE().test(t)) && lettersWoDigits(t) <= 12;
const strong = t => EXPCUE.test(t) || CVCCUE.test(t);
const tokRe = () => new RegExp(String.raw`(?:\d+(?:st|nd|rd|th)?(?:[\s\-,./]{1,3}\d+(?:st|nd|rd|th)?)*)|(?:\b(?:${DWALL})\b(?:[\s\-,]{1,3}\b(?:${DWALL})\b)*)`, "gi");

function luhn(d) {
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    s += n;
  }
  return s % 10 === 0;
}

function events(t) {
  const ev = [];
  for (const m of t.matchAll(new RegExp(EXPCUE_SRC, "gi"))) ev.push([m.index + m[0].length, "EXPIRY"]);
  for (const m of t.matchAll(new RegExp(CVCCUE_SRC, "gi"))) ev.push([m.index + m[0].length, "CVC"]);
  const nc = [];
  for (const m of t.matchAll(new RegExp(NUMCUE.source, "gi"))) nc.push([m.index + m[0].length, "CARD"]);
  let listing = false;
  if (nc.length && ev.length) {
    const lastNc = Math.max(...nc.map(e => e[0])), lastEv = Math.max(...ev.map(e => e[0]));
    listing = lastEv > lastNc && !/\d/.test(t.slice(lastNc));
  }
  return { ev: [...ev, ...nc].sort((a, b) => a[0] - b[0]), listing };
}

function redactTurn(t, state, forced) {
  const { ev, listing } = events(t);
  const dig = { CARD: 0, EXPIRY: 0, CVC: 0 };
  let out = "", pos = 0, n = 0;
  for (const m of t.matchAll(tokRe())) {
    const tok = m[0], start = m.index, end = start + tok.length;
    let st = forced || state;
    if (!forced) for (const [e, s2] of ev) if (e <= start) st = s2;
    if (t.slice(Math.max(0, start - 1), start) === "$" || UNIT.test(t.slice(end))) continue;
    if (!/\d/.test(tok)) {
      const after = t.slice(end, end + 14).toLowerCase();
      if (/^\s*(?:digits?|numbers?|number|little|weeks?|months?|sec\b|seconds?|minutes?|check|of (?:the|those|them|us|you)|thing)/.test(after)) continue;
      const words = tok.match(DWRE()) || [];
      if (words.length === 1 && words[0].toLowerCase() === "oh" && lettersWoDigits(t) > 0) continue;
      if (words.length === 1 && ["one", "double", "triple", "hundred", "thousand"].includes(words[0].toLowerCase()) && !pure(t)) continue;
    }
    if (!forced && st !== "CVC" && /^\s*(?:is|are)\s+(?:the|my)\s+(?:\w+\s+)?(?:digits|cvc|cvv|numbers)/i.test(t.slice(end))) st = "CVC";
    out += t.slice(pos, start) + `[REDACTED-${st}]`;
    pos = end; n++;
    dig[st] += countMatches(/\d/g, tok) + countMatches(DWRE(), tok);
  }
  out += t.slice(pos);
  let final = state;
  for (const [, s2] of ev) final = s2;
  if (listing) final = "CARD";
  if (out.includes("[REDACTED-EXPIRY]")) {
    out = out.replace(new RegExp(String.raw`\b(?:${MON}|${ORD})\b(?=[\s,.]*(?:of\s+(?:the\s+)?)?\[REDACTED-EXPIRY\])`, "gi"), "[REDACTED-EXPIRY]");
    out = out.replace(new RegExp(String.raw`(\[REDACTED-EXPIRY\][\s,.]*(?:of\s+(?:the\s+)?)?)\b(?:${MON}|${ORD})\b`, "gi"), "$1[REDACTED-EXPIRY]");
  }
  out = out.replace(/\[REDACTED-(\w+)\](?:[\s,\-]*\[REDACTED-\1\])+/g, "[REDACTED-$1]");
  return { text: out, state: final, n, dig };
}

function findSegments(texts) {
  const segs = [];
  let used = -1;
  for (let k = 0; k < texts.length; k++) {
    if (k <= used || !strong(texts[k])) continue;
    let s = -1;
    for (let x = k; x >= Math.max(0, k - 15); x--) if (NUMCUE.test(texts[x])) { s = x; break; }
    if (s < 0) {
      s = k; let gap = 0;
      for (let x = k - 1; x >= 0 && k - x <= 15; x--) {
        if (numish(texts[x])) { s = x; gap = 0; } else if (++gap > 3) break;
      }
    }
    let e = k, gap = 0, cvcCue = CVCCUE.test(texts[k]), cvcAns = false;
    for (let x = k + 1; x < texts.length && x <= k + 20; x++) {
      const t2 = texts[x];
      if (CVCCUE.test(t2)) cvcCue = true;
      const isnum = (numish(t2) && !cvcCue && !STOP.test(t2)) || (pure(t2) && !STOP.test(t2));
      if (strong(t2) || isnum) { e = x; gap = 0; if (cvcCue && isnum) cvcAns = true; }
      else { gap++; if (STOP.test(t2) || gap > (cvcAns ? 1 : 4)) break; }
    }
    segs.push([s, e]); used = e;
  }
  const merged = [];
  for (const [s, e] of segs) {
    if (merged.length && s <= merged[merged.length - 1][1] + 1) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    else merged.push([s, e]);
  }
  return merged;
}

export function maskCardReadouts(sentences) {
  const list = Array.isArray(sentences) ? sentences : [];
  const texts = list.map(s => (s && typeof s.text === "string") ? s.text : "");
  const out = texts.slice();
  let spans = 0;
  for (const [s, e] of findSegments(texts)) {
    let state = "CARD";
    const tmp = [], D = { CARD: 0, EXPIRY: 0, CVC: 0 };
    for (let x = s; x <= e; x++) {
      const r = redactTurn(out[x], state);
      state = r.state;
      for (const k in D) D[k] += r.dig[k];
      tmp.push([x, r.text, r.n]);
    }
    if (D.CARD >= 12 && (D.EXPIRY + D.CVC > 0 || D.CARD >= 15)) {
      for (const [x, txt, n] of tmp) if (n) { out[x] = txt; spans += n; }
    }
  }
  // Safety net 1: Luhn-valid 13-19 digit runs anywhere.
  // Safety net 2: 15+ digit grouped runs within 10 sentences of a card cue.
  const near = i => texts.slice(Math.max(0, i - 10), i + 11).some(t => CARDCTX.test(t));
  for (let i = 0; i < out.length; i++) {
    out[i] = out[i].replace(/\d(?:[\s\-.]{0,2}\d){12,30}/g, m => {
      const d = m.replace(/\D/g, "");
      if ((d.length <= 19 && luhn(d)) || (d.length >= 15 && near(i))) { spans++; return "[REDACTED-CARD]"; }
      return m;
    });
  }
  const masked = list.map((s, i) => (out[i] === texts[i] ? s : { ...s, text: out[i] }));
  return { sentences: masked, spans };
}

// maskFirefliesData(result) -> { data: maskedCopy, spans }
// Walks a Fireflies GraphQL response ({ data: { transcript } } or { data: { transcripts: [] } })
// and masks every transcript's sentences plus its summary strings (Luhn/near-cue safety
// nets apply to summaries too). Used by fireflies-bridge.mjs before anything is returned.
export function maskFirefliesData(result) {
  if (!result || typeof result !== "object" || !result.data) return { data: result, spans: 0 };
  let spans = 0;
  const maskOne = t => {
    if (!t || typeof t !== "object") return t;
    const out = { ...t };
    if (Array.isArray(t.sentences)) {
      const r = maskCardReadouts(t.sentences);
      out.sentences = r.sentences; spans += r.spans;
    }
    if (t.summary && typeof t.summary === "object") {
      const sum = { ...t.summary };
      for (const [k, v] of Object.entries(t.summary)) {
        if (typeof v === "string") {
          const r = maskCardReadouts([{ text: v }]); sum[k] = r.sentences[0].text; spans += r.spans;
        } else if (Array.isArray(v) && v.every(x => typeof x === "string")) {
          const r = maskCardReadouts(v.map(text => ({ text }))); sum[k] = r.sentences.map(s => s.text); spans += r.spans;
        }
      }
      out.summary = sum;
    }
    return out;
  };
  const data = { ...result.data };
  if (result.data.transcript) data.transcript = maskOne(result.data.transcript);
  if (Array.isArray(result.data.transcripts)) data.transcripts = result.data.transcripts.map(maskOne);
  return { data: { ...result, data }, spans };
}
