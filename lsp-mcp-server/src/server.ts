import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LSPManager } from "./lsp/index.js";
import { executeLspTool, LspToolSchema, LSP_TOOL_DESCRIPTION } from "./tools/lsp-tools.js";
import { AospToolSchema, AOSP_TOOL_DESCRIPTION, executeAospTool } from "./tools/aosp-tools.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { resolveLspManagerConfig } from "./config.js";

export interface CreateLspMcpServerOptions {
  workspaceRoot?: string;
  configPath?: string;
  serverName?: string;
  serverVersion?: string;
}

export async function createLspMcpServer(options: CreateLspMcpServerOptions = {}) {
  const workspaceRoot = options.workspaceRoot || process.env.WORKSPACE_ROOT || process.cwd();
  const managerConfig = await resolveLspManagerConfig({
    workspaceRoot,
    configPath: options.configPath,
  });
  const lspManager = new LSPManager(managerConfig);

  const server = new Server(
    {
      name: options.serverName || "lsp-mcp-server",
      version: options.serverVersion || "1.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler("tools/list" as any, async () => ({
    tools: [
      {
        name: "lsp",
        description: LSP_TOOL_DESCRIPTION,
        inputSchema: zodToJsonSchema(LspToolSchema),
      },
      {
        name: "aosp",
        description: AOSP_TOOL_DESCRIPTION,
        inputSchema: zodToJsonSchema(AospToolSchema),
      },
    ],
  }));

  server.setRequestHandler("tools/call" as any, async (request: any) => {
    try {
      let result: unknown;
      if (request.params.name === "lsp") {
        const input = LspToolSchema.parse(request.params.arguments);
        result = await executeLspTool(lspManager, input);
      } else if (request.params.name === "aosp") {
        const input = AospToolSchema.parse(request.params.arguments);
        result = await executeAospTool({ workspaceRoot }, input);
      } else {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return { server, lspManager, workspaceRoot };
}

export async function startLspMcpStdioServer(options: CreateLspMcpServerOptions = {}) {
  const runtime = await createLspMcpServer(options);
  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);
  return runtime;
}
