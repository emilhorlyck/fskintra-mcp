import { describe, expect, test } from 'bun:test';
import { isChildLink } from './child-link.ts';

describe('isChildLink', () => {
  test('matches a bare child path', () => {
    expect(isChildLink('/parent/1234/Andrea/Index')).toBe(true);
  });

  // The login flow lands on absolute URLs; the client scrapes bare hrefs.
  // Both must be accepted, or the two layers disagree about the same page.
  test('matches the same link as an absolute URL', () => {
    expect(isChildLink('https://minskole.skoleintra.dk/parent/1234/Andrea/Index')).toBe(true);
  });

  test('tolerates a trailing slash', () => {
    expect(isChildLink('/parent/1234/Andrea/Index/')).toBe(true);
  });

  // Regression (review #6): the module's contract is that login and the client
  // never disagree about a page. A child link with a query string or fragment
  // must be accepted, or a front page login accepts yields zero children.
  test('accepts a child link carrying a query string', () => {
    expect(isChildLink('/parent/1234/Andrea/Index?SchoolId=3')).toBe(true);
  });

  test('accepts a child link carrying a fragment', () => {
    expect(isChildLink('/parent/1234/Andrea/Index#top')).toBe(true);
  });

  test('accepts an absolute child link with a query string', () => {
    expect(isChildLink('https://skole.skoleintra.dk/parent/1234/Andrea/Index?x=1')).toBe(true);
  });

  test('is case-insensitive on the Index segment', () => {
    expect(isChildLink('/parent/1234/Andrea/index')).toBe(true);
  });

  test('rejects a path that is not three segments then Index', () => {
    expect(isChildLink('/parent/1234/Index')).toBe(false);
    expect(isChildLink('/a/b/c/d/Index')).toBe(false);
    expect(isChildLink('/parent/1234/Andrea/Messages')).toBe(false);
  });

  test('rejects empty, missing, and non-link hrefs', () => {
    expect(isChildLink('')).toBe(false);
    expect(isChildLink(undefined)).toBe(false);
    expect(isChildLink(null)).toBe(false);
    expect(isChildLink('/')).toBe(false);
  });
});
