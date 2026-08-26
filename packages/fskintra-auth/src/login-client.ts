/**
 * The ForældreIntra login flow.
 *
 * Ported from `svalgaard/fskintra`'s `skoleintra/surllib.py:skoleLogin`, which
 * is the only written-down description of this flow that exists. It is a small
 * state machine rather than a linear script because the site can interpose
 * pages in any order:
 *
 *   /Account/IdpLogin ──credentials POST──> SSO relay (auto-submit form)
 *          │                                        │
 *          │                                        ▼
 *          └──> /ConfirmContacts ──────────> /parent/<id>/<name>/Index
 *
 * Each round looks at where we landed and decides the next move. Bounded at
 * MAX_ROUNDS so a redirect cycle fails loudly instead of hanging.
 *
 * Why no headless browser (the same reasoning as aula-mcp's MitID decision):
 *   - Playwright is ~300 MB of Chromium per platform for a flow that is three
 *     form posts.
 *   - A browser flow fails with "selector not found" or "navigation timeout".
 *     This one fails with "no login form at <url>" or "landed on <url> after 8
 *     rounds", which points at a line.
 *   - Every hop goes through the wire tracer, so a failing login produces a
 *     shareable, sanitised transcript.
 */

import {
  ConfirmContactsRequiredError,
  FskintraAuthError,
  InvalidCredentialsError,
  UniLoginNotSupportedError,
} from './errors.ts';
import { type Doc, findFormWithField, parse, serializeForm, textOf } from './html.ts';
import type { FskintraResponse } from './http.ts';
import { FskintraHttpClient } from './http.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import type { StoredSessionRecord } from './session-store.ts';

/** A logged-in front page looks like https://host/parent/1234/Andrea/Index */
const INDEX_RE = /\/parent\/[^/]+\/[^/]*\/Index\/?$/i;
const MAX_ROUNDS = 8;

export interface LoginCredentials {
  /** Bare hostname, e.g. `minskole.skoleintra.dk`. A full URL is accepted. */
  hostname: string;
  username: string;
  password: string;
}

export interface LoginClientOptions {
  http?: FskintraHttpClient;
  logger?: Logger;
  /**
   * Submit the periodic "Bekræft kontaktoplysninger" form automatically.
   * Off by default: confirming is a change the school sees, and this client
   * should not make it on the user's behalf without being told to.
   */
  autoConfirmContacts?: boolean;
}

export interface LoginResult {
  /** The parsed, logged-in front page. */
  doc: Doc;
  /** Absolute URL of the front page — worth persisting; it skips the chain. */
  indexUrl: string;
  /** Serialized cookie jar, for the session store. */
  cookies: string;
}

/** Normalise a pasted URL or bare host into a hostname. */
export function normalizeHostname(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
}

export class FskintraLoginClient {
  readonly http: FskintraHttpClient;
  private readonly logger: Logger;
  private readonly autoConfirmContacts: boolean;

  constructor(options: LoginClientOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.http = options.http ?? new FskintraHttpClient({ logger: this.logger });
    this.autoConfirmContacts = options.autoConfirmContacts ?? false;
  }

  absUrl(hostname: string, url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    return `https://${hostname}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  /**
   * Restore a previous session's cookies and check whether they still work by
   * fetching the cached front page. Returns undefined when there is nothing to
   * restore or the session is dead — the caller then runs a full `login()`.
   *
   * This is the cheap path, and the common one: it is a single GET.
   */
  async resume(record: StoredSessionRecord): Promise<LoginResult | undefined> {
    if (!record.cookies || !record.indexUrl) return undefined;

    await this.http.restoreJar(record.cookies);

    this.logger.debug('login.resume_attempt', { indexUrl: record.indexUrl });
    let response: FskintraResponse;
    try {
      const followed = await this.http.follow(record.indexUrl);
      response = followed.final;
    } catch (error) {
      this.logger.info('login.resume_failed', { error: (error as Error).message });
      return undefined;
    }

    if (response.status !== 200 || !INDEX_RE.test(new URL(response.url).pathname)) {
      this.logger.info('login.resume_rejected', { url: response.url, status: response.status });
      return undefined;
    }

    return {
      doc: parse(response.body),
      indexUrl: response.url,
      cookies: await this.http.jar.serialize(),
    };
  }

  /** Full login from credentials. */
  async login(credentials: LoginCredentials): Promise<LoginResult> {
    const hostname = normalizeHostname(credentials.hostname);
    const startUrl = this.absUrl(hostname, '/Account/IdpLogin');
    this.logger.info('login.start', { hostname, username: credentials.username });

    let response: FskintraResponse;
    try {
      response = (await this.http.follow(startUrl)).final;
    } catch (cause) {
      throw new FskintraAuthError(
        `Could not reach https://${hostname}. Check the hostname and your connection.`,
        { cause },
      );
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const doc = parse(response.body);
      const url = new URL(response.url);
      this.logger.debug('login.step', {
        round: round + 1,
        url: response.url,
        status: response.status,
      });

      if (INDEX_RE.test(url.pathname) && response.body.length > 0) {
        this.logger.info('login.success', { indexUrl: response.url });
        return {
          doc,
          indexUrl: response.url,
          cookies: await this.http.jar.serialize(),
        };
      }

      if (url.hostname.endsWith('emu.dk') || /unilogin/i.test(url.hostname)) {
        throw new UniLoginNotSupportedError(url.hostname);
      }

      if (/\/ConfirmContacts\/?$/i.test(url.pathname)) {
        response = await this.handleConfirmContacts(doc, response.url);
        continue;
      }

      // Relay detection comes BEFORE the credentials branch, as it does in
      // fskintra. An SSO relay can render at the same path the login form
      // uses, and matching on the URL alone would then re-submit credentials
      // into a form that has no username field.
      const relay = this.findRelayForm(doc, url) ?? undefined;
      if (relay?.explicit) {
        this.logger.debug('login.relay', { action: relay.action || response.url });
        response = (
          await this.http.follow(new URL(relay.action || response.url, response.url).toString(), {
            method: relay.method,
            ...(relay.method === 'POST' ? { body: relay.fields } : {}),
          })
        ).final;
        continue;
      }

      if (/\/Account\/(IdpLogin|Login)\/?$/i.test(url.pathname)) {
        response = await this.submitCredentials(doc, response.url, credentials);
        continue;
      }

      if (relay) {
        this.logger.debug('login.relay_generic', { action: relay.action || response.url });
        response = (
          await this.http.follow(new URL(relay.action || response.url, response.url).toString(), {
            method: relay.method,
            ...(relay.method === 'POST' ? { body: relay.fields } : {}),
          })
        ).final;
        continue;
      }

      break;
    }

    throw new FskintraAuthError(
      `Login did not reach the ForældreIntra front page after ${MAX_ROUNDS} rounds. ` +
        `Last URL: ${response.url}. Re-run with --debug for a wire transcript.`,
    );
  }

  private async submitCredentials(
    doc: Doc,
    currentUrl: string,
    credentials: LoginCredentials,
  ): Promise<FskintraResponse> {
    const pageText = textOf(doc, doc('body')).toLowerCase();
    if (pageText.includes('ikke adgang') || pageText.includes('forkert brugernavn')) {
      throw new InvalidCredentialsError(
        'ForældreIntra rejected the credentials. Check the username and password.',
      );
    }

    const form = findFormWithField(doc, 'UserName', 'Username', 'username');
    if (!form) {
      if (doc('a[href*="RedirectToUniLogin"]').length) {
        throw new UniLoginNotSupportedError(new URL(currentUrl).hostname);
      }
      throw new FskintraAuthError(
        `No ordinary login form at ${currentUrl}. The page layout may have changed, or ` +
          `JavaScript-based login protection is active.`,
      );
    }

    const userField =
      form.find('[name="UserName"], [name="Username"], [name="username"]').attr('name') ??
      'UserName';
    const passField = form.find('[name="Password"], [name="password"]').attr('name') ?? 'Password';

    const spec = serializeForm(doc, form, {
      [userField]: credentials.username,
      [passField]: credentials.password,
    });

    this.logger.debug('login.submit_credentials', { action: spec.action || currentUrl });
    return (
      await this.http.follow(new URL(spec.action || currentUrl, currentUrl).toString(), {
        method: 'POST',
        body: spec.fields,
      })
    ).final;
  }

  /**
   * The "Bekræft kontaktoplysninger" interstitial. fskintra clicks it
   * automatically; we don't, unless asked. Confirming tells the school the
   * details on file are correct, which is a statement the user should make,
   * not their MCP server.
   */
  private async handleConfirmContacts(doc: Doc, currentUrl: string): Promise<FskintraResponse> {
    const form = doc('.sk-l-content-wrapper form, form')
      .filter((_, el) => /Confirm\/?$/i.test(doc(el).attr('action') ?? ''))
      .first();

    const pageText = textOf(doc, doc('.sk-l-content-wrapper').first()) || textOf(doc, doc('body'));

    if (!form.length) {
      throw new ConfirmContactsRequiredError(currentUrl, pageText.slice(0, 2000));
    }
    if (!this.autoConfirmContacts) {
      throw new ConfirmContactsRequiredError(currentUrl, pageText.slice(0, 2000));
    }

    const spec = serializeForm(doc, form);
    this.logger.warn('login.auto_confirming_contacts', { url: currentUrl });
    return (
      await this.http.follow(new URL(spec.action, currentUrl).toString(), {
        method: 'POST',
        body: spec.fields,
      })
    ).final;
  }

  /**
   * SSO relay pages carry exactly one form that a browser would auto-submit
   * via JavaScript.
   *
   * `explicit` marks the two shapes fskintra actually observed — a form named
   * `relay`, or a page under `/sso/ssocomplete`. Those are safe to submit
   * before anything else. A lone unnamed form is the general case and is only
   * tried once the known branches have been ruled out, because the login page
   * is also a lone form.
   */
  private findRelayForm(
    doc: Doc,
    url: URL,
  ):
    | { action: string; method: 'GET' | 'POST'; fields: URLSearchParams; explicit: boolean }
    | undefined {
    const forms = doc('form');
    if (forms.length !== 1) return undefined;

    const form = forms.first();
    const explicit =
      url.pathname.toLowerCase().includes('/sso/ssocomplete') ||
      (form.attr('name') ?? '').toLowerCase() === 'relay';

    return { ...serializeForm(doc, form), explicit };
  }
}
