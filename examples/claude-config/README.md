# Wiring fskintra-mcp into an agent

Two transports. Pick by how the agent runs.

- **stdio** — the agent spawns the server. Simplest; no port, no daemon. This is
  what Claude Code, Claude Desktop and Cursor want.
- **HTTP/SSE** — the server runs on its own and the agent connects. This is what
  Home Assistant wants, and what you want if several clients share one session.

## Log in first

```bash
bun run fskintra login
bun run fskintra doctor      # confirm the sections actually parse
```

The MCP server reads the same session store the CLI writes, so this works
against an already-running server.

## Claude Code

```bash
claude mcp add foraldreintra -- bun /path/to/fskintra-mcp/packages/mcp-server/src/server-stdio.ts
```

Or copy `claude-code.json` into your project's `.mcp.json`.

## Tell the agent to discover first

This matters more than the wiring. Put something like this in the system prompt:

> Before answering anything about school, call `foraldreintra.discover` once and
> reuse the result. It tells you the children's names and which sections this
> school actually has. If a section's `availableFor` is empty, the school does
> not use that module — say so rather than reporting it as empty.

The server also ships this as MCP `instructions`, which capable hosts surface on
their own. The prompt line is for the ones that don't.

## Environment

| Variable | Effect |
|---|---|
| `FSKINTRA_MCP_LOG=1` | Verbose logs (stderr under stdio) |
| `FSKINTRA_MCP_WRITE=1` | Register write tools (mark read). Off by default |
| `FSKINTRA_MCP_RAW=1` | Register the raw page-fetch escape hatch. Off by default |
| `FSKINTRA_MCP_NO_KEYCHAIN=1` | Use the encrypted file instead of the macOS Keychain |
| `FSKINTRA_MCP_KEY` | Encryption key or passphrase for the file backend |
