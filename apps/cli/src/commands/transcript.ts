/**
 * `fskintra transcript` — list, view and prune wire transcripts.
 *
 * Transcripts are already sanitised when written (see the auth package's
 * wire-tracer). They still describe a family's school activity, so `prune`
 * exists to make cleaning them up a one-liner rather than a chore.
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { formatTraceText, type WireEntry } from '@fskintra-mcp/fskintra-auth';
import { fail, fmt, info, ok, printJson } from '../io.ts';
import { transcriptDir } from '../store.ts';

async function listFiles(): Promise<{ name: string; path: string; size: number; mtime: Date }[]> {
  const dir = transcriptDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
    const path = join(dir, name);
    const info = await stat(path);
    out.push({ name, path, size: info.size, mtime: info.mtime });
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export async function runTranscriptList(flags: { json?: boolean | undefined }): Promise<number> {
  const files = await listFiles();
  if (flags.json) {
    printJson({ dir: transcriptDir(), files });
    return 0;
  }
  if (files.length === 0) {
    info(`No transcripts in ${transcriptDir()}.`);
    return 0;
  }
  for (const file of files) {
    info(
      `${file.name}  ${fmt.dim(`${(file.size / 1024).toFixed(1)} kB, ${file.mtime.toLocaleString('da-DK')}`)}`,
    );
  }
  return 0;
}

export async function runTranscriptView(
  path: string | undefined,
  flags: { json?: boolean | undefined },
): Promise<number> {
  if (!path) {
    fail('Usage: fskintra transcript view <file>');
    return 2;
  }
  const resolved = path.includes('/') ? path : join(transcriptDir(), path);

  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch {
    fail(`Cannot read ${resolved}`);
    return 1;
  }

  const entries: WireEntry[] = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as WireEntry);
    } catch {
      // Skip malformed rows.
    }
  }

  if (flags.json) {
    printJson({ path: resolved, entries });
    return 0;
  }
  process.stdout.write(`${formatTraceText(entries)}\n`);
  return 0;
}

export async function runTranscriptPrune(flags: {
  keep?: string | boolean | undefined;
  'dry-run'?: boolean | undefined;
}): Promise<number> {
  const keep = typeof flags.keep === 'string' ? Number.parseInt(flags.keep, 10) || 5 : 5;
  const dryRun = flags['dry-run'] === true;
  const files = await listFiles();
  const doomed = files.slice(keep);

  if (doomed.length === 0) {
    info(`Nothing to prune (${files.length} transcript(s), keeping ${keep}).`);
    return 0;
  }

  for (const file of doomed) {
    if (dryRun) info(`would delete ${file.name}`);
    else await unlink(file.path);
  }

  ok(`${dryRun ? 'Would delete' : 'Deleted'} ${doomed.length} transcript(s), kept ${keep}.`);
  return 0;
}
