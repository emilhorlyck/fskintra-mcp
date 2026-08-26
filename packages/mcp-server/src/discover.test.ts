import { afterEach, describe, expect, test } from 'bun:test';
import { MemorySessionStore } from '@fskintra-mcp/fskintra-auth';
import { FskintraContext } from './context.ts';
import { buildDiscoverManifest } from './discover.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const HOST = 'skole.skoleintra.dk';
const INDEX = `https://${HOST}/parent/1234/Andrea/Index`;

const FRONT_PAGE = `
  <html><body>
    <button id="sk-personal-menu-button">Andrea 3A</button>
    <a href="/parent/1234/Andrea/Index"></a>
    <a href="/parent/1234/Andrea/messages/conversations">Beskeder</a>
    <ul class="sk-reminders-container"><li>Ingenting</li></ul>
  </body></html>`;

const NOT_AUTHORIZED = '<html><body>Du er ikke autoriseret til denne side.</body></html>';

/**
 * Serve the front page for everything except the sections we want to look
 * switched off, which answer with ForældreIntra's "ikke autoriseret" page.
 */
function stubSchool(disabled: string[]): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = (typeof input === 'string' ? input : input.toString()).toLowerCase();
    if (disabled.some((fragment) => url.includes(fragment))) {
      return new Response(NOT_AUTHORIZED, { status: 200 });
    }
    if (url.includes('/photos/archives')) {
      return new Response('<html><body><div id="sk-photos-toolbar-filter"></div></body></html>');
    }
    if (url.includes('/contacts/students/cards')) {
      return new Response('<html><body><div id="sk-toolbar-contact-dropdown"></div></body></html>');
    }
    if (url.includes('/documents/class')) {
      return new Response('<html><body><input id="FoldersJson" value="[]"></body></html>');
    }
    if (url.includes('/signup/')) {
      return new Response('<html><body><div class="sk-signup-container"></div></body></html>');
    }
    if (url.includes('/messages/conversations')) {
      return new Response('<html><body><div class="sk-l-content-wrapper"></div></body></html>');
    }
    return new Response(FRONT_PAGE, { status: 200 });
  }) as typeof fetch;
}

async function seededContext(): Promise<FskintraContext> {
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
  return new FskintraContext({ store });
}

describe('buildDiscoverManifest', () => {
  test('reports the children and the school', async () => {
    stubSchool([]);
    const context = await seededContext();
    try {
      const manifest = await buildDiscoverManifest(context);
      expect(manifest.school).toEqual({ hostname: HOST, username: 'emil' });
      expect(manifest.children.map((c) => c.name)).toEqual(['Andrea 3A']);
      expect(manifest.messageUi).toBe('conversations');
    } finally {
      context.dispose();
    }
  });

  test('separates "the school does not have this" from "there is none"', async () => {
    // The distinction the whole manifest exists for: an agent told a module is
    // unavailable says so; an agent handed an empty array says "no homework".
    stubSchool(['weeklyplansandhomework']);
    const context = await seededContext();
    try {
      const manifest = await buildDiscoverManifest(context);

      expect(manifest.unavailableSections).toContain('homework');
      expect(manifest.unavailableSections).toContain('weekplans');
      expect(manifest.capabilities['homework']?.availableFor).toEqual([]);
      expect(manifest.capabilities['homework']?.notes).toContain('ikke autoriseret');

      expect(manifest.capabilities['news']?.availableFor).toEqual(['Andrea 3A']);
      expect(manifest.unavailableSections).not.toContain('news');
    } finally {
      context.dispose();
    }
  });

  test('names the tools for each capability', async () => {
    stubSchool([]);
    const context = await seededContext();
    try {
      const manifest = await buildDiscoverManifest(context);
      expect(manifest.capabilities['messages']?.tools).toEqual([
        'foraldreintra.messages.list',
        'foraldreintra.messages.get',
      ]);
    } finally {
      context.dispose();
    }
  });

  test('keeps write and raw tools off unless opted in', async () => {
    stubSchool([]);
    const context = await seededContext();
    try {
      const manifest = await buildDiscoverManifest(context);
      expect(manifest.writeEnabled).toBe(false);
      expect(manifest.rawRequestEnabled).toBe(false);
    } finally {
      context.dispose();
    }
  });
});
