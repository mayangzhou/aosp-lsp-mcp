import fs from "fs/promises";
import path from "path";
import type { LSPManagerConfig, LSPServerConfig } from "./lsp/index.js";

export const DEFAULT_LSP_SERVERS: Record<string, LSPServerConfig> = {
  typescript: {
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  },
  python: {
    command: ["pyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"],
  },
  rust: {
    command: ["rust-analyzer"],
    extensions: [".rs"],
  },
  go: {
    command: ["gopls"],
    extensions: [".go"],
  },
};

interface RawConfigFile {
  includeDefaultServers?: boolean;
  servers?: Record<string, LSPServerConfig>;
}

export interface ResolveConfigOptions {
  workspaceRoot: string;
  configPath?: string;
}

function normalizeServerConfig(config: LSPServerConfig, serverID: string): LSPServerConfig {
  if (!Array.isArray(config.command) || config.command.length === 0) {
    throw new Error(`Invalid LSP server "${serverID}": command must be a non-empty array`);
  }
  if (!Array.isArray(config.extensions) || config.extensions.length === 0) {
    throw new Error(`Invalid LSP server "${serverID}": extensions must be a non-empty array`);
  }
  return config;
}

export async function resolveLspManagerConfig(
  options: ResolveConfigOptions
): Promise<LSPManagerConfig> {
  const configPath =
    options.configPath ||
    process.env.LSP_MCP_CONFIG ||
    path.join(options.workspaceRoot, "lsp-mcp-config.json");

  let configFile: RawConfigFile = {};
  try {
    const source = await fs.readFile(configPath, "utf-8");
    configFile = JSON.parse(source) as RawConfigFile;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`Failed to load config at ${configPath}: ${(error as Error).message}`);
    }
  }

  const includeDefaultServers = configFile.includeDefaultServers !== false;
  const mergedServers: Record<string, LSPServerConfig> = {
    ...(includeDefaultServers ? DEFAULT_LSP_SERVERS : {}),
    ...(configFile.servers ?? {}),
  };

  for (const [serverID, serverConfig] of Object.entries(mergedServers)) {
    mergedServers[serverID] = normalizeServerConfig(serverConfig, serverID);
  }

  return {
    workspaceRoot: options.workspaceRoot,
    servers: mergedServers,
  };
}
