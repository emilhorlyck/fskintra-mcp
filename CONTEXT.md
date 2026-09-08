# CONTEXT.md

The domain vocabulary of `fskintra-mcp`. When you name a concept in an issue,
test, refactor, or hypothesis, use the term as defined here rather than a
synonym. This is a living glossary — extend it via `/domain-modeling` when a
real term is missing, don't invent parallel language.

For _why_ the system is shaped the way it is, read `docs/architecture.md`. This
file is _what the words mean_.

## The domain

**ForældreIntra** — the parent-facing half of **SkoleIntra**, a Danish school
portal (owned by itslearning). This project is unofficial and unaffiliated. A
parent logs in and sees data about their own children's classes. There is no
public API; everything is scraped from HTML that varies by school and drifts
over time.

**Section** — one category of school data: `news`, `messages`, `weekplans`,
`homework`, `documents`, `photos`, `contacts`, `signups`. Each is a module a
school may or may not have bought. One section failing does not take the others
down.

**Child** — a pupil the logged-in parent is a guardian of. Data is scoped
per-child; a parent with two children queries each separately. A logged-in
front page carries one link per child (`/x/y/z/Index`) — that link shape, not a
fixed URL, is how the client recognises the front page.

## The three outcomes (the load-bearing distinction)

Never collapse these. The whole design turns on keeping them apart:

- **Available & parsed** — the section exists, the markup parsed, you have data
  (possibly a legitimately **empty** result: "no homework this week" is a true,
  successful answer).
- **Unavailable** — the school did not buy this module. ForældreIntra answers
  _"ikke autoriseret"_ / _"du er ikke autoriseret"_. Modelled as
  `SectionUnavailableError`. An agent must report this as "your school doesn't
  use that", **not** as "nothing found".
- **Broken** — the section should have parsed but didn't (markup drift, a moved
  selector). Modelled as `SectionParseError`. An agent reports this as a bug to
  file.

`doctor` renders these as `✓` (parsed), `!` (unavailable), `✗` (broken).

## Auth & session

**Ordinary login ("alm login")** — the only supported flow: three form posts,
no browser. **UNI-Login** is explicitly _not_ supported; the client stops with
an error rather than half-working.

**Entry path / front door** — where login starts. `/Fi/` (ForældreIntra's own
front door, gets the Parent role right) is tried before `/Account/IdpLogin`
(where the SSO chain ends; some installations serve it directly, others 404 it).

**SSO relay** — an intermediate auto-submitting form in the SAML chain. Must be
detected _before_ the login-form check, because a relay can render at the same
path as the login form.

**Front page** — the logged-in landing page, recognised by carrying child links
(see **Child**), not by a fixed URL. Login's "am I there?" test and the client's
"is this usable?" test are deliberately the same question.

**Stored session** — the persisted credential record. Because ForældreIntra has
**no refresh token**, renewing a dead session means replaying the login form,
so the record includes the **password** — which is why the store is
**encrypted** (macOS Keychain, or an AES-256-GCM file elsewhere), never plain
JSON. `--no-store-password` opts out at the cost of needing the user present at
every expiry.

**Expired-session trap** — an expired session gets `200 OK` and a login page,
not an error. `fetchRaw` detects this by final URL, re-authenticates **once**,
and retries.

## Message UIs

Schools run one of **two entirely different** message interfaces:

- **Conversations UI** (newer) — conversation list lives as JSON on a `data-`
  attribute; threads served from JSON endpoints. `thread_id` is meaningful.
- **Inbox/outbox UI** (older) — pages to scrape; the less-tested of the two.

`detectMessageUi` sniffs which from the "Besked" menu link; `discover` reports
it so the agent knows whether `thread_id` means anything before calling
`messages.get`. `findConversationsJson` matches by _shape_ (an attribute whose
name contains "message", value > 100 chars, parsing to an object with a
`Conversations` array), because the attribute has been renamed before.

## Tool surface

**`discover`** — the manifest. An agent calls it **once** and works from it: it
returns the children, per-section availability (`capabilities[section].availableFor`,
empty = school doesn't have it; plus `unavailableSections`), and which message
UI the school runs. Don't hard-code a tool tree; read the manifest.

**`doctor`** — the diagnostic. Walks every section for every child, separates
unavailable from broken, writes a sanitised wire transcript. The intended first
move for first contact and for any regression.

**Write tools** — `messages.mark_read` (behind `FSKINTRA_MCP_WRITE=1`). Marking
read is visible to the school. **Contact confirmation** ("Bekræft
kontaktoplysninger") is a write we do _not_ do by default: it's a statement the
parent makes that their details are correct, so the client throws
`ConfirmContactsRequiredError` and only `FSKINTRA_MCP_AUTO_CONFIRM_CONTACTS=1`
(or `--confirm-contacts`) says yes.

## Diagnostics

**Wire trace / transcript** — an opt-in (`--debug`) JSONL log of every HTTP
exchange, with secrets **redacted** (cookies, auth headers, passwords,
anti-forgery tokens, SAML responses; the same names as query params). Bodies
truncated at 4 KB with the real byte count kept. Lives in the HTTP client, not a
login-specific path, because this project is mostly _scraping_, not mostly
_auth_ — the transcript is the primary debugging tool for page fetches too.

**Reference source** — `svalgaard/fskintra`. None of its code is reused (Python
2, `mechanize`), but it is the only written-down description of ForældreIntra's
login flow, URL map, and DOM selectors. Fixture comments point back at the
module they were shaped from.
