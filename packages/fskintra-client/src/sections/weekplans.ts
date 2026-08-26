/**
 * Weekly plans ("ugeplaner").
 *
 * Two hops: a list page of links, then one page per week whose grid alternates
 * header rows (day + date) with content rows (a `ul` of entries).
 */

import { clean, type Doc, textOf } from '@fskintra-mcp/fskintra-auth';
import { childUrl, type FskintraClient } from '../client.ts';
import { SectionUnavailableError } from '../errors.ts';
import type { Child, Weekplan, WeekplanDay, WeekplanLink } from '../types.ts';

export async function listWeekplans(client: FskintraClient, child: Child): Promise<WeekplanLink[]> {
  const doc = await client.fetchPage(childUrl(child, 'item/weeklyplansandhomework/list/'));

  const list = doc('ul.sk-weekly-plans-list-container');
  if (!list.length) {
    assertAuthorized(doc, 'ugeplaner (weekly plans)');
    return [];
  }

  const plans: WeekplanLink[] = [];
  list.find('a[href]').each((_, a) => {
    const raw = doc(a).attr('href');
    if (!raw) return;
    const url = client.absUrl(raw);
    plans.push({
      id: url.replace(/\/$/, '').split('/').pop() ?? url,
      title: clean(doc(a).text()),
      url,
    });
  });
  return plans;
}

export async function getWeekplan(
  client: FskintraClient,
  url: string,
): Promise<Weekplan | undefined> {
  const doc = await client.fetchPage(url);
  return parseWeekplan(doc, url);
}

/** Pure parser. Returns undefined when the week simply has no plan. */
export function parseWeekplan(doc: Doc, url: string): Weekplan | undefined {
  const container = doc('div.sk-weekly-plan-container').first();
  if (!container.length) return undefined;

  const days: WeekplanDay[] = [];
  let current: WeekplanDay | undefined;

  container.find('.sk-weekly-plan-header, .sk-weekly-plan-grid-cell').each((_, el) => {
    const node = doc(el);
    if (node.hasClass('sk-weekly-plan-header')) {
      current = {
        day: clean(node.find('.sk-weekly-plan-day').text()),
        date: clean(node.find('.sk-weekly-plan-date').text()),
        entries: [],
      };
      days.push(current);
      return;
    }
    if (!current) return;
    const day = current;
    node.find('li').each((__, li) => {
      const text = textOf(doc, doc(li));
      if (text) day.entries.push(text);
    });
  });

  return {
    id: url.replace(/\/$/, '').split('/').pop() ?? url,
    title: clean(container.find('h3').first().text()),
    url,
    days,
  };
}

/** The most recent `limit` weeks, fully fetched. */
export async function getWeekplans(
  client: FskintraClient,
  child: Child,
  limit = 4,
): Promise<Weekplan[]> {
  const listed = await listWeekplans(client, child);
  const plans: Weekplan[] = [];
  for (const entry of listed.slice(0, limit)) {
    const plan = await getWeekplan(client, entry.url);
    if (plan) plans.push(plan);
  }
  return plans;
}

/**
 * ForældreIntra says "ikke autoriseret" when a module isn't part of the
 * school's subscription. Distinguishing that from a parse failure is what
 * lets `discover` report the section as unavailable instead of empty.
 */
export function assertAuthorized(doc: Doc, section: string): void {
  if (/ikke autoriseret/i.test(doc('body').text())) {
    throw new SectionUnavailableError(section);
  }
}
