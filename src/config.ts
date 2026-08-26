import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** Bare hostname of the school's ForældreIntra, e.g. "minskole.skoleintra.dk" */
  hostname: string;
  username: string;
  password: string;
  /** Where cookies and the cached front-page URL are persisted between runs */
  stateDir: string;
  /** Verbose logging to stderr (stdout is reserved for the MCP stdio transport) */
  debug: boolean;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Set FSKINTRA_HOSTNAME, FSKINTRA_USERNAME and FSKINTRA_PASSWORD ` +
        `in the MCP server's environment.`
    );
  }
  return value;
}

let cached: Config | undefined;

export function getConfig(): Config {
  if (!cached) {
    cached = {
      // Accept a pasted URL as well as a bare hostname
      hostname: required('FSKINTRA_HOSTNAME')
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, ''),
      username: required('FSKINTRA_USERNAME'),
      password: required('FSKINTRA_PASSWORD'),
      stateDir: process.env.FSKINTRA_STATE_DIR?.trim() || join(homedir(), '.fskintra-mcp'),
      debug: process.env.FSKINTRA_DEBUG === '1',
    };
  }
  return cached;
}

/** stderr only — stdout carries the JSON-RPC stream. */
export function log(message: string): void {
  if (getConfig().debug) process.stderr.write(`[fskintra] ${message}\n`);
}
