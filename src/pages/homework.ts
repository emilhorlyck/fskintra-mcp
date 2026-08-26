import { childUrl, type Child } from '../children.js';
import { clean, textOf } from '../html.js';
import { fetchPage } from '../login.js';
import { absUrl } from '../session.js';
import { assertAuthorized } from './weekplans.js';

export interface HomeworkEntry {
  subject: string;
  text: string;
}

export interface HomeworkGroup {
  /** Due-date heading, e.g. "Mandag, 3. sep. 2018:" */
  due: string;
  entries: HomeworkEntry[];
}

export interface Homework {
  title: string;
  url: string;
  groups: HomeworkGroup[];
}

/**
 * Homework ("lektier") lives behind three hops: the diary overview links to a
 * class page, which carries a "view all notes" link, which we extend with
 * /NextMonth to get the coming month's homework as well.
 */
export async function getHomework(child: Child): Promise<Homework[]> {
  const $ = await fetchPage(childUrl(child, 'item/weeklyplansandhomework/diary/'));

  const columns = $('li.ccl-rwgm-column-1-2.sk-grid-priority-column');
  if (!columns.length) {
    assertAuthorized($, 'lektier (homework)');
    return [];
  }

  const classUrls = new Set<string>();
  columns.find('a[href]').each((_, a) => {
    classUrls.add(absUrl($(a).attr('href')!));
  });

  const result: Homework[] = [];
  for (const classUrl of classUrls) {
    const $class = await fetchPage(classUrl);
    const viewAll = $class('a#sk-diary-notes-view-all[href]').first().attr('href');
    if (!viewAll) continue;

    const url = absUrl(viewAll) + '/NextMonth';
    const $notes = await fetchPage(url);

    const groups: HomeworkGroup[] = [];
    $notes('ul.sk-list > li').each((_, li) => {
      const item = $notes(li);
      const due = clean(item.find('div.sk-white-box > b').first().text());
      if (!due) return;

      const entries: HomeworkEntry[] = [];
      item.find('table tbody tr').each((__, tr) => {
        const cells = $notes(tr).children('td, th');
        if (cells.length < 2) return;
        const subject = clean(cells.eq(0).text());
        const text = textOf($notes, cells.eq(1));
        if (subject && text) entries.push({ subject, text });
      });

      if (entries.length) groups.push({ due, entries });
    });

    if (groups.length) {
      result.push({ title: clean($class('h3').first().text()), url, groups });
    }
  }

  return result;
}
