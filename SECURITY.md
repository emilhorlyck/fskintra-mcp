# Security policy

## Reporting a vulnerability

Please report privately through GitHub's security advisories rather than a
public issue. This project holds a credential that reads a family's school
data, so a public report is a live disclosure.

## What this project stores, and where

| Thing | Where | Protection |
|---|---|---|
| ForældreIntra password | macOS Keychain, or `~/.config/fskintra-mcp/session.json` | Keychain ACL, or AES-256-GCM with a key from `FSKINTRA_MCP_KEY` / `~/.config/fskintra-mcp/.key` (mode 0600) |
| Session cookies | same record | same |
| Wire transcripts | `~/.config/fskintra-mcp/transcripts/*.jsonl` | Plaintext, but written with secrets redacted |
| Login log | `~/.config/fskintra-mcp/login-log.jsonl` | Plaintext; hostname, username, outcome and timing only |

The password is stored because ForældreIntra offers no refresh token: replaying
the login form is the only way to renew an expired session. `fskintra login
--no-store-password` opts out, at the cost of needing you present whenever the
session dies.

## Defaults chosen for safety

- The HTTP server **refuses to bind a non-loopback address** unless
  `FSKINTRA_MCP_ALLOW_REMOTE=1`. Anyone who can reach `/mcp` can read your data.
- Write tools are **not registered** unless `FSKINTRA_MCP_WRITE=1`.
- The raw-page escape hatch is **not registered** unless `FSKINTRA_MCP_RAW=1`.
- The "Bekræft kontaktoplysninger" form is **not submitted** unless
  `FSKINTRA_MCP_AUTO_CONFIRM_CONTACTS=1` — confirming is a change the school
  sees, and it is the user's to make.

## Transcript redaction

Redaction lists live in `packages/fskintra-auth/src/wire-tracer.ts`
(`SECRET_HEADERS`, `SECRET_BODY_FIELDS`, `SECRET_URL_PARAMS`). Redacted values
are replaced with `<redacted N chars>`, so a transcript still tells you a value
was present without revealing it.

Not redacted, deliberately: HTTP method, host and path, status codes, redirect
locations minus their secret query params, and timing. Those are what make a
transcript diagnosable, and a transcript nobody can read is not worth writing.
