/**
 * Shared MCP server construction. Both transports (HTTP in `server.ts`, stdio
 * in `server-stdio.ts`) wire the same tool surface, instructions and context,
 * so there is one place to edit when capabilities change.
 */

import type { Logger } from '@fskintra-mcp/fskintra-auth';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FskintraContext } from './context.ts';
import { registerTools } from './tools.ts';

const INSTRUCTIONS = [
  'This server exposes ForældreIntra (SkoleIntra), a Danish school platform, to AI agents.',
  '',
  'Workflow:',
  '1. Call `foraldreintra.discover` ONCE per session and reuse the manifest. It returns the',
  '   children on the account, which sections this school actually has, and which message UI',
  '   it runs.',
  '2. Resolve any child names in the user prompt against `manifest.children[].name`',
  '   (case-insensitive, partial — `and` matches `Andrea 3A`). Pass that as `child`.',
  '3. Before calling a section tool, check `manifest.capabilities[section].availableFor`. If it',
  '   is empty, the school does not have that module — say so. Never report an unavailable',
  '   module as "nothing found": those mean different things to a parent.',
  '4. For messages, `manifest.messageUi` says which UI the school runs. On `conversations`',
  '   pass both thread_id and message_id to `foraldreintra.messages.get`; on `inbox`, thread_id',
  '   is ignored.',
  '5. Dates come back both parsed (`date`, ISO-8601) and raw (`dateText`, Danish). Prefer the',
  '   parsed one for arithmetic and the raw one when quoting the school.',
  '',
  "6. Reply in the user's language (Danish if they wrote Danish).",
  '',
  'Sessions refresh server-side. Only call `foraldreintra.reauthenticate` when a tool has',
  'actually returned `not_logged_in` or `session_expired`.',
].join('\n');

export interface McpAppOptions {
  logger: Logger;
}

export interface McpApp {
  mcp: McpServer;
  context: FskintraContext;
}

export function createMcpApp({ logger }: McpAppOptions): McpApp {
  const context = new FskintraContext({ logger });
  const mcp = new McpServer(
    { name: 'fskintra-mcp', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerTools(mcp, context);
  return { mcp, context };
}
