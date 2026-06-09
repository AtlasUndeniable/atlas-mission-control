/**
 * SHARED REGEX UNIVERSE — single source of truth for Slack-outbound redaction.
 *
 * Authoritative policy lives in:
 *   /Users/atlasai/.openclaw/workspace/SOUL.md §"Error Presentation Rule" (≈line 134)
 *   /Users/atlasai/.openclaw/workspace/SOUL.md §"VOICE GATE" (≈line 89)
 *
 * SOUL.md states the policy in prose ("NEVER show Rhys file paths, CLI commands,
 * stack traces, JSON payloads, raw API responses"). This file is the executable
 * realisation of that policy. If SOUL.md changes, update the patterns here AND
 * note the linkage in both files. The Slack gates module imports from here only —
 * no regex literals duplicated downstream.
 *
 * Conventions:
 *   - Each named export is either a single RegExp or an array of RegExps.
 *   - Arrays are evaluated with `.some()` in the gate caller — first match wins.
 *   - Patterns are case-insensitive unless explicitly anchored.
 *
 * Phase 3 note: these same patterns belong at the tool-result boundary BEFORE
 * subprocess stdout enters next-turn context. See lib/README.md.
 */

// ─── GATE 1 — subprocess / config-dump leakage ──────────────────────────────
// Maps to SOUL.md "Error Presentation Rule":
//   "NEVER show Rhys: File paths, CLI commands, Stack traces or error codes,
//    JSON payloads or raw API responses"
//
// Plus operational signatures observed in gateway.log:
//   "[plugins] acpx staging bundled runtime deps (44 specs): @x/y@1.2.3, ..."
//   "Request timed out before a response was generated. Please try again, or
//    increase `agents.defaults.timeoutSeconds` in your config."

// Plugin lifecycle lines: "[plugins] <name> staging|installed|registered|ready ..."
//
// Plugin-name-agnostic by design — `\S+` matches ANY plugin id (acpx, runway,
// tts-local-cli, senseaudio, voyage, alibaba, or any future plugin). This
// catches the structural sub-agent stdout-capture leak regardless of which
// plugin emits it. Disabling specific offending plugins via `openclaw plugins
// disable` stops the source; this regex is the defense-in-depth backstop in
// case a new leak shape appears or a disable gets reverted.
export const PLUGIN_LIFECYCLE_PATTERN = /\[plugins\]\s+\S+\s+(staging|installed|registered|ready)\b/i;

// "bundled runtime deps" — verbatim leak signature
export const BUNDLED_DEPS_PATTERN = /bundled runtime deps/i;

// npm manifest pattern: @scope/pkg@1.2.3, ... or @scope/pkg@^1.2.3
export const NPM_MANIFEST_PATTERN = /@\w[\w-]*\/[\w-]+@[\d.^~*x><=\-A-Za-z]+(?:[,\s]|$)/;

// Config-dump pattern: "agents.defaults.foo", "models.anthropic/claude-..."
export const CONFIG_DUMP_PATTERN = /\b(agents\.defaults|models\.[a-z-]+\/|meta\.lastTouchedAt|config hot reload)\b/i;

// Stack-trace signatures: "Error:", "    at funcName (", node_modules paths
export const STACK_TRACE_PATTERNS = [
  /^\s*Error:\s/m,
  /^\s+at\s+\S+\s+\(/m,
  /node_modules\//,
  /Traceback \(most recent call last\)/,
];

// Orphan JSON braces on their own line (suggests truncated payload paste)
export const JSON_BRACE_PATTERNS = [
  /^\s*\{\s*$/m,
  /^\s*\},?\s*$/m,
];

// Divider line — three-or-more dashes alone (markdown horizontal rule pasted from logs)
export const DIVIDER_PATTERN = /^---+$/m;

// Config error prefixes: "GATEWAY_ERROR: ...", "AGENT_RESPONSE_ERROR: ..."
export const ERROR_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]+_ERROR:\s/m;

// File path signature (SOUL: "File paths")
export const FILE_PATH_PATTERN = /\/(Users|opt|var|tmp|usr)\/[A-Za-z0-9._\/-]+/;

// CLI command signature (SOUL: "CLI commands like openclaw agent --message...")
export const CLI_COMMAND_PATTERN = /\b(openclaw|gcloud|launchctl|npm)\s+\w+\s+--?\w/;

// "Request timed out before a response was generated…" + `agents.defaults.timeoutSeconds`
// CONFIG_DUMP_PATTERN covers `agents.defaults.timeoutSeconds`. Also catch the prose:
export const GATEWAY_TIMEOUT_PATTERN = /Request timed out before a response was generated/i;

// Master list for `.some()` evaluation in gate 1.
export const SUBPROCESS_LEAK_PATTERNS = [
  PLUGIN_LIFECYCLE_PATTERN,
  BUNDLED_DEPS_PATTERN,
  NPM_MANIFEST_PATTERN,
  CONFIG_DUMP_PATTERN,
  ...STACK_TRACE_PATTERNS,
  ...JSON_BRACE_PATTERNS,
  DIVIDER_PATTERN,
  ERROR_PREFIX_PATTERN,
  FILE_PATH_PATTERN,
  CLI_COMMAND_PATTERN,
  GATEWAY_TIMEOUT_PATTERN,
];

// ─── GATE 3 — voice formality blacklist ─────────────────────────────────────
// Maps to SOUL.md §"VOICE GATE" point 3 "FORMALITY TEST":
//   "Words like 'regarding', 'additionally', 'furthermore', 'I'd like to',
//    'please note'. Em dashes, bullet points, or markdown formatting.
//    Sign-offs like 'Let me know' or 'Hope this helps'."

export const VOICE_FORMALITY_PATTERNS = [
  /\bregarding\b/i,
  /\badditionally\b/i,
  /\bfurthermore\b/i,
  /\bI(?:'d| would) like to\b/i,
  /\bplease note\b/i,
  /\bLet me know\b/i,
  /\bHope this helps\b/i,
  / — /, // em dash with spaces (rules out Rhys-style use)
];

// Source/reference lines that must be stripped from client-facing outbound.
// Match at start of line only — avoids stripping legitimate uses inside prose.
export const SOURCE_LINE_PATTERNS = [
  /^\s*Source:\s.*$/im,
  /^\s*Reference:\s.*$/im,
  /^\s*From:\s.*$/im,
  /^\s*Based on:\s.*$/im,
];

// Third-party framework citations — Hormozi/Leila/etc. attribution patterns.
// Match anywhere in line; gate 3 strips the entire line that contains them.
export const CITATION_PATTERNS = [
  /\b(Alex |Leila )?Hormozi\b/i,
  /\$100[Mm](?:\s+playbook|\s+leads|\s+offers)?/,
  /\bAcq(?:uisition)?\.com\b/i,
  /\bPer (Hormozi|Leila)\b/i,
  /\bFrom the \$100M\b/i,
];

// ─── GATE 4 — deliverable phrase triggers ───────────────────────────────────
// If text matches any of these AND no artifact is attached, gate 4 rejects.

export const DELIVERABLE_PHRASE_PATTERNS = [
  /\bfixed\b/i,
  /\bhere it is\b/i,
  /\bv[23]\b/i, // v2/v3
  /\brebuilt\b/i,
  /i'?ve\s+(updated|added|removed|fixed|rebuilt|sent)\b/i,
  /\bhere'?s the\b/i,
  // 'done' / 'ready' as a completion-claim: must be the LINE-LEADING word
  // (optionally preceded by a completion subject like "it's", "that's", "all",
  // "now", "finally"). Rejects "Done.", "It's done.", "All ready." while
  // letting through inline status counts like "317 done." or "12 ready, 3 pending".
  /^\s*(?:it'?s\s+|that'?s\s+|all\s+|now\s+|finally\s+)?(?:done|ready)\b\.?\s*$/im,
  /\bcheck(ing|ed)\s+(it\s+)?(now|again)\b/i,
];
