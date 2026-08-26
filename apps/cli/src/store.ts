/**
 * Store + tracer wiring shared by the CLI commands.
 *
 * The CLI and the MCP server deliberately use the same store, so logging in
 * here fixes a running server there.
 */

import { join } from 'node:path';
import {
  defaultConfigDir,
  defaultStore,
  EncryptedFileSessionStore,
  JsonlFileTracer,
  KeychainSessionStore,
  type SessionStore,
  type WireTracer,
} from '@fskintra-mcp/fskintra-auth';

export { defaultConfigDir };

export function resolveStore(): SessionStore {
  return defaultStore();
}

/** Human name of the backend in play — `status` and `doctor` both report it. */
export function storeBackendName(): string {
  const store = resolveStore();
  if (store instanceof KeychainSessionStore) return 'macOS Keychain';
  if (store instanceof EncryptedFileSessionStore) return `encrypted file (${store.filePath})`;
  return 'custom';
}

export function transcriptDir(): string {
  return join(defaultConfigDir(), 'transcripts');
}

/**
 * A tracer writing to a timestamped JSONL file, for `--debug`. Returns the
 * path too, so the command can tell the user where to find it — a transcript
 * nobody can locate is not a debugging aid.
 */
export function createDebugTracer(explicitPath?: string): { tracer: WireTracer; path: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = explicitPath ?? join(transcriptDir(), `login-${stamp}.jsonl`);
  return { tracer: new JsonlFileTracer(path), path };
}
