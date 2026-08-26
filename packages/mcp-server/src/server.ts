#!/usr/bin/env bun
/**
 * Hono + MCP Streamable HTTP server. Runs on Bun.
 *
 * Routes:
 *   POST   /mcp       — MCP JSON-RPC (Streamable HTTP transport)
 *   GET    /mcp       — Streamable HTTP SSE channel
 *   DELETE /mcp       — session close
 *   GET    /sse       — legacy MCP SSE transport (Home Assistant's MCP client
 *                       integration speaks this dialect)
 *   POST   /messages  — client→server channel for a /sse session, selected by
 *                       the ?sessionId= query param
 *   GET    /healthz   — liveness probe
 *
 * For stdio (Claude Code, Claude Desktop, Cursor) see `server-stdio.ts` — same
 * tools, different transport.
 *
 * Env:
 *   FSKINTRA_MCP_PORT             — port for MCP traffic (default 7979)
 *   FSKINTRA_MCP_HOST             — interface to bind (default 127.0.0.1)
 *   FSKINTRA_MCP_DIR              — config dir (default ~/.config/fskintra-mcp)
 *   FSKINTRA_MCP_KEY              — encryption key for the session store
 *   FSKINTRA_MCP_RAW=1            — enable the raw_request escape hatch
 *   FSKINTRA_MCP_WRITE=1          — enable write tools; read-only without it
 *   FSKINTRA_MCP_LOG=1            — verbose logs
 *   FSKINTRA_MCP_ALLOW_REMOTE=1   — allow binding a non-loopback address.
 *                                   Refused by default: the server is
 *                                   single-user and anyone who can reach /mcp
 *                                   can read this family's school data.
 *   FSKINTRA_MCP_SSE_MAX_SESSIONS — concurrent /sse sessions before 503
 *                                   (default 16)
 *   FSKINTRA_MCP_SSE_IDLE_MS      — evict /sse sessions idle this long
 *                                   (default 300000)
 */

import { consoleLogger, silentLogger } from '@fskintra-mcp/fskintra-auth';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createMcpApp, type McpApp } from './setup.ts';
import { HonoSseTransport } from './sse-transport.ts';

const PORT = Number(process.env.FSKINTRA_MCP_PORT ?? 7979);
const HOST = process.env.FSKINTRA_MCP_HOST ?? '127.0.0.1';

const logger = process.env.FSKINTRA_MCP_LOG === '1' ? consoleLogger('fskintra-mcp') : silentLogger;

assertSafeBindAddress(HOST);

const { mcp } = createMcpApp({ logger });

// Stateful mode: the SDK forbids reusing a *stateless* transport across
// requests, so we supply a session-id generator and let it track per-session
// state. Single-user in practice means one session created on the first
// request and reused after.
const transport = new WebStandardStreamableHTTPServerTransport({
  enableJsonResponse: true,
  sessionIdGenerator: () => crypto.randomUUID(),
});

await mcp.connect(transport);

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true, name: 'fskintra-mcp' }));

const handleMcp = (request: Request): Promise<Response> => transport.handleRequest(request);
app.post('/mcp', (c) => handleMcp(c.req.raw));
app.get('/mcp', (c) => handleMcp(c.req.raw));
app.delete('/mcp', (c) => handleMcp(c.req.raw));

// Legacy SSE transport, for clients that haven't moved to Streamable HTTP —
// notably Home Assistant. Each GET /sse opens a fresh session with its own
// McpServer and context; POSTs to /messages?sessionId=… route back to it.
//
// The map is capped and idle-evicted. The server defaults to loopback, but the
// HA addon exposes it on the LAN, so an unbounded map is a footgun: a crashed
// or looping client could pile up sessions indefinitely.
interface SseSession {
  transport: HonoSseTransport;
  app: McpApp;
  lastActivityAt: number;
}

const SSE_MAX_SESSIONS = Math.max(1, Number(process.env.FSKINTRA_MCP_SSE_MAX_SESSIONS ?? 16));
const SSE_IDLE_MS = Math.max(1_000, Number(process.env.FSKINTRA_MCP_SSE_IDLE_MS ?? 300_000));
const SSE_SWEEP_INTERVAL_MS = Math.max(1_000, Math.floor(SSE_IDLE_MS / 4));
const sseSessions = new Map<string, SseSession>();

async function closeSseSession(sessionId: string, reason: string): Promise<void> {
  const session = sseSessions.get(sessionId);
  if (!session) return;
  sseSessions.delete(sessionId);
  try {
    await session.transport.close();
  } catch (err) {
    logger.error('fskintra-mcp.sse.transport_close_error', {
      sessionId,
      reason,
      error: (err as Error).message,
    });
  }
  session.app.context.dispose();
  try {
    await session.app.mcp.close();
  } catch (err) {
    logger.error('fskintra-mcp.sse.server_close_error', {
      sessionId,
      reason,
      error: (err as Error).message,
    });
  }
  logger.info('fskintra-mcp.sse.session_closed', { sessionId, reason });
}

setInterval(() => {
  const cutoff = Date.now() - SSE_IDLE_MS;
  for (const [sessionId, session] of sseSessions) {
    if (session.lastActivityAt < cutoff) void closeSseSession(sessionId, 'idle');
  }
}, SSE_SWEEP_INTERVAL_MS).unref?.();

app.get('/sse', (c) => {
  if (sseSessions.size >= SSE_MAX_SESSIONS) {
    logger.warn('fskintra-mcp.sse.session_limit_reached', { limit: SSE_MAX_SESSIONS });
    return c.json({ error: 'too many SSE sessions' }, 503);
  }

  const sessionId = crypto.randomUUID();

  return streamSSE(c, async (stream) => {
    const sessionApp = createMcpApp({ logger });
    const sessionTransport = new HonoSseTransport({
      sessionId,
      messageEndpoint: '/messages',
      stream,
      onActivity: () => {
        const session = sseSessions.get(sessionId);
        if (session) session.lastActivityAt = Date.now();
      },
    });

    sseSessions.set(sessionId, {
      transport: sessionTransport,
      app: sessionApp,
      lastActivityAt: Date.now(),
    });
    logger.info('fskintra-mcp.sse.session_opened', { sessionId, open: sseSessions.size });

    await sessionApp.mcp.connect(sessionTransport);

    // Hold the stream open until the client disconnects.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });

    await closeSseSession(sessionId, 'client disconnected');
  });
});

app.post('/messages', async (c) => {
  const sessionId = c.req.query('sessionId');
  if (!sessionId) return c.json({ error: 'sessionId query parameter required' }, 400);

  const session = sseSessions.get(sessionId);
  if (!session) return c.json({ error: 'unknown sessionId' }, 404);

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  session.transport.receive(payload);
  // The response goes out on the SSE stream, not here.
  return c.body(null, 202);
});

/**
 * Refuse to bind anything but loopback unless explicitly allowed. This server
 * holds a credential that reads a family's school data; a default that listens
 * on the LAN would be the wrong one.
 */
function assertSafeBindAddress(host: string): void {
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (loopback || process.env.FSKINTRA_MCP_ALLOW_REMOTE === '1') return;
  throw new Error(
    `Refusing to bind ${host}: anyone who can reach /mcp can read your ForældreIntra data. ` +
      `Set FSKINTRA_MCP_ALLOW_REMOTE=1 if that is what you intend.`,
  );
}

logger.info('fskintra-mcp.http_ready', { host: HOST, port: PORT });

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
};
