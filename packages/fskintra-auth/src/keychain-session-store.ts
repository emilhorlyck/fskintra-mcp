/**
 * macOS Keychain-backed SessionStore.
 *
 * Uses the platform `security` CLI rather than a native binding, so there is
 * no compiled module to build per platform and per Node/Bun version. The
 * trade-off is a forked process per operation — fine for a store that is read
 * once per server start and written once per login.
 *
 * This matters more here than it does for OAuth tokens: the record contains
 * the user's ForældreIntra password (see session-store.ts), so keeping it in
 * the OS keychain rather than a file on disk is the better default where the
 * platform offers one.
 *
 * Service name `fskintra-mcp`, account `session`; both overridable for tests.
 * On non-macOS platforms `isSupported()` returns false and `defaultStore()`
 * picks the encrypted file backend instead.
 */

import { spawn } from 'node:child_process';
import type { SessionStore, StoredSessionRecord } from './session-store.ts';
import { EncryptedFileSessionStore, SessionStoreError } from './session-store.ts';

export interface KeychainSessionStoreOptions {
  service?: string;
  account?: string;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runSecurity(args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export class KeychainSessionStore implements SessionStore {
  private readonly service: string;
  private readonly account: string;

  constructor(opts: KeychainSessionStoreOptions = {}) {
    this.service = opts.service ?? 'fskintra-mcp';
    this.account = opts.account ?? 'session';
  }

  /** True on macOS. The `security` CLI is otherwise absent. */
  static isSupported(): boolean {
    return process.platform === 'darwin';
  }

  async load(): Promise<StoredSessionRecord | undefined> {
    const result = await runSecurity([
      'find-generic-password',
      '-s',
      this.service,
      '-a',
      this.account,
      '-w',
    ]);
    // Exit 44 = "The specified item could not be found in the keychain."
    if (result.exitCode === 44) return undefined;
    if (result.exitCode !== 0) {
      throw new SessionStoreError(`security find-generic-password failed: ${result.stderr.trim()}`);
    }

    try {
      return JSON.parse(result.stdout.trim()) as StoredSessionRecord;
    } catch (cause) {
      throw new SessionStoreError('Keychain item is not valid JSON.', { cause });
    }
  }

  async save(record: StoredSessionRecord): Promise<void> {
    // `-U` updates in place when the item already exists.
    const result = await runSecurity([
      'add-generic-password',
      '-U',
      '-s',
      this.service,
      '-a',
      this.account,
      '-D',
      'fskintra-mcp session',
      '-w',
      JSON.stringify(record),
    ]);
    if (result.exitCode !== 0) {
      throw new SessionStoreError(`security add-generic-password failed: ${result.stderr.trim()}`);
    }
  }

  async clear(): Promise<void> {
    const result = await runSecurity([
      'delete-generic-password',
      '-s',
      this.service,
      '-a',
      this.account,
    ]);
    if (result.exitCode !== 0 && result.exitCode !== 44) {
      throw new SessionStoreError(
        `security delete-generic-password failed: ${result.stderr.trim()}`,
      );
    }
  }
}

/**
 * The store the CLI and MCP server use unless told otherwise: Keychain on
 * macOS, encrypted file everywhere else. `FSKINTRA_MCP_NO_KEYCHAIN=1` forces
 * the file backend — needed when running headless (a NAS, the Home Assistant
 * addon) where no keychain daemon exists.
 */
export function defaultStore(): SessionStore {
  if (KeychainSessionStore.isSupported() && process.env.FSKINTRA_MCP_NO_KEYCHAIN !== '1') {
    return new KeychainSessionStore();
  }
  return new EncryptedFileSessionStore();
}
