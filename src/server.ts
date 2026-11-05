import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MoonrakerClient } from './qidi/client.js';
import { registerQidiTools } from './tools/qidi.js';

export interface CreateServerOptions {
  client?: MoonrakerClient;
  /** Gateway-verified user the request acts for (X-MCP-User). */
  onBehalfOf?: string;
  now?: () => number;
}

let sharedClient: MoonrakerClient | undefined;

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'qidi', version: '0.1.0' });
  const client = options.client ?? (sharedClient ??= new MoonrakerClient());
  registerQidiTools(server, client, { actingAs: options.onBehalfOf, now: options.now });
  return server;
}
