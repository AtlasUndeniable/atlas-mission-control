#!/bin/sh
# Lane X kill switch: one command refuses ALL external requests, then takes the path down.
#   sh atlas-mcp/deploy/kill-switch.sh            # refuse everything now, stop origin + tunnel
#   sh atlas-mcp/deploy/kill-switch.sh --revoke   # also revoke every exposed token
# Order matters: the origin refuses first (instant, even mid-request), then the processes stop.
# Prints no secrets. Safe to run repeatedly. It never touches the local Rhys stdio install.
set -u
HERE=$(cd "$(dirname "$0")/../.." && pwd)
CONFIG=${ATLAS_MCP_EXPOSURE_CONFIG:-/Users/atlasai/.config/atlas/atlas-mcp-exposure/config.json}
NODE=/opt/homebrew/bin/node
REVOKE=""
[ "${1:-}" = "--revoke" ] && REVOKE="--revoke-tokens"
# 1. Origin refuses every request (503) from this moment, including in-flight ones.
"$NODE" --no-warnings "$HERE/atlas-mcp/bin/atlas-mcp.ts" exposure-kill --config "$CONFIG" $REVOKE || echo "kill-file step FAILED: stop the processes below and check by hand" >&2
# 2. Stop the origin server (launchd job), if loaded.
launchctl bootout "gui/$(id -u)/ai.atlas.atlas-mcp-exposure" 2>/dev/null && echo "origin job stopped" || echo "origin job was not loaded"
# 3. Stop the tunnel: user LaunchAgent if present; a system daemon needs sudo (printed, not run).
launchctl bootout "gui/$(id -u)/com.cloudflare.cloudflared" 2>/dev/null && echo "tunnel agent stopped" || true
if launchctl print system/com.cloudflare.cloudflared >/dev/null 2>&1; then
  echo "A system cloudflared daemon is loaded. Run: sudo launchctl bootout system/com.cloudflare.cloudflared" >&2
fi
pkill -f "cloudflared.*tunnel" 2>/dev/null && echo "cloudflared processes stopped" || true
# 4. Report.
"$NODE" --no-warnings "$HERE/atlas-mcp/bin/atlas-mcp.ts" exposure-status --config "$CONFIG"
echo "Next (human, in Cloudflare): revoke the Grok service token and/or disable the Access application."
