/**
 * Central secrets reader — SERVER ONLY.
 *
 * ATLAS keeps its credentials in one file, `~/.config/atlas/secrets.env`
 * (chmod 600), after the 2026-07-11 migration that pulled them out of the
 * launchd plists. Mission Control needs exactly two of them to read the hosted
 * action board: SUPABASE_ANON_KEY and ATLAS_RETRIEVAL_TOKEN.
 *
 * WHY A FILE READ AND NOT A PLIST WRAPPER. The other services that need
 * secrets.env get it by turning their plist into a zsh wrapper that `source`s
 * the whole file. Doing that here would hand a web server every key ATLAS owns
 * — Anthropic, Slack, GHL, the Supabase service_role key — when it needs two
 * read-scoped values. This reads the two it names and nothing else.
 *
 * process.env wins over the file, so a plist wrapper, a shell export or
 * .env.local still override without touching this module.
 *
 * NOTHING HERE MAY REACH THE BROWSER. It is imported only from route handlers
 * under src/app/api, which Next never bundles for the client, and the window
 * guard below turns a future mis-import into a build/runtime error rather than
 * a silently shipped token.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

if (typeof window !== "undefined") {
  throw new Error("atlas-secrets is server-only and must never be imported into a client bundle");
}

const SECRETS_PATH =
  process.env.ATLAS_SECRETS_FILE ?? join(homedir(), ".config", "atlas", "secrets.env");

/** `export KEY=value`, `KEY=value`, blank lines and `#` comments. */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

let cache: { key: string; values: Map<string, string> } | null = null;

/**
 * Parse the file the way `source` would in the two respects that matter here:
 * a later assignment of the same name WINS (secrets.env genuinely carries
 * SUPABASE_URL twice, appended by two different service migrations), and
 * matched surrounding quotes are stripped.
 */
function parse(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values.set(m[1], value);   // last assignment wins
  }
  return values;
}

/** Re-read only when the file actually changed, so a rotation lands without a restart. */
function load(): Map<string, string> {
  let key: string;
  try {
    const s = statSync(SECRETS_PATH);
    key = `${s.mtimeMs}:${s.size}`;
  } catch {
    return new Map();          // no file is not an error here; process.env may carry it
  }
  if (cache && cache.key === key) return cache.values;
  try {
    const values = parse(readFileSync(SECRETS_PATH, "utf8"));
    cache = { key, values };
    return values;
  } catch {
    return new Map();
  }
}

/** The named secret, or null. NEVER log or return the value from an API response. */
export function readAtlasSecret(name: string): string | null {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  return load().get(name) ?? null;
}

export const ATLAS_SECRETS_PATH = SECRETS_PATH;
