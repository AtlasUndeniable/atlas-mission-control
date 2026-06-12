/**
 * PROOF HARNESS — grounded research engine + anti-fabrication gate (slice 1).
 *
 * Runs ENTIRELY against fixtures: stubbed vault search, stubbed web search,
 * scripted LLM + entailment-verifier stubs. Zero network, zero file writes,
 * zero Slack, zero API spend. The flagship case is the live failing request:
 * "build me a competitor teardown pdf for gym owners".
 *
 * DONE criteria + one pinned regression per adversarial-review finding
 * (4 skeptics refuted v1; every hole is a named SKEPTIC-* test here).
 *
 * Run: node --test tests/grounded-research-proof.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPETITOR_TEARDOWN_SCHEMA,
  extractRequestTerms,
  parseJsonObject,
  renderClientMarkdown,
  runGroundedResearch,
} from "../openclaw-runtime/workspace/lib/grounded-research.mjs";
import {
  classifyClaim,
  claimTextViolations,
  coverageForEvidence,
  digitGroups,
  evaluateGate,
  vaultNameDenylist,
  SEARCH_INCOMPLETE_NOTICE,
} from "../openclaw-runtime/workspace/lib/research-gate.mjs";

const REQUEST = "build me a competitor teardown pdf for gym owners";

// ── Fixture world ────────────────────────────────────────────────────────────
function fixtureRetrieveVault(query) {
  const chunks = [];
  if (/playbook|differentiation retention/.test(query)) {
    chunks.push(
      { source: "pricing-playbook.md", title: "Price Raise Playbook", content: "Undeniable's price raise playbook: anchor against franchise pricing, never compete on price. Position coaching outcomes against the $15 per week big-box baseline.", relevance: 0.78, category: "playbook" },
      { source: "retention-playbook.md", title: "Retention Playbook", content: "Retention lever one: 90-day onboarding arc. Owners who run structured check-ins keep clients past the industry cliff.", relevance: 0.66, category: "playbook" },
    );
  }
  if (/competitors market|franchises/.test(query)) {
    chunks.push(
      { source: "2025-12-08-Tommy-Rhys-Kickoff-Call.md", title: "Tommy & Rhys Kickoff Call", content: "Owner call: the studio competes with two Anytime Fitness franchises and an F45 within 3 km. The franchise gyms win on price and hours, never on coaching.", relevance: 0.71, category: "fireflies" },
    );
  }
  if (/membership pricing|price comparison/.test(query)) {
    chunks.push(
      { source: "2026-03-04-Will-and-Mikki-Crozier-x-Rhys.md", title: "Will and Mikki Crozier x Rhys", content: "Owner call benchmark: local semi-private at 89 per week against PT studios charging 120 per session block.", relevance: 0.58, category: "fireflies" },
    );
  }
  return { chunks, degraded: false };
}

function fixtureSearchWeb(query) {
  const results = [];
  if (/membership pricing|price comparison/.test(query)) {
    results.push(
      { title: "Gym membership prices Australia 2026", url: "https://example.com/gym-prices-au", description: "Big-box chains average $15 to $20 per week. Anytime Fitness sits near $18 per week on a 12-month term; F45 group training runs $55 to $65 per week.", age: "2 weeks ago" },
    );
  }
  if (/competitors market|franchises/.test(query)) {
    results.push(
      { title: "Fitness franchise landscape report", url: "https://example.com/franchise-landscape", description: "Anytime Fitness, F45 Training and Snap Fitness dominate Australian suburbs; boutique studios compete on community and coaching depth.", age: "1 month ago" },
    );
  }
  if (/local competition franchise/.test(query)) {
    results.push(
      { title: "Independent gyms vs franchises", url: "https://example.com/indie-vs-franchise", description: "Franchise gyms leverage brand and 24/7 access; independents win retention through coaching relationships.", age: "3 months ago" },
    );
  }
  if (/marketing positioning|lead generation/.test(query)) {
    results.push(
      { title: "How gyms position against big-box", url: "https://example.com/gym-positioning", description: "Successful studios position on outcomes and accountability rather than access; six-week challenge offers remain the dominant acquisition play.", age: "2 months ago" },
    );
  }
  return { results, degraded: false };
}

function parsePool(prompt) {
  const pool = [];
  const re = /^(E\d+) \[(vault|web)[^\]]*\] (.+)\n {3}(.+)$/gm;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    pool.push({ alias: m[1], provenance: m[2], title: m[3], excerpt: m[4] });
  }
  return pool;
}

function aliasWhereExcerptMatches(pool, regex) {
  const hit = pool.find((p) => regex.test(p.excerpt) || regex.test(p.title));
  return hit ? hit.alias : null;
}

// The OBEDIENT stub: grounded claims, verbatim numbers, every claim cited.
function obedientSections(prompt) {
  const pool = parsePool(prompt);
  const priceWeb = aliasWhereExcerptMatches(pool, /\$18 per week/);
  const franchiseWeb = aliasWhereExcerptMatches(pool, /Snap Fitness/);
  const indieWeb = aliasWhereExcerptMatches(pool, /24\/7 access/);
  const positioningWeb = aliasWhereExcerptMatches(pool, /six-week challenge/);
  const kickoffVault = aliasWhereExcerptMatches(pool, /two Anytime Fitness franchises/);
  const playbookVault = aliasWhereExcerptMatches(pool, /price raise playbook/i);
  const crozierVault = aliasWhereExcerptMatches(pool, /89 per week/);
  return [
    { id: "executive-summary", claims: [
      { text: "Franchise gyms compete on price and access while independent studios win on coaching depth and retention.", kind: "soft", evidence: [franchiseWeb, indieWeb].filter(Boolean) },
    ], gapNote: null },
    { id: "competitor-set", claims: [
      { text: "Anytime Fitness, F45 Training and Snap Fitness dominate Australian suburban markets.", kind: "material", evidence: [franchiseWeb].filter(Boolean) },
      { text: "Owner calls report studios competing directly with two Anytime Fitness franchises and an F45 within 3 km.", kind: "material", evidence: [kickoffVault].filter(Boolean) },
    ], gapNote: null },
    { id: "offers-pricing", claims: [
      { text: "Anytime Fitness sits near $18 per week on a 12-month term, while F45 group training runs $55 to $65 per week.", kind: "material", evidence: [priceWeb].filter(Boolean) },
      { text: "Owner calls have benchmarked local semi-private at 89 per week against PT studios charging 120 per session block.", kind: "material", evidence: [crozierVault].filter(Boolean) },
    ], gapNote: null },
    { id: "positioning-marketing", claims: [
      { text: "Successful studios position on outcomes and accountability rather than access, with six-week challenge offers the dominant acquisition play.", kind: "material", evidence: [positioningWeb].filter(Boolean) },
    ], gapNote: null },
    { id: "local-vs-franchise", claims: [
      { text: "Franchises leverage brand and 24/7 access while independents win retention through coaching relationships.", kind: "material", evidence: [indieWeb].filter(Boolean) },
    ], gapNote: "Single public source; verify against local market data before client use." },
    { id: "undeniable-angle", claims: [
      { text: "The house playbook anchors against franchise pricing and positions coaching outcomes against the $15 per week big-box baseline rather than competing on price.", kind: "material", evidence: [playbookVault].filter(Boolean) },
    ], gapNote: null },
    { id: "recommendations", claims: [
      { text: "Position against the franchise price anchor with outcome-led offers instead of discounting.", kind: "soft", evidence: [playbookVault, positioningWeb].filter(Boolean) },
    ], gapNote: null },
  ];
}

const obedientLlm = () => async ({ prompt }) => JSON.stringify({ sections: obedientSections(prompt) });

// Entailment stubs: approveAll trusts every claim; honest stubs flag specific texts.
const approveAll = async ({ claims }) => ({ verdicts: claims.map((c) => ({ id: c.id, supported: true })) });
const flagMatching = (regex, reason) => async ({ claims }) => ({
  verdicts: claims.map((c) => ({ id: c.id, supported: !regex.test(c.text), reason })),
});

function engineOpts(llm, overrides = {}) {
  return {
    request: REQUEST,
    retrieveVault: async (q) => fixtureRetrieveVault(q),
    searchWeb: async (q) => fixtureSearchWeb(q),
    llm,
    verifyClaims: approveAll,
    now: () => new Date("2026-06-12T07:00:00.000Z"),
    ...overrides,
  };
}

// ── DONE 1: flagship teardown — cited, honest, gate + verification pass ─────
test("DONE-1: teardown request => cited brief, thin/none honest, gate PASS", async () => {
  const result = await runGroundedResearch(engineOpts(obedientLlm()));
  assert.equal(result.ok, true, JSON.stringify(result.gate?.checks, null, 1));
  assert.equal(result.status, "completed");
  assert.equal(result.gate.verdict, "pass");
  assert.ok(result.brief.claims.length >= 6, "substantive brief");
  for (const claim of result.brief.claims) {
    assert.ok(claim.evidenceIds.length >= 1, `uncited claim: ${claim.text}`);
    for (const id of claim.evidenceIds) {
      assert.ok(result.brief.evidence.some((e) => e.id === id), `dangling ${id}`);
    }
  }
  const retention = result.brief.sections.find((s) => s.id === "retention-economics");
  assert.equal(retention.coverage, "none");
  assert.equal(retention.honestGap, true);
  assert.match(result.internalMarkdown, /Coverage: NONE/);
  assert.match(result.internalMarkdown, /Nothing has been fabricated/);
  const thin = result.brief.sections.find((s) => s.id === "local-vs-franchise");
  assert.equal(thin.coverage, "thin");
  assert.match(result.internalMarkdown, /Coverage: THIN/);
  // R2: synthesisOnly coverage derives from what its claims CITE, not the
  // whole pool — the exec summary cites two web snippets, so it stays hedged.
  const exec = result.brief.sections.find((s) => s.id === "executive-summary");
  assert.equal(exec.coverage, "thin", "one strong pool item must not launder the exec summary to matched");
  assert.match(result.clientMarkdown, /## Executive Summary\n\n_Note: public data on this section is limited/);
  const recs = result.brief.sections.find((s) => s.id === "recommendations");
  assert.equal(recs.coverage, "matched", "recommendations cite the strong playbook and earn matched");
  assert.match(result.internalMarkdown, /\[E\d+/);
  assert.match(result.internalMarkdown, /## Sources/);
  const angle = result.brief.claims.filter((c) => c.sectionId === "undeniable-angle");
  assert.ok(angle.length >= 1);
  assert.ok(angle.every((c) => c.evidenceIds.every((id) => result.brief.evidence.find((e) => e.id === id)?.provenance === "vault")));
  assert.equal(result.brief.verification.unsupportedClaimIds.length, 0);
});

// ── DONE 2: healthy search, genuinely nothing => honest empty, zero calls ───
test("DONE-2: no-grounding request => honest output, LLM and verifier never called", async () => {
  let llmCalls = 0;
  const result = await runGroundedResearch(engineOpts(
    async () => { llmCalls += 1; throw new Error("must not be called"); },
    {
      retrieveVault: async () => ({ chunks: [], degraded: false }),
      searchWeb: async () => ({ results: [], degraded: false }),
      verifyClaims: async () => { throw new Error("must not be called"); },
    },
  ));
  assert.equal(llmCalls, 0);
  assert.equal(result.budget.llmCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed_with_gaps");
  assert.equal(result.honestEmpty, true);
  assert.equal(result.brief.claims.length, 0);
  assert.ok(result.brief.sections.every((s) => s.coverage === "none" && s.honestGap === true));
  assert.match(result.clientMarkdown, /open question/);
  assert.equal(result.gate.verdict, "pass", "honesty is never blocked");
});

// ── DONE 3: fabricators die — deterministically, every variant ──────────────
test("DONE-3a: fabricated numbers + dangling citations => reject every round, no client render", async () => {
  const fabricator = async ({ prompt }) => {
    const pool = parsePool(prompt);
    const anyAlias = pool[0]?.alias || "E1";
    return JSON.stringify({ sections: [
      { id: "offers-pricing", claims: [
        { text: "Anytime Fitness churns 71% of members within 6 months.", kind: "material", evidence: [anyAlias] },
        { text: "Snap Fitness raised prices to $31 per week nationally.", kind: "material", evidence: ["E999"] },
      ], gapNote: null },
    ] });
  };
  const result = await runGroundedResearch(engineOpts(fabricator, { maxRepairRounds: 2 }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "insufficient_grounding");
  assert.equal(result.gate.verdict, "reject");
  assert.equal(result.budget.llmCalls, 3, "initial + 2 bounded repairs, no verifier spend on rejected rounds");
  assert.equal(result.clientMarkdown, "", "fail-closed: nothing shippable after rejection");
  const checkIds = result.gate.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.ok(checkIds.includes("referential_integrity"));
  assert.ok(checkIds.includes("number_presence"));
});

test("SKEPTIC-F1: numberless uncited 'soft' fabrication is rejected (universal citation)", async () => {
  const softFabricator = async ({ prompt }) => {
    const sections = obedientSections(prompt);
    sections[0].claims.push({ text: "Every major franchise is quietly bleeding members and on the verge of regional collapse.", kind: "soft", evidence: [] });
    return JSON.stringify({ sections });
  };
  const result = await runGroundedResearch(engineOpts(softFabricator, { maxRepairRounds: 0 }));
  assert.equal(result.ok, false);
  assert.equal(result.clientMarkdown, "");
  const referential = result.gate.checks.find((c) => c.id === "referential_integrity");
  assert.equal(referential.ok, false);
  assert.match(JSON.stringify(referential.offenders), /no resolvable citation/);
});

test("SKEPTIC-F4: markdown/link injection in claim text is rejected", async () => {
  const injector = async ({ prompt }) => {
    const sections = obedientSections(prompt);
    const cited = sections[1].claims[0].evidence;
    sections[1].claims.push({ text: "Industry consensus confirms the shift; read more at [the official report](https://evil.example/phish).", kind: "soft", evidence: cited });
    return JSON.stringify({ sections });
  };
  const result = await runGroundedResearch(engineOpts(injector, { maxRepairRounds: 0 }));
  assert.equal(result.ok, false);
  assert.equal(result.clientMarkdown, "");
  assert.equal(result.gate.checks.find((c) => c.id === "claim_text_hygiene").ok, false);
});

test("R2-GAPNOTE-DISCARD: model gapNotes are a dead channel — discarded, never rendered, deterministic notes only", async () => {
  const smuggler = async ({ prompt }) => {
    const sections = obedientSections(prompt);
    sections[4].gapNote = "Anytime Fitness lost 47% of members in 2025; Snap reportedly bled ４７ percent and is insolvent.";
    return JSON.stringify({ sections });
  };
  const result = await runGroundedResearch(engineOpts(smuggler));
  assert.equal(result.ok, true, "discarding the note leaves a clean build");
  assert.ok(!/insolvent|bled|bankrupt/.test(result.internalMarkdown), "smuggled facts never reach the internal render");
  assert.ok(!/insolvent|bled|bankrupt/.test(JSON.stringify(result.brief.sections)), "nor the structured brief");
  const thinNote = result.brief.sections.find((s) => s.id === "local-vs-franchise").gapNote;
  assert.match(thinNote, /treat as directional/, "deterministic gap note in place");
});

test("R2-VERDICT-DUP: a duplicate verifier verdict cannot flip an unsupported claim back to shipped", async () => {
  const unitSwapper = async ({ prompt }) => {
    const pool = parsePool(prompt);
    const price = aliasWhereExcerptMatches(pool, /\$18 per week/);
    return JSON.stringify({ sections: [
      { id: "offers-pricing", claims: [
        { text: "Anytime Fitness costs just $18 per month on a 12-month term.", kind: "material", evidence: [price].filter(Boolean) },
      ], gapNote: null },
    ] });
  };
  const duplicitous = async ({ claims }) => ({ verdicts: [
    { id: claims[0].id, supported: false, reason: "unit swap: source says per week" },
    { id: claims[0].id, supported: true },
  ] });
  const result = await runGroundedResearch(engineOpts(unitSwapper, { verifyClaims: duplicitous, maxRepairRounds: 0 }));
  assert.equal(result.ok, false, "any false verdict for an id keeps the claim unsupported");
  assert.equal(result.clientMarkdown, "");

  // and a stringy "true" is not support either
  const stringy = async ({ claims }) => ({ verdicts: claims.map((c) => ({ id: c.id, supported: "true" })) });
  const result2 = await runGroundedResearch(engineOpts(unitSwapper, { verifyClaims: stringy, maxRepairRounds: 0 }));
  assert.equal(result2.ok, false);
});

test("R2-HOMOGLYPH: Unicode numerals fold to ASCII — fullwidth digits cannot dodge number presence", () => {
  assert.deepEqual(digitGroups("churn reached ４７%"), ["47"]);
  assert.deepEqual(digitGroups("share fell to ٤٧ percent"), ["47"]);
  assert.equal(classifyClaim("churn reached ４７ percent this year").triggers.includes("digits"), true);
  const brief = {
    schemaVersion: "rb-1",
    evidence: [{ id: "ev_a", provenance: "web", url: "https://x", title: "src", excerpt: "membership trends discussed broadly", relevance: 0.8 }],
    sections: [{ id: "s", title: "S", coverage: "matched", allocatedEvidenceIds: ["ev_a"] }],
    claims: [{ id: "c1", sectionId: "s", text: "Franchise churn reached ４７% this year.", kind: "material", evidenceIds: ["ev_a"] }],
  };
  const verdict = evaluateGate({ brief });
  assert.equal(verdict.verdict, "reject");
  assert.equal(verdict.checks.find((c) => c.id === "number_presence").ok, false);
});

test("SKEPTIC-ENTAIL: negation-flip with matching digits passes the gate but dies at verification", async () => {
  const flipper = async ({ prompt }) => {
    const pool = parsePool(prompt);
    const indie = aliasWhereExcerptMatches(pool, /24\/7 access/);
    return JSON.stringify({ sections: [
      { id: "local-vs-franchise", claims: [
        // excerpt says franchises LEVERAGE 24/7 access; the claim flips it
        { text: "Franchise gyms do not offer 24/7 access.", kind: "material", evidence: [indie].filter(Boolean) },
      ], gapNote: null },
    ] });
  };
  const result = await runGroundedResearch(engineOpts(flipper, {
    verifyClaims: flagMatching(/do not offer/, "polarity flip: excerpt asserts the opposite"),
    maxRepairRounds: 0,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "insufficient_grounding");
  assert.equal(result.clientMarkdown, "");
  assert.ok(result.brief.verification.unsupportedClaimIds.length >= 1);
});

test("SKEPTIC-ENTAIL-REPAIR: verification rejection feeds the repair loop and recovers", async () => {
  let round = 0;
  const llm = async ({ prompt }) => {
    round += 1;
    if (round === 1) {
      const pool = parsePool(prompt);
      const price = aliasWhereExcerptMatches(pool, /\$18 per week/);
      return JSON.stringify({ sections: [
        { id: "offers-pricing", claims: [
          { text: "Anytime Fitness costs $18 per month, an unbeatable 12-month value.", kind: "material", evidence: [price].filter(Boolean) }, // unit swap, digits match
        ], gapNote: null },
      ] });
    }
    return obedientLlm()({ prompt });
  };
  const result = await runGroundedResearch(engineOpts(llm, {
    verifyClaims: flagMatching(/per month/, "unit swap: source says per week"),
  }));
  assert.equal(result.ok, true, "repair recovered after the unit swap was flagged");
  assert.ok(!JSON.stringify(result.brief.claims).includes("per month"));
});

test("R2-LLM-DOWN: synthesis model unavailable => fail closed, no crash, nothing ships", async () => {
  const result = await runGroundedResearch(engineOpts(async () => { throw new Error("ECONNREFUSED api.anthropic.com"); }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "synthesis_unavailable");
  assert.equal(result.clientMarkdown, "");
  assert.equal(result.gate.verdict, "reject");
});

test("SKEPTIC-VERIFIER-DOWN: entailment verifier unavailable => fail closed, nothing ships", async () => {
  const result = await runGroundedResearch(engineOpts(obedientLlm(), {
    verifyClaims: async () => { throw new Error("verifier offline"); },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "verification_unavailable");
  assert.equal(result.clientMarkdown, "");
});

test("DONE-3c: repair loop recovers when the model drops its fabrication", async () => {
  let round = 0;
  const repenting = async ({ prompt }) => {
    round += 1;
    if (round === 1) {
      return JSON.stringify({ sections: [
        { id: "offers-pricing", claims: [
          { text: "Gym memberships average $999 per week.", kind: "material", evidence: ["E1"] },
        ], gapNote: null },
      ] });
    }
    return obedientLlm()({ prompt });
  };
  const result = await runGroundedResearch(engineOpts(repenting));
  assert.equal(result.ok, true);
  assert.equal(result.budget.llmCalls, 3, "synth + repair synth + one verification on the passing round");
  assert.ok(!JSON.stringify(result.brief.claims).includes("999"));
});

// ── SKEPTIC: degraded-search honesty ─────────────────────────────────────────
test("SKEPTIC-O1: total search outage => ok:false search_unavailable, never 'nothing exists'", async () => {
  let llmCalls = 0;
  const result = await runGroundedResearch(engineOpts(
    async () => { llmCalls += 1; throw new Error("must not be called"); },
    {
      retrieveVault: async () => ({ chunks: [], degraded: true, error: "ECONNREFUSED" }),
      searchWeb: async () => ({ results: [], degraded: true, error: "503" }),
    },
  ));
  assert.equal(llmCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, "search_unavailable");
  assert.equal(result.clientMarkdown, "", "no deliverable can claim the world is empty when search was down");
});

test("SKEPTIC-O1b: partial outage => brief is stamped degraded and the client render carries the notice", async () => {
  const result = await runGroundedResearch(engineOpts(obedientLlm(), {
    searchWeb: async (q) => ({ ...fixtureSearchWeb(q), degraded: true }),
  }));
  assert.equal(result.ok, true, JSON.stringify(result.gate?.checks));
  assert.equal(result.brief.degraded.web, true);
  assert.ok(result.clientMarkdown.includes(SEARCH_INCOMPLETE_NOTICE));
  assert.match(result.internalMarkdown, /SEARCH DEGRADED/);
  // and the gate REJECTS a degraded brief whose client render omits the notice
  const tampered = evaluateGate({ brief: result.brief, clientMarkdown: result.clientMarkdown.replace(SEARCH_INCOMPLETE_NOTICE, "") });
  assert.equal(tampered.verdict, "reject");
  assert.equal(tampered.checks.find((c) => c.id === "degraded_honesty").ok, false);
});

test("SKEPTIC-O3: web-only evidence caps at THIN — two cold snippets never strip the hedge", async () => {
  const result = await runGroundedResearch(engineOpts(obedientLlm()));
  const positioning = result.brief.sections.find((s) => s.id === "positioning-marketing");
  assert.equal(positioning.coverage, "thin", "web-only section must stay hedged");
  const offers = result.brief.sections.find((s) => s.id === "offers-pricing");
  assert.equal(offers.coverage, "thin", "one mid-relevance vault call + snippets stays directional");
  const competitorSet = result.brief.sections.find((s) => s.id === "competitor-set");
  assert.equal(competitorSet.coverage, "matched", "a strong vault source still earns matched");
});

// ── SKEPTIC: gate determinism + inflation + leak edges ───────────────────────
test("SKEPTIC-D2: duplicate evidence ids cannot inflate THIN into MATCHED", () => {
  const brief = {
    schemaVersion: "rb-1",
    evidence: [{ id: "ev_a", provenance: "web", url: "https://x", title: "src", excerpt: "one source", relevance: 0.56 }],
    sections: [{ id: "s", title: "S", coverage: "matched", allocatedEvidenceIds: ["ev_a", "ev_a"] }],
    claims: [],
  };
  const verdict = evaluateGate({ brief });
  assert.equal(verdict.verdict, "reject");
  assert.equal(verdict.checks.find((c) => c.id === "coverage_honesty").ok, false);
});

test("R2-DENYLIST: generic document titles contribute nothing — 'Anytime Fitness' stays writable (live-smoke over-block)", () => {
  const evidence = [
    { id: "e1", provenance: "vault", handle: "operators-manual.md", title: "The Complete Autonomous Operator's Manual for an Online Fitness Coaching Business", excerpt: "x", relevance: 0.8 },
    { id: "e2", provenance: "vault", handle: "trend-analysis.md", title: "AI Training Dataset: Comprehensive Trend Analysis & Strategic Playbook", excerpt: "x", relevance: 0.8 },
    { id: "e3", provenance: "vault", handle: "2026-01-01-Will-and-Mikki-Crozier-x-Rhys.md", title: "Will and Mikki Crozier x Rhys", excerpt: "x", relevance: 0.8 },
  ];
  const denylist = vaultNameDenylist(evidence);
  for (const generic of ["The", "Fitness", "Business", "Analysis", "Strategic", "Complete", "Online"]) {
    assert.ok(!denylist.includes(generic), `generic word "${generic}" must never be denied`);
  }
  assert.ok(denylist.includes("Mikki") && denylist.includes("Crozier"), "real participants still caught");
});

test("SKEPTIC-I1: client render naming an internal call participant is rejected (doc-converter hard rule)", () => {
  const evidence = [
    { id: "ev_v", provenance: "vault", handle: "2025-12-08-Tommy-Rhys-Kickoff-Call.md", title: "Tommy & Rhys Kickoff Call", excerpt: "owner call content", relevance: 0.8 },
  ];
  assert.ok(vaultNameDenylist(evidence).includes("Tommy"));
  const brief = {
    schemaVersion: "rb-1",
    evidence,
    sections: [{ id: "s", title: "S", coverage: "matched", allocatedEvidenceIds: ["ev_v"] }],
    claims: [{ id: "c1", sectionId: "s", text: "Owner calls describe heavy franchise pressure.", kind: "soft", evidenceIds: ["ev_v"] }],
  };
  const leaking = evaluateGate({ brief, clientMarkdown: "# Brief\n- Tommy's studio faces heavy franchise pressure." });
  assert.equal(leaking.verdict, "reject");
  assert.match(JSON.stringify(leaking.checks.find((c) => c.id === "client_hygiene").offenders), /Tommy/);
  const clean = evaluateGate({ brief, clientMarkdown: "# Brief\n- Owner calls describe heavy franchise pressure." });
  assert.equal(clean.checks.find((c) => c.id === "client_hygiene").ok, true);
});

test("SKEPTIC-I2: synthesis unparseable every round => verdict reject (never a phantom pass), nothing ships", async () => {
  const chatterbox = async () => "I had trouble, here are some thoughts { unfinished";
  const result = await runGroundedResearch(engineOpts(chatterbox, { maxRepairRounds: 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "synthesis_unparseable");
  assert.equal(result.gate.verdict, "reject", "a never-evaluated build must not carry verdict:pass");
  assert.equal(result.clientMarkdown, "");
  assert.equal(result.internalMarkdown, "");
});

test("SKEPTIC-I3: fenced and chattered JSON still parses", async () => {
  const fenced = async ({ prompt }) => "Here you go!\n```json\n" + JSON.stringify({ sections: obedientSections(prompt) }) + "\n```\nHope that helps {smile}";
  const result = await runGroundedResearch(engineOpts(fenced));
  assert.equal(result.ok, true);
  assert.throws(() => parseJsonObject("no json here at all"));
});

// ── Gate unit edges ──────────────────────────────────────────────────────────
test("GATE: number normalisation — separators/currency/trailing-zeros pass, paraphrase fails closed", () => {
  assert.deepEqual(digitGroups("$1,200/mo and 47.50%"), ["1200", "47.5"]);
  const pool = [{ id: "ev_a", provenance: "web", url: "https://x", title: "src", excerpt: "memberships at 1200 AUD monthly, churn 47.5 percent", relevance: 0.8 }];
  const mk = (text) => ({
    schemaVersion: "rb-1",
    evidence: pool,
    sections: [{ id: "s", title: "S", coverage: "matched", allocatedEvidenceIds: ["ev_a"] }],
    claims: [{ id: "c1", sectionId: "s", text, kind: "material", evidenceIds: ["ev_a"] }],
  });
  assert.equal(evaluateGate({ brief: mk("Memberships cost $1,200 per month with churn at 47.50%.") }).verdict, "pass");
  const reject = evaluateGate({ brief: mk("Roughly 33% of owners pay monthly.") });
  assert.equal(reject.verdict, "reject");
  assert.ok(reject.checks.find((c) => c.id === "number_presence" && !c.ok));
});

test("GATE: coverage lies are rejected — 'matched' without evidence; ANY claims inside NONE", () => {
  const tampered = {
    schemaVersion: "rb-1",
    evidence: [],
    sections: [{ id: "s", title: "S", coverage: "matched", allocatedEvidenceIds: [] }],
    claims: [],
  };
  assert.equal(evaluateGate({ brief: tampered }).verdict, "reject");

  const noneWithClaims = {
    schemaVersion: "rb-1",
    evidence: [{ id: "ev_b", provenance: "web", url: "https://y", title: "t", excerpt: "soft filler text", relevance: 0.8 }],
    sections: [{ id: "s", title: "S", coverage: "none", honestGap: true, allocatedEvidenceIds: [] }],
    claims: [{ id: "c1", sectionId: "s", text: "A perfectly soft filler sentence.", kind: "soft", evidenceIds: ["ev_b"] }],
  };
  const v2 = evaluateGate({ brief: noneWithClaims });
  assert.equal(v2.verdict, "reject");
  assert.ok(v2.checks.find((c) => c.id === "coverage_honesty" && !c.ok));
});

test("GATE: claim text hygiene + classifier metadata behave", () => {
  assert.deepEqual(claimTextViolations("plain prose with $18 numbers"), []);
  assert.ok(claimTextViolations("see [link](https://x.example)").length >= 1);
  assert.ok(claimTextViolations("visit https://x.example now").length >= 1);
  assert.ok(claimTextViolations("as shown [source: leaked data]").length >= 1);
  assert.equal(classifyClaim("Anytime Fitness leads the suburban market.").kind, "material");
  assert.equal(classifyClaim("It is the cheapest option in most suburbs.").kind, "material");
  assert.equal(classifyClaim("According to industry reports, churn is rising.").kind, "material");
  assert.equal(classifyClaim("Independent studios tend to build deeper coaching relationships.").kind, "soft");
});

test("GATE: coverage tiers from evidence are deterministic", () => {
  assert.equal(coverageForEvidence([]), "none");
  assert.equal(coverageForEvidence([{ id: "a", relevance: 0.5 }]), "thin");
  assert.equal(coverageForEvidence([{ id: "a", relevance: 0.72 }]), "matched");
  assert.equal(coverageForEvidence([{ id: "a", relevance: 0.56 }, { id: "b", relevance: 0.6 }]), "matched");
  assert.equal(coverageForEvidence([{ id: "a", relevance: 0.56 }, { id: "a", relevance: 0.56 }]), "thin", "duplicates never inflate");
});

// ── Hygiene + determinism + budget ──────────────────────────────────────────
test("HYGIENE: client render — no markers/paths/handles/call-names; internal render fully cited", async () => {
  const result = await runGroundedResearch(engineOpts(obedientLlm()));
  assert.equal(result.ok, true);
  assert.ok(!/\[E\d/.test(result.clientMarkdown));
  assert.ok(!/\/Users\//.test(result.clientMarkdown));
  assert.ok(!/pricing-playbook\.md|Kickoff-Call\.md/.test(result.clientMarkdown));
  assert.ok(!/\bTommy\b|\bMikki\b/.test(result.clientMarkdown), "no internal call participants client-side");
  assert.match(result.clientMarkdown, /Undeniable internal knowledge base \(\d+ references?\)/);
  assert.match(result.clientMarkdown, /https:\/\/example\.com/);
  assert.match(result.internalMarkdown, /vault: pricing-playbook\.md/);
  assert.equal(renderClientMarkdown(result.brief), result.clientMarkdown);
});

test("DETERMINISM: identical inputs => identical brief JSON and identical verdict", async () => {
  const a = await runGroundedResearch(engineOpts(obedientLlm()));
  const b = await runGroundedResearch(engineOpts(obedientLlm()));
  assert.deepEqual(a.brief, b.brief);
  assert.equal(a.internalMarkdown, b.internalMarkdown);
  assert.deepEqual(a.gate, b.gate);
});

test("BUDGET: query cap honoured; vault-only sections never hit the web", async () => {
  const webQueries = [];
  const result = await runGroundedResearch(engineOpts(obedientLlm(), {
    searchWeb: async (q) => { webQueries.push(q); return fixtureSearchWeb(q); },
    maxQueries: 6,
  }));
  assert.ok(result.budget.vaultAndWebQueries <= 6);
  assert.ok(webQueries.every((q) => !/playbook/.test(q)));
});

test("TERMS: request term extraction is deterministic and stopword-free", () => {
  assert.deepEqual(extractRequestTerms(REQUEST), ["competitor", "teardown", "gym", "owners"]);
});
