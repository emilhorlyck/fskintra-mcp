#!/usr/bin/env bun
/**
 * `fskintra` — CLI entry point. Tiny dispatcher; each subcommand lives in its
 * own file under ./commands/.
 */

import { runDoctor } from './commands/doctor.ts';
import { runDiscover, runFetch, runThreadFetch } from './commands/fetch.ts';
import { runLog } from './commands/log.ts';
import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runStatus } from './commands/status.ts';
import { runTranscriptList, runTranscriptPrune, runTranscriptView } from './commands/transcript.ts';
import { runWhoami } from './commands/whoami.ts';
import { fail, fmt } from './io.ts';
import { parseArgs } from './parse-args.ts';

const HELP = `${fmt.bold('fskintra')} — ForældreIntra from the command line

${fmt.bold('Usage')}:
  fskintra login [--hostname <host>] [--username <user>] [--debug]
                 [--transcript <file>] [--no-store-password] [--confirm-contacts]
  fskintra status [--json]
  fskintra whoami [--json]
  fskintra doctor [--json] [--debug] [--dump <dir>]
  fskintra discover
  fskintra fetch <news|messages|weekplans|homework|documents|photos|contacts|signups>
                 [--child <name>] [--limit N] [--comments]
  fskintra thread <message-id> [--thread <thread-id>] [--child <name>]
  fskintra log [--last N] [--json]
  fskintra transcript list [--json]
  fskintra transcript view <file> [--json]
  fskintra transcript prune [--keep N] [--dry-run]
  fskintra logout
  fskintra --help

${fmt.bold('Notes')}:
  • On macOS the session is stored in the system Keychain by default. Set
    FSKINTRA_MCP_NO_KEYCHAIN=1 to use the encrypted file at
    ~/.config/fskintra-mcp/session.json instead — that is what headless
    installs (a NAS, the Home Assistant addon) want.
  • Set FSKINTRA_MCP_KEY (hex or passphrase) for stronger key handling than
    the auto-generated .key file.
  • The stored session includes your password, because replaying the login
    form is the only way ForældreIntra offers to renew a session. Use
    --no-store-password to opt out; expired sessions then need you present.
  • --debug writes a sanitised wire transcript to JSONL — safe to share when
    reporting a parser bug.
  • ${fmt.bold('fskintra doctor')} walks every section for every child and reports which
    parsed, which the school does not have, and which are broken. Start there.
`;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.flags['help'] === true || args.command === 'help' || !args.command) {
    process.stdout.write(HELP);
    return args.command || args.flags['help'] ? 0 : 1;
  }

  const flag = (name: string): string | undefined => {
    const value = args.flags[name];
    return typeof value === 'string' ? value : undefined;
  };
  const bool = (name: string): boolean | undefined =>
    args.flags[name] === true ? true : undefined;

  switch (args.command) {
    case 'login':
      return runLogin({
        hostname: flag('hostname'),
        username: flag('username'),
        password: flag('password'),
        debug: bool('debug'),
        transcript: flag('transcript'),
        noStorePassword: bool('no-store-password'),
        confirmContacts: bool('confirm-contacts'),
      });

    case 'logout':
      return runLogout();

    case 'status':
      return runStatus({ json: bool('json') });

    case 'whoami':
      return runWhoami({ json: bool('json') });

    case 'doctor':
      return runDoctor({
        json: bool('json'),
        debug: bool('debug'),
        dump: flag('dump'),
      });

    case 'discover':
      return runDiscover();

    case 'fetch':
      return runFetch(args.positional[0], {
        child: flag('child'),
        limit: flag('limit'),
        comments: bool('comments'),
      });

    case 'thread':
      return runThreadFetch(args.positional[0], {
        child: flag('child'),
        thread: flag('thread'),
      });

    case 'log':
      return runLog({ json: bool('json'), last: args.flags['last'] });

    case 'transcript': {
      const sub = args.positional[0];
      if (sub === 'list') return runTranscriptList({ json: bool('json') });
      if (sub === 'view') return runTranscriptView(args.positional[1], { json: bool('json') });
      if (sub === 'prune') {
        return runTranscriptPrune({ keep: args.flags['keep'], 'dry-run': bool('dry-run') });
      }
      fail('Usage: fskintra transcript <list|view|prune>');
      return 2;
    }

    default:
      fail(`Unknown command: ${args.command}`);
      process.stdout.write(HELP);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
