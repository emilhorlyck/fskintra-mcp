import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredSessionRecord } from './session-store.ts';
import {
  canReauthenticate,
  EncryptedFileSessionStore,
  MemorySessionStore,
} from './session-store.ts';

const RECORD: StoredSessionRecord = {
  version: 1,
  hostname: 'skole.skoleintra.dk',
  username: 'emil',
  password: 'hemmelig',
  cookies: '{"cookies":[]}',
  indexUrl: 'https://skole.skoleintra.dk/parent/1/Andrea/Index',
  saved_at: 1_750_000_000,
};

describe('MemorySessionStore', () => {
  test('round-trips and clears', async () => {
    const store = new MemorySessionStore();
    expect(await store.load()).toBeUndefined();
    await store.save(RECORD);
    expect(await store.load()).toEqual(RECORD);
    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
});

describe('EncryptedFileSessionStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fskintra-store-'));
    filePath = join(dir, 'session.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.FSKINTRA_MCP_KEY;
  });

  test('round-trips a record through an explicit key', async () => {
    const key = Buffer.alloc(32, 7);
    const store = new EncryptedFileSessionStore({ filePath, key });
    await store.save(RECORD);
    expect(await new EncryptedFileSessionStore({ filePath, key }).load()).toEqual(RECORD);
  });

  test('leaves nothing readable on disk', async () => {
    const store = new EncryptedFileSessionStore({ filePath, key: Buffer.alloc(32, 7) });
    await store.save(RECORD);
    const raw = await readFile(filePath, 'utf8');
    // The password is the reason this store is encrypted at all.
    expect(raw).not.toContain('hemmelig');
    expect(raw).not.toContain('emil');
    expect(JSON.parse(raw).v).toBe(1);
  });

  test('writes the file 0600', async () => {
    const store = new EncryptedFileSessionStore({ filePath, key: Buffer.alloc(32, 7) });
    await store.save(RECORD);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  test('accepts a passphrase in FSKINTRA_MCP_KEY', async () => {
    process.env.FSKINTRA_MCP_KEY = 'en lang kodesætning';
    await new EncryptedFileSessionStore({ filePath }).save(RECORD);
    expect(await new EncryptedFileSessionStore({ filePath }).load()).toEqual(RECORD);
  });

  test('fails with an actionable message when the key changed', async () => {
    await new EncryptedFileSessionStore({ filePath, key: Buffer.alloc(32, 1) }).save(RECORD);
    const wrong = new EncryptedFileSessionStore({ filePath, key: Buffer.alloc(32, 2) });
    expect(wrong.load()).rejects.toThrow(/Could not decrypt/);
  });

  test('returns undefined when there is no file yet', async () => {
    expect(await new EncryptedFileSessionStore({ filePath }).load()).toBeUndefined();
  });

  test('generates a 0600 key file when no key is configured', async () => {
    await new EncryptedFileSessionStore({ filePath }).save(RECORD);
    expect((await stat(join(dir, '.key'))).mode & 0o777).toBe(0o600);
  });
});

describe('canReauthenticate', () => {
  test('needs hostname, username and password', () => {
    expect(canReauthenticate(RECORD)).toBe(true);
    const { password: _omitted, ...withoutPassword } = RECORD;
    expect(canReauthenticate(withoutPassword)).toBe(false);
    expect(canReauthenticate(undefined)).toBe(false);
  });
});
