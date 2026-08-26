import { childUrl, type Child } from '../children.js';
import { clean } from '../html.js';
import { fetchPage } from '../login.js';
import { absUrl } from '../session.js';

export interface ContactCard {
  name: string;
  url: string;
  /** Section heading -> label/value pairs as shown on the card */
  fields: { section: string; label: string; value: string }[];
}

/** Contact cards for the pupils in the child's class. */
export async function getContacts(child: Child): Promise<ContactCard[]> {
  const $ = await fetchPage(childUrl(child, '/contacts/students/cards'));

  const urls: string[] = [];
  $('#sk-toolbar-contact-dropdown option[value]').each((_, opt) => {
    urls.push(absUrl($(opt).attr('value')!));
  });

  if (urls.length === 0) {
    throw new Error('No pupils found on the contacts page.');
  }

  const cards: ContactCard[] = [];
  for (const url of urls) {
    const $card = await fetchPage(url);
    const name = clean(
      $card('.sk-contact-person-name span.sk-labeledtext-value').first().text()
    );

    const fields: ContactCard['fields'] = [];
    let section = '';
    // The card is a flat run of headings and label/value span pairs.
    $card('div.text-block')
      .first()
      .find('h2, div')
      .each((_, el) => {
        const node = $card(el);
        if (el.tagName?.toLowerCase() === 'h2') {
          section = clean(node.text());
          return;
        }
        const spans = node.children('span');
        if (spans.length < 2) return;
        const label = clean(spans.eq(0).text()).replace(/:$/, '');
        const value = clean(spans.eq(1).text());
        if (label || value) fields.push({ section, label, value });
      });

    cards.push({ name, url, fields });
  }

  return cards;
}
