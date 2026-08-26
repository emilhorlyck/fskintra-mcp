/**
 * The lazy FskintraClient the MCP tools share.
 *
 * The server is deliberately stateless across restarts: it reads the same
 * session store the CLI writes to, so `fskintra login` from a terminal "just
 * works" against an already-running server. When the store is file-backed we
 * also watch the file, so an out-of-band login invalidates the cached client
 * immediately rather than at the next failure.
 */

import { type FSWatcher, watch } from 'node:fs';
import {
  defaultStore,
  type Logger,
  type SessionStore,
  silentLogger,
} from '@fskintra-mcp/fskintra-auth';
import { FskintraClient } from '@fskintra-mcp/fskintra-client';

export interface FskintraContextOptions {
  store?: SessionStore;
  logger?: Logger;
}

export class FskintraContext {
  private readonly store: SessionStore;
  private readonly logger: Logger;
  // Declared `T | undefined` rather than `T?` so we can assign `undefined` to
  // invalidate — `exactOptionalPropertyTypes` forbids that on an optional.
  private clientPromise: Promise<FskintraClient> | undefined;
  private watcher: FSWatcher | undefined;
  private watchDebounce: ReturnType<typeof setTimeout> | undefined;

  constructor(options: FskintraContextOptions = {}) {
    this.store = options.store ?? defaultStore();
    this.logger = options.logger ?? silentLogger;
    this.watchSessionFile();
  }

  /**
   * Watch a file-backed store and invalidate on change.
   *
   * Duck-typed on `filePath` rather than `instanceof EncryptedFileSessionStore`
   * for the reason aula-mcp documents: a bundler can produce two copies of the
   * same class across a bundled graph, and `instanceof` then silently returns
   * false, leaving the watcher unattached and stale sessions lingering.
   *
   * Best-effort — the retry-on-expiry path in the client is the real backstop.
   */
  private watchSessionFile(): void {
    const filePath = (this.store as { filePath?: unknown }).filePath;
    if (typeof filePath !== 'string' || filePath.length === 0) return;

    try {
      this.watcher = watch(filePath, { persistent: false }, (eventType) => {
        // fs.watch fires several times per write (write + close + chmod).
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => {
          this.watchDebounce = undefined;
          this.logger.info('context.session_file_changed_invalidating', { filePath, eventType });
          this.invalidate();
        }, 250);
      });
      this.watcher.on('error', (err) => {
        this.logger.warn('context.session_file_watch_error', {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      this.logger.warn('context.session_file_watch_setup_failed', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Close the watcher. Tests should call this; servers can leave it to exit. */
  dispose(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
  }

  /**
   * Get the client, authenticating on first use. Concurrency-safe: the
   * in-flight promise is shared, so a login fires once and everyone waits.
   */
  async getClient(): Promise<FskintraClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.buildClient().catch((err: unknown) => {
        // Clear on failure so the next call retries instead of re-throwing the
        // same stale rejection forever.
        this.clientPromise = undefined;
        throw err;
      });
    }
    return this.clientPromise;
  }

  private async buildClient(): Promise<FskintraClient> {
    const client = new FskintraClient({
      store: this.store,
      logger: this.logger,
      autoConfirmContacts: process.env.FSKINTRA_MCP_AUTO_CONFIRM_CONTACTS === '1',
    });
    await client.authenticate();
    return client;
  }

  /** Drop cached state. Called on an out-of-band login, and by the CLI tools. */
  invalidate(): void {
    this.clientPromise = undefined;
  }

  /** Force a fresh login, discarding the resumed session. */
  async reauthenticate(): Promise<FskintraClient> {
    this.invalidate();
    const client = await this.getClient();
    await client.authenticate(true);
    return client;
  }
}
