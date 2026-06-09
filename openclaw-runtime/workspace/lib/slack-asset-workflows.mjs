import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

export const ATLAS_UNDENIABLE_DOCUMENT_WORKFLOW_ID = "atlas-undeniable-doc-converter";
export const WORKSPACE_EXPORTS_ROOT = "/Users/atlasai/.openclaw/workspace/exports";

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
    const artifactPaths = [...new Set([
      selected.artifactPath,
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
      sourcePaths: selected.sourcePaths || [],
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
