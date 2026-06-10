/**
 * Client name extraction — ported from the call-processor's pattern at
 * /Users/atlasai/.openclaw/workspace/services/call-processor/call-processor.mjs
 *
 * Handles sourceCall values like:
 *   "Jamie Knight"              → "Jamie Knight"
 *   "Nate x Rhys"               → "Nate"
 *   "Orion H x Rhys"            → "Orion H"
 *   "Rhys x Cade Robertson"     → "Cade Robertson"
 *   "Coaching - Jess Sidoti"    → "Jess Sidoti"
 *   "Apr 20, 07:31 PM"          → null  (date-only, no client inferable)
 */

const TEAM_NAMES = [
  "rhys", "livingstone",
  "pat", "patrick",
  "lily", "jian", "miranda", "dan", "daniel", "manus",
];

export function extractClientName(sourceCall: string | null | undefined): string | null {
  if (!sourceCall || sourceCall === "Unknown") return null;

  // Skip obvious non-client labels (pure dates, etc.)
  if (/^[A-Z][a-z]{2}\s+\d/.test(sourceCall)) return null;

  const cleaned = sourceCall
    .replace(/\s*\(.*?\)/g, "")
    .replace(/^undeniable\s+\w+\s*:\s*/i, "")
    .replace(/\b(L2|call|session|coaching|mentoring|check.?in|catch.?up)\b/gi, "")
    .replace(/^[\s\-:]+|[\s\-:]+$/g, "")
    .trim();

  if (!cleaned) return null;

  // Separators: " x ", " vs ", " and ", " with ", "/", "&", " - " (dash with
  // surrounding whitespace — won't catch hyphenated names like "Mary-Jane").
  const segments = cleaned
    .split(/\s+(?:x|vs|and|with|\/|&|-|–|—)\s+/i)
    .map((s) => s.replace(/^[\s\-:]+|[\s\-:]+$/g, "").trim())
    .filter(Boolean);

  for (const seg of segments) {
    const words = seg.toLowerCase().split(/\s+/);
    const allTeam = words.every((w) => TEAM_NAMES.includes(w));
    if (!allTeam && seg.length > 1) return seg;
  }

  const fallback = segments[0];
  return fallback && fallback.length > 1 ? fallback : null;
}

/** Split "Cade Robertson" → "cade". Useful for fuzzy matching Slack channels. */
export function firstNameSlug(client: string | null): string | null {
  if (!client) return null;
  const first = client.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return first && first.length > 1 ? first : null;
}
