#!/bin/sh
# Lane X kill switch: one command refuses ALL external requests, then takes the path down.
#   sh atlas-mcp/deploy/kill-switch.sh --config <phase config.json> [--revoke]
#   (or ATLAS_MCP_EXPOSURE_CONFIG=<phase config.json>; there is NO default, so the acceptance
#    and production registries cannot be confused; R16b B4)
# Order matters: the origin refuses first (instant, even mid-request), then the processes stop.
# It only touches THIS lane's two user jobs and THIS named tunnel (atlas-mcp-grok). Any other
# cloudflared tunnel or daemon on the Mac is outside this lane and is never stopped here.
# Stopped state is verified, not assumed. Prints no secrets. Safe to run repeatedly.
set -u
HERE=$(cd "$(dirname "$0")/../.." && pwd)
CONFIG=${ATLAS_MCP_EXPOSURE_CONFIG:-}
REVOKE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG=${2:-}; shift 2 ;;
    --revoke) REVOKE="--revoke-tokens"; shift ;;
    *) echo "usage: kill-switch.sh --config <phase config.json> [--revoke]" >&2; exit 2 ;;
  esac
done
if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
  echo "REFUSED: name the phase config explicitly (--config <file> or ATLAS_MCP_EXPOSURE_CONFIG)." >&2; exit 2
fi
TUNNEL=atlas-mcp-grok
ORIGIN_LABEL=ai.atlas.atlas-mcp-exposure
TUNNEL_LABEL=ai.atlas.cloudflared-atlas-mcp-grok
NODE=/opt/homebrew/bin/node
UID_=$(id -u)
FAIL=0
echo "config: $CONFIG"
# 1. Origin refuses every request (503) from this moment, including in-flight ones.
if ! "$NODE" --no-warnings "$HERE/atlas-mcp/bin/atlas-mcp.ts" exposure-kill --config "$CONFIG" $REVOKE; then
  echo "KILL-FILE STEP FAILED: continue stopping the processes, then check by hand" >&2; FAIL=1
fi
# 2. Stop the origin job and this tunnel's user job, then VERIFY each is gone.
for L in "$ORIGIN_LABEL" "$TUNNEL_LABEL"; do
  if launchctl print "gui/$UID_/$L" >/dev/null 2>&1; then
    launchctl bootout "gui/$UID_/$L" 2>/dev/null || true
    if launchctl print "gui/$UID_/$L" >/dev/null 2>&1; then echo "STILL LOADED: $L" >&2; FAIL=1; else echo "stopped: $L"; fi
  else
    echo "not loaded: $L"
  fi
done
# 3. Any remaining process for THIS tunnel only (by name), then verify.
pkill -f "cloudflared .*tunnel .*run .*$TUNNEL\$" 2>/dev/null || true
if pgrep -f "cloudflared .*tunnel .*run .*$TUNNEL" >/dev/null 2>&1; then echo "STILL RUNNING: cloudflared tunnel $TUNNEL" >&2; FAIL=1; else echo "no cloudflared process for tunnel $TUNNEL"; fi
if pgrep -f "atlas-mcp.ts exposure-http" >/dev/null 2>&1; then echo "STILL RUNNING: exposure-http process" >&2; FAIL=1; fi
# 4. Report (status of the named config: killed, hostedSource, tokens).
"$NODE" --no-warnings "$HERE/atlas-mcp/bin/atlas-mcp.ts" exposure-status --config "$CONFIG" || FAIL=1
echo "Next (human, in Cloudflare): revoke this phase's service token and/or disable the Access application."
exit $FAIL
