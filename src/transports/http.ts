import { createServer as createNodeServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer } from '../server.js';
import {
  assertAllowedOrigin,
  assertAuthorized,
  assertSafeHttpStartup,
  corsHeaders,
  forwardedHeadersTrusted,
  getHttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

assertSafeHttpStartup();
const config = getHttpConfig();
const trusted = forwardedHeadersTrusted(config);

const httpServer = createNodeServer(async (req, res) => {
  try {
    if (req.url !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' }, req);
      return;
    }

    assertAllowedOrigin(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, req, { Allow: 'POST' });
      return;
    }

    assertAuthorized(req, config);
    const body = await readJsonBody(req, config.maxBodyBytes);

    // The gateway forwards the Entra-verified user as X-MCP-User. Moonraker
    // runs every command as one trusted LAN client, so the audit log is the
    // only place a printer action is tied to a person: with trust enabled, a request
    // without the header is refused rather than logged anonymously.
    const forwardedUser = trusted ? firstHeaderValue(req.headers['x-mcp-user']) : undefined;
    if (trusted && !forwardedUser) {
      throw new HttpRequestError(401, 'Missing X-MCP-User from the gateway');
    }

    const mcpServer = createMcpServer({ onBehalfOf: forwardedUser });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      if (error instanceof HttpRequestError) {
        sendJson(res, error.status, { error: error.message }, req);
        return;
      }

      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      }, req);
    }
  }
});

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

httpServer.listen(config.port, config.host, () => {
  console.error(`QIDI MCP HTTP server listening on http://${config.host}:${config.port}/mcp`);
});
