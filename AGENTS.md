# AGENTS.md

Operating instructions for agents working on `fskintra-mcp`. Read this, then
`CONTEXT.md`, before making changes.

## What this is

An MCP server for **ForældreIntra** (SkoleIntra): logs in as a parent and
exposes school data (news, messages, weekly plans, homework, documents, photos,
contacts, sign-ups) as tools an LLM can call. It is an interface, not the LLM.
See `README.md` for the user-facing picture and `docs/architecture.md` for the
design rationale.

**Nothing here has been proven against a live ForældreIntra.** Every selector is
ported from `svalgaard/fskintra`, a Python 2 tool that froze years ago.
`fskintra doctor --debug` is the tool for first contact and for every "it
stopped working".

## Non-negotiables

- **Layering is one-way and enforced by review**: `fskintra-auth → fskintra-client → mcp-server ← apps/cli`. `fskintra-auth` must not learn what a page contains; `fskintra-client` must not learn about MCP. Tests import only their own layer's internals.
- **"Unavailable", "empty", and "broken" are three different types.** A school without a module answers _"ikke autoriseret"_ → `SectionUnavailableError`. Markup that should have parsed but didn't → `SectionParseError`. An empty result is a real, successful empty. Collapsing any two of these tells a parent something false. This is the single most important invariant in the codebase.
- **Read-only by default.** Write tools register only under `FSKINTRA_MCP_WRITE=1`; the raw escape hatch only under `FSKINTRA_MCP_RAW=1`; a non-loopback bind only under `FSKINTRA_MCP_ALLOW_REMOTE=1`. A write is a statement the parent makes, not the server.
- **Every parser has a pure `Doc → data` function**, tested against a fixture shaped after real markup, with a comment naming the `svalgaard/fskintra` module it came from. Never reach for the network in a test.
- **`trash`, never `rm`.** Don't run destructive git (force-push, history rewrite) without explicit instruction.

## Workflow

- **Toolchain is Bun alone** (1.4+). `bun install`, `bun test`, `bun run typecheck`, `bun run lint`. No Node, no second package manager. See ADR / `docs/architecture.md#why-bun-alone`. Bun installs to `~/.bun/bin`; if `bun: command not found`, `export PATH="$HOME/.bun/bin:$PATH"`.
- **Commits are Conventional Commits** — release-please builds the changelog and version bumps from them. `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- **Before merging**: `bun test && bun run typecheck && bun run lint` all green.
- Reporting a parser break: attach the output of `fskintra doctor --debug` (sanitised wire transcript) and the section that failed.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues on `emilhorlyck/fskintra-mcp` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to identically-named labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
