# Architecture

Design rationale for the choices that aren't obvious from reading the code. The
README covers _what_ this does; this covers _why_ it's shaped this way.

The shape is deliberately borrowed from
[Casperjuel/aula-mcp](https://github.com/Casperjuel/aula-mcp), which solves the
adjacent problem for Aula. Where the reasoning transfers unchanged, this
document says so and moves on. Where ForældreIntra forced a different answer,
it says that instead — those sections are the interesting ones.

## Why a monorepo

The package layout mirrors layered responsibility, with a strict one-way
dependency direction:

```
fskintra-auth  →  fskintra-client  →  mcp-server
                                          ↑
                                       apps/cli
```

- `fskintra-auth` knows about HTTP, cookies, the login form and the encrypted
  session store. It does not know what a ForældreIntra page contains.
- `fskintra-client` knows what those pages contain. It does not know about MCP,
  Hono, or the CLI.
- `mcp-server` and `apps/cli` are leaves — two transports over the same two
  libraries.

The payoff is triage. "Login stopped working" and "homework stopped parsing"
are different packages, and the second is by far the more common. Keeping them
apart means a bug report usually lands in one package without reading the
others, and the auth package stays reusable by anyone who wants an
authenticated ForældreIntra session without buying into MCP.

## Why Bun alone

Bun is the package manager, the test runner and the runtime. There is no Node
in the toolchain and no second package manager.

This is a deliberate divergence from aula-mcp, which splits the two: pnpm
installs, Bun runs, and its architecture doc justifies that with "Bun's
installer doesn't yet match pnpm's strictness for this workspace". That was
true when it was written. On Bun 1.4 the four things pnpm was there for have
all landed:

| Needed | Bun 1.4 |
|---|---|
| Strict, no-phantom-dependency layout | `linker = "isolated"` |
| A lockfile CI can freeze against | `--frozen-lockfile`, `bun.lock` |
| Supply-chain publish delay | `minimumReleaseAge` |
| Workspaces and `workspace:*` | supported |

The first two live in `bunfig.toml`; the lockfile and workspaces need no
configuration. One unit trap worth knowing: pnpm counts `minimumReleaseAge` in
minutes, Bun counts it in seconds, so the same two-day window is `172800` here
rather than `2880`.

`tsc --noEmit` runs under Bun too, so TypeScript stays the type-checker without
dragging a runtime along behind it.

### What this costs

Dependabot's Bun support covers version updates but not security updates, and
there is an open bug where its updater image ships an older Bun that cannot read
a `lockfileVersion 2` `bun.lock` and silently rewrites it as v1. `pnpm-lock.yaml`
has better coverage today.

That is a real trade, taken knowingly: for a repo one family runs against one
school, a single toolchain is worth more than automated security bumps. If this
ever grows a userbase, moving installs back to pnpm is a `bunfig.toml` deletion
and a CI step — the layering above does not depend on it.

## Why we own the HTTP flow

fskintra (the Python reference) used `mechanize`. The obvious modern move would
be Playwright. We don't, for the reasons aula-mcp gives about MitID, all of
which apply here and one of which applies harder:

- **Dependency footprint.** ~300 MB of Chromium per platform, for a flow that
  is three form posts.
- **Failure modes.** A browser flow fails with "selector not found" or
  "navigation timeout". This one fails with `No ordinary login form at
  https://…/Account/IdpLogin` or `Login did not reach the front page after 8
  rounds. Last URL: …`. Those point at a line.
- **Auditability.** `wire-tracer.ts` produces a sanitised JSONL transcript of
  every exchange. Inside a browser the actual requests are invisible to us.

The harder one: **this project is mostly scraping, not mostly auth.** Aula has a
real API behind a hard login; ForældreIntra has a trivial login in front of
HTML that changes. The transcript is not a login-debugging tool here, it is the
primary tool, and it needs to cover ordinary page fetches too — which is why the
tracer lives in the HTTP client rather than in a login-specific path.

### Manual redirects are not an optimisation

`fetch`'s automatic redirect handling never surfaces `Set-Cookie` from
intermediate hops. The ForældreIntra login walks an SSO relay chain that sets
cookies on those hops. Following redirects by hand is the difference between a
login that works and one that appears to work and then 302s back to the login
page on the first real request. `http.test.ts` pins this.

The same loop also has to drop the POST body when a 302 turns the request into a
GET. It didn't, at first; the test that caught it is still there.

## Where ForældreIntra differs from Aula

### There is no refresh token, so the password is stored

Aula persists OAuth tokens and refreshes them silently. ForældreIntra offers
nothing equivalent: when the session cookie dies, the only way to get another is
to replay the login form with the password.

So `StoredSessionRecord` carries the password, and **that is the reason the
store is encrypted rather than plain JSON**. Key resolution follows aula-mcp's
order exactly:

1. an explicit `Buffer` passed to the constructor — strongest, for callers
   reading from a system keychain,
2. `FSKINTRA_MCP_KEY` — 64 hex chars, or a passphrase (SHA-256-derived),
3. a generated `~/.config/fskintra-mcp/.key` (mode 0600), with a warning that 1
   or 2 are stronger.

`fskintra login --no-store-password` opts out. The trade-off is real and it is
the user's to make: without a stored password, an expired session needs you
present, and a headless server on a NAS simply stops working until you notice.

### Keychain by default, unlike aula-mcp v0.1

aula-mcp deferred OS keychain support, reasoning that four platform bindings
weren't worth it before the flow had been used in anger. We ship the macOS one
now, because the thing being stored is a password rather than a short-lived
token, and because the `security` CLI needs no binding at all — just a forked
process, a few times a day.

Non-macOS platforms and containers get the encrypted file. The Home Assistant
add-on forces it with `FSKINTRA_MCP_NO_KEYCHAIN=1`; there is no keychain daemon
in a container, and discovering that at runtime is a worse experience than
being told.

### The equivalent of "widget JWT goes dead"

aula-mcp bakes in a fix for upstream #311: a widget token expires and Aula
answers **200 OK** with a body that means "not authenticated", so naive callers
don't notice.

ForældreIntra has exactly this failure, in the most common possible form: an
expired session gets a 200 and a login page. `FskintraClient.fetchRaw` detects
it by final URL, re-authenticates **once**, and retries. It lives in the client
for the same reason aula-mcp put its version in `WidgetTokenManager`: at a call
site, someone will forget.

### `discover` matters more here, not less

The `aula.discover` argument — don't hard-code a tool tree, hand the agent a
manifest — transfers directly. But ForældreIntra sharpens it.

Aula's widget detection is about which third-party provider serves a capability.
ForældreIntra's is about whether the capability exists at all: schools buy
modules separately, and one without homework answers with a page reading *"du er
ikke autoriseret"*.

That makes the distinction load-bearing in a way it isn't for Aula. "This school
does not use homework" and "there is no homework this week" are different
sentences to a parent, and only one of them is true. So:

- `SectionUnavailableError` and `SectionParseError` are separate types.
- `probeSections` runs one cheap request per section and reports which is which.
- The manifest exposes `capabilities[section].availableFor` (empty = the school
  doesn't have it) and `unavailableSections`.
- The MCP tool turns the first into `{"error":"section_unavailable", …}` with an
  explicit instruction not to report it as "nothing found".

### Two message UIs

Schools run one of two entirely different message interfaces. The newer one
keeps its conversation list in JSON on a `data-` attribute and serves threads
from JSON endpoints; the older one is inbox/outbox pages to scrape.

`detectMessageUi` sniffs it from the "Besked" menu link, as fskintra did, and
`discover` reports it — so the agent knows whether `thread_id` means anything
before it calls `messages.get`, rather than finding out by failing.

The attribute holding that JSON has been renamed before, so
`findConversationsJson` searches by *shape*: any attribute whose name contains
"message", whose value exceeds 100 characters, and which parses to an object
with a `Conversations` array. A fixed selector would break silently at the next
rename.

### Contact confirmation is a write, and we don't do writes by default

ForældreIntra periodically blocks login with "Bekræft kontaktoplysninger".
fskintra clicks it for you. We don't.

Confirming tells the school the details on file are correct. That is a statement
the parent makes, not their MCP server. So the login client throws
`ConfirmContactsRequiredError` carrying the page text, the tool layer turns it
into a structured `confirm_contacts_required` payload with a URL and an
instruction, and `FSKINTRA_MCP_AUTO_CONFIRM_CONTACTS=1` (or `fskintra login
--confirm-contacts`) is how you say yes.

This is the same reflex as aula-mcp surfacing `AulaStepUpRequiredError` as
structured JSON: an agent can act on "you must do X"; it cannot act on `[]`.

### The login flow has more than one front door

Login used to start at `https://<host>/Account/IdpLogin` and nowhere else. That
is where the flow *ends*, and on a good number of installations the school host
does not serve it at all — the request 404s and the state machine reports "no
ordinary login form", which reads like markup drift and is actually a wrong URL.

What those installations do serve is `/Fi/`, ForældreIntra's own front door. It
redirects through `/Infoweb/Fi2/Default.asp` to
`csiproxy/login?roleType=Parent` on the school's `.m.` host, bounces off the
SAML IdP at `idp.m.skoleintra.dk`, and comes back to an `/Account/IdpLogin`
form already stamped `RoleType=Parent`:

```
/Fi/ → /Infoweb/Fi2/Default.asp → <school>.m.skoleintra.dk/csiproxy/login?roleType=Parent
     → idp.m.skoleintra.dk/sso/ssoservice?SAMLRequest=… → <school>.m.skoleintra.dk/Account/IdpLogin?role=Parent
```

So `ENTRY_PATHS` tries `/Fi/` first and `/Account/IdpLogin` second, treating any
error status (a 404, but also a 403/410) as "not this door" rather than as
failure. Asking for the front door first
also gets the role right: entering at the school host's root would pick up
`roleType=Teacher`, which is a login a parent cannot complete.

Two consequences worth stating out loud. The credentials POST can land on a
different host than the one the user typed, which is why the cookie jar is a
real jar and redirects are followed by hand. And a login that finds no door
anywhere reports every URL it tried with the status each returned, because the
next school to break this will break it by moving the door again.

### Authentication succeeding is not the same as landing somewhere

The flow carries a return URL through the whole SAML exchange —
`/Fi/`, typically, because that is the door it came in by. One school
(`steinerskolen-kvistgaard.m.skoleintra.dk`) consumes the assertion, sets the
session cookies, redirects to that return URL, and answers it with a bare IIS
404. Every step worked. The parent simply does not live at `/Fi/` there:

```
POST /sso/assertionconsumerservice → 302 /Fi/   ← cookies set, login done
GET  /Fi/                          → 404        ← the return URL is a fiction
```

Reported as "login did not reach the front page after 8 rounds", which is true
and useless: it points at the credentials, and the credentials were fine.

So a 4xx/5xx *after* the SSO exchange is not a failed login, and the state
machine no longer treats it as one. It retries at the site root — first on the
host it ended up on, then on the one the user typed, each at most once. The
root is the installation's own answer to "where does this user belong": with
the assertion already consumed it renders the front page directly, and if the
session did not take it starts a fresh SAML round trip the loop can walk. A
root that cannot be fetched is swallowed, so the error still names the dead end
we actually found rather than the guess we made about it.

That fallback only helps if the page it lands on is recognised, and matching
`/parent/<id>/<name>/Index` on the URL is too narrow for a flow whose whole
problem is that URLs move. A front page is now anything carrying child links
(`/x/y/z/Index`) — which is precisely what the client scrapes off it a moment
later, so the login's test for "am I there?" and the client's test for "is this
usable?" are the same question. `resume()` uses it too; otherwise a session
whose front page is at `/` would be re-logged-in on every single call.

### The relay check has to come before the login check

The login state machine originally tested "am I on `/Account/IdpLogin`?" before
"is this an SSO relay?". fskintra orders them the other way, and it is right: a
relay can render at the same path the login form uses, and matching on the URL
alone re-submits credentials into a form with no username field.

The fix distinguishes an *explicit* relay (a form named `relay`, or a page under
`/sso/ssocomplete` — the two shapes fskintra actually observed) from a lone
unnamed form. Explicit relays are followed first; the generic single-form case
is tried only after every known branch is ruled out — including the child-link
front-page test, because a real ASP.NET front page wraps its whole body in one
`<form>` and would otherwise be submitted back to the school. The generic relay
is also never followed on an error status, where a stray form is a dead landing
rather than a relay. The login page is a lone form too, which is the other
reason this case comes last.

## Read-only by default

The server registers no write tools unless `FSKINTRA_MCP_WRITE=1`, and no
raw-page escape hatch unless `FSKINTRA_MCP_RAW=1`. The HTTP server refuses to
bind a non-loopback address unless `FSKINTRA_MCP_ALLOW_REMOTE=1`.

Three defaults, one reason: the credential this holds reads a specific family's
school data, and the blast radius of a mistake is a child's school life rather
than a rate limit.

The only write ForældreIntra offers that we implement at all is marking a
message read — and even that is visible to the school.

## Wire trace and sanitisation

`--debug` tees a JSONL transcript to
`~/.config/fskintra-mcp/transcripts/login-<timestamp>.jsonl`. Redaction lists
live in `wire-tracer.ts`.

Redacted: `cookie` / `set-cookie` / `authorization` headers; body fields for
passwords, anti-forgery tokens, SAML responses and OAuth material; the same
names as URL query parameters.

Not redacted, deliberately: method, host, path, status, redirect locations minus
their secret params, and timing. Those are what make a transcript diagnosable,
and a transcript nobody can read is not worth writing. Redacted values become
`<redacted N chars>`, so the trace still says a value was there.

Response bodies are truncated at 4 KB with the real byte count kept.
ForældreIntra pages are large and mostly navigation chrome; the first 4 KB tells
you which page came back, which is the question being asked.

## Testing

Every parser has a pure `Doc → data` function, tested against a fixture shaped
after the real markup, with a comment naming the fskintra module it came from.
Network-touching code is tested by stubbing `fetch` with a route map.

Three tests exist because they caught real bugs, and are worth not deleting:

- cookies from intermediate redirect hops reaching the final request,
- a redirected POST not resending its body,
- an expired session (200 + login page) re-authenticating exactly once.

## Where this leaves us

The architecture is built and unit-tested. What has **not** happened is a run
against a live ForældreIntra: every selector here is ported from a Python
codebase that stopped being updated years ago.

`fskintra doctor --debug` exists precisely to make that first contact short. It
walks every section for every child, separates "the school doesn't have this"
from "this is broken", and writes a shareable transcript. Expect the first run
to find things.
