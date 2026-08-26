import { describe, expect, test } from 'bun:test';
import { clean, htmlToText, parse, parseDanishDateTime, serializeForm, textOf } from './html.ts';

describe('clean', () => {
  test('collapses non-breaking spaces and runs of whitespace', () => {
    expect(clean('  Uge  35\n\n  2018 ')).toBe('Uge 35 2018');
    expect(clean(undefined)).toBe('');
  });
});

describe('textOf', () => {
  test('keeps block-level line breaks', () => {
    const doc = parse('<div id="x"><p>Første linje</p><p>Anden<br>linje</p></div>');
    expect(textOf(doc, doc('#x'))).toBe('Første linje\nAnden\nlinje');
  });

  test('collapses the blank lines nested block elements produce', () => {
    const doc = parse('<div id="x">\n  <div>En</div>\n  <div>To</div>\n</div>');
    expect(textOf(doc, doc('#x'))).toBe('En\nTo');
  });
});

describe('htmlToText', () => {
  test('renders a message body fragment', () => {
    expect(htmlToText('<p>Hej <b>alle</b></p><p>Mvh Jens</p>')).toBe('Hej alle\nMvh Jens');
  });
});

describe('parseDanishDateTime', () => {
  test('handles the formats ForældreIntra emits', () => {
    expect(parseDanishDateTime('ons. 25. jun. 2018 16:26')).toBe('2018-06-25T16:26');
    expect(parseDanishDateTime('25. juni 2018 kl. 16:26')).toBe('2018-06-25T16:26');
    expect(parseDanishDateTime('01-02-2024 07:05')).toBe('2024-02-01T07:05');
  });

  test('defaults to noon when no time of day is given', () => {
    // Matches fskintra's behaviour; a date-only item sorts mid-day, not at
    // midnight, so it doesn't jump a day either side of a timezone shift.
    expect(parseDanishDateTime('3. september 2021')).toBe('2021-09-03T12:00');
  });

  test('resolves relative days against "now"', () => {
    const now = new Date(2026, 7, 26, 10, 0);
    expect(parseDanishDateTime('I dag kl. 09:12', now)).toBe('2026-08-26T09:12');
    expect(parseDanishDateTime('I går kl. 23:59', now)).toBe('2026-08-25T23:59');
    expect(parseDanishDateTime('I morgen kl. 08:00', now)).toBe('2026-08-27T08:00');
  });

  test('returns undefined rather than guessing', () => {
    expect(parseDanishDateTime('for nylig')).toBeUndefined();
  });
});

describe('serializeForm', () => {
  test('keeps hidden fields and drops unchecked boxes', () => {
    const doc = parse(`
      <form action="/Account/IdpLogin" method="post">
        <input type="hidden" name="__RequestVerificationToken" value="tok123">
        <input type="text" name="UserName" value="">
        <input type="password" name="Password" value="">
        <input type="checkbox" name="RememberMe" value="true">
        <input type="checkbox" name="Accepted" value="yes" checked>
        <input type="submit" name="submit" value="Log ind">
      </form>`);

    const spec = serializeForm(doc, doc('form'), { UserName: 'emil', Password: 'hemmelig' });

    expect(spec.method).toBe('POST');
    expect(spec.action).toBe('/Account/IdpLogin');
    // The anti-forgery token is the reason hidden fields cannot be dropped.
    expect(spec.fields.get('__RequestVerificationToken')).toBe('tok123');
    expect(spec.fields.get('UserName')).toBe('emil');
    expect(spec.fields.get('Password')).toBe('hemmelig');
    expect(spec.fields.get('Accepted')).toBe('yes');
    expect(spec.fields.has('RememberMe')).toBe(false);
    expect(spec.fields.has('submit')).toBe(false);
  });

  test('picks the selected option of a select', () => {
    const doc = parse(`
      <form>
        <select name="klasse">
          <option value="3a">3A</option>
          <option value="3b" selected>3B</option>
        </select>
      </form>`);
    expect(serializeForm(doc, doc('form')).fields.get('klasse')).toBe('3b');
  });
});
