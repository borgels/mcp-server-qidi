import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MoonrakerClient } from './qidi/client.js';
import { registerQidiTools } from './tools/qidi.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: MoonrakerClient;
  /** Authenticated user the request acts for, as forwarded in X-MCP-User. */
  onBehalfOf?: string;
  now?: () => number;
}

let sharedClient: MoonrakerClient | undefined;

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'qidi', version: PACKAGE_VERSION });
  const client = options.client ?? (sharedClient ??= new MoonrakerClient());
  registerQidiTools(server, client, { actingAs: options.onBehalfOf, now: options.now });
  return server;
}
