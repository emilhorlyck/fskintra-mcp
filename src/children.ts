import { log } from './config.js';
import { clean, type Doc } from './html.js';
import { login } from './login.js';
import { absUrl } from './session.js';

export interface Child {
  /** Display name as ForældreIntra shows it, e.g. "Andrea 3A" */
  name: string;
  /** Numeric id from the URL, e.g. "1234" */
  id: string;
  /** Absolute prefix, e.g. https://host/parent/1234/Andrea */
  urlPrefix: string;
}

/** Links like /parent/1234/Andrea/Index — three path segments then /Index. */
const CHILD_LINK_RE = /^(\/[^/]*){3}\/Index$/i;

let children: Child[] | undefined;

export async function getChildren(force = false): Promise<Child[]> {
  if (children && !force) return children;

  children = parseChildren(await login(force));
  log(`found ${children.length} child(ren): ${children.map((c) => c.name).join(', ')}`);

  if (children.length === 0) {
    throw new Error(
      'No children found on the ForældreIntra front page. The page layout may have changed.'
    );
  }
  return children;
}

/** Pure parser, so the markup contract can be tested without the network. */
export function parseChildren($: Doc): Child[] {
  // The currently selected child's name is only in the personal menu button;
  // its own nav link renders with empty text.
  const selectedName = clean($('#sk-personal-menu-button').first().text());

  const byPrefix = new Map<string, Child>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')!;
    if (!CHILD_LINK_RE.test(href)) return;

    const urlPrefix = absUrl(href.replace(/\/Index$/i, ''));
    if (byPrefix.has(urlPrefix)) return;

    const name = clean($(el).text()) || selectedName;
    if (!name) return;

    const id = new URL(urlPrefix).pathname.split('/')[2] ?? '';
    byPrefix.set(urlPrefix, { name, id, urlPrefix });
  });

  return [...byPrefix.values()].sort((a, b) => a.name.localeCompare(b.name, 'da'));
}

/**
 * Resolve a child by name (case-insensitive, prefix match) or id. With no
 * argument, returns the only child — or fails if there is more than one.
 */
export async function resolveChild(nameOrId?: string): Promise<Child> {
  const all = await getChildren();
  if (!nameOrId) {
    if (all.length === 1) return all[0]!;
    throw new Error(
      `More than one child on this account; specify one of: ${all.map((c) => c.name).join(', ')}`
    );
  }

  const needle = nameOrId.trim().toLowerCase();
  const match =
    all.find((c) => c.id === needle || c.name.toLowerCase() === needle) ??
    all.find((c) => c.name.toLowerCase().startsWith(needle)) ??
    all.find((c) => c.name.toLowerCase().includes(needle));

  if (!match) {
    throw new Error(
      `No child matching ${JSON.stringify(nameOrId)}. Known: ${all.map((c) => c.name).join(', ')}`
    );
  }
  return match;
}

/**
 * Build a child-scoped URL. Most sections hang off the prefix with a leading
 * slash; the weekplan/homework pages are the odd ones out and concatenate
 * directly (`.../Andreaitem/weeklyplansandhomework/list/`) — a quirk of
 * ForældreIntra that fskintra also had to reproduce.
 */
export function childUrl(child: Child, suffix: string): string {
  if (!suffix.startsWith('/') && !suffix.startsWith('item/')) {
    throw new Error(`childUrl suffix must start with "/" or "item/": ${suffix}`);
  }
  return child.urlPrefix + suffix;
}
