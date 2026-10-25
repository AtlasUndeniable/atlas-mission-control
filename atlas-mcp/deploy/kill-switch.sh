#!/bin/sh
# Lane X kill switch: one command refuses ALL external requests, then takes the path down.
#   sh atlas-mcp/deploy/kill-switch.sh            # refuse everything now, stop origin + this tunnel
#   sh atlas-mcp/deploy/kill-switch.sh --revoke   # also revoke every exposed token
# Order matters: the origin refuses first (instant, even mid-request), then the processes stop.
# It only touches THIS lane's job and THIS named tunnel (atlas-mcp-grok); other cloudflared
# tunnels on the Mac are left alone (R16). Stopped state is verified, not assumed.
# Prints no secrets. Safe to run repeatedly. It never touches the local Rhys stdio install.
set -u
HERE=$(cd "$(dirname "$0")/../.." && pwd)
CONFIG=${ATLAS_MCP_EXPOSURE_CONFIG:-/Users/atlasai/.config/atlas/atlas-mcp-exposure/config.json}
TUNNEL=${ATLAS_MCP_TUNNEL_NAME:-atlas-mcp-grok}
ORIGIN_LABEL=ai.atlas.atlas-mcp-exposure
TUNNEL_LABEL=${ATLAS_MCP_TUNNEL_LABEL:-ai.atlas.cloudflared-atlas-mcp-grok}
NODE=/opt/homebrew/bin/node
UID_=$(id -u)
REVOKE=""
FAIL=0
[ "${1:-}" = "--revoke" ] && REVOKE="--revoke-tokens"
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
pkill -f "cloudflared .*tunnel .*run .*$TUNNEL " 2>/dev/null || true
if pgrep -f "cloudflared .*tunnel .*run .*$TUNNEL" >/dev/null 2>&1; then echo "STILL RUNNING: cloudflared tunnel $TUNNEL" >&2; FAIL=1; else echo "no cloudflared process for tunnel $TUNNEL"; fi
if pgrep -f "atlas-mcp.ts exposure-http" >/dev/null 2>&1; then echo "STILL RUNNING: exposure-http process" >&2; FAIL=1; fi
# A system-level daemon needs sudo: printed, never run.
if launchctl print system/com.cloudflare.cloudflared >/dev/null 2>&1; then
  echo "A system cloudflared daemon is loaded. If it serves $TUNNEL run: sudo launchctl bootout system/com.cloudflare.cloudflared" >&2
fi
# 4. Report.
"$NODE" --no-warnings "$HERE/atlas-mcp/bin/atlas-mcp.ts" exposure-status --config "$CONFIG" || FAIL=1
echo "Next (human, in Cloudflare): revoke the Grok service token and/or disable the Access application."
exit $FAIL
