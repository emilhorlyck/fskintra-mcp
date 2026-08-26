# Running fskintra-mcp with Home Assistant

The short version lives in
[`homeassistant-addon/README.md`](../homeassistant-addon/README.md). This page
covers the parts that trip people up.

## Why the legacy SSE transport exists

MCP has moved to Streamable HTTP. Home Assistant's official `mcp` (client)
integration still speaks the older SSE dialect, so the server serves both:

| Route | Transport |
|---|---|
| `/mcp` | Streamable HTTP (POST / GET / DELETE) |
| `/sse` + `/messages?sessionId=…` | Legacy SSE |

Each `GET /sse` opens its own session with its own MCP server and its own
client. The session map is capped (`FSKINTRA_MCP_SSE_MAX_SESSIONS`, default 16)
and idle-evicted (`FSKINTRA_MCP_SSE_IDLE_MS`, default 5 minutes), because a
looping client would otherwise pile up sessions on a box you aren't watching.

## Credentials on a headless box

There is no keychain in a container, so the add-on forces the encrypted-file
backend. Two ways to get credentials in, with a real trade-off:

**Add-on options.** Simple. The password sits in HA's options store, readable by
anyone with admin access to your HA instance.

**Copy a session.** Log in on a workstation with
`FSKINTRA_MCP_NO_KEYCHAIN=1 bun run fskintra login --no-store-password`, then copy
`session.json` and `.key` into `/config/fskintra-mcp/`. The password never
reaches HA — but neither can the add-on renew the session when it expires, and
it will, silently, until someone notices Assist has gone quiet.

Set `fskintra_mcp_key` to a passphrase if you'd rather not copy the `.key` file.

## Asking the agent the right way

The conversation agent needs to be told to call `foraldreintra.discover` first.
The server advertises this in its MCP `instructions`; HA's integration does not
always surface those to the model, so put it in the agent's prompt too:

> Before answering anything about school, call `foraldreintra.discover` once and
> reuse the result. If a section's `availableFor` is empty, the school does not
> use that module — say so; do not report it as empty.

## Exposure

The server refuses non-loopback binds unless told otherwise. The add-on sets
`allow_remote: true` by default because serving the LAN is the whole point —
which does mean anyone on your LAN who can reach `:7979` can read your family's
school data. There is no authentication on `/mcp`. Treat it like any other
unauthenticated service on your home network.
