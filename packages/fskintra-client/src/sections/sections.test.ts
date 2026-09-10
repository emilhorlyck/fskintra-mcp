import { describe, expect, test } from 'bun:test';
import { parse } from '@fskintra-mcp/fskintra-auth';
import { SectionParseError } from '../errors.ts';
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
  // The weekly-plan detail page is a client-side Vue app: the day/lesson data
  // is NOT in the server DOM, it is a JSON blob on
  // `#root[data-clientlogic-settings-WeeklyPlansApp]`, which the browser
  // renders. Shape and field names are taken from a real capture against
  // steinerskolen-kvistgaard.m.skoleintra.dk (week 38-2026).
  const appData = {
    SelectedPlan: {
      FormattedWeek: '38-2026',
      ClassOrGroup: '01',
      DailyPlans: [
        {
          Date: '2026-09-14',
          Day: 'Mandag',
          FormattedDate: '14. sep.',
          LessonPlans: [
            {
              Subject: { Title: 'Dansk', FormattedTitle: 'Dansk' },
              // Content is HTML with entities, exactly as the server sends it.
              Content: '<p>Velkommen til Sarah&nbsp;&#128522;.</p>\n',
              IsDraft: false,
            },
          ],
        },
        {
          Date: '2026-09-15',
          Day: 'Tirsdag',
          FormattedDate: '15. sep.',
          LessonPlans: [],
        },
        {
          Date: '2026-09-16',
          Day: 'Onsdag',
          FormattedDate: '16. sep.',
          LessonPlans: [
            {
              Subject: { Title: 'Matematik', FormattedTitle: 'Matematik' },
              Content: '<p>L&aelig;s side 12</p>',
              IsDraft: false,
            },
          ],
        },
      ],
    },
  };

  const detailPage = (data: unknown) =>
    `<html><body><div id="root" data-clientlogic-settings-WeeklyPlansApp='${JSON.stringify(
      data,
    )}'></div></body></html>`;

  test('reads the plan from the WeeklyPlansApp JSON, not the DOM', () => {
    const plan = parseWeekplan(parse(detailPage(appData)), `https://${HOST}/x/item/class/38-2026`);
    expect(plan?.id).toBe('38-2026');
    expect(plan?.days).toEqual([
      { day: 'Mandag', date: '14. sep.', entries: ['Dansk: Velkommen til Sarah 😊.'] },
      { day: 'Tirsdag', date: '15. sep.', entries: [] },
      { day: 'Onsdag', date: '16. sep.', entries: ['Matematik: Læs side 12'] },
    ]);
  });

  test('returns undefined when the page carries no WeeklyPlansApp data', () => {
    expect(parseWeekplan(parse('<html><body>tom</body></html>'), 'x')).toBeUndefined();
  });

  // Broken != empty: the attribute is present (so it should have parsed) but the
  // JSON is malformed. That is a bug report, not an empty week — throw
  // SectionParseError, matching how messages/contacts signal parse failure.
  test('throws SectionParseError when the WeeklyPlansApp JSON is malformed', () => {
    const page = `<div id="root" data-clientlogic-settings-WeeklyPlansApp='{not valid json'></div>`;
    expect(() => parseWeekplan(parse(page), `https://${HOST}/x/item/class/9-2026`)).toThrow(
      SectionParseError,
    );
  });

  // A draft is a teacher's unpublished work-in-progress. A parent-facing,
  // read-only view must not surface it.
  test('filters out draft lessons', () => {
    const data = {
      SelectedPlan: {
        FormattedWeek: '9-2026',
        DailyPlans: [
          {
            Day: 'Mandag',
            FormattedDate: '1. mar.',
            LessonPlans: [
              { Subject: { Title: 'Dansk' }, Content: '<p>udkast</p>', IsDraft: true },
              { Subject: { Title: 'Matematik' }, Content: '<p>side 4</p>', IsDraft: false },
            ],
          },
        ],
      },
    };
    const plan = parseWeekplan(parse(detailPage(data)), `https://${HOST}/x/item/class/9-2026`);
    expect(plan?.days[0]?.entries).toEqual(['Matematik: side 4']);
  });

  // Broken != empty (part 2): valid JSON but a field is the wrong shape — a
  // realistic server-side API drift. An unguarded .map/.filter would throw a
  // raw TypeError that escapes the SectionParseError contract; guard it.
  test('throws SectionParseError when DailyPlans is not an array', () => {
    const data = { SelectedPlan: { FormattedWeek: '9-2026', DailyPlans: { nope: 1 } } };
    expect(() =>
      parseWeekplan(parse(detailPage(data)), `https://${HOST}/x/item/class/9-2026`),
    ).toThrow(SectionParseError);
  });

  test('throws SectionParseError when a day LessonPlans is not an array', () => {
    const data = {
      SelectedPlan: {
        FormattedWeek: '9-2026',
        DailyPlans: [{ Day: 'Mandag', FormattedDate: '1. mar.', LessonPlans: 'oops' }],
      },
    };
    expect(() =>
      parseWeekplan(parse(detailPage(data)), `https://${HOST}/x/item/class/9-2026`),
    ).toThrow(SectionParseError);
  });

  // When the payload lacks FormattedWeek, fall back to the list-level title
  // rather than an empty string.
  test('falls back to the list title when FormattedWeek is absent', () => {
    const data = { SelectedPlan: { DailyPlans: [] } };
    const plan = parseWeekplan(
      parse(detailPage(data)),
      `https://${HOST}/x/item/class/9-2026`,
      'Plan for uge 9',
    );
    expect(plan?.title).toBe('Plan for uge 9');
    expect(plan?.id).toBe('9-2026');
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
