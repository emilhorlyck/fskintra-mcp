import { afterEach, describe, expect, test } from 'bun:test';
import {
  ConfirmContactsRequiredError,
  InvalidCredentialsError,
  UniLoginNotSupportedError,
} from './errors.ts';
import { FskintraHttpClient } from './http.ts';
import { FskintraLoginClient, normalizeHostname } from './login-client.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const HOST = 'skole.skoleintra.dk';
const INDEX = `https://${HOST}/parent/1234/Andrea/Index`;

const LOGIN_PAGE = `
  <html><body>
    <form action="/Account/IdpLogin" method="post">
      <input type="hidden" name="__RequestVerificationToken" value="tok">
      <input type="text" name="UserName" value="">
      <input type="password" name="Password" value="">
    </form>
  </body></html>`;

const RELAY_PAGE = `
  <html><body>
    <form name="relay" action="/sso/ssocomplete" method="post">
      <input type="hidden" name="SAMLResponse" value="blob">
    </form>
  </body></html>`;

const FRONT_PAGE = `
  <html><body>
    <button id="sk-personal-menu-button">Andrea 3A</button>
    <a href="/parent/1234/Andrea/Index"></a>
  </body></html>`;

/** What an installation serves for a return URL it does not actually have. */
const IIS_404 = '<html><head><title>404 - File or directory not found.</title></head></html>';

const CONFIRM_PAGE = `
  <html><body><div class="sk-l-c...pper">
    <h2>Bekræft kontaktoplysninger</h2>
    <p>Elev: Andrea Hansen</p>
    <form action="/parent/1234/Andrea/Confirm" method="post">
      <input type="hidden" name="Id" value="9">
    </form>
  </div></body></html>`;

/**
 * A real ConfirmContacts page is rendered inside the ordinary site chrome,
 * which carries the child-switcher nav — the very links `isFrontPage` looks
 * for. It must still be recognised as ConfirmContacts, not as the front page.
 */
const CONFIRM_PAGE_WITH_NAV = `
  <html><body>
    <nav><a href="/parent/1234/Andrea/Index">Andrea</a></nav>
    <div class="sk-l-c...pper">
      <h2>Bekræft kontaktoplysninger</h2>
      <form action="/parent/1234/Andrea/Confirm" method="post">
        <input type="hidden" name="Id" value="9">
      </form>
    </div>
  </body></html>`;

/** A front page whose child links carry a query string. */
const FRONT_PAGE_WITH_QUERY = `
  <html><body>
    <button id="sk-per...tton">Andrea 3A</button>
    <a href="/parent/1234/Andrea/Index?SchoolId=3"></a>
  </body></html>`;

/**
 * A real ForældreIntra front page is a classic ASP.NET page: the whole body is
 * wrapped in a single `<form runat="server">`. That lone form must NOT be
 * mistaken for a generic SSO relay and submitted — the page carries child
 * links and is the front page.
 */
const FRONT_PAGE_IN_FORM = `
  <html><body>
    <form method="post" action="/Fi/Forside.aspx">
      <input type="hidden" name="__VIEWSTATE" value="abc">
      <a href="/parent/1234/Andrea/Index">Andrea 3A</a>
    </form>
  </body></html>`;

interface Route {
  status?: number;
  location?: string;
  body?: string;
}

/** Schools that serve /Account/IdpLogin directly have no /Fi/ front door. */
const NO_FI: Route = { status: 404 };

/**
 * Route by "METHOD url" so a page can answer differently to the GET that
 * renders it and the POST that submits it — which is exactly what the login
 * form does. A list of routes answers successive requests for the same key,
 * the last one repeating: one URL can be a login page before the assertion
 * and a 404 after it.
 */
function stub(routes: Record<string, Route | Route[]>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = `${init?.method ?? 'GET'} ${url}`;
    const seen = calls.filter((c) => c === key).length;
    calls.push(key);
    const routed = routes[key];
    const route = Array.isArray(routed) ? routed[Math.min(seen, routed.length - 1)] : routed;
    if (!route) throw new Error(`No stub for ${key}`);
    const headers = new Headers();
    if (route.location) headers.set('location', route.location);
    return new Response(route.body ?? '', { status: route.status ?? 200, headers });
  }) as typeof fetch;
  return { calls };
}

function newClient(autoConfirmContacts = false): FskintraLoginClient {
  return new FskintraLoginClient({ http: new FskintraHttpClient(), autoConfirmContacts });
}

describe('normalizeHostname', () => {
  test('accepts a pasted URL as well as a bare host', () => {
    expect(normalizeHostname('https://skole.skoleintra.dk/parent/1')).toBe(HOST);
    expect(normalizeHostname('  skole.skoleintra.dk  ')).toBe(HOST);
  });
});

describe('FskintraLoginClient.login', () => {
  test('walks form → relay → front page', async () => {
    const { calls } = stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET https://${HOST}/Account/IdpLogin`]: { body: LOGIN_PAGE },
      [`POST https://${HOST}/Account/IdpLogin`]: { body: RELAY_PAGE },
      [`POST https://${HOST}/sso/ssocomplete`]: { status: 302, location: INDEX },
      [`GET ${INDEX}`]: { body: FRONT_PAGE },
    });

    const result = await newClient().login({ hostname: HOST, username: 'emil', password: 'pw' });

    expect(result.indexUrl).toBe(INDEX);
    expect(result.doc('#sk-personal-menu-button').text()).toBe('Andrea 3A');
    expect(calls).toContain(`POST https://${HOST}/sso/ssocomplete`);
  });

  test('rejects bad credentials with a specific error', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET https://${HOST}/Account/IdpLogin`]: { body: LOGIN_PAGE },
      [`POST https://${HOST}/Account/IdpLogin`]: {
        body: '<html><body>Du har ikke adgang</body></html>',
      },
    });

    expect(
      newClient().login({ hostname: HOST, username: 'emil', password: 'wrong' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  test('stops at UNI-Login rather than half-walking a flow it cannot finish', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET https://${HOST}/Account/IdpLogin`]: {
        status: 302,
        location: 'https://login.emu.dk/login',
      },
      'GET https://login.emu.dk/login': { body: '<html><body>Uni-Login</body></html>' },
    });

    expect(
      newClient().login({ hostname: HOST, username: 'emil', password: 'pw' }),
    ).rejects.toBeInstanceOf(UniLoginNotSupportedError);
  });

  test('refuses to confirm contact details on the user’s behalf by default', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET https://${HOST}/Account/IdpLogin`]: { body: LOGIN_PAGE },
      [`POST https://${HOST}/Account/IdpLogin`]: {
        status: 302,
        location: `https://${HOST}/parent/1234/Andrea/ConfirmContacts`,
      },
      [`GET https://${HOST}/parent/1234/Andrea/ConfirmContacts`]: { body: CONFIRM_PAGE },
    });

    const error = await newClient()
      .login({ hostname: HOST, username: 'emil', password: 'pw' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfirmContactsRequiredError);
    // The page text has to reach the caller: it names the child whose details
    // are being confirmed, which is what makes the prompt actionable.
    expect((error as ConfirmContactsRequiredError).pageText).toContain('Andrea Hansen');
  });

  test('submits the confirmation form when explicitly told to', async () => {
    const { calls } = stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET https://${HOST}/Account/IdpLogin`]: { body: LOGIN_PAGE },
      [`POST https://${HOST}/Account/IdpLogin`]: {
        status: 302,
        location: `https://${HOST}/parent/1234/Andrea/ConfirmContacts`,
      },
      [`GET https://${HOST}/parent/1234/Andrea/ConfirmContacts`]: { body: CONFIRM_PAGE },
      [`POST https://${HOST}/parent/1234/Andrea/Confirm`]: { status: 302, location: INDEX },
      [`GET ${INDEX}`]: { body: FRONT_PAGE },
    });

    const result = await newClient(true).login({
      hostname: HOST,
      username: 'emil',
      password: 'pw',
    });

    expect(result.indexUrl).toBe(INDEX);
    expect(calls).toContain(`POST https://${HOST}/parent/1234/Andrea/Confirm`);
  });

  test('names the page when the login form is missing', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET https://${HOST}/Account/IdpLogin`]: {
        body: '<html><body><p>Javascript kræves</p><p>Prøv igen</p></body></html>',
      },
    });

    expect(newClient().login({ hostname: HOST, username: 'emil', password: 'pw' })).rejects.toThrow(
      /No ordinary login form/,
    );
  });

  test('gives up with the last URL rather than looping forever', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET https://${HOST}/Account/IdpLogin`]: { status: 302, location: `https://${HOST}/odd` },
      [`GET https://${HOST}/odd`]: {
        body: '<html><body><p>ingen formular her</p></body></html>',
      },
    });

    expect(newClient().login({ hostname: HOST, username: 'emil', password: 'pw' })).rejects.toThrow(
      /did not reach the ForældreIntra front page/,
    );
  });

  /**
   * The shape that made this fallback necessary: the school host serves no
   * /Account/IdpLogin at all, and /Fi/ hands the flow to an IdP on the
   * school's `.m.` host. The credentials are then posted cross-host, so the
   * cookie jar has to survive the hop.
   */
  test('enters through /Fi/ and follows it onto the .m. host', async () => {
    const M_LOGIN = `https://skole.m.skoleintra.dk/Account/IdpLogin?role=Parent`;
    const { calls } = stub({
      [`GET https://${HOST}/Fi/`]: { status: 302, location: M_LOGIN },
      [`GET ${M_LOGIN}`]: {
        body: LOGIN_PAGE.replace('action="/Account/IdpLogin"', `action="${M_LOGIN}"`),
      },
      [`POST ${M_LOGIN}`]: {
        body: RELAY_PAGE.replace('/sso/ssocomplete', `https://${HOST}/sso/ssocomplete`),
      },
      [`POST https://${HOST}/sso/ssocomplete`]: { status: 302, location: INDEX },
      [`GET ${INDEX}`]: { body: FRONT_PAGE },
    });

    const result = await newClient().login({ hostname: HOST, username: 'emil', password: 'pw' });

    expect(result.indexUrl).toBe(INDEX);
    expect(calls).not.toContain(`GET https://${HOST}/Account/IdpLogin`);
  });

  /**
   * Observed on steinerskolen-kvistgaard.m.skoleintra.dk: the flow carries
   * `ReturnUrl=/Fi/` all the way through SAML, the assertion is consumed, the
   * session cookies are set — and then the school answers its own return URL
   * with a bare IIS 404. Authentication worked; only the landing was wrong.
   */
  test('recovers at the site root when the return URL 404s after the assertion', async () => {
    const ROOT = `https://${HOST}/`;
    const { calls } = stub({
      // The entry GET renders the login form; the post-assertion GET 404s.
      [`GET https://${HOST}/Fi/`]: [{ body: LOGIN_PAGE }, { status: 404, body: IIS_404 }],
      [`POST https://${HOST}/Account/IdpLogin`]: { body: RELAY_PAGE },
      [`POST https://${HOST}/sso/ssocomplete`]: { status: 302, location: `https://${HOST}/Fi/` },
      [`GET ${ROOT}`]: { body: FRONT_PAGE },
    });

    const result = await newClient().login({ hostname: HOST, username: 'emil', password: 'pw' });

    expect(result.indexUrl).toBe(ROOT);
    expect(result.doc('#sk-personal-menu-button').text()).toBe('Andrea 3A');
    expect(calls).toContain(`GET ${ROOT}`);
  });

  /** The front page can also be served somewhere INDEX_RE has never heard of. */
  test('accepts a front page by the child links it carries, not its URL', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: { body: LOGIN_PAGE },
      [`POST https://${HOST}/Account/IdpLogin`]: {
        status: 302,
        location: `https://${HOST}/Fi/Forside.aspx`,
      },
      [`GET https://${HOST}/Fi/Forside.aspx`]: { body: FRONT_PAGE },
    });

    const result = await newClient().login({ hostname: HOST, username: 'emil', password: 'pw' });

    expect(result.indexUrl).toBe(`https://${HOST}/Fi/Forside.aspx`);
  });

  test('names every entry point it tried when the host has none of them', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET https://${HOST}/Account/IdpLogin`]: { status: 404 },
    });

    expect(newClient().login({ hostname: HOST, username: 'emil', password: 'pw' })).rejects.toThrow(
      /No ForældreIntra login page[\s\S]*\/Fi\/ → HTTP 404[\s\S]*IdpLogin → HTTP 404/,
    );
  });

  test('blames the connection when no entry point resolves at all', async () => {
    stub({}); // every request throws, the way an unresolvable host does

    expect(
      newClient().login({ hostname: 'nope.skoleintra.dk', username: 'emil', password: 'pw' }),
    ).rejects.toThrow(/Could not reach https:\/\/nope.skoleintra.dk/);
  });

  // Regression (review blocker #1): a ConfirmContacts page is rendered inside
  // the site chrome, so it carries the child-switcher nav. The link-based
  // front-page test must not fire before the ConfirmContacts branch, or "you
  // must confirm your details" collapses into "you're logged in".
  test('surfaces ConfirmContacts even when the page carries child-link nav', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET https://${HOST}/Account/IdpLogin`]: { body: LOGIN_PAGE },
      [`POST https://${HOST}/Account/IdpLogin`]: {
        status: 302,
        location: `https://${HOST}/ConfirmContacts`,
      },
      [`GET https://${HOST}/ConfirmContacts`]: { body: CONFIRM_PAGE_WITH_NAV },
    });

    expect(newClient().login({ hostname: HOST, username: 'emil', password: 'pw' })).rejects.toThrow(
      ConfirmContactsRequiredError,
    );
  });

  // Regression (review blocker #2): some schools serve the credential-rejection
  // page with a 4xx status. The post-assertion landing fallback must not fire
  // ahead of the credential-rejection check, or InvalidCredentialsError is lost
  // and the diagnosis points at the flow instead of the password.
  test('reports invalid credentials even when the rejection page is a 4xx', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      // First GET renders the form; after the failed POST the re-rendered form
      // comes back 401 with the rejection text.
      [`GET https://${HOST}/Account/IdpLogin`]: [
        { body: LOGIN_PAGE },
        { status: 401, body: '<html><body>Du har ikke adgang</body></html>' },
      ],
      [`POST https://${HOST}/Account/IdpLogin`]: {
        status: 302,
        location: `https://${HOST}/Account/IdpLogin`,
      },
    });

    expect(newClient().login({ hostname: HOST, username: 'emil', password: 'pw' })).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  // Regression (review should-fix #3): a non-404 error on /Fi/ must be treated
  // as "not this door" so /Account/IdpLogin is still tried, rather than
  // diverting to the site root and never reaching the working login form.
  test('tries the next entry path when /Fi/ answers a non-404 error', async () => {
    const { calls } = stub({
      [`GET https://${HOST}/Fi/`]: { status: 403, body: '<html><body>Forbidden</body></html>' },
      [`GET https://${HOST}/Account/IdpLogin`]: { body: LOGIN_PAGE },
      [`POST https://${HOST}/Account/IdpLogin`]: { body: RELAY_PAGE },
      [`POST https://${HOST}/sso/ssocomplete`]: { status: 302, location: INDEX },
      [`GET ${INDEX}`]: { body: FRONT_PAGE },
    });

    const result = await newClient().login({ hostname: HOST, username: 'emil', password: 'pw' });

    expect(result.indexUrl).toBe(INDEX);
    expect(calls).toContain(`GET https://${HOST}/Account/IdpLogin`);
  });

  // Regression (review should-fix #6): a front page whose child hrefs carry a
  // query string. isChildLink must accept it, so login and the client agree.
  test('accepts a front page whose child links carry a query string', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: { body: LOGIN_PAGE },
      [`POST https://${HOST}/Account/IdpLogin`]: {
        status: 302,
        location: `https://${HOST}/Fi/Forside.aspx`,
      },
      [`GET https://${HOST}/Fi/Forside.aspx`]: { body: FRONT_PAGE_WITH_QUERY },
    });

    const result = await newClient().login({ hostname: HOST, username: 'emil', password: 'pw' });

    expect(result.indexUrl).toBe(`https://${HOST}/Fi/Forside.aspx`);
  });

  // Regression (review follow-up blocker): a real ASP.NET front page wraps its
  // body in a single <form>. That lone form must not be submitted as a generic
  // relay — the page carries child links and IS the front page. Submitting it
  // both fails login and POSTs to the school's site (read-only violation).
  test('accepts a single-form front page instead of submitting it as a relay', async () => {
    const { calls } = stub({
      [`GET https://${HOST}/Fi/`]: { body: LOGIN_PAGE },
      [`POST https://${HOST}/Account/IdpLogin`]: {
        status: 302,
        location: `https://${HOST}/Fi/Forside.aspx`,
      },
      [`GET https://${HOST}/Fi/Forside.aspx`]: { body: FRONT_PAGE_IN_FORM },
    });

    const result = await newClient().login({ hostname: HOST, username: 'emil', password: 'pw' });

    expect(result.indexUrl).toBe(`https://${HOST}/Fi/Forside.aspx`);
    // It must never POST the front page back to itself.
    expect(calls).not.toContain(`POST https://${HOST}/Fi/Forside.aspx`);
  });

  // Coverage (review #7): the 200-with-chrome dead landing — the return URL is
  // served, but as a page with no child links. The fallback must recover at
  // the site root, not accept the chrome page as the front page.
  test('recovers at the site root when the return URL is a 200 page of chrome', async () => {
    const ROOT = `https://${HOST}/`;
    const CHROME = '<html><body><nav>Skolen</nav><p>Velkommen</p></body></html>';
    const { calls } = stub({
      [`GET https://${HOST}/Fi/`]: [{ body: LOGIN_PAGE }, { body: CHROME }],
      [`POST https://${HOST}/Account/IdpLogin`]: { body: RELAY_PAGE },
      [`POST https://${HOST}/sso/ssocomplete`]: { status: 302, location: `https://${HOST}/Fi/` },
      [`GET ${ROOT}`]: { body: FRONT_PAGE },
    });

    const result = await newClient().login({ hostname: HOST, username: 'emil', password: 'pw' });

    expect(result.indexUrl).toBe(ROOT);
    expect(calls).toContain(`GET ${ROOT}`);
  });

  // Coverage (review #7): the cross-host fallback candidate. The flow ends on
  // a different host than the user typed; the root on the landed host is a dead
  // end, so the root on the user-typed host must be tried too.
  test('falls back to the user-typed host root when the landed host root is dead', async () => {
    const M_HOST = 'skole.m.skoleintra.dk';
    const M_ROOT = `https://${M_HOST}/`;
    const TYPED_ROOT = `https://${HOST}/`;
    const IIS = '<html><head><title>404 - File or directory not found.</title></head></html>';
    const { calls } = stub({
      [`GET https://${HOST}/Fi/`]: { status: 302, location: `https://${M_HOST}/Fi/` },
      // /Fi/ on the .m. host renders the login form, then 404s post-assertion.
      [`GET https://${M_HOST}/Fi/`]: [{ body: LOGIN_PAGE }, { status: 404, body: IIS }],
      [`POST https://${M_HOST}/Account/IdpLogin`]: { body: RELAY_PAGE },
      [`POST https://${M_HOST}/sso/ssocomplete`]: {
        status: 302,
        location: `https://${M_HOST}/Fi/`,
      },
      // The landed-host root is itself a dead end; the typed-host root works.
      [`GET ${M_ROOT}`]: { status: 404, body: IIS },
      [`GET ${TYPED_ROOT}`]: { body: FRONT_PAGE },
    });

    const result = await newClient().login({ hostname: HOST, username: 'emil', password: 'pw' });

    expect(result.indexUrl).toBe(TYPED_ROOT);
    expect(calls).toContain(`GET ${M_ROOT}`);
    expect(calls).toContain(`GET ${TYPED_ROOT}`);
  });
});

describe('FskintraLoginClient.resume', () => {
  const record = {
    version: 1 as const,
    hostname: HOST,
    username: 'emil',
    cookies: '{"cookies":[]}',
    indexUrl: INDEX,
    saved_at: 1_750_000_000,
  };

  test('returns the front page when the cookies still work', async () => {
    stub({ [`GET ${INDEX}`]: { body: FRONT_PAGE } });
    const result = await newClient().resume(record);
    expect(result?.indexUrl).toBe(INDEX);
  });

  // Coverage (review #7): a session whose stored front page lives at a URL
  // INDEX_RE never matches (e.g. `/`). resume must accept it by its child
  // links, or such a session is re-logged-in on every single call.
  test('accepts a resumed front page recognised only by its child links', async () => {
    const ROOT_RECORD = { ...record, indexUrl: `https://${HOST}/` };
    stub({ [`GET https://${HOST}/`]: { body: FRONT_PAGE } });
    const result = await newClient().resume(ROOT_RECORD);
    expect(result?.indexUrl).toBe(`https://${HOST}/`);
  });

  test('returns undefined when the session is dead', async () => {
    stub({
      [`GET https://${HOST}/Fi/`]: NO_FI,
      [`GET ${INDEX}`]: { status: 302, location: `https://${HOST}/Account/IdpLogin` },
      [`GET https://${HOST}/Account/IdpLogin`]: { body: LOGIN_PAGE },
    });
    expect(await newClient().resume(record)).toBeUndefined();
  });

  test('returns undefined when there is nothing stored to resume from', async () => {
    const { cookies: _c, ...withoutCookies } = record;
    expect(await newClient().resume(withoutCookies)).toBeUndefined();
  });
});
