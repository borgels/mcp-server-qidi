#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { validateQidiEnv } from '../qidi/policy.js';
import { createServer } from '../server.js';

async function main(): Promise<void> {
  // Refuse to start with invalid temperature caps, plate-check age or timeout.
  validateQidiEnv();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
