/**
 * `fskintra discover` and `fskintra fetch <section>` — the section data, from
 * a terminal.
 *
 * Useful on its own, but the real reason it exists is that it exercises the
 * same client the MCP tools use. When an agent reports something odd, this is
 * how you check whether the problem is the parser or the agent.
 */

import {
  type Child,
  FskintraClient,
  getContacts,
  getConversation,
  getDocuments,
  getFrontpage,
  getHomework,
  getPhotoAlbums,
  getSignups,
  getWeekplans,
  listConversations,
  SECTION_IDS,
  type SectionId,
} from '@fskintra-mcp/fskintra-client';
import { buildDiscoverManifest, FskintraContext } from '@fskintra-mcp/mcp-server';
import { fail, printJson } from '../io.ts';
import { resolveStore } from '../store.ts';

export async function runDiscover(): Promise<number> {
  const context = new FskintraContext({ store: resolveStore() });
  try {
    printJson(await buildDiscoverManifest(context));
    return 0;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    context.dispose();
  }
}

function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value);
}

export async function runFetch(
  section: string | undefined,
  flags: { child?: string | undefined; limit?: string | undefined; comments?: boolean | undefined },
): Promise<number> {
  if (!section || !isSectionId(section)) {
    fail(`Usage: fskintra fetch <${SECTION_IDS.join('|')}> [--child NAME]`);
    return 2;
  }

  const client = new FskintraClient({ store: resolveStore() });
  try {
    const child = await client.resolveChild(flags.child);
    printJson(await fetchSection(client, child, section, flags));
    return 0;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function fetchSection(
  client: FskintraClient,
  child: Child,
  section: SectionId,
  flags: { limit?: string | undefined; comments?: boolean | undefined },
): Promise<unknown> {
  const limit = flags.limit ? Number.parseInt(flags.limit, 10) : undefined;

  switch (section) {
    case 'news':
      return getFrontpage(client, child, { includeComments: flags.comments === true });
    case 'messages':
      return listConversations(client, child);
    case 'weekplans':
      return getWeekplans(client, child, limit ?? 4);
    case 'homework':
      return getHomework(client, child);
    case 'documents':
      return getDocuments(client, child);
    case 'photos':
      return getPhotoAlbums(client, child);
    case 'contacts':
      return getContacts(client, child);
    case 'signups':
      return getSignups(client, child);
  }
}

export async function runThreadFetch(
  messageId: string | undefined,
  flags: { child?: string | undefined; thread?: string | undefined },
): Promise<number> {
  if (!messageId) {
    fail('Usage: fskintra thread <message-id> [--thread THREAD_ID] [--child NAME]');
    return 2;
  }

  const client = new FskintraClient({ store: resolveStore() });
  try {
    const child = await client.resolveChild(flags.child);
    printJson(await getConversation(client, child, flags.thread ?? '', messageId));
    return 0;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
