#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { enforceAntigravityRuntime } from '../src/guard.js';
import { registerCoreTools } from '../src/tools/coreTools.js';
import { registerReportingTools } from '../src/tools/reportingTools.js';
import { registerResearchTools } from '../src/tools/researchTools.js';
import { registerMutateTools } from '../src/tools/mutateTools.js';

export function createSwaGoogleAdsMcpServer() {
  const server = new McpServer({
    name: 'swa-google-ads-mcp',
    version: '1.0.0'
  });

  registerCoreTools(server);
  registerReportingTools(server);
  registerResearchTools(server);
  registerMutateTools(server);

  return server;
}

async function main() {
  // Enforce Google Antigravity CLI / MCP runtime environment
  enforceAntigravityRuntime('mcp');

  const server = createSwaGoogleAdsMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error('[swa-google-ads-mcp] Ready on stdio transport (Antigravity runtime verified).');
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('mcp-server.js') || process.argv[1].endsWith('swa-google-ads-mcp-server'));

if (isDirectExecution) {
  main().catch((err) => {
    console.error('[swa-google-ads-mcp] Fatal startup error:', err);
    process.exit(1);
  });
}
