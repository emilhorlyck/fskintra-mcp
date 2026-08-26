import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clean, htmlToText, parse, parseDanishDateTime, serializeForm, textOf } from '../src/html.js';

test('clean collapses non-breaking spaces and runs of whitespace', () => {
  assert.equal(clean('  Uge  35\n\n  2018 '), 'Uge 35 2018');
  assert.equal(clean(undefined), '');
});

test('textOf keeps block-level line breaks', () => {
  const $ = parse('<div id="x"><p>Første linje</p><p>Anden<br>linje</p></div>');
  assert.equal(textOf($, $('#x')), 'Første linje\nAnden\nlinje');
});

test('htmlToText renders a message body fragment', () => {
  assert.equal(htmlToText('<p>Hej <b>alle</b></p><p>Mvh Jens</p>'), 'Hej alle\nMvh Jens');
});

test('parseDanishDateTime handles the formats ForældreIntra emits', () => {
  assert.equal(parseDanishDateTime('ons. 25. jun. 2018 16:26'), '2018-06-25T16:26');
  assert.equal(parseDanishDateTime('25. juni 2018 kl. 16:26'), '2018-06-25T16:26');
  // No time of day means noon, matching fskintra's behaviour.
  assert.equal(parseDanishDateTime('3. september 2021'), '2021-09-03T12:00');
  assert.equal(parseDanishDateTime('01-02-2024 07:05'), '2024-02-01T07:05');
});

test('parseDanishDateTime resolves relative days against "now"', () => {
  const now = new Date(2026, 7, 26, 10, 0);
  assert.equal(parseDanishDateTime('I dag kl. 09:12', now), '2026-08-26T09:12');
  assert.equal(parseDanishDateTime('I går kl. 23:59', now), '2026-08-25T23:59');
});

test('parseDanishDateTime returns undefined rather than guessing', () => {
  assert.equal(parseDanishDateTime('for nylig'), undefined);
});

test('serializeForm keeps hidden fields and drops unchecked boxes', () => {
  const $ = parse(`
    <form action="/Account/IdpLogin" method="post">
      <input type="hidden" name="__RequestVerificationToken" value="tok123">
      <input type="text" name="UserName" value="">
      <input type="password" name="Password" value="">
      <input type="checkbox" name="RememberMe" value="true">
      <input type="checkbox" name="Accepted" value="yes" checked>
      <input type="submit" name="submit" value="Log ind">
    </form>`);

  const spec = serializeForm($, $('form'), { UserName: 'emil', Password: 'hemmelig' });

  assert.equal(spec.method, 'POST');
  assert.equal(spec.action, '/Account/IdpLogin');
  assert.equal(spec.fields.get('__RequestVerificationToken'), 'tok123');
  assert.equal(spec.fields.get('UserName'), 'emil');
  assert.equal(spec.fields.get('Password'), 'hemmelig');
  assert.equal(spec.fields.get('Accepted'), 'yes');
  assert.equal(spec.fields.has('RememberMe'), false);
  assert.equal(spec.fields.has('submit'), false);
});

test('serializeForm picks the selected option of a select', () => {
  const $ = parse(`
    <form>
      <select name="klasse">
        <option value="3a">3A</option>
        <option value="3b" selected>3B</option>
      </select>
    </form>`);
  assert.equal(serializeForm($, $('form')).fields.get('klasse'), '3b');
});
