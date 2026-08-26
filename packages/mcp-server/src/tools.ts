/**
 * MCP tool registrations. Each tool delegates to FskintraContext /
 * FskintraClient; inputs are validated by Zod schemas registered with
 * McpServer.
 *
 * Two conventions worth keeping:
 *   - Typed failures become structured JSON, not empty results. An agent can
 *     act on `{"error":"confirm_contacts_required", …}`; it cannot act on `[]`.
 *   - Write tools are registered only under FSKINTRA_MCP_WRITE=1. The server
 *     is read-only by default, because the only writes ForældreIntra offers
 *     are visible to the school.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  ConfirmContactsRequiredError,
  InvalidCredentialsError,
  NotLoggedInError,
  UniLoginNotSupportedError,
} from '@fskintra-mcp/fskintra-auth';
import {
  getContacts,
  getConversation,
  getDocuments,
  getFrontpage,
  getHomework,
  getPhotoAlbums,
  getSignups,
  getWeekplans,
  listConversations,
  markRead,
  SectionParseError,
  SectionUnavailableError,
  SessionExpiredError,
} from '@fskintra-mcp/fskintra-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FskintraContext } from './context.ts';
import { buildDiscoverManifest } from './discover.ts';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function jsonContent(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Turn a thrown error into a structured payload the agent can branch on.
 * The `error` field is a stable machine-readable code; `message` is for the
 * user; `action` says what would fix it.
 */
function errorContent(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof ConfirmContactsRequiredError) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'confirm_contacts_required',
              message,
              url: error.url,
              page_text: error.pageText,
              action:
                'Tell the user to confirm their contact details once in a browser at the URL ' +
                'above. Confirming is a change the school sees, so this server will not do it ' +
                'automatically unless FSKINTRA_MCP_AUTO_CONFIRM_CONTACTS=1 is set.',
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  if (error instanceof SectionUnavailableError) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'section_unavailable',
              section: error.section,
              message,
              action:
                'Tell the user this school does not use that module. Do NOT report it as ' +
                '"nothing found" — those mean different things.',
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const code =
    error instanceof NotLoggedInError
      ? 'not_logged_in'
      : error instanceof InvalidCredentialsError
        ? 'invalid_credentials'
        : error instanceof UniLoginNotSupportedError
          ? 'unilogin_not_supported'
          : error instanceof SessionExpiredError
            ? 'session_expired'
            : error instanceof SectionParseError
              ? 'parse_error'
              : 'error';

  const action =
    code === 'not_logged_in' || code === 'invalid_credentials'
      ? 'Tell the user to run `fskintra login`.'
      : code === 'parse_error'
        ? "ForældreIntra's markup changed. Ask the user to run `fskintra doctor --debug` and " +
          'file the transcript upstream.'
        : undefined;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: code, message, ...(action ? { action } : {}) }, null, 2),
      },
    ],
    isError: true,
  };
}

async function run(handler: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return jsonContent(await handler());
  } catch (error) {
    return errorContent(error);
  }
}

const childArg = {
  child: z
    .string()
    .optional()
    .describe(
      'Child name or id from foraldreintra.discover. Optional when the account has one child.',
    ),
};

export function registerTools(mcp: McpServer, context: FskintraContext): void {
  const withChild = async (name: string | undefined) => {
    const client = await context.getClient();
    return { client, child: await client.resolveChild(name) };
  };

  mcp.registerTool(
    'foraldreintra.discover',
    {
      title: 'Discover children and capabilities',
      description:
        'Call this ONCE per session before any other tool. Returns the children on this ' +
        'account, which sections the school actually has, which message UI it runs, and ' +
        'which tools are worth calling for each child.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => buildDiscoverManifest(context)),
  );

  mcp.registerTool(
    'foraldreintra.news',
    {
      title: 'Front page news',
      description:
        'News items from the front page ("opslagstavle") for a child: author, recipients, ' +
        'date, body text and attachment links.',
      inputSchema: {
        ...childArg,
        include_comments: z
          .boolean()
          .optional()
          .describe('Also fetch comments (one extra request per commented item).'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ child, include_comments }) =>
      run(async () => {
        const ctx = await withChild(child);
        return getFrontpage(ctx.client, ctx.child, {
          ...(include_comments === undefined ? {} : { includeComments: include_comments }),
        });
      }),
  );

  mcp.registerTool(
    'foraldreintra.messages.list',
    {
      title: 'List message conversations',
      description:
        'Conversation list for a child. Returns thread ids and the latest message id, which ' +
        'foraldreintra.messages.get needs.',
      inputSchema: { ...childArg },
      annotations: { readOnlyHint: true },
    },
    ({ child }) =>
      run(async () => {
        const ctx = await withChild(child);
        return { conversations: await listConversations(ctx.client, ctx.child) };
      }),
  );

  mcp.registerTool(
    'foraldreintra.messages.get',
    {
      title: 'Read a conversation',
      description: 'Every message in one conversation, oldest first.',
      inputSchema: {
        ...childArg,
        thread_id: z
          .string()
          .describe(
            'Thread id from messages.list. Empty string for standalone messages, and ignored ' +
              'entirely when discover reports messageUi "inbox".',
          ),
        message_id: z.string().describe('Latest message id from messages.list.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ child, thread_id, message_id }) =>
      run(async () => {
        const ctx = await withChild(child);
        return { messages: await getConversation(ctx.client, ctx.child, thread_id, message_id) };
      }),
  );

  mcp.registerTool(
    'foraldreintra.weekplans',
    {
      title: 'Weekly plans',
      description: 'Weekly plans ("ugeplaner") for a child, broken down per day.',
      inputSchema: {
        ...childArg,
        limit: z.number().int().min(1).max(20).optional().describe('How many weeks. Default 4.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ child, limit }) =>
      run(async () => {
        const ctx = await withChild(child);
        return { weekplans: await getWeekplans(ctx.client, ctx.child, limit ?? 4) };
      }),
  );

  mcp.registerTool(
    'foraldreintra.homework',
    {
      title: 'Homework',
      description: 'Homework ("lektier") for a child, grouped by due date.',
      inputSchema: { ...childArg },
      annotations: { readOnlyHint: true },
    },
    ({ child }) =>
      run(async () => {
        const ctx = await withChild(child);
        return { homework: await getHomework(ctx.client, ctx.child) };
      }),
  );

  mcp.registerTool(
    'foraldreintra.documents',
    {
      title: 'Class documents',
      description:
        'Documents shared with the class, including sub-folders. Fetch one with ' +
        'foraldreintra.download.',
      inputSchema: { ...childArg },
      annotations: { readOnlyHint: true },
    },
    ({ child }) =>
      run(async () => {
        const ctx = await withChild(child);
        return { documents: await getDocuments(ctx.client, ctx.child) };
      }),
  );

  mcp.registerTool(
    'foraldreintra.photos',
    {
      title: 'Photo albums',
      description: 'Photo albums for a child, with the image URLs in each album.',
      inputSchema: { ...childArg },
      annotations: { readOnlyHint: true },
    },
    ({ child }) =>
      run(async () => {
        const ctx = await withChild(child);
        return { albums: await getPhotoAlbums(ctx.client, ctx.child) };
      }),
  );

  mcp.registerTool(
    'foraldreintra.contacts',
    {
      title: 'Class contacts',
      description: "Contact cards for the pupils in the child's class.",
      inputSchema: { ...childArg },
      annotations: { readOnlyHint: true },
    },
    ({ child }) =>
      run(async () => {
        const ctx = await withChild(child);
        return { contacts: await getContacts(ctx.client, ctx.child) };
      }),
  );

  mcp.registerTool(
    'foraldreintra.signups',
    {
      title: 'Sign-ups',
      description:
        'Open sign-ups for parent-teacher conversations and school events. Closed ones are ' +
        'omitted, since there is nothing to act on.',
      inputSchema: { ...childArg },
      annotations: { readOnlyHint: true },
    },
    ({ child }) =>
      run(async () => {
        const ctx = await withChild(child);
        return { signups: await getSignups(ctx.client, ctx.child) };
      }),
  );

  mcp.registerTool(
    'foraldreintra.download',
    {
      title: 'Download an attachment',
      description:
        'Download an attachment, document or photo to a local file using the logged-in ' +
        'session. Pass a URL returned by another tool.',
      inputSchema: {
        url: z.string().describe('ForældreIntra URL of the file.'),
        dest_path: z.string().describe('Local file path to write to.'),
      },
      annotations: { readOnlyHint: false },
    },
    ({ url, dest_path }) =>
      run(async () => {
        const client = await context.getClient();
        const file = await client.download(url);
        const path = resolve(dest_path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.data);
        return { path, bytes: file.data.length, content_type: file.contentType };
      }),
  );

  mcp.registerTool(
    'foraldreintra.reauthenticate',
    {
      title: 'Log in again',
      description:
        'Discard the cached session and log in from scratch. Use only when other tools fail ' +
        'with not_logged_in or session_expired — routine refresh is handled server-side.',
      inputSchema: {},
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    () =>
      run(async () => {
        const client = await context.reauthenticate();
        return { ok: true, children: (await client.getChildren(true)).map((c) => c.name) };
      }),
  );

  if (process.env.FSKINTRA_MCP_WRITE === '1') {
    mcp.registerTool(
      'foraldreintra.messages.mark_read',
      {
        title: 'Mark a message read',
        description:
          'Mark a message as read or unread. This changes state the school can see. Only ' +
          'registered when FSKINTRA_MCP_WRITE=1.',
        inputSchema: {
          ...childArg,
          message_id: z.string().describe('Message id to mark.'),
          is_read: z.boolean().optional().describe('Defaults to true.'),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      ({ child, message_id, is_read }) =>
        run(async () => {
          const ctx = await withChild(child);
          await markRead(ctx.client, ctx.child, message_id, is_read ?? true);
          return { ok: true, message_id, is_read: is_read ?? true };
        }),
    );
  }

  /**
   * Escape hatch for debugging markup drift: fetch an arbitrary page with the
   * session's cookies and get the raw HTML back. Off by default — it can read
   * anything the parent can, and an agent should not have that reach unless
   * the user opted in.
   */
  if (process.env.FSKINTRA_MCP_RAW === '1') {
    mcp.registerTool(
      'foraldreintra.raw_request',
      {
        title: 'Raw page fetch',
        description:
          'Fetch a ForældreIntra URL with the logged-in session and return the raw HTML. ' +
          'Debugging aid; only registered when FSKINTRA_MCP_RAW=1.',
        inputSchema: {
          url: z.string().describe('Absolute or site-relative URL.'),
          max_chars: z.number().int().min(500).max(200_000).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      ({ url, max_chars }) =>
        run(async () => {
          const client = await context.getClient();
          const body = await client.fetchRaw(url);
          const limit = max_chars ?? 20_000;
          return {
            url: client.absUrl(url),
            bytes: body.length,
            truncated: body.length > limit,
            body: body.slice(0, limit),
          };
        }),
    );
  }
}
