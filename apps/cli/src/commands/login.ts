/**
 * `fskintra login` — authenticate and persist the session.
 *
 * Prompts for anything not given as a flag. The password prompt is echo-free
 * and the value is never printed, logged, or written to the wire transcript.
 */

import {
  ConfirmContactsRequiredError,
  FskintraHttpClient,
  FskintraLoginClient,
  InvalidCredentialsError,
  normalizeHostname,
  silentLogger,
  stderrLogger,
  UniLoginNotSupportedError,
} from '@fskintra-mcp/fskintra-auth';
import { parseChildren } from '@fskintra-mcp/fskintra-client';
import { fail, fmt, info, ok, prompt, promptSecret, warn } from '../io.ts';
import { appendLoginLog } from '../login-log.ts';
import { createDebugTracer, resolveStore, storeBackendName } from '../store.ts';

export interface LoginFlags {
  hostname?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  debug?: boolean | undefined;
  transcript?: string | undefined;
  /**
   * Don't persist the password. The session still works until the cookies
   * expire; after that, an interactive `fskintra login` is required, and a
   * headless MCP server cannot recover on its own.
   */
  noStorePassword?: boolean | undefined;
  /** Submit the "Bekræft kontaktoplysninger" form. See the auth package. */
  confirmContacts?: boolean | undefined;
}

/**
 * Ask for a value, offering the previously-stored one as the default. Empty
 * input keeps the default, which makes re-login after an expiry a two-keypress
 * operation.
 */
async function promptWithDefault(
  label: string,
  fallback: string | undefined,
  example?: string,
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]:` : example ? ` (e.g. ${example}):` : ':';
  const answer = await prompt(`${label}${suffix}`);
  return answer || fallback || '';
}

export async function runLogin(flags: LoginFlags): Promise<number> {
  const store = resolveStore();
  const existing = await store.load().catch(() => undefined);

  const hostname = normalizeHostname(
    flags.hostname ??
      (await promptWithDefault(
        'ForældreIntra hostname',
        existing?.hostname,
        'minskole.skoleintra.dk',
      )),
  );
  if (!hostname) {
    fail('A hostname is required.');
    return 2;
  }

  const username = flags.username ?? (await promptWithDefault('Username', existing?.username));
  if (!username) {
    fail('A username is required.');
    return 2;
  }

  const password = flags.password ?? (await promptSecret('Password:'));
  if (!password) {
    fail('A password is required.');
    return 2;
  }

  const logger = flags.debug ? stderrLogger('fskintra-login') : silentLogger;
  const debug = flags.debug || flags.transcript ? createDebugTracer(flags.transcript) : undefined;
  if (debug) info(`Wire transcript: ${debug.path}`);

  const http = new FskintraHttpClient({
    logger,
    ...(debug ? { tracer: debug.tracer } : {}),
  });
  const client = new FskintraLoginClient({
    http,
    logger,
    autoConfirmContacts: flags.confirmContacts === true,
  });

  const startedAt = Date.now();
  info(`Logging in to ${hostname} as ${username}…`);

  try {
    const result = await client.login({ hostname, username, password });
    const durationMs = Date.now() - startedAt;

    await store.save({
      version: 1,
      hostname,
      username,
      ...(flags.noStorePassword ? {} : { password }),
      cookies: result.cookies,
      indexUrl: result.indexUrl,
      saved_at: Math.floor(Date.now() / 1000),
      verified_at: Math.floor(Date.now() / 1000),
    });

    await appendLoginLog({
      ts: new Date().toISOString(),
      hostname,
      username,
      outcome: 'success',
      durationMs,
    });

    const children = parseChildren(result.doc, (url) =>
      /^https?:\/\//i.test(url) ? url : `https://${hostname}${url}`,
    );

    ok(`Logged in. Session stored in ${storeBackendName()}.`);
    if (children.length) {
      info(`Children: ${children.map((c) => c.name).join(', ')}`);
    } else {
      warn('No children found on the front page — run `fskintra doctor` to look into it.');
    }
    if (flags.noStorePassword) {
      warn(
        'Password not stored. When the session expires you will have to run `fskintra login` ' +
          'again; a headless MCP server cannot renew it on its own.',
      );
    }
    return 0;
  } catch (error) {
    await appendLoginLog({
      ts: new Date().toISOString(),
      hostname,
      username,
      outcome: 'failure',
      error: error instanceof Error ? error.name : 'Error',
      durationMs: Date.now() - startedAt,
    });

    if (error instanceof InvalidCredentialsError) {
      fail(error.message);
      return 1;
    }
    if (error instanceof UniLoginNotSupportedError) {
      fail(error.message);
      info('Only ordinary ForældreIntra login ("alm login") is implemented.');
      return 1;
    }
    if (error instanceof ConfirmContactsRequiredError) {
      fail('ForældreIntra wants you to confirm your contact details before continuing.');
      info(`Open ${error.url} in a browser and confirm, then run login again.`);
      info(`Or re-run with ${fmt.bold('--confirm-contacts')} to submit it from here.`);
      process.stdout.write(`\n${error.pageText.slice(0, 1000)}\n`);
      return 1;
    }

    fail(error instanceof Error ? error.message : String(error));
    if (!debug) info('Re-run with --debug to capture a sanitised wire transcript.');
    return 1;
  }
}
