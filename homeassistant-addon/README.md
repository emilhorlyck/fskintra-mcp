# fskintra-mcp — Home Assistant add-on

Runs the ForældreIntra MCP server on your Home Assistant box so Assist (and
Voice) can answer "hvad har Andrea for til på mandag?".

## Install

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add
   `https://github.com/emilhein/fskintra-mcp`.
2. Install **fskintra-mcp**, then open its **Configuration** tab.
3. Fill in `hostname`, `username` and `password`, or leave them blank and copy
   a session in by hand (below). Start the add-on.
4. **Settings → Devices & Services → Add Integration → Model Context Protocol**,
   URL `http://homeassistant.local:7979/sse`.
5. Point your conversation agent at the MCP integration and tell it, in the
   system prompt, to call `foraldreintra.discover` first.

## Credentials: two ways

**Add-on options** (simple). The password lives in HA's options store, readable
by anyone with admin access to your HA instance.

**Copy a session** (keeps the password off HA). On a workstation:

```bash
FSKINTRA_MCP_NO_KEYCHAIN=1 bun run fskintra login --no-store-password
```

Then copy `~/.config/fskintra-mcp/session.json` and `.key` into
`/config/fskintra-mcp/` on the HA box. Note the trade-off: without a stored
password the add-on cannot renew an expired session on its own, and you will
have to repeat this when it dies.

Setting `fskintra_mcp_key` to a passphrase means the `.key` file is not needed.

## Networking

The server refuses to bind anything but loopback unless told otherwise; the
add-on's `allow_remote: true` default flips that, because serving the LAN is the
point. Anyone on your LAN who can reach `:7979` can read your family's school
data — put HA behind a network you trust.

## Ports

| Port | Purpose |
|---|---|
| 7979 | `/mcp` (Streamable HTTP) and `/sse` (legacy transport, what HA speaks) |

## Troubleshooting

Turn on the `log` option and check the add-on log. If tools return
`not_logged_in`, the credentials never took; if they return `session_expired`,
the session died and could not be renewed — which usually means no password is
stored.
