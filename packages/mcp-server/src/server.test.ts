import { afterEach, describe, expect, test } from 'bun:test';
import { silentLogger } from '@fskintra-mcp/fskintra-auth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpApp } from './setup.ts';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const { mcp, context } = createMcpApp({ logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      context.dispose();
      await client.close();
      await mcp.close();
    },
  };
}

describe('MCP tool surface', () => {
  test('registers the read-only tools and tells the agent to discover first', async () => {
    const { client, close } = await connectedClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'foraldreintra.contacts',
        'foraldreintra.discover',
        'foraldreintra.documents',
        'foraldreintra.download',
        'foraldreintra.homework',
        'foraldreintra.messages.get',
        'foraldreintra.messages.list',
        'foraldreintra.news',
        'foraldreintra.photos',
        'foraldreintra.reauthenticate',
        'foraldreintra.signups',
        'foraldreintra.weekplans',
      ]);
    } finally {
      await close();
    }
  });

  test('is read-only unless FSKINTRA_MCP_WRITE=1', async () => {
    const plain = await connectedClient();
    try {
      const names = (await plain.client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('foraldreintra.messages.mark_read');
    } finally {
      await plain.close();
    }

    process.env.FSKINTRA_MCP_WRITE = '1';
    const writable = await connectedClient();
    try {
      const names = (await writable.client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('foraldreintra.messages.mark_read');
    } finally {
      await writable.close();
    }
  });

  test('keeps the raw escape hatch behind FSKINTRA_MCP_RAW=1', async () => {
    process.env.FSKINTRA_MCP_RAW = '1';
    const { client, close } = await connectedClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('foraldreintra.raw_request');
    } finally {
      await close();
    }
  });

  test('marks the read tools readOnlyHint so hosts can auto-approve them', async () => {
    const { client, close } = await connectedClient();
    try {
      const tools = (await client.listTools()).tools;
      const news = tools.find((t) => t.name === 'foraldreintra.news');
      const download = tools.find((t) => t.name === 'foraldreintra.download');
      expect(news?.annotations?.readOnlyHint).toBe(true);
      expect(download?.annotations?.readOnlyHint).toBe(false);
    } finally {
      await close();
    }
  });

  test('returns a structured not_logged_in payload instead of an opaque failure', async () => {
    // Nothing is stored and no credentials are in the environment, so every
    // tool should say exactly that — and say what fixes it.
    process.env.FSKINTRA_MCP_DIR = '/nonexistent-fskintra-test-dir';
    process.env.FSKINTRA_MCP_NO_KEYCHAIN = '1';
    delete process.env.FSKINTRA_HOSTNAME;
    delete process.env.FSKINTRA_USERNAME;
    delete process.env.FSKINTRA_PASSWORD;

    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({ name: 'foraldreintra.news', arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0]?.text ?? '{}');
      expect(result.isError).toBe(true);
      expect(payload.error).toBe('not_logged_in');
      expect(payload.action).toContain('fskintra login');
    } finally {
      await close();
    }
  });
});
