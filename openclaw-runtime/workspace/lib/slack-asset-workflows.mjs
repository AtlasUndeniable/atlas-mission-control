import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export const ATLAS_UNDENIABLE_DOCUMENT_WORKFLOW_ID = "atlas-undeniable-doc-converter";
export const WORKSPACE_EXPORTS_ROOT = "/Users/atlasai/.openclaw/workspace/exports";
export const ATLAS_DOCUMENT_CONVERTER_SCRIPT = "/Users/atlasai/.openclaw/workspace/skills/doc-converter/scripts/convert.sh";

const JESS_ENDURE_PLAYBOOK_STEM = "2026-06-09-jess-endure-ad-cta-dm-follow-up-playbook-branded";
const JESS_ENDURE_PLAYBOOK_TITLE = "Jess Endure Mentoring: Ad CTA + DM Follow-Up Playbook";
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
  converterScript = ATLAS_DOCUMENT_CONVERTER_SCRIPT,
  runConverter = runAtlasDocumentConverter,
} = {}) {
  mkdirSync(exportsRoot, { recursive: true });
  const sourcePath = join(exportsRoot, `${JESS_ENDURE_PLAYBOOK_STEM}.md`);
  const title = workflow?.title || JESS_ENDURE_PLAYBOOK_TITLE;
  writeFileSync(sourcePath, renderJessEndureAdCtaPlaybookMarkdown(), "utf8");

  const outputFilenames = [
    `${JESS_ENDURE_PLAYBOOK_STEM}.pdf`,
    `${JESS_ENDURE_PLAYBOOK_STEM}.docx`,
    `${JESS_ENDURE_PLAYBOOK_STEM}.html`,
  ];

  for (const outputFilename of outputFilenames) {
    await runConverter({
      converterScript,
      sourcePath,
      outputFilename,
      title,
    });
  }

  return {
    artifactPath: join(exportsRoot, outputFilenames[0]),
    artifactPaths: outputFilenames.map((filename) => join(exportsRoot, filename)),
    sourcePaths: [sourcePath, ...JESS_ENDURE_SOURCE_PATHS],
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

async function runAtlasDocumentConverter({ converterScript, sourcePath, outputFilename, title }) {
  return new Promise((resolvePromise, reject) => {
    execFile("/bin/bash", [
      converterScript,
      sourcePath,
      outputFilename,
      "--title",
      title,
    ], {
      env: {
        ...process.env,
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const details = String(stderr || stdout || error.message || "").trim();
        reject(new Error(details || `converter failed for ${outputFilename}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function renderJessEndureAdCtaPlaybookMarkdown() {
  return `# Jess Endure Mentoring: Ad CTA + DM Follow-Up Playbook

Brand: Undeniable
Client: Jess Endure Mentoring
Purpose: close ad videos with one clear action, then turn the first DM into a practical next step.

## Diagnosis

Jess does not need a softer CTA. She needs a lower-friction CTA.

"Message me" sounds casual, but it asks the viewer to decide what to write. That adds thinking at the exact moment the ad should create action. The move is to give the viewer one word, one channel, and one reason to act now.

## Exact CTA Script

Use this closing line at the end of the ad:

> If this sounds like you, DM me the word START and I will send you the next step.

If Jess wants a slightly warmer version:

> If you want help with this, DM me START and I will send you the next step.

Keep it spoken, direct, and clean. Do not add three extra options after it.

## Why "DM Me START" Beats "Message Me"

1. It removes the blank-page problem. They do not need to invent a message.
2. It creates a trackable demand signal. START is easy to count across ads.
3. It gives the setter a clean handoff. The first reply can be templated without feeling robotic.
4. It keeps the ad focused on one action. More choices usually means fewer responses.
5. It makes follow-up faster. Jess can test the hook, topic, and CTA without changing the whole funnel.

## First 3 DM Replies After Someone Sends START

### Reply 1: sort the problem

Hey, amazing. Quick one so I can send the right next step: what are you trying to fix first right now - fat loss, strength, routine, or confidence?

### Reply 2: find the sticking point

Got you. What have you tried recently, and what usually pulls you off track?

### Reply 3: move to the next step

That makes sense. Best next step is a quick fit check so Jess can map the first 2 weeks properly. Want me to send you the details?

If they say yes:

Perfect. I will send the details now. What is the best email or number for you?

## 7-Day Filming And Testing Checklist

Day 1: Film three ads using the same CTA. Change only the opening hook.

Day 2: Post or launch the best two. Track START messages separately by ad.

Day 3: Reply to every START with the three-message sequence above. Log the sticking point people name most often.

Day 4: Film one new ad around the most common sticking point. Keep the CTA identical.

Day 5: Add one short proof point before the CTA: a client outcome, a common objection handled, or a "this is for you if" line.

Day 6: Review numbers: views, START messages, replies after Reply 1, and booked next steps.

Day 7: Keep the CTA if it is producing conversations. Change the hook or topic before changing the CTA.

## Source And Context Notes

This was built from verified Atlas/Undeniable context, not from a generic PDF template.

- Slack context from June 9, 2026: Jess Endure Mentoring asked what CTA to say at the end of her ads. The approved direction was to use "DM me the word START and I will send you the next step."
- Coaching memory for Jess Endure: existing notes point to fresh creative cadence, more nurture between enquiry and call, QR or opt-in event offers, and personalized follow-up after people signal interest.
- Jess De Bortoli call memory from June 3, 2025: Endure has real demand and delivery constraints, so the CTA should create trackable conversations instead of vague attention.

## Operating Rule

Do not make the viewer work at the end of the ad. Give them the word, make the reply easy, and let the next message do the qualification.
`;
}
