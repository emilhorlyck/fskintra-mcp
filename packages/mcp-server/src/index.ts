/** Public surface of `@fskintra-mcp/mcp-server`. */

export type { FskintraContextOptions } from './context.ts';
export { FskintraContext } from './context.ts';
export type {
  DiscoveredCapability,
  DiscoveredChild,
  DiscoverManifest,
} from './discover.ts';
export { buildDiscoverManifest } from './discover.ts';
export type { McpApp, McpAppOptions } from './setup.ts';
export { createMcpApp } from './setup.ts';
export { HonoSseTransport } from './sse-transport.ts';
export { registerTools } from './tools.ts';
