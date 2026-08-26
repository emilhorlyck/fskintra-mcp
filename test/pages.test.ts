import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChildren } from '../src/children.js';
import { parse } from '../src/html.js';
import { parseFrontpage } from '../src/pages/news.js';

process.env.FSKINTRA_HOSTNAME ??= 'skole.skoleintra.dk';
process.env.FSKINTRA_USERNAME ??= 'test';
process.env.FSKINTRA_PASSWORD ??= 'test';

/** Shaped after the markup fskintra targets: see skoleintra/schildren.py. */
const FRONTPAGE = `
<html><body>
  <button id="sk-personal-menu-button"> Andrea 3A </button>
  <nav>
    <a href="/parent/1234/Andrea/Index"></a>
    <a href="/parent/5678/Bertil/Index">Bertil 6B</a>
    <a href="/parent/1234/Andrea/Index">Andrea 3A</a>
    <a href="/parent/1234/Andrea/messages/conversations">Beskeder</a>
    <a href="/some/other/page/Index/deeper">Ikke et barn</a>
  </nav>

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

test('parseChildren finds every child once, naming the selected one', () => {
  const children = parseChildren(parse(FRONTPAGE));

  assert.deepEqual(
    children.map((c) => [c.name, c.id]),
    [
      ['Andrea 3A', '1234'],
      ['Bertil 6B', '5678'],
    ]
  );
  assert.equal(children[0]!.urlPrefix, 'https://skole.skoleintra.dk/parent/1234/Andrea');
});

test('parseFrontpage extracts news items and drops the noise reminder', () => {
  const page = parseFrontpage(parse(FRONTPAGE), 'Andrea 3A');

  assert.deepEqual(page.reminders, ['Bertil har fødselsdag i dag']);
  assert.equal(page.news.length, 2);

  const first = page.news[0]!;
  assert.equal(first.id, '99001');
  assert.equal(first.title, 'Udflugt til Zoo');
  assert.equal(first.author, 'Jens Hansen');
  assert.deepEqual(first.recipients, ['3A', '3B', 'Forældre']);
  assert.equal(first.date, '2018-06-25T16:26');
  assert.equal(first.body, 'Udflugt til Zoo.\nHusk madpakke og regntøj.');
  assert.deepEqual(first.attachments, [
    { name: 'seddel.pdf', url: 'https://skole.skoleintra.dk/files/seddel.pdf' },
  ]);
  assert.equal(first.commentCount, 3);
});

test('parseFrontpage reports no comments when none are posted', () => {
  const page = parseFrontpage(parse(FRONTPAGE), 'Andrea 3A');
  assert.equal(page.news[1]!.commentCount, 0);
});
