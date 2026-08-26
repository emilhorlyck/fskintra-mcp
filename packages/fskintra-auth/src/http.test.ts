import { afterEach, describe, expect, test } from 'bun:test';
import { FskintraHttpClient } from './http.ts';
import { InMemoryTracer } from './wire-tracer.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface StubResponse {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string;
}

/** Replace fetch with a URL→response map, recording what was requested. */
function stubFetch(routes: Record<string, StubResponse>): {
  calls: { url: string; method: string; cookie: string | undefined; body: string | undefined }[];
} {
  const calls: {
    url: string;
    method: string;
    cookie: string | undefined;
    body: string | undefined;
  }[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      cookie: headers.get('cookie') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    const route = routes[url];
    if (!route) throw new Error(`No stub for ${url}`);

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(route.headers ?? {})) {
      for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
    }
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: responseHeaders,
    });
  }) as typeof fetch;

  return { calls };
}

describe('FskintraHttpClient.follow', () => {
  test('collects cookies set on intermediate redirect hops', async () => {
    // This is the whole reason redirects are followed by hand: fetch's own
    // redirect handling never surfaces the middle hop's Set-Cookie.
    const { calls } = stubFetch({
      'https://skole.dk/start': {
        status: 302,
        headers: { location: 'https://skole.dk/middle', 'set-cookie': 'first=1; Path=/' },
      },
      'https://skole.dk/middle': {
        status: 302,
        headers: { location: 'https://skole.dk/end', 'set-cookie': 'second=2; Path=/' },
      },
      'https://skole.dk/end': { status: 200, body: '<html>done</html>' },
    });

    const client = new FskintraHttpClient();
    const result = await client.follow('https://skole.dk/start');

    expect(result.final.status).toBe(200);
    expect(result.final.url).toBe('https://skole.dk/end');
    expect(result.history.map((h) => h.status)).toEqual([302, 302, 200]);

    const lastCall = calls.at(-1);
    expect(lastCall?.cookie).toContain('first=1');
    expect(lastCall?.cookie).toContain('second=2');
  });

  test('turns a redirected POST into a GET and drops the body', async () => {
    const { calls } = stubFetch({
      'https://skole.dk/login': { status: 302, headers: { location: 'https://skole.dk/home' } },
      'https://skole.dk/home': { status: 200, body: 'ok' },
    });

    const client = new FskintraHttpClient();
    await client.follow('https://skole.dk/login', {
      method: 'POST',
      body: new URLSearchParams({ UserName: 'emil' }),
    });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('UserName=emil');
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.body).toBeUndefined();
  });

  test('preserves method and body across a 307', async () => {
    const { calls } = stubFetch({
      'https://skole.dk/a': { status: 307, headers: { location: 'https://skole.dk/b' } },
      'https://skole.dk/b': { status: 200, body: 'ok' },
    });

    const client = new FskintraHttpClient();
    await client.follow('https://skole.dk/a', {
      method: 'POST',
      body: new URLSearchParams({ x: '1' }),
    });

    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.body).toBe('x=1');
  });

  test('throws RedirectLoopError instead of hanging', async () => {
    stubFetch({
      'https://skole.dk/loop': { status: 302, headers: { location: 'https://skole.dk/loop' } },
    });
    const client = new FskintraHttpClient();
    expect(client.follow('https://skole.dk/loop', { maxHops: 3 })).rejects.toThrow(
      /Exceeded 3 redirect hops/,
    );
  });

  test('records every hop in the tracer, with secrets redacted', async () => {
    stubFetch({
      'https://skole.dk/login': { status: 200, body: 'ok', headers: { 'set-cookie': 's=1' } },
    });

    const tracer = new InMemoryTracer();
    const client = new FskintraHttpClient({ tracer });
    await client.follow('https://skole.dk/login', {
      method: 'POST',
      body: new URLSearchParams({ UserName: 'emil', Password: 'hemmelig' }),
    });

    expect(tracer.entries).toHaveLength(1);
    expect(tracer.entries[0]?.requestBody).toContain('UserName=emil');
    expect(tracer.entries[0]?.requestBody).not.toContain('hemmelig');
  });

  test('restoreJar replaces the jar rather than merging', async () => {
    stubFetch({ 'https://skole.dk/x': { status: 200, body: 'ok' } });

    const first = new FskintraHttpClient();
    await first.jar.storeFromResponse(
      new Headers([['set-cookie', 'old=1; Path=/']]),
      'https://skole.dk/x',
    );
    const serialized = await first.jar.serialize();

    const second = new FskintraHttpClient();
    await second.jar.storeFromResponse(
      new Headers([['set-cookie', 'stale=1; Path=/']]),
      'https://skole.dk/x',
    );
    await second.restoreJar(serialized);

    const header = await second.jar.cookieHeader('https://skole.dk/x');
    expect(header).toContain('old=1');
    expect(header).not.toContain('stale=1');
  });
});
