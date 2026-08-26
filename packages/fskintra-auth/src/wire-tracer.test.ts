import { describe, expect, test } from 'bun:test';
import {
  InMemoryTracer,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeResponseBody,
  sanitizeUrl,
} from './wire-tracer.ts';

describe('sanitizeHeaders', () => {
  test('redacts cookies but keeps their length', () => {
    const out = sanitizeHeaders({ Cookie: 'ASP.NET_SessionId=abc123', 'X-Trace': 'keep-me' });
    expect(out['cookie']).toBe('<redacted 24 chars>');
    expect(out['x-trace']).toBe('keep-me');
  });
});

describe('sanitizeRequestBody', () => {
  test('redacts the password from a login POST, keeping the rest', () => {
    const out = sanitizeRequestBody(
      'UserName=emil&Password=hemmelig&__RequestVerificationToken=tok',
    );
    expect(out).toContain('UserName=emil');
    expect(out).not.toContain('hemmelig');
    expect(out).not.toContain('tok');
  });

  test('redacts secret fields in a JSON body', () => {
    const out = sanitizeRequestBody('{"user":"emil","password":"hemmelig"}');
    expect(out).toContain('"user":"emil"');
    expect(out).not.toContain('hemmelig');
  });

  test('reports an unrecognised body by length only', () => {
    expect(sanitizeRequestBody('opaque-blob')).toBe('<redacted 11 chars>');
  });

  test('treats an empty body as absent', () => {
    expect(sanitizeRequestBody('')).toBeNull();
    expect(sanitizeRequestBody(undefined)).toBeNull();
  });
});

describe('sanitizeUrl', () => {
  test('redacts secret query params and keeps the structure', () => {
    const out = sanitizeUrl('https://skole.dk/a/b?page=2&access_token=xyz');
    expect(out).toContain('page=2');
    expect(out).toContain('/a/b');
    expect(out).not.toContain('xyz');
  });

  test('passes a malformed URL through untouched', () => {
    expect(sanitizeUrl('not a url')).toBe('not a url');
  });
});

describe('sanitizeResponseBody', () => {
  test('truncates long pages but reports the real size', () => {
    const body = 'x'.repeat(10_000);
    const out = sanitizeResponseBody(body);
    expect(out.bytes).toBe(10_000);
    expect(out.text.length).toBeLessThan(10_000);
    expect(out.text).toContain('truncated');
  });
});

describe('InMemoryTracer', () => {
  test('collects and clears entries', () => {
    const tracer = new InMemoryTracer();
    tracer.record({
      ts: '2026-08-26T00:00:00.000Z',
      seq: 1,
      method: 'GET',
      url: 'https://skole.dk/',
      requestHeaders: {},
      requestBody: null,
      status: 200,
      responseHeaders: {},
      responseBody: '',
      responseBodyBytes: 0,
      durationMs: 5,
    });
    expect(tracer.entries).toHaveLength(1);
    tracer.clear();
    expect(tracer.entries).toHaveLength(0);
  });
});
