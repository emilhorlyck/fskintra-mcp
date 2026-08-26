/**
 * `fskintra doctor` — walk every section for every child and report what
 * works.
 *
 * This is the command that matters most in this project. ForældreIntra's
 * markup is not a contract, schools enable different modules, and the only way
 * to know which of those two is biting you is to try everything and say which
 * failed and how. `--debug` captures a sanitised transcript alongside, so the
 * output of a bad run is directly fileable.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { silentLogger, stderrLogger } from '@fskintra-mcp/fskintra-auth';
import {
  type Child,
  detectMessageUi,
  FskintraClient,
  getContacts,
  getDocuments,
  getFrontpage,
  getHomework,
  getPhotoAlbums,
  getSignups,
  getWeekplans,
  listConversations,
  probeSections,
  type SectionId,
  SectionUnavailableError,
} from '@fskintra-mcp/fskintra-client';
import { fail, fmt, info, ok, printJson, rule, warn } from '../io.ts';
import { createDebugTracer, resolveStore, storeBackendName } from '../store.ts';

interface SectionResult {
  child: string;
  section: SectionId;
  status: 'ok' | 'unavailable' | 'failed';
  summary: string;
  durationMs: number;
}

type Fetcher = (client: FskintraClient, child: Child) => Promise<unknown>;

const FETCHERS: Readonly<Record<SectionId, Fetcher>> = Object.freeze({
  news: (c, ch) => getFrontpage(c, ch),
  messages: (c, ch) => listConversations(c, ch),
  weekplans: (c, ch) => getWeekplans(c, ch, 2),
  homework: (c, ch) => getHomework(c, ch),
  documents: (c, ch) => getDocuments(c, ch),
  photos: (c, ch) => getPhotoAlbums(c, ch),
  contacts: (c, ch) => getContacts(c, ch),
  signups: (c, ch) => getSignups(c, ch),
});

/** One-line shape summary — enough to tell "empty" from "parsed nothing". */
function summarize(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : String(v).slice(0, 30)}`)
      .join(' ');
  }
  return String(value);
}

export interface DoctorFlags {
  json?: boolean | undefined;
  debug?: boolean | undefined;
  /** Save each section's parsed output here, for selector debugging. */
  dump?: string | undefined;
}

export async function runDoctor(flags: DoctorFlags): Promise<number> {
  const logger = flags.debug ? stderrLogger('fskintra-doctor') : silentLogger;
  const debug = flags.debug ? createDebugTracer() : undefined;
  if (debug) info(`Wire transcript: ${debug.path}`);

  const client = new FskintraClient({
    store: resolveStore(),
    logger,
    ...(debug ? { tracer: debug.tracer } : {}),
  });

  info(`Store backend: ${storeBackendName()}`);

  let children: Child[];
  try {
    await client.authenticate();
    children = await client.getChildren();
  } catch (error) {
    fail(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!debug) info('Re-run with --debug for a wire transcript.');
    return 1;
  }

  ok(`Logged in to ${client.hostname} as ${client.username}`);
  const messageUi = await detectMessageUi(client);
  info(`Message UI: ${messageUi}`);
  info(`Children: ${children.map((c) => c.name).join(', ')}`);

  const results: SectionResult[] = [];

  for (const child of children) {
    if (!flags.json) rule(child.name);

    const availability = await probeSections(client, child);

    for (const status of availability) {
      const startedAt = Date.now();

      if (!status.available) {
        results.push({
          child: child.name,
          section: status.id,
          status: 'unavailable',
          summary: status.note ?? 'not available',
          durationMs: Date.now() - startedAt,
        });
        if (!flags.json) {
          warn(`${status.id.padEnd(11)} unavailable — ${status.note ?? ''}`);
        }
        continue;
      }

      try {
        const data = await FETCHERS[status.id](client, child);
        const durationMs = Date.now() - startedAt;
        results.push({
          child: child.name,
          section: status.id,
          status: 'ok',
          summary: summarize(data),
          durationMs,
        });
        if (!flags.json) {
          ok(`${status.id.padEnd(11)} ${summarize(data)} ${fmt.dim(`(${durationMs}ms)`)}`);
        }
        if (flags.dump) {
          await mkdir(flags.dump, { recursive: true });
          await writeFile(
            join(flags.dump, `${child.id}-${status.id}.json`),
            JSON.stringify(data, null, 2),
          );
        }
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        const kind = error instanceof SectionUnavailableError ? 'unavailable' : 'failed';
        results.push({
          child: child.name,
          section: status.id,
          status: kind,
          summary: message,
          durationMs,
        });
        if (!flags.json) {
          if (kind === 'unavailable') warn(`${status.id.padEnd(11)} ${message}`);
          else fail(`${status.id.padEnd(11)} ${message}`);
        }
      }
    }
  }

  const failed = results.filter((r) => r.status === 'failed');

  if (flags.json) {
    printJson({
      hostname: client.hostname,
      username: client.username,
      messageUi,
      children: children.map((c) => ({ id: c.id, name: c.name })),
      results,
      ...(debug ? { transcript: debug.path } : {}),
    });
    return failed.length ? 1 : 0;
  }

  rule('summary');
  const okCount = results.filter((r) => r.status === 'ok').length;
  const unavailable = results.filter((r) => r.status === 'unavailable').length;
  info(`${okCount} ok, ${unavailable} unavailable, ${failed.length} failed`);

  if (failed.length) {
    warn('Failures are parser bugs, not missing modules. Please file them upstream with:');
    if (debug) info(`  ${debug.path}`);
    else info('  a re-run of `fskintra doctor --debug`');
    return 1;
  }

  ok('Every enabled section parsed.');
  return 0;
}
