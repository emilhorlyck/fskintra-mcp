/**
 * Append-only log of login attempts.
 *
 * `fskintra log` reads it. The point is answering "when did this last work?"
 * without a wire transcript — the common support question is whether the
 * session died an hour ago or a month ago.
 *
 * Nothing secret goes in: hostname, username, outcome, error class, timestamp.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultConfigDir } from '@fskintra-mcp/fskintra-auth';

export interface LoginLogEntry {
  ts: string;
  hostname: string;
  username: string;
  outcome: 'success' | 'failure';
  /** Error class name on failure, e.g. `InvalidCredentialsError`. */
  error?: string;
  /** Whether this was a resumed session rather than a full login. */
  resumed?: boolean;
  durationMs?: number;
}

export function loginLogPath(): string {
  return join(defaultConfigDir(), 'login-log.jsonl');
}

export async function appendLoginLog(entry: LoginLogEntry): Promise<void> {
  const path = loginLogPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Logging must never be the reason a login fails.
  }
}

export async function readLoginLog(limit = 20): Promise<LoginLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(loginLogPath(), 'utf8');
  } catch {
    return [];
  }
  const entries: LoginLogEntry[] = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as LoginLogEntry);
    } catch {
      // Skip malformed rows rather than failing the whole read.
    }
  }
  return entries.slice(-limit).reverse();
}
