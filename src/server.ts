#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { getChildren, resolveChild } from './children.js';
import { forgetLogin, login } from './login.js';
import { getContacts } from './pages/contacts.js';
import { getDocuments } from './pages/documents.js';
import { getHomework } from './pages/homework.js';
import { getConversation, listConversations, markRead } from './pages/messages.js';
import { getFrontpage } from './pages/news.js';
import { getPhotoAlbums } from './pages/photos.js';
import { getSignups } from './pages/signup.js';
import { getWeekplans } from './pages/weekplans.js';
import { getSession } from './session.js';

const server = new McpServer({ name: 'fskintra-mcp', version: '0.1.0' });

const childArg = {
  child: z
    .string()
    .optional()
    .describe('Child name or id. Optional when the account has only one child.'),
};

type Handler = () => Promise<unknown>;

/** Every tool returns JSON text; failures come back as readable tool errors. */
async function run(handler: Handler) {
  try {
    const result = await handler();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  }
}

server.registerTool(
  'foraldreintra_list_children',
  {
    title: 'List children',
    description:
      'List the children available on this ForældreIntra account. Call this first — every ' +
      'other tool takes a child name or id.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () => run(async () => ({ children: await getChildren() }))
);

server.registerTool(
  'foraldreintra_get_news',
  {
    title: 'Get front page news',
    description:
      'News items from the front page ("opslagstavle") for a child, with author, recipients, ' +
      'date, body text and attachment links.',
    inputSchema: {
      ...childArg,
      include_comments: z
        .boolean()
        .optional()
        .describe('Also fetch the comments on each item (one extra request per item).'),
    },
    annotations: { readOnlyHint: true },
  },
  ({ child, include_comments }) =>
    run(async () =>
      getFrontpage(await resolveChild(child), { includeComments: include_comments })
    )
);

server.registerTool(
  'foraldreintra_list_messages',
  {
    title: 'List messages',
    description:
      'List message conversations ("beskeder") for a child. Returns thread ids and the latest ' +
      'message id, which foraldreintra_get_message needs.',
    inputSchema: { ...childArg },
    annotations: { readOnlyHint: true },
  },
  ({ child }) =>
    run(async () => ({ conversations: await listConversations(await resolveChild(child)) }))
);

server.registerTool(
  'foraldreintra_get_message',
  {
    title: 'Read a conversation',
    description: 'Fetch every message in one conversation, oldest first.',
    inputSchema: {
      ...childArg,
      thread_id: z
        .string()
        .describe('Thread id from foraldreintra_list_messages. Empty string for standalone messages.'),
      message_id: z.string().describe('Latest message id from foraldreintra_list_messages.'),
    },
    annotations: { readOnlyHint: true },
  },
  ({ child, thread_id, message_id }) =>
    run(async () => ({
      messages: await getConversation(await resolveChild(child), thread_id, message_id),
    }))
);

server.registerTool(
  'foraldreintra_mark_message_read',
  {
    title: 'Mark a message read',
    description:
      'Mark a message as read or unread in ForældreIntra. This changes state the school can see.',
    inputSchema: {
      ...childArg,
      message_id: z.string().describe('Message id to mark.'),
      is_read: z.boolean().optional().describe('Defaults to true.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  ({ child, message_id, is_read }) =>
    run(async () => {
      await markRead(await resolveChild(child), message_id, is_read ?? true);
      return { ok: true, message_id, is_read: is_read ?? true };
    })
);

server.registerTool(
  'foraldreintra_get_weekplans',
  {
    title: 'Get weekly plans',
    description: 'Weekly plans ("ugeplaner") for a child, broken down per day.',
    inputSchema: {
      ...childArg,
      limit: z.number().int().min(1).max(20).optional().describe('How many weeks. Default 4.'),
    },
    annotations: { readOnlyHint: true },
  },
  ({ child, limit }) =>
    run(async () => ({ weekplans: await getWeekplans(await resolveChild(child), limit ?? 4) }))
);

server.registerTool(
  'foraldreintra_get_homework',
  {
    title: 'Get homework',
    description: 'Homework ("lektier") for a child, grouped by due date.',
    inputSchema: { ...childArg },
    annotations: { readOnlyHint: true },
  },
  ({ child }) => run(async () => ({ homework: await getHomework(await resolveChild(child)) }))
);

server.registerTool(
  'foraldreintra_list_documents',
  {
    title: 'List documents',
    description:
      'Documents shared with the class ("Klassens dokumenter"), including sub-folders. ' +
      'Use foraldreintra_download to fetch one.',
    inputSchema: { ...childArg },
    annotations: { readOnlyHint: true },
  },
  ({ child }) => run(async () => ({ documents: await getDocuments(await resolveChild(child)) }))
);

server.registerTool(
  'foraldreintra_get_photos',
  {
    title: 'Get photo albums',
    description: 'Photo albums for a child, with the image URLs in each album.',
    inputSchema: { ...childArg },
    annotations: { readOnlyHint: true },
  },
  ({ child }) => run(async () => ({ albums: await getPhotoAlbums(await resolveChild(child)) }))
);

server.registerTool(
  'foraldreintra_get_contacts',
  {
    title: 'Get class contacts',
    description: 'Contact cards for the pupils in the child\'s class.',
    inputSchema: { ...childArg },
    annotations: { readOnlyHint: true },
  },
  ({ child }) => run(async () => ({ contacts: await getContacts(await resolveChild(child)) }))
);

server.registerTool(
  'foraldreintra_get_signups',
  {
    title: 'Get sign-ups',
    description:
      'Open sign-ups for parent-teacher conversations and school events ' +
      '("tilmelding til samtaler/arrangementer"). Closed ones are omitted.',
    inputSchema: { ...childArg },
    annotations: { readOnlyHint: true },
  },
  ({ child }) => run(async () => ({ signups: await getSignups(await resolveChild(child)) }))
);

server.registerTool(
  'foraldreintra_download',
  {
    title: 'Download an attachment',
    description:
      'Download an attachment or document from ForældreIntra to a local file, using the ' +
      'logged-in session. Pass a URL returned by one of the other tools.',
    inputSchema: {
      url: z.string().describe('Absolute ForældreIntra URL of the file.'),
      dest_path: z.string().describe('Local file path to write to.'),
    },
    annotations: { readOnlyHint: false },
  },
  ({ url, dest_path }) =>
    run(async () => {
      await login();
      const file = await getSession().requestBinary(url);
      const path = resolve(dest_path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.data);
      return { path, bytes: file.data.length, content_type: file.contentType };
    })
);

server.registerTool(
  'foraldreintra_reauthenticate',
  {
    title: 'Log in again',
    description:
      'Discard the cached session and log in from scratch. Use when other tools start ' +
      'failing with login errors.',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  () =>
    run(async () => {
      forgetLogin();
      await login(true);
      return { ok: true, children: (await getChildren(true)).map((c) => c.name) };
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
