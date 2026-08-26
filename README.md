# fskintra-mcp

An MCP server for **ForældreIntra** (SkoleIntra) — logs in as a parent and exposes news,
messages, weekly plans, homework, documents, photos, contacts and sign-ups as tools.

ForældreIntra has no public API, so this scrapes the site. The URL map, login flow and DOM
selectors are ported from [svalgaard/fskintra](https://github.com/svalgaard/fskintra), a
long-running Python 2 tool that turns ForældreIntra into email. Nothing of that code is
reused directly — it is the reverse-engineering that carries over.

Unofficial and third-party: not affiliated with itslearning.

## Setup

```bash
npm install
npm run build
```

Configuration is environment-only:

| Variable | Required | Meaning |
|---|---|---|
| `FSKINTRA_HOSTNAME` | yes | Your school's host, e.g. `minskole.skoleintra.dk`. A full URL is accepted too. |
| `FSKINTRA_USERNAME` | yes | ForældreIntra username |
| `FSKINTRA_PASSWORD` | yes | ForældreIntra password |
| `FSKINTRA_STATE_DIR` | no | Where cookies are cached. Default `~/.fskintra-mcp` (files written `0600`). |
| `FSKINTRA_DEBUG` | no | `1` to log every request to stderr |
| `FSKINTRA_AUTO_CONFIRM_CONTACTS` | no | `1` to auto-submit the "Bekræft kontaktoplysninger" page. See below. |

Only ordinary ForældreIntra login ("alm login") is supported. If your school redirects to
UNI-Login, the server fails with an explicit error rather than half-working.

## Verify against your school first

```bash
FSKINTRA_HOSTNAME=minskole.skoleintra.dk \
FSKINTRA_USERNAME=... FSKINTRA_PASSWORD=... \
npm run probe -- --dump /tmp/fskintra-dump
```

This logs in, lists your children and reports OK/FAIL per section. `--dump` saves the parsed
output and the front-page HTML so selectors can be corrected when a section fails — schools
enable different modules, and the markup drifts.

## Register with Claude Code

```bash
claude mcp add foraldreintra \
  --env FSKINTRA_HOSTNAME=minskole.skoleintra.dk \
  --env FSKINTRA_USERNAME=... \
  --env FSKINTRA_PASSWORD=... \
  -- node /Users/emil/dev/fskintra-mcp/dist/server.js
```

## Tools

| Tool | What it does |
|---|---|
| `foraldreintra_list_children` | Children on the account. Call first — every other tool takes `child`. |
| `foraldreintra_get_news` | Front-page news with author, recipients, date, body, attachments; comments optional |
| `foraldreintra_list_messages` | Conversation list with thread/message ids |
| `foraldreintra_get_message` | Every message in one conversation |
| `foraldreintra_mark_message_read` | Marks read/unread — **writes state the school can see** |
| `foraldreintra_get_weekplans` | Weekly plans broken down per day |
| `foraldreintra_get_homework` | Homework grouped by due date |
| `foraldreintra_list_documents` | Class documents incl. sub-folders |
| `foraldreintra_get_photos` | Photo albums and image URLs |
| `foraldreintra_get_contacts` | Contact cards for the class |
| `foraldreintra_get_signups` | Open sign-ups for conversations and events |
| `foraldreintra_download` | Saves an attachment to a local path using the session |
| `foraldreintra_reauthenticate` | Drops the cached session and logs in again |

Everything except `mark_message_read`, `download` and `reauthenticate` is read-only.

## How it works

- `src/session.ts` — cookie-jar HTTP client. Redirects are followed **manually**, because
  `fetch`'s automatic redirect handling drops cookies set on intermediate SSO hops. Cookies
  and the discovered front-page URL persist to `FSKINTRA_STATE_DIR` so restarts skip login.
- `src/login.ts` — the login state machine: `/Account/IdpLogin` → credentials POST → SSO
  relay auto-submits → `/parent/<id>/<name>/Index`. Handles the periodic "confirm your
  contact details" interstitial, and retries once from scratch when a cached session expires.
- `src/children.ts` — children are discovered by scraping links matching
  `^(/[^/]*){3}/Index$`; the selected child's name only appears in `#sk-personal-menu-button`.
- `src/pages/*.ts` — one module per section. Each returns plain data, not HTML.

### The contact-details page

ForældreIntra periodically blocks login with "Bekræft kontaktoplysninger". Confirming is a
change the school sees, so by default the server refuses and shows you the page text.
Confirm once in a browser, or set `FSKINTRA_AUTO_CONFIRM_CONTACTS=1`.

## Known limits

- **Selectors are a moving target.** Sections fail independently; a failure in one does not
  break the others. Re-run the probe with `--dump` after a ForældreIntra update.
- **UNI-Login is not supported.**
- **Old vs new message UI.** Schools run one of two message interfaces; the server sniffs
  which from the "Besked" menu link. The new one reads a JSON blob out of a data attribute;
  the old one scrapes inbox/outbox pages. The old path is the less-tested of the two.
- **No sending.** Reading only — the server cannot write messages or sign up for events.

## Development

```bash
npm test        # parser unit tests, no network
npm run typecheck
npm run build
```
