import { childUrl, type Child } from '../children.js';
import { clean, textOf, type Doc } from '../html.js';
import { fetchPage } from '../login.js';
import { absUrl } from '../session.js';

export interface WeekplanDay {
  day: string;
  date: string;
  entries: string[];
}

export interface Weekplan {
  /** Week identifier from the URL, e.g. "35-2018" */
  id: string;
  title: string;
  url: string;
  days: WeekplanDay[];
}

export class SectionUnavailableError extends Error {}

/** Links to the available weekly plans, newest first as ForældreIntra lists them. */
export async function listWeekplans(child: Child): Promise<{ id: string; title: string; url: string }[]> {
  const $ = await fetchPage(childUrl(child, 'item/weeklyplansandhomework/list/'));

  const list = $('ul.sk-weekly-plans-list-container');
  if (!list.length) {
    assertAuthorized($, 'ugeplaner (weekly plans)');
    return [];
  }

  const plans: { id: string; title: string; url: string }[] = [];
  list.find('a[href]').each((_, a) => {
    const href = absUrl($(a).attr('href')!);
    plans.push({
      id: href.replace(/\/$/, '').split('/').pop() ?? href,
      title: clean($(a).text()),
      url: href,
    });
  });
  return plans;
}

export async function getWeekplan(url: string): Promise<Weekplan | undefined> {
  const $ = await fetchPage(url);
  const container = $('div.sk-weekly-plan-container').first();
  if (!container.length) return undefined;

  const days: WeekplanDay[] = [];
  let current: WeekplanDay | undefined;

  container.find('.sk-weekly-plan-header, .sk-weekly-plan-grid-cell').each((_, el) => {
    const node = $(el);
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
    node.find('li').each((__, li) => {
      const text = textOf($, $(li));
      if (text) current!.entries.push(text);
    });
  });

  return {
    id: url.replace(/\/$/, '').split('/').pop() ?? url,
    title: clean(container.find('h3').first().text()),
    url,
    days,
  };
}

/** All weekly plans for a child, optionally limited to the most recent `limit`. */
export async function getWeekplans(child: Child, limit = 4): Promise<Weekplan[]> {
  const listed = await listWeekplans(child);
  const plans: Weekplan[] = [];
  for (const entry of listed.slice(0, limit)) {
    const plan = await getWeekplan(entry.url);
    if (plan) plans.push(plan);
  }
  return plans;
}

export function assertAuthorized($: Doc, section: string): void {
  if (/ikke autoriseret/i.test($('body').text())) {
    throw new SectionUnavailableError(
      `This school does not use ${section}, or your account has no access to it.`
    );
  }
}
