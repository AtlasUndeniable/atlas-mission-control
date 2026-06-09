import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export const ATLAS_UNDENIABLE_DOCUMENT_WORKFLOW_ID = "atlas-undeniable-doc-converter";
export const WORKSPACE_EXPORTS_ROOT = "/Users/atlasai/.openclaw/workspace/exports";
export const ATLAS_DOCUMENT_CONVERTER_SCRIPT = "/Users/atlasai/.openclaw/workspace/skills/doc-converter/scripts/convert.sh";
export const ATLAS_WEASYPRINT_BIN = "/opt/homebrew/bin/weasyprint";
export const ATLAS_PANDOC_BIN = "/opt/homebrew/bin/pandoc";

const JESS_ENDURE_PLAYBOOK_STEM = "2026-06-09-jess-endure-ad-cta-dm-follow-up-playbook-branded";
const JESS_ENDURE_PLAYBOOK_TITLE = "Jess Endure Mentoring: Ad CTA + DM Follow-Up Playbook";
const UNDENIABLE_STACKED_LOGO = "undeniable-stacked-black.png";
const UNDENIABLE_HORIZONTAL_LOGO = "undeniable-horizontal-black.png";
const JESS_ENDURE_SOURCE_PATHS = Object.freeze([
  "/Users/atlasai/.openclaw/workspace/memory/daily/2026-06-09-slack-webapi-24h.json",
  "/Users/atlasai/.openclaw/workspace/memory/PARA/Areas/coaching.md",
  "/Users/atlasai/.openclaw/workspace/memory/PARA/Resources/fireflies/call-2025-06-03-jess-de-bortoli-G9659B.md",
]);

export const VERIFIED_SLACK_ASSET_WORKFLOWS = Object.freeze([
  {
    key: "first-10k-online-coach",
    workflowId: ATLAS_UNDENIABLE_DOCUMENT_WORKFLOW_ID,
    adapter: "existing-export-package",
    title: "First $10K Month coaching playbook",
    message: "Done. I found the verified First $10K Month branded asset and attached it here. This is the existing Atlas/Undeniable artifact, not a fresh hallucinated draft.",
    artifactPath: `${WORKSPACE_EXPORTS_ROOT}/2026-05-20-first-10k-month-bible-branded.pdf`,
    artifactPaths: [
      `${WORKSPACE_EXPORTS_ROOT}/2026-05-20-first-10k-month-bible-branded.pdf`,
      `${WORKSPACE_EXPORTS_ROOT}/2026-05-20-first-10k-month-bible-branded.docx`,
      `${WORKSPACE_EXPORTS_ROOT}/2026-05-20-first-10k-month-bible-branded.html`,
    ],
    sourcePaths: [
      `${WORKSPACE_EXPORTS_ROOT}/2026-05-20-first-10k-month-bible-branded.html`,
      `${WORKSPACE_EXPORTS_ROOT}/build_first_10k_bible.py`,
      `${WORKSPACE_EXPORTS_ROOT}/build_first_10k_bible_html.py`,
    ],
    match(text) {
      const normalized = normalizeRequestText(text);
      const asksFirst10k = /\b(first|1st)?\s*\$?10k\b|\bfirst\s+ten\s+k\b|\bfirst\s+10\s*k\b/.test(normalized);
      const asksOnlineCoach = /\b(online\s+coach|coach|coaching)\b/.test(normalized);
      const asksAsset = /\b(asset|doc|document|pdf|playbook|strategy|strategic|model|pricing|offer|retention|sales)\b/.test(normalized);
      return asksFirst10k && asksOnlineCoach && asksAsset;
    },
  },
  {
    key: "jess-endure-ad-cta-dm-follow-up",
    workflowId: ATLAS_UNDENIABLE_DOCUMENT_WORKFLOW_ID,
    adapter: "generated-source-package",
    title: JESS_ENDURE_PLAYBOOK_TITLE,
    message: "Done. I created the branded Undeniable Ad CTA + DM Follow-Up Playbook for Jess Endure Mentoring and attached the PDF here.",
    sourcePaths: JESS_ENDURE_SOURCE_PATHS,
    async build(args) {
      return buildJessEndureAdCtaPlaybook(args);
    },
    match(text) {
      const normalized = normalizeRequestText(text);
      const asksJess = /\b(jess|jessica|de\s+bortoli|endure)\b/.test(normalized);
      const asksCta = /\bcta\b|\bcall\s+to\s+action\b|\bad\b|\bads\b/.test(normalized);
      const asksDm = /\bdm\b|\bdms\b|\bfollow\s*up\b|\bfollow-up\b|\bstart\b/.test(normalized);
      const asksAsset = /\b(asset|pdf|playbook|guide|doc|document|brief)\b/.test(normalized);
      return asksJess && asksCta && asksDm && asksAsset;
    },
  },
]);

const ALLOWED_ARTIFACT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".html", ".md", ".png"]);

export function normalizeRequestText(text = "") {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function findSlackAssetWorkflowForRequest(text = "", workflows = VERIFIED_SLACK_ASSET_WORKFLOWS) {
  return workflows.find((workflow) => {
    if (typeof workflow.match === "function") return workflow.match(text);
    const patterns = Array.isArray(workflow.matchPatterns) ? workflow.matchPatterns : [];
    return patterns.every((pattern) => new RegExp(pattern, "i").test(String(text || "")));
  }) || null;
}

export async function buildJessEndureAdCtaPlaybook({
  workflow,
  exportsRoot = WORKSPACE_EXPORTS_ROOT,
  weasyprintBin = ATLAS_WEASYPRINT_BIN,
  pandocBin = ATLAS_PANDOC_BIN,
  runPdfBuilder = runWeasyPrintPdf,
  runDocxBuilder = runPandocDocx,
} = {}) {
  mkdirSync(exportsRoot, { recursive: true });
  const sourcePath = join(exportsRoot, `${JESS_ENDURE_PLAYBOOK_STEM}.md`);
  const cssPath = join(exportsRoot, `${JESS_ENDURE_PLAYBOOK_STEM}.css`);
  const htmlPath = join(exportsRoot, `${JESS_ENDURE_PLAYBOOK_STEM}.html`);
  const pdfPath = join(exportsRoot, `${JESS_ENDURE_PLAYBOOK_STEM}.pdf`);
  const docxPath = join(exportsRoot, `${JESS_ENDURE_PLAYBOOK_STEM}.docx`);
  const title = workflow?.title || JESS_ENDURE_PLAYBOOK_TITLE;
  const bodyMarkdown = renderJessEndureAdCtaPlaybookMarkdown();
  writeFileSync(sourcePath, bodyMarkdown, "utf8");
  writeFileSync(cssPath, renderJessEndureAdCtaPlaybookCss(), "utf8");
  writeFileSync(htmlPath, renderJessEndureAdCtaPlaybookHtml({ cssFilename: basename(cssPath) }), "utf8");

  await runPdfBuilder({ weasyprintBin, htmlPath, pdfPath });
  await runDocxBuilder({ pandocBin, sourcePath, docxPath, title });

  return {
    artifactPath: pdfPath,
    artifactPaths: [pdfPath, docxPath, htmlPath],
    sourcePaths: [sourcePath, htmlPath, cssPath, ...JESS_ENDURE_SOURCE_PATHS],
  };
}

export function validateSlackAssetFile(filePath, { allowedRoots = [WORKSPACE_EXPORTS_ROOT] } = {}) {
  if (!filePath) throw new Error("artifactPath is required");
  const normalized = resolve(String(filePath));
  if (!allowedRoots.some((root) => isInsideRoot(normalized, root))) {
    throw new Error("artifact path is outside approved artifact roots");
  }
  const ext = extname(normalized).toLowerCase();
  if (!ALLOWED_ARTIFACT_EXTENSIONS.has(ext)) {
    throw new Error(`artifact extension is not allowed: ${ext || "none"}`);
  }
  if (!existsSync(normalized)) throw new Error(`artifact file does not exist: ${basename(normalized)}`);
  const st = statSync(normalized);
  if (!st.isFile()) throw new Error("artifact path is not a file");
  if (st.size <= 0) throw new Error("artifact file is empty");
  const header = readFileSync(normalized, { encoding: null, flag: "r" }).subarray(0, 5);
  if (ext === ".pdf" && header.toString("ascii", 0, 5) !== "%PDF-") {
    throw new Error("PDF artifact failed header validation");
  }
  if (ext === ".docx" && header.toString("ascii", 0, 2) !== "PK") {
    throw new Error("DOCX artifact failed zip validation");
  }
  return { artifactPath: normalized, filename: basename(normalized), size: st.size, ext };
}

export async function executeSlackAssetWorkflow({ text = "", workflow, workflows = VERIFIED_SLACK_ASSET_WORKFLOWS, allowedRoots } = {}) {
  const selected = workflow || findSlackAssetWorkflowForRequest(text, workflows);
  if (!selected) {
    return {
      ok: false,
      status: "blocked",
      safeErrorSummary: "No verified Slack asset workflow matched this request.",
      userMessage: "I checked the asset registry, but I do not have a verified workflow for that asset yet. I will not invent a generic PDF; this needs a real Atlas/Undeniable workflow or source package first.",
    };
  }

  try {
    const built = typeof selected.build === "function"
      ? await selected.build({ text, workflow: selected })
      : {};
    const artifactPaths = [...new Set([
      built.artifactPath,
      selected.artifactPath,
      ...(Array.isArray(built.artifactPaths) ? built.artifactPaths : []),
      ...(Array.isArray(selected.artifactPaths) ? selected.artifactPaths : []),
    ].filter(Boolean))];
    const validatedArtifacts = artifactPaths.map((artifactPath) => validateSlackAssetFile(artifactPath, {
      allowedRoots: allowedRoots || [WORKSPACE_EXPORTS_ROOT],
    }));
    const primaryArtifact = validatedArtifacts.find((artifact) => artifact.ext === ".pdf") || validatedArtifacts[0];
    return {
      ok: true,
      status: "artifact_ready",
      workflowKey: selected.key,
      workflowId: selected.workflowId,
      adapter: selected.adapter || "existing-artifact-package",
      title: selected.title || primaryArtifact.filename,
      message: selected.message || "Done. I attached the verified file here.",
      artifactPath: primaryArtifact.artifactPath,
      artifactPaths: validatedArtifacts.map((artifact) => artifact.artifactPath),
      sourcePaths: [...new Set([
        ...(Array.isArray(built.sourcePaths) ? built.sourcePaths : []),
        ...(Array.isArray(selected.sourcePaths) ? selected.sourcePaths : []),
      ])],
      reusedExistingArtifact: selected.adapter === "existing-export-package",
    };
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      workflowKey: selected.key,
      workflowId: selected.workflowId,
      adapter: selected.adapter || "existing-artifact-package",
      safeErrorSummary: `Verified asset workflow failed validation: ${err.message}`,
      userMessage: "I found a matching asset workflow, but the file package failed validation, so I am not sending it yet.",
    };
  }
}

function isInsideRoot(filePath, root) {
  const normalizedPath = resolve(filePath);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

async function runWeasyPrintPdf({ weasyprintBin, htmlPath, pdfPath }) {
  return runCommand(weasyprintBin, [htmlPath, pdfPath], { label: "weasyprint PDF build" });
}

async function runPandocDocx({ pandocBin, sourcePath, docxPath, title }) {
  return runCommand(pandocBin, [
    sourcePath,
    "-o",
    docxPath,
    "-f",
    "markdown-tex_math_dollars-tex_math_single_backslash-raw_html",
    "--metadata",
    `title=${title}`,
  ], { label: "pandoc DOCX build" });
}

async function runCommand(command, args, { label }) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      env: {
        ...process.env,
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const details = String(stderr || stdout || error.message || "").trim();
        reject(new Error(details || `${label || command} failed`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function renderJessEndureAdCtaPlaybookMarkdown() {
  return `# Jess Endure Mentoring: Ad CTA + DM Follow-Up Playbook

Prepared by Undeniable Mentoring
Prepared for Jess Endure Mentoring
Purpose: turn ad attention into clean, trackable DM conversations.

## Executive Brief

Jess does not need a more complicated closing line. She needs one action that is easy enough for the viewer to do immediately and specific enough for the team to track.

The CTA is:

> DM me the word START and I will send you the next step.

That line beats "message me" because it removes the blank-page problem. The viewer does not need to think of what to say. The team does not need to interpret vague messages. Everyone knows what START means.

## Diagnosis

The current risk is not that the CTA is too direct. The risk is that the ad creates interest and then leaves the viewer with too much work.

"Message me" sounds friendly, but it creates three problems:

1. The viewer has to decide what to write.
2. The team gets inconsistent, hard-to-sort inbound messages.
3. The ad becomes harder to test because the action is vague.

The fix is a keyword CTA. The word START becomes the bridge between the ad and the first useful conversation.

## Exact CTA Script

Primary version:

> If this sounds like you, DM me the word START and I will send you the next step.

Warmer version:

> If you want help with this, DM me START and I will send you the next step.

Short version:

> DM me START and I will send you the next step.

Do not add a second CTA after it. Do not say "message me, comment below, or click the link." One ad, one action.

## Why "DM Me START" Beats "Message Me"

1. It removes the blank-page problem. They do not need to invent a message.
2. It creates a trackable demand signal. START is easy to count across ads.
3. It gives the setter a clean handoff. The first reply can be templated without feeling robotic.
4. It keeps the ad focused on one action. More choices usually means fewer responses.
5. It makes follow-up faster. Jess can test the hook, topic, and CTA without changing the whole funnel.
6. It creates a cleaner lead quality read. START messages can be compared against views, replies, applications, and booked calls.

## First 3 DM Replies After Someone Sends START

### Reply 1: Sort the problem

Hey, amazing. Quick one so I can send the right next step: what are you trying to fix first right now - fat loss, strength, routine, or confidence?

Goal: sort the person into the right problem lane without over-coaching in the first reply.

### Reply 2: Find the sticking point

Got you. What have you tried recently, and what usually pulls you off track?

Goal: find the real blocker. The answer becomes the reason the next step matters.

### Reply 3: Move to the next step

That makes sense. Best next step is a quick fit check so Jess can map the first 2 weeks properly. Want me to send you the details?

If they say yes:

Perfect. I will send the details now. What is the best email or number for you?

## DM Sorting Rules

| Signal | Meaning | Move |
| --- | --- | --- |
| Clear pain + replies quickly | High intent | Move to fit check fast |
| Vague goal + slow reply | Warm but early | Ask one more problem question |
| Wants price first | Not enough context | Ask what they want fixed first |
| Sends a long story | Strong pain | Reflect it back, then move |
| One-word answers | Low effort | Keep it simple and do not chase |

## 7-Day Filming And Testing Checklist

Day 1: Film three ads using the same CTA. Change only the opening hook.

Day 2: Post or launch the best two. Track START messages separately by ad.

Day 3: Reply to every START with the three-message sequence above. Log the sticking point people name most often.

Day 4: Film one new ad around the most common sticking point. Keep the CTA identical.

Day 5: Add one short proof point before the CTA: a client outcome, a common objection handled, or a "this is for you if" line.

Day 6: Review numbers: views, START messages, replies after Reply 1, and booked next steps.

Day 7: Keep the CTA if it is producing conversations. Change the hook or topic before changing the CTA.

## 7-Day Scoreboard

| Metric | Track Daily | What It Tells You |
| --- | --- | --- |
| Views | Yes | Reach and hook strength |
| START messages | Yes | CTA strength |
| Reply 1 responses | Yes | Conversation quality |
| Fit checks sent | Yes | Setter movement |
| Applications or bookings | Yes | Funnel conversion |
| Notes on objections | Yes | Next ad angle |

## Source Context Used

This was built from verified Atlas/Undeniable context, not from a generic PDF template.

- Recent Slack context: Jess Endure Mentoring asked what CTA to say at the end of her ads. The recommended direction was "DM me the word START and I will send you the next step."
- Jess/Endure coaching memory: notes point to fresh creative cadence, more nurture between enquiry and call, event/QR opt-in offers, and personalized follow-up after someone signals interest.
- Jess De Bortoli call memory: Endure has real demand and delivery constraints, so the CTA should create trackable conversations instead of vague attention.

## Operating Rule

Do not make the viewer work at the end of the ad. Give them the word, make the reply easy, and let the next message do the qualification.
`;
}

function renderJessEndureAdCtaPlaybookHtml({ cssFilename }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${htmlEscape(JESS_ENDURE_PLAYBOOK_TITLE)}</title>
  <link rel="stylesheet" href="${htmlEscape(cssFilename)}">
</head>
<body>
  <section class="cover">
    <img class="cover-logo" src="${UNDENIABLE_STACKED_LOGO}" alt="Undeniable">
    <div class="cover-kicker">Undeniable Mentoring Playbook</div>
    <h1>Ad CTA + DM<br>Follow-Up Playbook</h1>
    <p class="cover-subtitle">A practical operating script for turning Jess Endure Mentoring ad viewers into clean, trackable DM conversations.</p>
    <div class="cover-meta">
      <div><strong>Prepared For</strong><span>Jess Endure Mentoring</span></div>
      <div><strong>Prepared By</strong><span>Undeniable Mentoring</span></div>
      <div><strong>Updated</strong><span>9 June 2026</span></div>
    </div>
  </section>

  <section class="toc page">
    <div class="brand-header"><img src="${UNDENIABLE_HORIZONTAL_LOGO}" alt="Undeniable"></div>
    <h2>Operating Map</h2>
    <div class="toc-row"><span>01</span><strong>Executive Brief</strong></div>
    <div class="toc-row"><span>02</span><strong>The Diagnosis</strong></div>
    <div class="toc-row"><span>03</span><strong>The Exact CTA</strong></div>
    <div class="toc-row"><span>04</span><strong>First 3 DM Replies</strong></div>
    <div class="toc-row"><span>05</span><strong>7-Day Test Plan</strong></div>
    <div class="toc-row"><span>06</span><strong>Source Context</strong></div>
  </section>

  <section class="page">
    <div class="brand-header"><img src="${UNDENIABLE_HORIZONTAL_LOGO}" alt="Undeniable"></div>
    <p class="section-label">01 / Executive Brief</p>
    <h2>Make The Viewer Do One Easy Thing</h2>
    <p class="lede">Jess does not need a more complicated closing line. She needs one action that is easy enough for the viewer to do immediately and specific enough for the team to track.</p>
    <div class="hero-callout">DM me the word START and I will send you the next step.</div>
    <div class="two-grid">
      <div class="card"><h3>The job of the CTA</h3><p>Move attention into a measurable conversation. The CTA is not trying to explain the whole offer. It is trying to make the next action obvious.</p></div>
      <div class="card"><h3>The rule</h3><p>One ad. One word. One reply path. If the ad gives people multiple choices, the team gets weaker data and fewer clean conversations.</p></div>
    </div>
    <div class="keyline">
      <strong>Operating principle:</strong> do not make the viewer work at the end of the ad. Give them the word, make the reply easy, then let the next message qualify.
    </div>
  </section>

  <section class="page">
    <div class="brand-header"><img src="${UNDENIABLE_HORIZONTAL_LOGO}" alt="Undeniable"></div>
    <p class="section-label">02 / Diagnosis</p>
    <h2>"Message Me" Is Too Vague</h2>
    <p>"Message me" sounds friendly, but it asks the viewer to decide what to write. That creates thinking at the exact moment the ad should create action.</p>
    <div class="three-grid">
      <div class="metric"><span>01</span><p>The viewer has to invent the message.</p></div>
      <div class="metric"><span>02</span><p>The team receives inconsistent inbound replies.</p></div>
      <div class="metric"><span>03</span><p>The ad becomes harder to test because the action is not clean.</p></div>
    </div>
    <h3>The fix</h3>
    <p>Use a keyword CTA. START becomes the bridge between the ad and the first useful conversation.</p>
    <table>
      <thead><tr><th>Old CTA</th><th>Problem</th><th>New CTA</th></tr></thead>
      <tbody>
        <tr><td>Message me</td><td>Vague action, hard to track, inconsistent replies.</td><td>DM me START</td></tr>
        <tr><td>Click the link</td><td>Can work, but creates a bigger jump from attention to form.</td><td>Start in DM, then move to fit check.</td></tr>
        <tr><td>Comment below</td><td>Public signal, lower privacy for body/health conversations.</td><td>Private keyword reply.</td></tr>
      </tbody>
    </table>
  </section>

  <section class="page">
    <div class="brand-header"><img src="${UNDENIABLE_HORIZONTAL_LOGO}" alt="Undeniable"></div>
    <p class="section-label">03 / Exact CTA Script</p>
    <h2>Use This Closing Line</h2>
    <div class="script-block">
      <p>If this sounds like you, DM me the word <strong>START</strong> and I will send you the next step.</p>
    </div>
    <div class="two-grid">
      <div class="card"><h3>Warmer version</h3><p>If you want help with this, DM me START and I will send you the next step.</p></div>
      <div class="card"><h3>Short version</h3><p>DM me START and I will send you the next step.</p></div>
    </div>
    <h3>Why START wins</h3>
    <ol class="tight-list">
      <li>It removes the blank-page problem.</li>
      <li>It gives the setter a clean handoff.</li>
      <li>It creates a trackable demand signal across ads.</li>
      <li>It keeps the ad focused on one action.</li>
      <li>It lets Jess test hooks and topics without changing the whole funnel.</li>
    </ol>
    <div class="warning"><strong>Do not add a second CTA.</strong> No "message me, comment below, or click the link." One ad, one action.</div>
  </section>

  <section class="page">
    <div class="brand-header"><img src="${UNDENIABLE_HORIZONTAL_LOGO}" alt="Undeniable"></div>
    <p class="section-label">04 / First 3 DM Replies</p>
    <h2>The Follow-Up Sequence</h2>
    <div class="reply">
      <span>Reply 01</span>
      <h3>Sort the problem</h3>
      <p>Hey, amazing. Quick one so I can send the right next step: what are you trying to fix first right now - fat loss, strength, routine, or confidence?</p>
      <em>Goal: sort the person into the right problem lane without over-coaching in the first reply.</em>
    </div>
    <div class="reply">
      <span>Reply 02</span>
      <h3>Find the sticking point</h3>
      <p>Got you. What have you tried recently, and what usually pulls you off track?</p>
      <em>Goal: find the real blocker. The answer becomes the reason the next step matters.</em>
    </div>
    <div class="reply">
      <span>Reply 03</span>
      <h3>Move to the next step</h3>
      <p>That makes sense. Best next step is a quick fit check so Jess can map the first 2 weeks properly. Want me to send you the details?</p>
      <em>If they say yes: Perfect. I will send the details now. What is the best email or number for you?</em>
    </div>
  </section>

  <section class="page">
    <div class="brand-header"><img src="${UNDENIABLE_HORIZONTAL_LOGO}" alt="Undeniable"></div>
    <p class="section-label">05 / Sorting Rules</p>
    <h2>How To Read The Replies</h2>
    <table>
      <thead><tr><th>Signal</th><th>Meaning</th><th>Move</th></tr></thead>
      <tbody>
        <tr><td>Clear pain + fast replies</td><td>High intent.</td><td>Move to fit check fast.</td></tr>
        <tr><td>Vague goal + slow reply</td><td>Warm but early.</td><td>Ask one more problem question.</td></tr>
        <tr><td>Wants price first</td><td>Not enough context yet.</td><td>Ask what they want fixed first.</td></tr>
        <tr><td>Sends a long story</td><td>Strong pain.</td><td>Reflect it back, then move.</td></tr>
        <tr><td>One-word answers</td><td>Low effort.</td><td>Keep it simple and do not chase.</td></tr>
      </tbody>
    </table>
    <div class="keyline"><strong>Setter standard:</strong> do not coach for free in the DM. Sort the problem, find the blocker, move to the next step.</div>
  </section>

  <section class="page">
    <div class="brand-header"><img src="${UNDENIABLE_HORIZONTAL_LOGO}" alt="Undeniable"></div>
    <p class="section-label">06 / 7-Day Test Plan</p>
    <h2>Film, Track, Adjust</h2>
    <table>
      <thead><tr><th>Day</th><th>Action</th><th>What To Watch</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>Film three ads with the same CTA. Change only the opening hook.</td><td>Hook clarity.</td></tr>
        <tr><td>2</td><td>Post or launch the best two. Track START messages separately by ad.</td><td>CTA response.</td></tr>
        <tr><td>3</td><td>Reply to every START with the three-message sequence.</td><td>Reply 1 response rate.</td></tr>
        <tr><td>4</td><td>Film one new ad around the most common sticking point.</td><td>Problem resonance.</td></tr>
        <tr><td>5</td><td>Add one proof point before the CTA.</td><td>Trust lift.</td></tr>
        <tr><td>6</td><td>Review views, START messages, replies, and bookings.</td><td>Funnel drop-off.</td></tr>
        <tr><td>7</td><td>Keep the CTA if it starts conversations. Change hook/topic before changing CTA.</td><td>Consistency.</td></tr>
      </tbody>
    </table>
  </section>

  <section class="page">
    <div class="brand-header"><img src="${UNDENIABLE_HORIZONTAL_LOGO}" alt="Undeniable"></div>
    <p class="section-label">07 / Scoreboard</p>
    <h2>Track The Chain</h2>
    <table>
      <thead><tr><th>Metric</th><th>Track</th><th>What It Tells You</th></tr></thead>
      <tbody>
        <tr><td>Views</td><td>Daily</td><td>Reach and hook strength.</td></tr>
        <tr><td>START messages</td><td>Daily</td><td>CTA strength.</td></tr>
        <tr><td>Reply 1 responses</td><td>Daily</td><td>Conversation quality.</td></tr>
        <tr><td>Fit checks sent</td><td>Daily</td><td>Setter movement.</td></tr>
        <tr><td>Applications or bookings</td><td>Daily</td><td>Funnel conversion.</td></tr>
        <tr><td>Objection notes</td><td>Daily</td><td>Next ad angle.</td></tr>
      </tbody>
    </table>
    <div class="hero-callout small">If START messages are low, fix the hook or pain. If START messages are high but bookings are low, fix the DM sequence.</div>
  </section>

  <section class="page source-page">
    <div class="brand-header"><img src="${UNDENIABLE_HORIZONTAL_LOGO}" alt="Undeniable"></div>
    <p class="section-label">08 / Source Context</p>
    <h2>What This Used</h2>
    <p>This playbook was built from verified Atlas/Undeniable context and the current Jess Endure Mentoring request, not a generic PDF template.</p>
    <div class="source-card"><strong>Recent Slack context</strong><p>Jess Endure Mentoring asked what CTA to say at the end of her ads. The working direction was: "DM me the word START and I will send you the next step."</p></div>
    <div class="source-card"><strong>Jess/Endure coaching memory</strong><p>Existing notes point to fresh creative cadence, more nurture between enquiry and call, event/QR opt-in offers, and personalized follow-up after someone signals interest.</p></div>
    <div class="source-card"><strong>Jess De Bortoli call memory</strong><p>Endure has real demand and delivery constraints, so the CTA should create trackable conversations instead of vague attention.</p></div>
    <div class="final-rule">Give them the word. Make the reply easy. Let the next message do the qualification.</div>
  </section>
</body>
</html>`;
}

function renderJessEndureAdCtaPlaybookCss() {
  return `@page {
  size: A4;
  margin: 22mm 18mm 18mm 22mm;
  @bottom-left {
    content: "UNDENIABLE MENTORING | AD CTA + DM FOLLOW-UP PLAYBOOK";
    font-family: Inter, Arial, sans-serif;
    font-size: 7pt;
    color: #777;
    letter-spacing: 1.2px;
  }
  @bottom-right {
    content: counter(page, decimal-leading-zero);
    font-family: "Bebas Neue", Impact, sans-serif;
    font-size: 10pt;
    color: #999;
    letter-spacing: 1px;
  }
}
@page:first {
  margin: 25mm;
  @bottom-left { content: ""; }
  @bottom-right { content: ""; }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, Arial, Helvetica, sans-serif;
  color: #333;
  font-size: 10.1pt;
  line-height: 1.46;
}
p { margin: 0 0 4mm; }
h1, h2 {
  font-family: "Bebas Neue", Impact, Arial Black, sans-serif;
  color: #000;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
h2 {
  font-size: 31pt;
  line-height: 0.95;
  margin: 0 0 7mm;
  border-top: 2pt solid #000;
  padding-top: 5mm;
}
h3 {
  font-size: 11.2pt;
  line-height: 1.25;
  margin: 0 0 2mm;
  color: #000;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 4mm 0 6mm;
  break-inside: avoid;
}
th {
  background: #e5e5e5;
  color: #000;
  font-weight: 800;
  text-align: left;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  font-size: 7.8pt;
}
td, th {
  border: 0.45pt solid #bdbdbd;
  padding: 3.2mm;
  vertical-align: top;
  font-size: 8.5pt;
  line-height: 1.32;
}
.cover {
  min-height: 247mm;
  position: relative;
  page-break-after: always;
}
.cover-logo {
  position: absolute;
  top: 0;
  left: 0;
  width: 46mm;
  height: auto;
}
.cover-kicker {
  position: absolute;
  top: 72mm;
  left: 0;
  width: 100mm;
  border-top: 2pt solid #000;
  padding-top: 4mm;
  font-size: 8pt;
  font-weight: 800;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: #000;
}
.cover h1 {
  position: absolute;
  top: 99mm;
  left: 0;
  width: 160mm;
  margin: 0;
  font-size: 55pt;
  line-height: 0.9;
}
.cover-subtitle {
  position: absolute;
  top: 169mm;
  left: 0;
  width: 145mm;
  border-left: 2.4pt solid #000;
  padding-left: 5mm;
  font-size: 13pt;
  line-height: 1.35;
  font-weight: 300;
  color: #333;
}
.cover-meta {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  border-top: 0.8pt solid #000;
  padding-top: 5mm;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8mm;
  font-size: 7.5pt;
  line-height: 1.45;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 1.2px;
}
.cover-meta strong {
  display: block;
  color: #000;
  font-size: 8pt;
  margin-bottom: 1mm;
}
.cover-meta span { display: block; }
.page {
  min-height: 247mm;
  page-break-after: always;
}
.brand-header {
  margin-bottom: 10mm;
  border-bottom: 0.6pt solid #000;
  padding-bottom: 3mm;
}
.brand-header img {
  width: 42mm;
  height: auto;
  display: block;
}
.section-label {
  margin: 0 0 3mm;
  font-size: 7.5pt;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: #777;
}
.lede {
  font-size: 13pt;
  line-height: 1.36;
  color: #222;
  max-width: 150mm;
}
.hero-callout {
  margin: 7mm 0;
  padding: 6mm;
  background: #0b0b0b;
  color: #fff;
  font-family: "Bebas Neue", Impact, sans-serif;
  font-size: 27pt;
  line-height: 1.05;
  text-transform: uppercase;
}
.hero-callout.small {
  font-size: 19pt;
  line-height: 1.12;
}
.two-grid, .three-grid {
  display: grid;
  gap: 4mm;
  margin: 5mm 0;
}
.two-grid { grid-template-columns: 1fr 1fr; }
.three-grid { grid-template-columns: 1fr 1fr 1fr; }
.card, .source-card {
  border: 0.7pt solid #c6c6c6;
  background: #f5f5f5;
  padding: 4.5mm;
  break-inside: avoid;
}
.card p, .source-card p { margin-bottom: 0; }
.keyline, .warning, .final-rule {
  border-left: 3pt solid #000;
  background: #f5f5f5;
  padding: 4mm 5mm;
  margin-top: 6mm;
  font-weight: 600;
}
.warning {
  background: #fff;
  border: 0.8pt solid #000;
}
.metric {
  border-top: 1.4pt solid #000;
  padding-top: 3mm;
  break-inside: avoid;
}
.metric span {
  font-family: "Bebas Neue", Impact, sans-serif;
  display: block;
  font-size: 24pt;
  color: #000;
  line-height: 1;
}
.metric p { margin: 2mm 0 0; }
.script-block {
  border: 1.2pt solid #000;
  padding: 7mm;
  margin: 5mm 0 6mm;
  font-size: 17pt;
  line-height: 1.35;
  font-weight: 700;
  color: #000;
}
.script-block p { margin: 0; }
.tight-list {
  margin: 0 0 5mm 5mm;
  padding-left: 5mm;
}
.tight-list li { margin-bottom: 2mm; }
.reply {
  border: 0.7pt solid #c6c6c6;
  background: #f7f7f7;
  padding: 4mm 5mm;
  margin-bottom: 4mm;
  break-inside: avoid;
}
.reply span {
  display: block;
  font-size: 7.5pt;
  font-weight: 800;
  color: #777;
  text-transform: uppercase;
  letter-spacing: 1.8px;
  margin-bottom: 1.5mm;
}
.reply p {
  font-size: 10.5pt;
  color: #111;
  margin-bottom: 2mm;
}
.reply em {
  display: block;
  font-style: normal;
  color: #666;
  font-size: 8.5pt;
}
.toc h2 { margin-bottom: 9mm; }
.toc-row {
  display: grid;
  grid-template-columns: 18mm 1fr;
  gap: 5mm;
  border-bottom: 0.45pt solid #bbb;
  padding: 3mm 0;
}
.toc-row span {
  font-family: "Bebas Neue", Impact, sans-serif;
  font-size: 17pt;
  color: #999;
}
.toc-row strong {
  font-size: 11pt;
  color: #000;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.source-page .source-card {
  margin-bottom: 4mm;
}
.source-card strong {
  display: block;
  margin-bottom: 1.5mm;
  color: #000;
  text-transform: uppercase;
  letter-spacing: 1px;
  font-size: 8.2pt;
}
.final-rule {
  margin-top: 8mm;
  font-family: "Bebas Neue", Impact, sans-serif;
  font-size: 24pt;
  line-height: 1.05;
  text-transform: uppercase;
}
`;
}

function htmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
