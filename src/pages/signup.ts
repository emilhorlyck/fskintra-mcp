import { childUrl, type Child } from '../children.js';
import { clean } from '../html.js';
import { fetchPage } from '../login.js';

export interface SignupEvent {
  kind: 'conversation' | 'event';
  title: string;
  fields: { label: string; value: string }[];
}

/**
 * Sign-ups for parent-teacher conversations and school events. Closed rows
 * ("Status: Lukket") are skipped — there is nothing to act on.
 */
export async function getSignups(child: Child): Promise<SignupEvent[]> {
  const events: SignupEvent[] = [];

  for (const kind of ['conversation', 'event'] as const) {
    const $ = await fetchPage(childUrl(child, `/signup/${kind}`));

    $('.sk-signup-container ul.ccl-rwgm-row').each((_, ul) => {
      const row = $(ul);
      if (row.hasClass('sk-grid-top-header')) return;

      const fields: { label: string; value: string }[] = [];
      let label = '';
      row.find('li').each((__, li) => {
        const text = clean($(li).text());
        if ($(li).hasClass('sk-grid-inline-header')) {
          label = text.replace(/:$/, '');
        } else {
          fields.push({ label, value: text });
        }
      });

      const isClosed = fields.some(
        (f) => /^status/i.test(f.label) && /^lukket/i.test(f.value)
      );
      if (isClosed || fields.length === 0) return;

      const first = fields[0]!;
      events.push({ kind, title: `${first.label}: ${first.value}`, fields });
    });
  }

  return events;
}
