/** `fskintra whoami` — the account and its children, nothing more. */

import { FskintraClient } from '@fskintra-mcp/fskintra-client';
import { fail, info, printJson } from '../io.ts';
import { resolveStore } from '../store.ts';

export async function runWhoami(flags: { json?: boolean | undefined }): Promise<number> {
  const client = new FskintraClient({ store: resolveStore() });
  try {
    await client.authenticate();
    const children = await client.getChildren();

    if (flags.json) {
      printJson({ hostname: client.hostname, username: client.username, children });
      return 0;
    }

    info(`${client.username} @ ${client.hostname}`);
    for (const child of children) {
      info(`  ${child.name}  (id ${child.id})`);
    }
    return 0;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
