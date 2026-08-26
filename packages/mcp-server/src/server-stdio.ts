#!/usr/bin/env bun
/**
 * MCP server, stdio transport. Same tool surface as `server.ts`; meant for
 * spawn-by-agent-runtime use (Claude Code, Claude Desktop, Cursor, Cline)
 * where stdio is the simpler local transport — no port, no daemon, no
 * loopback-binding decision.
 *
 * IMPORTANT: stdout is the JSON-RPC channel. This file must not write to it.
 * Logs go to stderr via `stderrLogger` when FSKINTRA_MCP_LOG=1.
 *
 * Env:
 *   FSKINTRA_MCP_DIR   — config dir (default ~/.config/fskintra-mcp)
 *   FSKINTRA_MCP_KEY   — encryption key for the session store
 *   FSKINTRA_MCP_RAW=1 — enable the raw_request escape hatch
 *   FSKINTRA_MCP_WRITE=1 — enable write tools (mark_read)
 *   FSKINTRA_MCP_LOG=1 — verbose logs to stderr
 */

import { silentLogger, stderrLogger } from '@fskintra-mcp/fskintra-auth';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpApp } from './setup.ts';

const logger = process.env.FSKINTRA_MCP_LOG === '1' ? stderrLogger('fskintra-mcp') : silentLogger;

const { mcp, context } = createMcpApp({ logger });

await mcp.connect(new StdioServerTransport());
logger.info('fskintra-mcp.stdio_ready');

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('fskintra-mcp.shutdown', { signal });
  context.dispose();
  try {
    await mcp.close();
  } catch (err) {
    logger.error('fskintra-mcp.shutdown_error', { error: (err as Error).message });
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
