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
  <html><body><div class="sk-l-content-wrapper">
    <h2>Bekræft kontaktoplysninger</h2>
    <p>Elev: Andrea Hansen</p>
    <form action="/parent/1234/Andrea/Confirm" method="post">
      <input type="hidden" name="Id" value="9">
    </form>
  </div></body></html>`;

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
