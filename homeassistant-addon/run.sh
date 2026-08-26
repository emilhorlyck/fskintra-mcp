#!/bin/sh
# Home Assistant add-on entry. Translates HA-style options (read from
# /data/options.json, populated by Supervisor) into the env vars fskintra-mcp
# expects, then execs into the long-running MCP server.
set -eu

OPTIONS_FILE=/data/options.json

if [ -f "$OPTIONS_FILE" ]; then
  HOSTNAME_OPT="$(jq -r '.hostname // empty' "$OPTIONS_FILE")"
  USERNAME_OPT="$(jq -r '.username // empty' "$OPTIONS_FILE")"
  PASSWORD_OPT="$(jq -r '.password // empty' "$OPTIONS_FILE")"
  KEY_OPT="$(jq -r '.fskintra_mcp_key // empty' "$OPTIONS_FILE")"
  LOG="$(jq -r '.log // false' "$OPTIONS_FILE")"
  ALLOW_REMOTE="$(jq -r '.allow_remote // true' "$OPTIONS_FILE")"
else
  # Running outside Supervisor (a local docker test). Fall back to env.
  HOSTNAME_OPT="${FSKINTRA_HOSTNAME:-}"
  USERNAME_OPT="${FSKINTRA_USERNAME:-}"
  PASSWORD_OPT="${FSKINTRA_PASSWORD:-}"
  KEY_OPT="${FSKINTRA_MCP_KEY:-}"
  LOG="${LOG:-false}"
  ALLOW_REMOTE="${ALLOW_REMOTE:-true}"
fi

# /config/fskintra-mcp/ is mapped from Supervisor's config volume. Two ways to
# get credentials in: fill the add-on options above, or copy a session.json +
# .key here from a workstation. The options path is simpler and is what most
# people want; the copy path avoids putting the password in HA's options store.
export FSKINTRA_MCP_DIR="/config/fskintra-mcp"
mkdir -p "$FSKINTRA_MCP_DIR"

# No keychain daemon in a container — force the encrypted-file backend.
export FSKINTRA_MCP_NO_KEYCHAIN=1

[ -n "$HOSTNAME_OPT" ] && export FSKINTRA_HOSTNAME="$HOSTNAME_OPT"
[ -n "$USERNAME_OPT" ] && export FSKINTRA_USERNAME="$USERNAME_OPT"
[ -n "$PASSWORD_OPT" ] && export FSKINTRA_PASSWORD="$PASSWORD_OPT"
[ -n "$KEY_OPT" ] && export FSKINTRA_MCP_KEY="$KEY_OPT"

# The server refuses non-loopback binds by default. Serving the LAN is the whole
# point of running it in HA, so the default option opens it up. Setting
# allow_remote: false keeps traffic inside the container — useful behind a
# reverse proxy, but then HA's MCP client integration cannot reach :7979 either.
if [ "$ALLOW_REMOTE" = "true" ]; then
  export FSKINTRA_MCP_HOST="0.0.0.0"
  export FSKINTRA_MCP_ALLOW_REMOTE=1
else
  export FSKINTRA_MCP_HOST="127.0.0.1"
fi

if [ "$LOG" = "true" ]; then
  export FSKINTRA_MCP_LOG=1
fi

cd /app
exec bun packages/mcp-server/src/server.ts
