/**
 * Read-only retrieval lane for Slack DM document requests.
 *
 * THE over-block this fixes (race.md §B): "find the VSL framework I sent
 * before and send it to me" had no retrieval class, hit the \bdoc\b
 * document_request branch, routed into the produce-or-block 2-key registry,
 * and got the anti-fake-PDF refusal. This lane resolves such a request ONLY
 * against files that DEMONSTRABLY ALREADY EXIST — local exports + the
 * artifact-deliveries ledger, plus the bot's own Slack uploads when the token
 * carries files:read. There is NO generation path here, so closing the
 * over-block cannot reopen the fake-PDF hole.
 *
 * On a confident match it delivers through the EXISTING gated send
 * (sendRhysDmArtifact — bot identity, Rhys DM only, never as-Rhys, approved
 * roots + extension allowlist). No match → honest "couldn't find it, want me
 * to build one?". Ambiguous → list the real candidates and ask which.
 */

import { basename, extname } from "node:path";

// Words that carry no document identity — stripped before scoring.
const STOPWORDS = new Set([
  "the", "a", "an", "i", "we", "you", "me", "my", "our", "your", "it", "that", "this",
  "to", "of", "in", "on", "for", "and", "or", "with", "from", "as", "at", "by", "is", "are",
  "have", "has", "had", "was", "were", "been", "be", "do", "did", "can", "could", "would",
  "before", "after", "already", "again", "previously", "earlier", "previous", "original",
  "existing", "last", "time", "week", "yesterday", "ago", "back", "here", "there", "please",
  "just", "one", "ones", "some", "any", "client", "clients", "slack", "over", "sent", "send",
  "share", "shared", "gave", "made", "created", "find", "locate", "look", "search", "dig",
  "pull", "up", "resend", "fetch", "grab", "get", "show", "give", "want", "need", "about",
]);

const MIN_MATCH_SCORE = 2; // need ≥2 distinctive term hits to claim a match
const AMBIGUOUS_MARGIN = 1; // winner must beat the runner-up by > this

function collapse(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * One canonical identity for an artifact regardless of source: strips the
 * extension, the YYYY-MM-DD- date prefix, and -branded/-cover(-preview)-NNN
 * style suffixes before collapsing. Export-scan keys and ledger titles or
 * basenames for the SAME file must land on the same key, or one real file
 * shows up as two candidates and a clean match degrades to "which one?".
 */
export function canonicalGroupKey(value = "") {
  return collapse(
    String(value)
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/^\d{4}-\d{2}-\d{2}-/, "")
      .replace(/-branded(?:-v\d+)?$/i, "")
      .replace(/-cover(?:-preview)?(?:-\d+)?$/i, "")
      .replace(/-page-preview(?:-\d+)?$/i, ""),
  );
}

/** Content terms from a request — punctuation split, stopwords/verbs removed.
 *  Floor is length 2 so short identifiers ("q2", "10k") survive; pure-digit
 *  tokens (years like "2026") are dropped as noise. */
export function extractRetrievalTerms(text = "") {
  return [...new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPWORDS.has(t)),
  )];
}

function groupTokens(key = "") {
  return String(key).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

/**
 * Score one real artifact group against the request terms. A term scores when
 * it shares identity with a group token (exact, prefix, or substring either
 * way) — so "hand"/"over" both hit "handover" and "vsl" hits "...-vsl-...".
 */
export function scoreGroup(terms, group) {
  const key = group.artifactKey || group.title || basename(group.artifactPaths?.[0] || "");
  const tokens = groupTokens(key);
  const collapsedKey = collapse(key);
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const hit = tokens.some((tok) => tok === term
      || (term.length >= 3 && tok.startsWith(term))
      || (tok.length >= 4 && term.startsWith(tok)))
      || (term.length >= 5 && collapsedKey.includes(term));
    if (hit) { score += 1; hits.push(term); }
  }
  return { score, hits };
}

/**
 * Pure resolver. Inputs are already-enumerated REAL artifacts:
 *   exportGroups  — scanExportArtifactGroups() output (on-disk only)
 *   ledgerGroups  — groups derived from delivered artifact-ledger rows
 *   slackFiles    — [{ id, name, title }] of the bot's own uploads (or [])
 * Returns { status: 'match'|'ambiguous'|'none', match, candidates }.
 */
export function resolveRetrieval({ text, exportGroups = [], ledgerGroups = [], slackFiles = [] } = {}) {
  const terms = extractRetrievalTerms(text);
  if (terms.length === 0) return { status: "none", match: null, candidates: [], terms };

  // Merge all REAL sources into one candidate set. Identity is the canonical
  // key OR any shared on-disk path — the same file recorded in the ledger
  // under a human title and found by the export scan must merge into ONE
  // candidate, never two (that false-ambiguity re-blocks the headline case).
  const byKey = new Map();
  const pathIndex = new Map(); // absolute path -> canonical key already holding it
  const addGroup = (group, origin) => {
    const paths = (group.artifactPaths || []).filter(Boolean);
    if (!paths.length) return;
    let key = canonicalGroupKey(group.artifactKey || group.title || basename(paths[0]));
    if (!key) return;
    const overlapKey = paths.map((p) => pathIndex.get(p)).find(Boolean);
    if (overlapKey) key = overlapKey;
    const existing = byKey.get(key);
    if (existing) {
      existing.artifactPaths = [...new Set([...existing.artifactPaths, ...paths])];
      existing.newestMtimeMs = Math.max(existing.newestMtimeMs || 0, group.newestMtimeMs || 0);
      existing.title = existing.title || group.title || null;
      for (const p of paths) pathIndex.set(p, key);
      return;
    }
    byKey.set(key, {
      artifactKey: group.artifactKey || basename(paths[0], extname(paths[0])),
      title: group.title || null,
      artifactPaths: paths,
      newestMtimeMs: group.newestMtimeMs || 0,
      origin,
    });
    for (const p of paths) pathIndex.set(p, key);
  };
  for (const g of exportGroups) addGroup(g, "exports");
  for (const g of ledgerGroups) addGroup(g, "ledger");

  // Only groups containing at least one real DOCUMENT are deliverable
  // candidates — png/css-only groups are previews/assets, and offering a
  // preview image against the real doc is a false ambiguity.
  const DOC_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".md", ".html"]);
  for (const [key, group] of byKey) {
    if (!group.artifactPaths.some((p) => DOC_EXTENSIONS.has(extname(p).toLowerCase()))) byKey.delete(key);
  }

  // Slack-side files have no local path — they cannot be delivered through the
  // gated send (which needs an on-disk path under an approved root). They only
  // confirm existence. Fold a Slack file into a local group when names align;
  // never surface a Slack-only file as a deliverable candidate.
  const slackNames = slackFiles.map((f) => collapse(f.name || f.title || ""));

  const scored = [...byKey.values()]
    .map((group) => {
      const { score, hits } = scoreGroup(terms, group);
      const slackBoost = slackNames.some((n) => n && collapse(group.artifactKey).includes(n.slice(0, 12))) ? 0 : 0;
      return { group, score: score + slackBoost, hits };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => (b.score - a.score) || ((b.group.newestMtimeMs || 0) - (a.group.newestMtimeMs || 0)));

  if (scored.length === 0 || scored[0].score < MIN_MATCH_SCORE) {
    return { status: "none", match: null, candidates: [], terms };
  }
  const top = scored[0];
  const second = scored[1];
  if (second && top.score - second.score <= AMBIGUOUS_MARGIN && second.score >= MIN_MATCH_SCORE) {
    const near = scored.filter((c) => top.score - c.score <= AMBIGUOUS_MARGIN && c.score >= MIN_MATCH_SCORE);
    return { status: "ambiguous", match: null, candidates: near.map((c) => c.group), terms };
  }
  return { status: "match", match: top.group, candidates: [top.group], terms };
}

/** Derive real artifact groups from delivered/created rows in the ledger. */
export function ledgerGroupsFromEvents(ledgerEvents = [], { fileExists } = {}) {
  const byKey = new Map();
  for (const event of ledgerEvents) {
    if (event.eventType !== "artifact_created") continue;
    const paths = (event.artifactPaths || []).filter(Boolean).filter((p) => !fileExists || fileExists(p));
    if (!paths.length) continue;
    const key = canonicalGroupKey(event.title || basename(paths[0]));
    if (!byKey.has(key)) {
      byKey.set(key, { artifactKey: basename(paths[0], extname(paths[0])), title: event.title || null, artifactPaths: paths, newestMtimeMs: Date.parse(event.artifactCreatedAt || event.eventAt || "") || 0 });
    } else {
      const g = byKey.get(key);
      g.artifactPaths = [...new Set([...g.artifactPaths, ...paths])];
    }
  }
  return [...byKey.values()];
}

// ── TR-6 copy (no ids, no states, no paths) ──────────────────────────────────
export function retrievalNotFoundText() {
  return "I couldn't find a doc matching that. Want me to build one?";
}

export function retrievalAmbiguousText(candidates = []) {
  const names = candidates
    .map((c) => prettyName(c))
    .filter(Boolean)
    .slice(0, 5);
  const list = names.map((n) => `• ${n}`).join("\n");
  return `I found a few that could match — which one?\n${list}`;
}

export function retrievalDeliveredText() {
  return "Found it. I attached it here.";
}

/** Human-readable artifact name for Rhys-facing copy (no dates/paths/ids). */
export function prettyName(group) {
  if (group?.title) return group.title;
  const key = group?.artifactKey || basename(group?.artifactPaths?.[0] || "");
  return key
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/-branded(?:-v\d+)?$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Orchestrate one retrieval. Everything injectable so the proof harness runs
 * entirely against fixtures; the listener passes live deps. Returns a result
 * describing what happened; the caller does the Slack reply + ledger writes
 * it does not own here.
 */
export async function runRetrievalLane({
  text,
  channel,
  userId,
  scanExports,            // () => exportGroups
  readLedger,             // () => ledgerEvents
  listBotFiles,           // async () => ({ ok, files }) | ({ ok:false, scope_missing:true })
  selectArtifactPath,     // (paths) => preferredPath
  sendArtifact,           // async ({ artifactPath, title, message }) => receipt
  fileExists,
} = {}) {
  const exportGroups = scanExports ? scanExports() : [];
  const ledgerGroups = readLedger ? ledgerGroupsFromEvents(readLedger(), { fileExists }) : [];

  let slackFiles = [];
  let slackScopeMissing = false;
  if (listBotFiles) {
    try {
      const res = await listBotFiles();
      if (res?.ok && Array.isArray(res.files)) slackFiles = res.files;
      else if (res && res.ok === false) slackScopeMissing = true;
    } catch {
      slackScopeMissing = true; // degrade gracefully — exports+ledger still authoritative
    }
  }

  const resolution = resolveRetrieval({ text, exportGroups, ledgerGroups, slackFiles });

  if (resolution.status === "none") {
    return { kind: "not_found", reply: retrievalNotFoundText(), slackScopeMissing, resolution };
  }
  if (resolution.status === "ambiguous") {
    return { kind: "ambiguous", reply: retrievalAmbiguousText(resolution.candidates), candidates: resolution.candidates, slackScopeMissing, resolution };
  }

  const artifactPath = selectArtifactPath(resolution.match.artifactPaths);
  if (!artifactPath) {
    return { kind: "not_found", reply: retrievalNotFoundText(), slackScopeMissing, resolution };
  }
  // Mixed "find the existing X and build a new one": deliver the existing
  // file now and say honestly that the build is a separate ask — never
  // silently drop it, never promise an automatic build.
  const asksToBuild = /\b(build|create|make|generate|draft|write)\b/.test(String(text).toLowerCase());
  const message = asksToBuild
    ? `${retrievalDeliveredText()} For the new version you mentioned, send that as its own request and I'll take it through the build lane.`
    : retrievalDeliveredText();
  const receipt = await sendArtifact({
    artifactPath,
    title: prettyName(resolution.match),
    message,
  });
  return { kind: "delivered", receipt, artifactPath, match: resolution.match, slackScopeMissing, resolution };
}
