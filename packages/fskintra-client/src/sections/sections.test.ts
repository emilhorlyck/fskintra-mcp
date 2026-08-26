import { describe, expect, test } from 'bun:test';
import { parse } from '@fskintra-mcp/fskintra-auth';
import { collectDocuments } from './documents.ts';
import { findConversationsJson, messageFromJson, normalizeRecipients } from './messages.ts';
import { parseFrontpage } from './news.ts';
import { parseWeekplan } from './weekplans.ts';

const HOST = 'skole.skoleintra.dk';
const absUrl = (url: string): string => (/^https?:\/\//.test(url) ? url : `https://${HOST}${url}`);

/** Shaped after the markup fskintra targets — see skoleintra/pgFrontpage.py. */
const FRONT_PAGE = `
  <html><body>
    <ul class="sk-reminders-container">
      <li>Bertil har fødselsdag i dag</li>
      <li>Der er aktiviteter i dag</li>
    </ul>

    <div class="sk-news-item" data-feed-item-id="99001">
      <div class="sk-news-item-author">
        <span>Jens Hansen</span>
        <span class="sk-news-item-for">til</span>
        3A, 3B<span class="sk-news-item-and"> og </span>Forældre
        <a class="sk-news-show-more-link">Vis mere</a>
      </div>
      <div class="sk-news-item-timestamp">25. jun. 2018 16:26 (opdateret 26. jun. 2018)</div>
      <div class="sk-news-item-content">
        <div>Udflugt til Zoo.</div>
        <div>Husk madpakke og regntøj.</div>
        <div class="sk-attachments-list"><a href="/files/seddel.pdf">seddel.pdf</a></div>
        <div class="sk-news-item-comments">Vis 3 kommentarer</div>
      </div>
    </div>

    <div class="sk-news-item" data-feed-item-id="99002">
      <div class="sk-news-item-author"><span>Skolen</span></div>
      <div class="sk-news-item-timestamp">I dag kl. 08:00</div>
      <div class="sk-news-item-content"><div>Kort besked</div>
        <div class="sk-news-item-comments">Tilføj en kommentar</div>
      </div>
    </div>
  </body></html>`;

describe('parseFrontpage', () => {
  test('extracts a news item in full', () => {
    const page = parseFrontpage(parse(FRONT_PAGE), 'Andrea 3A', absUrl);
    const first = page.news[0];

    expect(page.news).toHaveLength(2);
    expect(first?.id).toBe('99001');
    expect(first?.title).toBe('Udflugt til Zoo');
    expect(first?.author).toBe('Jens Hansen');
    expect(first?.date).toBe('2018-06-25T16:26');
    expect(first?.body).toBe('Udflugt til Zoo.\nHusk madpakke og regntøj.');
    expect(first?.attachments).toEqual([
      { name: 'seddel.pdf', url: `https://${HOST}/files/seddel.pdf` },
    ]);
    expect(first?.commentCount).toBe(3);
  });

  test('splits recipients without gluing the last two together', () => {
    // The " og " separator is its own element. Removing it outright — which is
    // what fskintra does — yields "3BForældre".
    const page = parseFrontpage(parse(FRONT_PAGE), 'Andrea 3A', absUrl);
    expect(page.news[0]?.recipients).toEqual(['3A', '3B', 'Forældre']);
  });

  test('keeps the raw timestamp alongside the parsed one', () => {
    const page = parseFrontpage(parse(FRONT_PAGE), 'Andrea 3A', absUrl);
    expect(page.news[0]?.dateText).toBe('25. jun. 2018 16:26');
  });

  test('drops the permanent "aktiviteter i dag" reminder', () => {
    const page = parseFrontpage(parse(FRONT_PAGE), 'Andrea 3A', absUrl);
    expect(page.reminders).toEqual(['Bertil har fødselsdag i dag']);
  });

  test('reports no comments when none are posted', () => {
    const page = parseFrontpage(parse(FRONT_PAGE), 'Andrea 3A', absUrl);
    expect(page.news[1]?.commentCount).toBe(0);
  });
});

describe('normalizeRecipients', () => {
  test('handles the pre-2025 array shape', () => {
    expect(normalizeRecipients(['Anne', 'Bo'])).toEqual(['Anne', 'Bo']);
  });

  test('handles the post-August-2025 map shape', () => {
    expect(normalizeRecipients({ '': [{ Name: 'Anne' }, { Name: 'Bo' }] })).toEqual(['Anne', 'Bo']);
  });

  test('tolerates missing recipients', () => {
    expect(normalizeRecipients(undefined)).toEqual([]);
  });
});

describe('messageFromJson', () => {
  test('renders body and quoted reply as text', () => {
    const message = messageFromJson(
      {
        Id: 42,
        Subject: 'Lejrskole',
        SenderName: 'Jens Hansen',
        SentReceivedDateText: '25. jun. 2018 16:26',
        BaseText: '<p>Hej <b>alle</b></p>',
        PreviousMessagesText: '<p>Tidligere besked</p>',
        Recipients: ['Anne'],
        AttachmentsLinks: [{ HrefAttributeValue: '/f/a.pdf', Text: 'a.pdf' }],
        ShowUnreadIndication: true,
      },
      'thread-1',
    );

    expect(message.id).toBe('42');
    expect(message.threadId).toBe('thread-1');
    expect(message.body).toBe('Hej alle');
    expect(message.quoted).toBe('Tidligere besked');
    expect(message.date).toBe('2018-06-25T16:26');
    expect(message.unread).toBe(true);
    expect(message.attachments).toEqual([{ name: 'a.pdf', url: '/f/a.pdf' }]);
  });

  test('falls back to a placeholder subject', () => {
    expect(messageFromJson({ Id: 1 }, '').subject).toBe('(uden emne)');
  });
});

describe('findConversationsJson', () => {
  const payload = JSON.stringify({
    Conversations: [{ ThreadId: 't1', LatestMessageId: 7, Subject: 'Hej' }],
    Padding: 'x'.repeat(200),
  });

  test('finds the list by attribute shape, not by attribute name', () => {
    // The attribute name has changed before; matching on it would break
    // silently at the next rename.
    const doc = parse(
      `<div class="sk-l-content-wrapper"><div data-weird-message-blob='${payload}'></div></div>`,
    );
    expect(findConversationsJson(doc)?.[0]?.ThreadId).toBe('t1');
  });

  test('returns undefined when nothing on the page holds a conversation list', () => {
    const doc = parse('<div class="sk-l-content-wrapper"><div data-message="{}"></div></div>');
    expect(findConversationsJson(doc)).toBeUndefined();
  });
});

describe('parseWeekplan', () => {
  const WEEK = `
    <div class="sk-weekly-plan-container">
      <h3>Uge 35</h3>
      <li class="sk-weekly-plan-header">
        <span class="sk-weekly-plan-day">Mandag</span>
        <span class="sk-weekly-plan-date">27. aug.</span>
      </li>
      <li class="sk-weekly-plan-grid-cell"><ul><li>Dansk: læs side 12</li><li>Idræt</li></ul></li>
      <li class="sk-weekly-plan-header">
        <span class="sk-weekly-plan-day">Tirsdag</span>
        <span class="sk-weekly-plan-date">28. aug.</span>
      </li>
      <li class="sk-weekly-plan-grid-cell"><ul><li>Matematik</li></ul></li>
    </div>`;

  test('pairs each header row with the content row that follows it', () => {
    const plan = parseWeekplan(parse(WEEK), `https://${HOST}/plan/35-2018`);
    expect(plan?.id).toBe('35-2018');
    expect(plan?.title).toBe('Uge 35');
    expect(plan?.days).toEqual([
      { day: 'Mandag', date: '27. aug.', entries: ['Dansk: læs side 12', 'Idræt'] },
      { day: 'Tirsdag', date: '28. aug.', entries: ['Matematik'] },
    ]);
  });

  test('returns undefined for a week with no plan', () => {
    expect(parseWeekplan(parse('<html><body>tom</body></html>'), 'x')).toBeUndefined();
  });
});

describe('collectDocuments', () => {
  test('skips rows missing a name, date or link', () => {
    const doc = parse(`
      <div class="sk-document">
        <span class="sk-documents-document-title">Referat.pdf</span>
        <div class="sk-documents-date-column">3. september 2021</div>
        <a href="/d/1">hent</a>
      </div>
      <div class="sk-document">
        <span class="sk-documents-document-title">Uden dato.pdf</span>
        <a href="/d/2">hent</a>
      </div>`);

    const docs = collectDocuments(doc, 'Klassens dokumenter', absUrl);
    expect(docs).toEqual([
      {
        name: 'Referat.pdf',
        folder: 'Klassens dokumenter',
        url: `https://${HOST}/d/1`,
        date: '2021-09-03T12:00',
        dateText: '3. september 2021',
      },
    ]);
  });
});
