#!/usr/bin/env node

import { startLspMcpStdioServer } from "./server.js";

async function main() {
  const runtime = await startLspMcpStdioServer();

  const shutdown = async () => {
    await runtime.lspManager.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(`LSP MCP Server running on stdio (workspace: ${runtime.workspaceRoot})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
