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

/**
 * Route by "METHOD url" so a page can answer differently to the GET that
 * renders it and the POST that submits it — which is exactly what the login
 * form does.
 */
function stub(routes: Record<string, Route>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push(key);
    const route = routes[key];
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
      [`GET https://${HOST}/Account/IdpLogin`]: { status: 302, location: `https://${HOST}/odd` },
      [`GET https://${HOST}/odd`]: {
        body: '<html><body><p>ingen formular her</p></body></html>',
      },
    });

    expect(newClient().login({ hostname: HOST, username: 'emil', password: 'pw' })).rejects.toThrow(
      /did not reach the ForældreIntra front page/,
    );
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
