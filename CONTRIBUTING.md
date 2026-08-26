# Contributing

## Setup

```bash
pnpm install     # pnpm resolves the workspace and owns the lockfile
bun test         # Bun runs the tests; there is no build step
pnpm typecheck   # tsc is the type-checker, not the runtime
pnpm lint        # biome
```

Node 22+ is installed only so `tsc` can run. Everything else executes under Bun.

## The one thing to know before changing a parser

ForældreIntra's markup is not a contract, and schools run different versions of
it. So:

1. **Every parser has a pure function** that takes a `Doc` and returns data —
   `parseFrontpage`, `parseWeekplan`, `collectDocuments`, `findConversationsJson`.
   Test that with a fixture. Do not reach for the network in a test.
2. **Fixtures go in the test file**, shaped after the real markup, with a
   comment pointing at the corresponding `svalgaard/fskintra` module. That repo
   is the only written-down description of these pages that exists.
3. **"Missing" and "not available" are different.** A school without the
   homework module answers "ikke autoriseret". Throw `SectionUnavailableError`
   for that and `SectionParseError` for markup that should have been there. An
   agent reports the first as "your school doesn't use that" and the second as
   a bug; collapsing them tells parents something false.

## Layering

```
fskintra-auth  →  fskintra-client  →  mcp-server
                                          ↑
                                       apps/cli
```

The direction is one-way and enforced by review. `fskintra-auth` must not learn
what a ForældreIntra page contains; `fskintra-client` must not learn about MCP.
Tests import only their own layer's internals.

## Commits

Conventional Commits — release-please builds the changelog and version bumps
from them. `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## Reporting a parser break

`fskintra doctor --debug` is the intended first move for any "it stopped
working". It walks every section for every child and writes a sanitised wire
transcript. Attach both.
