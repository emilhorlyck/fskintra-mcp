import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CookieJar, type SerializedCookieJar } from 'tough-cookie';
import { getConfig, log } from './config.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Cross-run state, mirroring what fskintra kept in its `.state` file. */
interface PersistedState {
  cookies?: SerializedCookieJar;
  /** Last known logged-in front page, e.g. https://host/parent/1234/Andrea/Index */
  indexUrl?: string;
}

export interface Response {
  /** Final URL after redirects */
  url: string;
  status: number;
  body: string;
  contentType: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function absUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const { hostname } = getConfig();
  return `https://${hostname}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * A cookie-aware HTTP client. Redirects are followed manually so that cookies
 * set on intermediate SSO hops are captured — `fetch`'s automatic redirect
 * handling would swallow them.
 */
export class Session {
  private jar = new CookieJar();
  private state: PersistedState = {};
  private loaded = false;

  private get statePath(): string {
    const { stateDir, hostname, username } = getConfig();
    const safeUser = username.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(stateDir, `${hostname}-${safeUser}.json`);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedState;
      this.state = raw;
      if (raw.cookies) this.jar = await CookieJar.deserialize(raw.cookies);
      log(`restored session state from ${this.statePath}`);
    } catch {
      log('no previous session state; starting fresh');
    }
  }

  async save(): Promise<void> {
    this.state.cookies = await this.jar.serialize();
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.state), { mode: 0o600 });
  }

  getIndexUrl(): string | undefined {
    return this.state.indexUrl;
  }

  setIndexUrl(url: string): void {
    this.state.indexUrl = url;
  }

  /** Forget cookies but keep the discovered index URL — used to retry a stale session. */
  async reset(): Promise<void> {
    this.jar = new CookieJar();
    await this.save();
  }

  async request(
    url: string,
    opts: { method?: 'GET' | 'POST'; body?: URLSearchParams; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    await this.load();

    let current = absUrl(url);
    let method = opts.method ?? 'GET';
    let body = opts.body;

    for (let hop = 0; hop < 12; hop++) {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
        ...opts.headers,
      };
      const cookie = await this.jar.getCookieString(current);
      if (cookie) headers['Cookie'] = cookie;
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

      log(`${method} ${current}`);
      const res = await fetch(current, {
        method,
        headers,
        body: body?.toString(),
        redirect: 'manual',
      });

      for (const raw of res.headers.getSetCookie()) {
        await this.jar.setCookie(raw, current, { ignoreError: true });
      }

      const location = res.headers.get('location');
      if (REDIRECT_STATUSES.has(res.status) && location) {
        current = new URL(location, current).toString();
        // 303 always becomes GET; 301/302 do in practice for POSTs
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      const contentType = res.headers.get('content-type') ?? '';
      const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
      const buf = await res.arrayBuffer();
      const text = new TextDecoder(charset.toLowerCase()).decode(buf);

      await this.save();
      return { url: current, status: res.status, body: text, contentType };
    }

    throw new Error(`Too many redirects starting at ${absUrl(url)}`);
  }

  /** Fetch a binary resource (attachment, photo) using the logged-in session. */
  async requestBinary(url: string): Promise<{ url: string; contentType: string; data: Buffer }> {
    await this.load();
    const target = absUrl(url);
    const cookie = await this.jar.getCookieString(target);
    const res = await fetch(target, {
      headers: { 'User-Agent': USER_AGENT, ...(cookie ? { Cookie: cookie } : {}) },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${target}`);
    return {
      url: res.url,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      data: Buffer.from(await res.arrayBuffer()),
    };
  }
}

let session: Session | undefined;

export function getSession(): Session {
  if (!session) session = new Session();
  return session;
}
