# fskintra-mcp

An MCP server for **ForældreIntra** (SkoleIntra) — logs in as a parent and
exposes news, messages, weekly plans, homework, documents, photos, contacts and
sign-ups as tools an AI agent can call.

Unofficial and third-party. Not affiliated with itslearning.

## Where this comes from

Two projects, two different debts:

- **[svalgaard/fskintra](https://github.com/svalgaard/fskintra)** — a long-running
  Python tool that turns ForældreIntra into email. None of its code is reused
  (it is Python 2 on `mechanize`), but it is the only written-down description
  of ForældreIntra's login flow, URL map and DOM selectors that exists. That
  reverse-engineering is what this project stands on.
- **[Casperjuel/aula-mcp](https://github.com/Casperjuel/aula-mcp)** — the same
  problem solved for Aula. The architecture here is deliberately borrowed from
  it: layered packages, encrypted credential store, wire-tracing with
  redaction, a `discover`-first tool surface, and a `doctor` command.
  [`docs/architecture.md`](docs/architecture.md) says which parts transferred
  unchanged and which ForældreIntra forced a different answer to.

## Quick start

```bash
bun install
bun run fskintra login
bun run fskintra doctor        # does anything actually parse?
```

Then wire it into an agent — see [`examples/claude-config`](examples/claude-config):

```bash
claude mcp add foraldreintra -- bun $PWD/packages/mcp-server/src/server-stdio.ts
```

Only ordinary ForældreIntra login ("alm login") is supported. If your school
redirects to UNI-Login, the client stops with an explicit error rather than
half-working.

## Start with `doctor`

```
$ bun run fskintra doctor
• Store backend: macOS Keychain
✓ Logged in to minskole.skoleintra.dk as emil
• Message UI: conversations
• Children: Andrea 3A, Bertil 6B

──────────────────────────────────────── Andrea 3A
✓ news        child=Andrea 3A reminders=1 news=6 (412ms)
✓ messages    12 item(s) (233ms)
! weekplans   ForældreIntra says "ikke autoriseret".
✓ homework    2 item(s) (890ms)
✓ documents   14 item(s) (301ms)
```

Three outcomes, and the difference between the last two is the point:

| Mark | Meaning |
|---|---|
| ✓ | Parsed |
| ! | Your school does not have this module |
| ✗ | A parser bug — please file it |

Add `--debug` for a sanitised wire transcript, and `--dump <dir>` to save what
each section parsed.

## Tools

Agents should call `foraldreintra.discover` **once** and work from the manifest:
it returns the children, which sections this school actually has, and which
message UI it runs.

| Tool | What it does |
|---|---|
| `foraldreintra.discover` | Children, per-section availability, capability→tool map |
| `foraldreintra.news` | Front-page news with author, recipients, date, attachments; comments optional |
| `foraldreintra.messages.list` | Conversation list with thread/message ids |
| `foraldreintra.messages.get` | Every message in one conversation |
| `foraldreintra.weekplans` | Weekly plans, per day |
| `foraldreintra.homework` | Homework grouped by due date |
| `foraldreintra.documents` | Class documents including sub-folders |
| `foraldreintra.photos` | Photo albums and image URLs |
| `foraldreintra.contacts` | Contact cards for the class |
| `foraldreintra.signups` | Open sign-ups for conversations and events |
| `foraldreintra.download` | Saves an attachment to a local path |
| `foraldreintra.reauthenticate` | Fresh login, discarding the cached session |

Behind flags: `foraldreintra.messages.mark_read` (`FSKINTRA_MCP_WRITE=1`) and
`foraldreintra.raw_request` (`FSKINTRA_MCP_RAW=1`). **The server is read-only
without them.**

## CLI

```
fskintra login [--hostname H] [--username U] [--debug] [--no-store-password]
fskintra status | whoami | logout
fskintra doctor [--json] [--debug] [--dump DIR]
fskintra discover
fskintra fetch <section> [--child NAME] [--limit N] [--comments]
fskintra thread <message-id> [--thread THREAD_ID]
fskintra log [--last N]
fskintra transcript list | view <file> | prune [--keep N]
```

## How it fits together

```
fskintra-auth  →  fskintra-client  →  mcp-server
                                          ↑
                                       apps/cli
```

- **`packages/fskintra-auth`** — cookie-jar HTTP client with manual redirect
  walking, the login state machine, wire tracing, and the encrypted session
  store (Keychain on macOS, AES-256-GCM file elsewhere).
- **`packages/fskintra-client`** — one module per section, plus the
  section-availability probe. Every parser has a pure `Doc → data` function.
- **`packages/mcp-server`** — tools, `discover`, and both transports.
- **`apps/cli`** — `fskintra`.

Three decisions worth knowing before you read the code:

**Redirects are followed by hand.** `fetch` doesn't expose `Set-Cookie` from
intermediate hops, and the SSO relay sets cookies there.

**The stored session includes your password.** ForældreIntra has no refresh
token; replaying the login form is the only way to renew a dead session. That is
why the store is encrypted. `--no-store-password` opts out, at the cost of
needing you present at every expiry.

**"Unavailable" and "empty" are different types.** A school without homework
answers *"ikke autoriseret"*. An agent handed an empty array tells a parent
"no homework this week", which would be false.

Full reasoning in [`docs/architecture.md`](docs/architecture.md).

## Configuration

| Variable | Effect |
|---|---|
| `FSKINTRA_MCP_DIR` | Config dir (default `~/.config/fskintra-mcp`) |
| `FSKINTRA_MCP_KEY` | Encryption key (64 hex chars) or passphrase for the file backend |
| `FSKINTRA_MCP_NO_KEYCHAIN=1` | Use the encrypted file instead of the macOS Keychain |
| `FSKINTRA_MCP_LOG=1` | Verbose logs (stderr under stdio) |
| `FSKINTRA_MCP_WRITE=1` | Register write tools |
| `FSKINTRA_MCP_RAW=1` | Register the raw page-fetch escape hatch |
| `FSKINTRA_MCP_AUTO_CONFIRM_CONTACTS=1` | Submit the "Bekræft kontaktoplysninger" form automatically |
| `FSKINTRA_MCP_PORT` / `_HOST` | HTTP server bind (default `127.0.0.1:7979`) |
| `FSKINTRA_MCP_ALLOW_REMOTE=1` | Permit a non-loopback bind (refused otherwise) |
| `FSKINTRA_HOSTNAME` / `_USERNAME` / `_PASSWORD` | Credentials for headless installs, instead of `fskintra login` |

## Home Assistant

There is an add-on: [`homeassistant-addon/`](homeassistant-addon/README.md).
Point HA's Model Context Protocol integration at
`http://homeassistant.local:7979/sse` and Assist can answer questions about
school out loud.

## Known limits

- **Nothing here has run against a live ForældreIntra yet.** Every selector is
  ported from a codebase that froze years ago. `fskintra doctor` is the
  first move.
- **UNI-Login is not supported.**
- **Read-only.** No sending messages, no signing up for events.
- **The old message UI is the less-tested of the two.**
- **Selectors are a moving target.** Sections fail independently; one broken
  parser doesn't take the others down.

## Development

```bash
bun test          # 91 tests, no network
bun run typecheck
bun run lint
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) — particularly the part about keeping
"unavailable" and "broken" apart when you touch a parser.
