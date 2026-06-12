/**
 * RESEARCH GATE — the deterministic heart of the anti-fabrication contract.
 *
 * evaluateGate() is a PURE function: no LLM, no network, no clock, no config
 * that changes verdict rules. Same brief in -> same verdict out, byte for
 * byte. Hardened after the 2026-06-12 adversarial review (4 skeptics, all
 * refuted v1):
 *
 *   1. STRUCTURE            — the brief is shape-valid (schema rb-1).
 *   2. UNIVERSAL CITATION   — EVERY claim (no materiality tiering: the v1
 *                             "soft" tier was a total bypass for numberless
 *                             fabrications and lowercase brands) must cite
 *                             >= 1 evidence id that resolves to the pool.
 *   3. NUMBER PRESENCE      — every digit-group asserted by ANY claim must
 *                             appear verbatim (post-normalisation) in at
 *                             least one excerpt it cites. Fabricated
 *                             precision dies here. (Deliberately
 *                             fail-closed: "roughly half" never licenses
 *                             "47%".)
 *   4. CLAIM TEXT HYGIENE   — no URLs, markdown links, fake source markers,
 *                             or code fences inside claim text (the v1 link-
 *                             injection hole).
 *   5. GAP-NOTE HYGIENE     — gapNotes are meta-commentary; digits, entity
 *                             runs, URLs in a gapNote are an uncited-fact
 *                             smuggling channel and reject.
 *   6. COVERAGE HONESTY     — per-section coverage equals the deterministic
 *                             recompute from DEDUPED evidence (the v1
 *                             duplicate-id inflation hole); THIN/NONE carry
 *                             their honest flag; NONE sections carry no
 *                             claims at all.
 *   7. DEGRADED HONESTY     — a brief built during a search-backend outage
 *                             must say so: the client render carries the
 *                             incomplete-sweep notice, never the "no data
 *                             exists" copy (the v1 outage-laundering hole).
 *   8. CLIENT HYGIENE       — the client render leaks no evidence markers,
 *                             paths, vault handles, or internal call
 *                             participant names (doc-converter hard rule).
 *
 * What this gate deliberately does NOT claim to do: prove that a cited
 * excerpt semantically ENTAILS the claim (unit swaps, negation flips,
 * mentions-vs-supports). That is impossible deterministically; the engine
 * closes it with a separate, fail-closed entailment verification stage
 * (see grounded-research.mjs). The gate is the floor, not the ceiling.
 */

export const RESEARCH_BRIEF_SCHEMA_VERSION = "rb-1";

// Coverage thresholds — constants, not options (gate determinism).
export const COVERAGE_MATCHED_MIN_RELEVANCE = 0.7;
export const COVERAGE_MATCHED_PAIR_RELEVANCE = 0.55;

// The literal incomplete-sweep sentence shared by renderer and gate, so the
// honesty requirement is a string-equality check, not a vibe.
export const SEARCH_INCOMPLETE_NOTICE =
  "Note: the research sweep behind this document was incomplete (a search backend was unavailable); gaps below may reflect the outage, not the market.";

// Words that never count as leak-risk name tokens or entity-run members.
const ENTITY_ALLOWLIST = new Set([
  "undeniable", "rhys", "livingstone", "atlas", "australia", "australian",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "coverage", "thin", "none", "matched", "executive", "summary",
]);

// Capitalised English homographs that are usually NOT person names — kept out
// of the call-participant leak check to avoid blocking ordinary prose.
const NAME_HOMOGRAPHS = new Set(["will", "may", "mark", "grace", "hope", "art", "bill", "rob", "pat", "summer", "june", "august"]);

// Generic words that appear in vault document titles but are not names.
const TITLE_NOISE = new Set([
  "call", "calls", "kickoff", "triage", "playbook", "price", "raise", "retention",
  "resource", "week", "session", "notes", "intelligence", "competitor", "strategy",
  "mentoring", "onboarding", "review", "plan", "report", "summary", "index",
]);

const COMPARATIVE_TRIGGERS = /\b(cheapest|priciest|largest|biggest|smallest|fastest|slowest|leading|dominant|#1|number one|market leader|most popular|best[- ]known|top[- ]rated|majority|fastest[- ]growing|highest|lowest|average|typical|median)\b/i;

const ATTRIBUTION_TRIGGERS = /\b(according to|reported|reports|study|studies|survey|surveys|research shows|data shows|statistics|census|claims that|announced)\b/i;

/**
 * Materiality classifier. After the v1 review this is DESCRIPTIVE metadata
 * (prompting, stats, repair messaging) — NOT a security boundary. The gate
 * requires citations on every claim regardless of kind.
 */
export function classifyClaim(text = "") {
  const triggers = [];
  const value = foldNumerals(text);
  if (/\d/.test(value)) triggers.push("digits");
  if (COMPARATIVE_TRIGGERS.test(value)) triggers.push("comparative");
  if (ATTRIBUTION_TRIGGERS.test(value)) triggers.push("attribution");

  const tokens = value.split(/\s+/);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const a = tokens[i];
    const b = tokens[i + 1] || "";
    const isCap = (t) => /^[A-Z][A-Za-z0-9&'-]*$/.test(t.replace(/[.,;:!?)"]+$/, ""));
    if (isCap(a) && isCap(b)) {
      const aClean = a.toLowerCase().replace(/[^a-z]/g, "");
      const bClean = b.toLowerCase().replace(/[^a-z]/g, "");
      if (!ENTITY_ALLOWLIST.has(aClean) || !ENTITY_ALLOWLIST.has(bClean)) {
        triggers.push("entity-run");
        break;
      }
    }
  }
  return { kind: triggers.length ? "material" : "soft", triggers };
}

/**
 * Fold Unicode numerals to ASCII before any digit logic. NFKC handles
 * fullwidth (４７) and superscripts (⁴⁷); Arabic-Indic and Extended
 * Arabic-Indic do not NFKC-fold, so they are mapped explicitly. Without this
 * fold, homoglyph digits silently void the number-presence guarantee (round-2
 * adversarial finding).
 */
export function foldNumerals(text = "") {
  return String(text)
    .normalize("NFKC")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

/**
 * Extract normalised digit-groups: folds Unicode numerals, strips currency
 * symbols and thousands separators, trims fractional trailing zeros so
 * "47.50" === "47.5" and "47.00" === "47".
 */
export function digitGroups(text = "") {
  const normalized = foldNumerals(text).replace(/[$€£]|A\$/g, "").replace(/(\d),(\d)/g, "$1$2");
  return (normalized.match(/\d+(?:\.\d+)?/g) || []).map((g) => {
    if (!g.includes(".")) return g;
    return g.replace(/0+$/, "").replace(/\.$/, "");
  });
}

/** Deterministic per-section coverage from DEDUPED evidence items. */
export function coverageForEvidence(evidenceItems = []) {
  const seen = new Set();
  const items = evidenceItems.filter(Boolean).filter((e) => {
    const key = e.id ?? e;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (items.length === 0) return "none";
  const strong = items.filter((e) => (e.relevance ?? 0) >= COVERAGE_MATCHED_MIN_RELEVANCE);
  const medium = items.filter((e) => (e.relevance ?? 0) >= COVERAGE_MATCHED_PAIR_RELEVANCE);
  if (strong.length >= 1 || medium.length >= 2) return "matched";
  return "thin";
}

/** Claim-text hygiene: link/URL/source-marker/fence injection (v1 hole). */
export function claimTextViolations(text = "") {
  const value = String(text);
  const violations = [];
  if (/https?:\/\//i.test(value)) violations.push("raw URL");
  if (/\]\(/.test(value)) violations.push("markdown link");
  if (/\[\s*source/i.test(value)) violations.push("fake source marker");
  if (/```|~~~/.test(value)) violations.push("code fence");
  if (/<\/?[a-z][^>]*>/i.test(value)) violations.push("html tag");
  return violations;
}

/**
 * Person-name leak candidates from vault evidence. Used to enforce the
 * doc-converter hard rule: client documents never name internal call
 * participants.
 *
 * Names are mined ONLY from the PARTICIPANT SEGMENT of call-shaped titles —
 * the text before an "x Rhys" / "& Rhys" / "and Rhys" connector ("Tommy &
 * Rhys Kickoff Call" -> "Tommy"; "Will and Mikki Crozier x Rhys" -> Mikki,
 * Crozier). Mining ALL capitalised title tokens (the v1 behaviour) put
 * generic words from playbook titles — "The", "Fitness", "Business" — on the
 * denylist, which made "Anytime Fitness" unwritable and every real build
 * unconvergeable (live-smoke finding). Generic document titles contribute
 * nothing; only call documents name participants.
 */
const CALL_TITLE_CONNECTOR = /\s+(?:x|&|and)\s+Rhys\b/i;

export function vaultNameDenylist(evidence = []) {
  const names = new Set();
  for (const e of evidence) {
    if (e.provenance !== "vault") continue;
    const title = String(e.title || "").replace(/\.[a-z]+$/i, "");
    const handle = String(e.handle || "").replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ");
    for (const raw of [title, handle]) {
      const match = CALL_TITLE_CONNECTOR.exec(raw);
      if (!match) continue;
      const participantSegment = raw.slice(0, match.index);
      for (const token of participantSegment.split(/[^A-Za-z]+/)) {
        if (!/^[A-Z][a-z]{2,}$/.test(token)) continue;
        const lower = token.toLowerCase();
        if (ENTITY_ALLOWLIST.has(lower) || TITLE_NOISE.has(lower) || NAME_HOMOGRAPHS.has(lower)) continue;
        names.add(token);
      }
    }
  }
  return [...names];
}

function offender(list, id, reason) {
  list.push({ id, reason });
}

/**
 * The gate. brief = the structured ResearchBrief (source of truth);
 * clientMarkdown = the provenance-stripped render (checked for hygiene +
 * degraded honesty).
 */
export function evaluateGate({ brief, clientMarkdown = "" } = {}) {
  const checks = [];
  const rejectedClaimIds = new Set();

  // 1. STRUCTURE
  const structural = [];
  if (!brief || typeof brief !== "object") offender(structural, "brief", "brief is not an object");
  else {
    if (brief.schemaVersion !== RESEARCH_BRIEF_SCHEMA_VERSION) offender(structural, "schemaVersion", `expected ${RESEARCH_BRIEF_SCHEMA_VERSION}`);
    if (!Array.isArray(brief.evidence)) offender(structural, "evidence", "missing evidence array");
    if (!Array.isArray(brief.sections)) offender(structural, "sections", "missing sections array");
    if (!Array.isArray(brief.claims)) offender(structural, "claims", "missing claims array");
  }
  checks.push({ id: "structure", ok: structural.length === 0, offenders: structural });
  if (structural.length) {
    return { verdict: "reject", checks, rejectedClaimIds: [] };
  }

  const poolById = new Map(brief.evidence.map((e) => [e.id, e]));
  const sectionById = new Map(brief.sections.map((s) => [s.id, s]));

  // 2. UNIVERSAL CITATION + 3. NUMBER PRESENCE + 4. CLAIM TEXT HYGIENE
  const referential = [];
  const numberPresence = [];
  const textHygiene = [];
  for (const claim of brief.claims) {
    const evidenceIds = [...new Set(Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [])];
    const resolved = evidenceIds.map((id) => poolById.get(id)).filter(Boolean);
    const dangling = evidenceIds.filter((id) => !poolById.has(id));
    if (dangling.length) {
      offender(referential, claim.id, `dangling evidenceIds: ${dangling.join(",")}`);
      rejectedClaimIds.add(claim.id);
    }
    if (!sectionById.has(claim.sectionId)) {
      offender(referential, claim.id, `unknown sectionId: ${claim.sectionId}`);
      rejectedClaimIds.add(claim.id);
    }
    // UNIVERSAL: every claim — "soft" included — must carry a real citation.
    if (resolved.length === 0) {
      offender(referential, claim.id, "claim carries no resolvable citation (every claim must cite the pool — no exceptions)");
      rejectedClaimIds.add(claim.id);
    } else {
      const claimGroups = digitGroups(claim.text);
      if (claimGroups.length) {
        const excerptGroups = new Set(resolved.flatMap((e) => digitGroups(e.excerpt || "")));
        const missing = claimGroups.filter((g) => !excerptGroups.has(g));
        if (missing.length) {
          offender(numberPresence, claim.id, `asserted numbers [${missing.join(",")}] not present in any cited excerpt`);
          rejectedClaimIds.add(claim.id);
        }
      }
    }
    const violations = claimTextViolations(claim.text);
    if (violations.length) {
      offender(textHygiene, claim.id, `claim text contains: ${violations.join(", ")}`);
      rejectedClaimIds.add(claim.id);
    }
  }
  checks.push({ id: "referential_integrity", ok: referential.length === 0, offenders: referential });
  checks.push({ id: "number_presence", ok: numberPresence.length === 0, offenders: numberPresence });
  checks.push({ id: "claim_text_hygiene", ok: textHygiene.length === 0, offenders: textHygiene });

  // 5. GAP-NOTE HYGIENE — meta-commentary only; no smuggled facts.
  const gapHygiene = [];
  for (const section of brief.sections) {
    const note = section.gapNote;
    if (!note) continue;
    const classified = classifyClaim(note);
    if (classified.triggers.includes("digits") || classified.triggers.includes("entity-run")) {
      offender(gapHygiene, section.id, `gapNote smuggles uncited specifics (${classified.triggers.join(",")}) — gap notes must stay meta`);
    }
    if (claimTextViolations(note).length) {
      offender(gapHygiene, section.id, "gapNote contains links/markers/fences");
    }
  }
  checks.push({ id: "gapnote_hygiene", ok: gapHygiene.length === 0, offenders: gapHygiene });

  // 6. COVERAGE HONESTY (deduped recompute; NONE sections carry NO claims)
  const coverage = [];
  for (const section of brief.sections) {
    const sectionClaims = brief.claims.filter((c) => c.sectionId === section.id);
    const citedEvidence = [...new Set(sectionClaims.flatMap((c) => c.evidenceIds || []))]
      .map((id) => poolById.get(id))
      .filter(Boolean);
    const allocated = Array.isArray(section.allocatedEvidenceIds)
      ? [...new Set(section.allocatedEvidenceIds)].map((id) => poolById.get(id)).filter(Boolean)
      : citedEvidence;
    const recomputed = coverageForEvidence(allocated.length ? allocated : citedEvidence);
    if (section.coverage !== recomputed) {
      offender(coverage, section.id, `coverage says "${section.coverage}" but evidence recomputes to "${recomputed}"`);
    }
    if (section.coverage !== "matched" && section.honestGap !== true) {
      offender(coverage, section.id, `coverage "${section.coverage}" must carry honestGap:true`);
    }
    if (section.coverage === "none" && sectionClaims.length) {
      offender(coverage, section.id, `NONE-coverage section carries ${sectionClaims.length} claim(s) — none means none`);
      sectionClaims.forEach((c) => rejectedClaimIds.add(c.id));
    }
  }
  checks.push({ id: "coverage_honesty", ok: coverage.length === 0, offenders: coverage });

  // 7. DEGRADED HONESTY — an outage may never masquerade as "no data exists".
  const degradedCheck = [];
  const isDegraded = Boolean(brief.degraded?.vault || brief.degraded?.web);
  if (isDegraded && !String(clientMarkdown).includes(SEARCH_INCOMPLETE_NOTICE)) {
    offender(degradedCheck, "client", "search was degraded but the client render omits the incomplete-sweep notice");
  }
  checks.push({ id: "degraded_honesty", ok: degradedCheck.length === 0, offenders: degradedCheck });

  // 8. CLIENT HYGIENE
  const hygiene = [];
  const client = String(clientMarkdown || "");
  if (/\[E[A-Za-z0-9]+\]/.test(client)) offender(hygiene, "client", "evidence markers leak into client render");
  if (/\/Users\//.test(client)) offender(hygiene, "client", "filesystem path leaks into client render");
  for (const e of brief.evidence) {
    if (e.provenance === "vault" && e.handle && client.includes(e.handle)) {
      offender(hygiene, "client", `vault handle "${e.handle}" leaks into client render`);
      break;
    }
  }
  for (const name of vaultNameDenylist(brief.evidence)) {
    if (new RegExp(`\\b${name}\\b`).test(client)) {
      offender(hygiene, "client", `internal call participant name "${name}" leaks into client render (doc-converter hard rule)`);
    }
  }
  checks.push({ id: "client_hygiene", ok: hygiene.length === 0, offenders: hygiene });

  const verdict = checks.every((c) => c.ok) ? "pass" : "reject";
  return { verdict, checks, rejectedClaimIds: [...rejectedClaimIds] };
}
