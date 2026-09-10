import { afterEach, describe, expect, test } from 'bun:test';
import { MemorySessionStore, parse } from '@fskintra-mcp/fskintra-auth';
import { childUrl, credentialsFromEnv, FskintraClient, parseChildren } from './client.ts';
import { getWeekplans } from './sections/weekplans.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.FSKINTRA_HOSTNAME;
  delete process.env.FSKINTRA_USERNAME;
  delete process.env.FSKINTRA_PASSWORD;
});

const HOST = 'skole.skoleintra.dk';
const INDEX = `https://${HOST}/parent/1234/Andrea/Index`;

const FRONT_PAGE = `
  <html><body>
    <button id="sk-personal-menu-button"> Andrea 3A </button>
    <nav>
      <a href="/parent/1234/Andrea/Index"></a>
      <a href="/parent/5678/Bertil/Index">Bertil 6B</a>
      <a href="/parent/1234/Andrea/Index">Andrea 3A</a>
      <a href="/parent/1234/Andrea/messages/conversations">Beskeder</a>
      <a href="/some/other/page/Index/deeper">Ikke et barn</a>
    </nav>
  </body></html>`;

const LOGIN_PAGE = `
  <html><body>
    <form action="/Account/IdpLogin" method="post">
      <input type="hidden" name="__RequestVerificationToken" value="tok">
      <input type="text" name="UserName" value="">
      <input type="password" name="Password" value="">
    </form>
  </body></html>`;

function absUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${HOST}${url}`;
}

describe('parseChildren', () => {
  test('finds every child once, naming the selected one', () => {
    const children = parseChildren(parse(FRONT_PAGE), absUrl);
    expect(children.map((c) => [c.name, c.id])).toEqual([
      ['Andrea 3A', '1234'],
      ['Bertil 6B', '5678'],
    ]);
    expect(children[0]?.urlPrefix).toBe(`https://${HOST}/parent/1234/Andrea`);
  });

  test('ignores links that merely end in /Index', () => {
    const children = parseChildren(parse(FRONT_PAGE), absUrl);
    expect(children.some((c) => c.urlPrefix.includes('/some/other'))).toBe(false);
  });

  // Regression (review #6 follow-through): a child href may carry a query
  // string. isChildLink accepts it, so parseChildren must strip the query when
  // building the urlPrefix — a prefix ending in `?SchoolId=3` breaks every
  // section URL derived from it.
  test('strips a query string from the child urlPrefix', () => {
    const page = `
      <html><body>
        <a href="/parent/1234/Andrea/Index?SchoolId=3">Andrea 3A</a>
      </body></html>`;
    const children = parseChildren(parse(page), absUrl);
    expect(children).toHaveLength(1);
    expect(children[0]?.urlPrefix).toBe(`https://${HOST}/parent/1234/Andrea`);
    expect(children[0]?.id).toBe('1234');
  });

  // Regression (review nit): a query with an embedded newline must still be
  // stripped, matching isChildLink's split, so the prefix is never malformed.
  test('strips a query containing a newline from the child urlPrefix', () => {
    const page = `
      <html><body>
        <a href="/parent/1234/Andrea/Index?a=1&#10;b=2">Andrea 3A</a>
      </body></html>`;
    const children = parseChildren(parse(page), absUrl);
    expect(children[0]?.urlPrefix).toBe(`https://${HOST}/parent/1234/Andrea`);
  });
});

describe('childUrl', () => {
  const child = { name: 'Andrea 3A', id: '1234', urlPrefix: `https://${HOST}/parent/1234/Andrea` };

  test('joins the ordinary sections with a slash', () => {
    expect(childUrl(child, '/messages/conversations')).toBe(
      `https://${HOST}/parent/1234/Andrea/messages/conversations`,
    );
  });

  test('concatenates the weekplan paths directly, quirk and all', () => {
    // Not a typo: the slash-separated form 404s. See the docstring.
    expect(childUrl(child, 'item/weeklyplansandhomework/list/')).toBe(
      `https://${HOST}/parent/1234/Andreaitem/weeklyplansandhomework/list/`,
    );
  });

  test('rejects a suffix that is neither', () => {
    expect(() => childUrl(child, 'messages')).toThrow(/must start with/);
  });
});

describe('credentialsFromEnv', () => {
  test('needs all three variables', () => {
    expect(credentialsFromEnv()).toBeUndefined();
    process.env.FSKINTRA_HOSTNAME = `https://${HOST}/whatever`;
    process.env.FSKINTRA_USERNAME = 'emil';
    expect(credentialsFromEnv()).toBeUndefined();
    process.env.FSKINTRA_PASSWORD = 'pw';
    expect(credentialsFromEnv()).toEqual({ hostname: HOST, username: 'emil', password: 'pw' });
  });
});

interface Route {
  status?: number;
  location?: string;
  body?: string;
}

function stub(routeFor: (key: string, hit: number) => Route): { calls: string[] } {
  const calls: string[] = [];
  const hits = new Map<string, number>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push(key);
    const hit = (hits.get(key) ?? 0) + 1;
    hits.set(key, hit);
    const route = routeFor(key, hit);
    const headers = new Headers();
    if (route.location) headers.set('location', route.location);
    return new Response(route.body ?? '', { status: route.status ?? 200, headers });
  }) as typeof fetch;
  return { calls };
}

async function seededStore(): Promise<MemorySessionStore> {
  const store = new MemorySessionStore();
  await store.save({
    version: 1,
    hostname: HOST,
    username: 'emil',
    password: 'pw',
    cookies: '{"cookies":[]}',
    indexUrl: INDEX,
    saved_at: 1_750_000_000,
  });
  return store;
}

describe('FskintraClient.fetchPage', () => {
  test('re-authenticates once when a page is really the login screen', async () => {
    // ForældreIntra answers an expired session with 200 and a login page, so
    // a status check alone would hand the caller navigation chrome.
    const target = `https://${HOST}/parent/1234/Andrea/documents/class`;
    const { calls } = stub((key, hit) => {
      if (key === `GET ${INDEX}`) return { body: FRONT_PAGE };
      if (key === `GET ${target}`) {
        return hit === 1
          ? { status: 302, location: `https://${HOST}/Account/IdpLogin` }
          : { body: '<html><body><div class="sk-document">ok</div></body></html>' };
      }
      if (key === `GET https://${HOST}/Account/IdpLogin`) return { body: LOGIN_PAGE };
      if (key === `POST https://${HOST}/Account/IdpLogin`) return { status: 302, location: INDEX };
      throw new Error(`No stub for ${key}`);
    });

    const client = new FskintraClient({ store: await seededStore() });
    const doc = await client.fetchPage(target);

    expect(doc('.sk-document').text()).toBe('ok');
    expect(calls.filter((c) => c === `POST https://${HOST}/Account/IdpLogin`)).toHaveLength(1);
    expect(calls.filter((c) => c === `GET ${target}`)).toHaveLength(2);
  });

  test('gives up with SessionExpiredError rather than retrying forever', async () => {
    const target = `https://${HOST}/parent/1234/Andrea/documents/class`;
    stub((key) => {
      if (key === `GET ${INDEX}`) return { body: FRONT_PAGE };
      if (key === `GET ${target}`) {
        return { status: 302, location: `https://${HOST}/Account/IdpLogin` };
      }
      if (key === `GET https://${HOST}/Account/IdpLogin`) return { body: LOGIN_PAGE };
      if (key === `POST https://${HOST}/Account/IdpLogin`) return { status: 302, location: INDEX };
      throw new Error(`No stub for ${key}`);
    });

    const client = new FskintraClient({ store: await seededStore() });
    expect(client.fetchPage(target)).rejects.toThrow(/session expired/i);
  });

  test('resumes from stored cookies without logging in again', async () => {
    const { calls } = stub((key) => {
      if (key === `GET ${INDEX}`) return { body: FRONT_PAGE };
      throw new Error(`No stub for ${key}`);
    });

    const client = new FskintraClient({ store: await seededStore() });
    expect((await client.getChildren()).map((c) => c.name)).toEqual(['Andrea 3A', 'Bertil 6B']);
    expect(calls.some((c) => c.includes('IdpLogin'))).toBe(false);
  });
});

describe('FskintraClient.resolveChild', () => {
  async function client(): Promise<FskintraClient> {
    stub((key) => {
      if (key === `GET ${INDEX}`) return { body: FRONT_PAGE };
      throw new Error(`No stub for ${key}`);
    });
    return new FskintraClient({ store: await seededStore() });
  }

  test('matches on id, exact name, prefix and substring', async () => {
    const c = await client();
    expect((await c.resolveChild('5678')).name).toBe('Bertil 6B');
    expect((await c.resolveChild('Andrea 3A')).id).toBe('1234');
    expect((await c.resolveChild('and')).id).toBe('1234');
    expect((await c.resolveChild('6b')).id).toBe('5678');
  });

  test('lists the options when the name is ambiguous or absent', async () => {
    const c = await client();
    expect(c.resolveChild()).rejects.toThrow(/Andrea 3A, Bertil 6B/);
    expect(c.resolveChild('Christian')).rejects.toThrow(/Known: Andrea 3A, Bertil 6B/);
  });
});

describe('getWeekplans (aggregator)', () => {
  const PREFIX = `https://${HOST}/parent/1234/Andrea`;
  const LIST_URL = `${PREFIX}item/weeklyplansandhomework/list/`;
  const WEEK_A = `${PREFIX}item/weeklyplansandhomework/item/class/38-2026`;
  const WEEK_B = `${PREFIX}item/weeklyplansandhomework/item/class/37-2026`;
  const child = { name: 'Andrea 3A', id: '1234', urlPrefix: PREFIX };

  const LIST_PAGE = `
    <html><body><ul class="sk-list ${'sk-'}weekly-plans-list-container">
      <li><a href="/parent/1234/Andreaitem/weeklyplansandhomework/item/class/38-2026">Plan A</a></li>
      <li><a href="/parent/1234/Andreaitem/weeklyplansandhomework/item/class/37-2026">Plan B</a></li>
    </ul></body></html>`;

  const detailPage = (data: unknown) =>
    `<html><body><div id="root" data-clientlogic-settings-WeeklyPlansApp='${JSON.stringify(
      data,
    )}'></div></body></html>`;

  const goodPlan = {
    SelectedPlan: {
      FormattedWeek: '38-2026',
      DailyPlans: [{ Day: 'Mandag', FormattedDate: '14. sep.', LessonPlans: [] }],
    },
  };

  // The central claim of the fix: a broken week is surfaced at list level
  // (flagged partial) and does NOT take out its sibling weeks.
  test('surfaces a broken week as partial without dropping its siblings', async () => {
    stub((key) => {
      if (key === `GET ${INDEX}`) return { body: FRONT_PAGE };
      if (key === `GET ${LIST_URL}`) return { body: LIST_PAGE };
      if (key === `GET ${WEEK_A}`) return { body: detailPage(goodPlan) };
      // Week B is present-but-malformed JSON -> parseWeekplan throws SectionParseError.
      if (key === `GET ${WEEK_B}`)
        return { body: `<div id="root" data-clientlogic-settings-WeeklyPlansApp='{bad'></div>` };
      throw new Error(`No stub for ${key}`);
    });

    const c = new FskintraClient({ store: await seededStore() });
    const plans = await getWeekplans(c, child);

    expect(plans).toHaveLength(2);
    expect(plans[0]?.id).toBe('38-2026');
    expect(plans[0]?.partial).toBeUndefined();
    // The broken sibling survived as a partial list-level plan, not dropped.
    expect(plans[1]?.id).toBe('37-2026');
    expect(plans[1]?.partial).toBe(true);
    expect(plans[1]?.days).toEqual([]);
  });

  // A detail page with no WeeklyPlansApp attribute is not a weekly-plan page:
  // still surfaced (partial), never silently dropped.
  test('surfaces a week whose detail has no plan attribute as partial', async () => {
    stub((key) => {
      if (key === `GET ${INDEX}`) return { body: FRONT_PAGE };
      if (key === `GET ${LIST_URL}`) return { body: LIST_PAGE };
      if (key === `GET ${WEEK_A}`) return { body: detailPage(goodPlan) };
      if (key === `GET ${WEEK_B}`) return { body: '<html><body>ingen plan her</body></html>' };
      throw new Error(`No stub for ${key}`);
    });

    const c = new FskintraClient({ store: await seededStore() });
    const plans = await getWeekplans(c, child);

    expect(plans.map((p) => p.id)).toEqual(['38-2026', '37-2026']);
    expect(plans[1]?.partial).toBe(true);
  });

  // Auth/network failures are NOT a broken-week: they must propagate, not be
  // masked as a partial empty week.
  test('propagates a non-parse error (expired session) instead of masking it', async () => {
    stub((key) => {
      if (key === `GET ${INDEX}`) return { body: FRONT_PAGE };
      if (key === `GET ${LIST_URL}`) return { body: LIST_PAGE };
      if (key === `GET ${WEEK_A}`) return { body: detailPage(goodPlan) };
      // Week B keeps bouncing to the login screen -> SessionExpiredError.
      if (key === `GET ${WEEK_B}`)
        return { status: 302, location: `https://${HOST}/Account/IdpLogin` };
      if (key === `GET https://${HOST}/Account/IdpLogin`) return { body: LOGIN_PAGE };
      if (key === `POST https://${HOST}/Account/IdpLogin`) return { status: 302, location: INDEX };
      throw new Error(`No stub for ${key}`);
    });

    const c = new FskintraClient({ store: await seededStore() });
    expect(getWeekplans(c, child)).rejects.toThrow(/session expired/i);
  });
});
