import { getConfig, log } from './config.js';
import { clean, findFormWithField, parse, serializeForm, textOf, type Doc } from './html.js';
import { getSession, type Response } from './session.js';

/** A logged-in front page looks like https://host/parent/1234/Andrea/Index */
const INDEX_RE = /\/parent\/[^/]+\/[^/]*\/Index\/?$/i;

export class LoginError extends Error {}

let loggedIn: Doc | undefined;

/**
 * Log in with an ordinary ForældreIntra username/password ("alm login") and
 * return the front page. The flow is a small state machine because the site
 * bounces through SSO relays and may interpose a "confirm your contact
 * details" page — ported from fskintra's `surllib.skoleLogin`.
 */
export async function login(force = false): Promise<Doc> {
  if (loggedIn && !force) return loggedIn;

  const config = getConfig();
  const session = getSession();
  await session.load();
  if (force) await session.reset();

  const start = (!force && session.getIndexUrl()) || '/Account/IdpLogin';
  log(`login starting at ${start}`);

  let res: Response;
  try {
    res = await session.request(start);
  } catch (cause) {
    throw new LoginError(
      `Could not reach https://${config.hostname}. Check FSKINTRA_HOSTNAME and your connection.`,
      { cause }
    );
  }

  for (let round = 0; round < 8; round++) {
    const $ = parse(res.body);
    const url = new URL(res.url);
    log(`login step ${round + 1}: ${res.url} (HTTP ${res.status})`);

    if (res.status === 404 && round === 0 && session.getIndexUrl()) {
      // A stale cached front page — start over at the real login URL.
      await session.reset();
      res = await session.request('/Account/IdpLogin');
      continue;
    }

    if (INDEX_RE.test(url.pathname) && res.body.length > 0) {
      log(`logged in at ${res.url}`);
      session.setIndexUrl(res.url);
      await session.save();
      loggedIn = $;
      return $;
    }

    if (url.hostname.endsWith('emu.dk') || /unilogin/i.test(url.hostname)) {
      throw new LoginError(
        `The school redirected to UNI-Login (${url.hostname}), but this server is configured ` +
          `for an ordinary ForældreIntra login. UNI-Login is not supported yet.`
      );
    }

    if (/\/ConfirmContacts\/?$/i.test(url.pathname)) {
      res = await confirmContacts($, res.url);
      continue;
    }

    if (/\/Account\/IdpLogin\/?$/i.test(url.pathname)) {
      res = await submitCredentials($, res, url);
      continue;
    }

    // Intermediate SSO relay: a single auto-submitting form.
    const forms = $('form');
    if (forms.length === 1) {
      const form = forms.first();
      const spec = serializeForm($, form);
      log(`following relay form -> ${spec.action || res.url}`);
      res = await getSession().request(new URL(spec.action || res.url, res.url).toString(), {
        method: spec.method,
        body: spec.method === 'POST' ? spec.fields : undefined,
      });
      continue;
    }

    break;
  }

  throw new LoginError(
    `Login did not reach the ForældreIntra front page. Last URL: ${res.url}. ` +
      `Verify FSKINTRA_USERNAME / FSKINTRA_PASSWORD, or try again later.`
  );
}

async function submitCredentials($: Doc, res: Response, url: URL): Promise<Response> {
  const config = getConfig();
  const page = textOf($, $('body')).toLowerCase();
  if (page.includes('ikke adgang') || page.includes('forkert brugernavn')) {
    throw new LoginError(
      'ForældreIntra rejected the credentials. Check FSKINTRA_USERNAME and FSKINTRA_PASSWORD.'
    );
  }

  const form = findFormWithField($, 'UserName', 'Username', 'username');
  if (!form) {
    const unilogin = $('a[href*="RedirectToUniLogin"]');
    if (unilogin.length) {
      throw new LoginError(
        'No ordinary login form on the page — this school appears to use UNI-Login only.'
      );
    }
    throw new LoginError(
      `Could not find the login form on ${res.url}. The page layout may have changed, ` +
        `or JavaScript-based login protection is active.`
    );
  }

  const userField = form.find('[name="UserName"], [name="Username"], [name="username"]').attr('name')!;
  const passField =
    form.find('[name="Password"], [name="password"]').attr('name') ?? 'Password';

  const spec = serializeForm($, form, {
    [userField]: config.username,
    [passField]: config.password,
  });

  log('submitting credentials');
  return getSession().request(new URL(spec.action || res.url, url).toString(), {
    method: 'POST',
    body: spec.fields,
  });
}

async function confirmContacts($: Doc, currentUrl: string): Promise<Response> {
  const form = $('.sk-l-content-wrapper form, form')
    .filter((_, el) => /Confirm\/?$/i.test($(el).attr('action') ?? ''))
    .first();

  if (!form.length) {
    throw new LoginError(
      `ForældreIntra is asking you to confirm your contact details, and the confirm form ` +
        `could not be found at ${currentUrl}. Log in with a browser once to clear it.`
    );
  }

  if (process.env.FSKINTRA_AUTO_CONFIRM_CONTACTS !== '1') {
    const details = textOf($, $('.sk-l-content-wrapper').first()) || textOf($, $('body'));
    throw new LoginError(
      `ForældreIntra is blocking login with the "Bekræft kontaktoplysninger" page. ` +
        `Confirming is a change the school sees, so this server will not click it for you. ` +
        `Either confirm once in a browser at ${currentUrl}, or set ` +
        `FSKINTRA_AUTO_CONFIRM_CONTACTS=1 to confirm automatically.\n\nThe page says:\n` +
        details.slice(0, 2000)
    );
  }

  const spec = serializeForm($, form);
  log('auto-confirming contact details');
  return getSession().request(new URL(spec.action, currentUrl).toString(), {
    method: 'POST',
    body: spec.fields,
  });
}

/**
 * Fetch a page as a logged-in parent. Retries once from a clean session if the
 * response looks like we were bounced back to the login screen.
 */
export async function fetchPage(
  url: string,
  opts: { method?: 'GET' | 'POST'; body?: URLSearchParams } = {}
): Promise<Doc> {
  await login();
  let res = await getSession().request(url, opts);

  if (looksLikeLogin(res)) {
    log('session appears expired; logging in again');
    await login(true);
    res = await getSession().request(url, opts);
    if (looksLikeLogin(res)) {
      throw new LoginError(`Still redirected to the login page when fetching ${url}.`);
    }
  }

  const $ = parse(res.body);
  $.root().attr('data-source-url', res.url);
  return $;
}

function looksLikeLogin(res: Response): boolean {
  const path = new URL(res.url).pathname;
  return /\/Account\/(IdpLogin|Login)/i.test(path) || res.status === 401;
}

/** Reset the in-process login cache (used by the reauthenticate tool). */
export function forgetLogin(): void {
  loggedIn = undefined;
}

export { clean };
