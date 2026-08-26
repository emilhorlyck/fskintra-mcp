/** `fskintra status` — what is stored, and is it still live? */

import { credentialsFromEnv, FskintraClient } from '@fskintra-mcp/fskintra-client';
import { fail, fmt, info, ok, printJson, warn } from '../io.ts';
import { resolveStore, storeBackendName } from '../store.ts';

export async function runStatus(flags: { json?: boolean | undefined }): Promise<number> {
  const store = resolveStore();
  const record = await store.load().catch(() => undefined);
  const env = credentialsFromEnv();

  if (!record && !env) {
    if (flags.json) {
      printJson({ logged_in: false, backend: storeBackendName() });
      return 1;
    }
    fail('No stored session and no credentials in the environment.');
    info('Run `fskintra login`.');
    return 1;
  }

  const client = new FskintraClient({ store });
  let live = false;
  let children: string[] = [];
  let error: string | undefined;

  try {
    await client.authenticate();
    children = (await client.getChildren()).map((c) => c.name);
    live = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (flags.json) {
    printJson({
      logged_in: live,
      backend: storeBackendName(),
      hostname: record?.hostname ?? env?.hostname,
      username: record?.username ?? env?.username,
      password_stored: Boolean(record?.password),
      credentials_from_env: Boolean(env),
      saved_at: record?.saved_at,
      verified_at: record?.verified_at,
      children,
      ...(error ? { error } : {}),
    });
    return live ? 0 : 1;
  }

  info(`Backend:  ${storeBackendName()}`);
  info(`School:   ${record?.hostname ?? env?.hostname ?? '(unknown)'}`);
  info(`Username: ${record?.username ?? env?.username ?? '(unknown)'}`);
  if (record?.saved_at) {
    info(`Saved:    ${new Date(record.saved_at * 1000).toLocaleString('da-DK')}`);
  }

  if (!record?.password && !env) {
    warn('No password stored — an expired session will need an interactive `fskintra login`.');
  }

  if (live) {
    ok(`Session is live. Children: ${children.join(', ') || '(none found)'}`);
    return 0;
  }

  fail(`Session is not usable: ${error}`);
  info(`Try ${fmt.bold('fskintra login')}.`);
  return 1;
}
