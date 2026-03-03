import { LSPClient, type LSPServerHandle } from "./client.js";
import { pathToFileURL } from "url";
import path from "path";
import { spawn } from "child_process";

export interface LSPServerConfig {
  command: string[];
  extensions: string[];
  env?: Record<string, string>;
  initialization?: Record<string, any>;
}

export interface LSPManagerConfig {
  workspaceRoot: string;
  servers: Record<string, LSPServerConfig>;
}

export class LSPManager {
  private clients: LSPClient[] = [];
  private spawning = new Map<string, Promise<LSPClient | undefined>>();
  private broken = new Set<string>();

  constructor(private config: LSPManagerConfig) {}

  private resolveFilePath(file: string): string {
    return path.isAbsolute(file) ? file : path.resolve(this.config.workspaceRoot, file);
  }

  async getClients(file: string): Promise<LSPClient[]> {
    const extension = path.extname(file) || file;
    const result: LSPClient[] = [];

    for (const [serverID, serverConfig] of Object.entries(this.config.servers)) {
      if (!serverConfig.extensions.includes(extension)) continue;

      const key = this.config.workspaceRoot + serverID;
      if (this.broken.has(key)) continue;

      const match = this.clients.find(
        (x) => x.root === this.config.workspaceRoot && x.serverID === serverID
      );
      if (match) {
        result.push(match);
        continue;
      }

      const inflight = this.spawning.get(key);
      if (inflight) {
        const client = await inflight;
        if (client) result.push(client);
        continue;
      }

      const task = this.spawnClient(serverID, serverConfig, key);
      this.spawning.set(key, task);

      task.finally(() => {
        if (this.spawning.get(key) === task) {
          this.spawning.delete(key);
        }
      });

      const client = await task;
      if (client) result.push(client);
    }

    return result;
  }

  private async getWorkspaceClients(): Promise<LSPClient[]> {
    const result: LSPClient[] = [];

    for (const [serverID, serverConfig] of Object.entries(this.config.servers)) {
      const key = this.config.workspaceRoot + serverID;
      if (this.broken.has(key)) continue;

      const match = this.clients.find(
        (x) => x.root === this.config.workspaceRoot && x.serverID === serverID
      );
      if (match) {
        result.push(match);
        continue;
      }

      const inflight = this.spawning.get(key);
      if (inflight) {
        const client = await inflight;
        if (client) result.push(client);
        continue;
      }

      const task = this.spawnClient(serverID, serverConfig, key);
      this.spawning.set(key, task);

      task.finally(() => {
        if (this.spawning.get(key) === task) {
          this.spawning.delete(key);
        }
      });

      const client = await task;
      if (client) result.push(client);
    }

    return result;
  }

  private async spawnClient(
    serverID: string,
    config: LSPServerConfig,
    key: string
  ): Promise<LSPClient | undefined> {
    try {
      const childProcess = spawn(config.command[0], config.command.slice(1), {
        cwd: this.config.workspaceRoot,
        env: { ...process.env, ...config.env },
      });

      const handle: LSPServerHandle = {
        process: childProcess,
        initialization: config.initialization,
      };

      const client = new LSPClient(serverID, this.config.workspaceRoot, handle);
      await client.initialize();

      this.clients.push(client);
      return client;
    } catch (err) {
      this.broken.add(key);
      console.error(`Failed to spawn LSP server ${serverID}:`, err);
      return undefined;
    }
  }

  async touchFile(file: string): Promise<void> {
    const clients = await this.getClients(file);
    await Promise.all(clients.map((client) => client.openFile(file)));
  }

  async definition(input: { file: string; line: number; character: number }) {
    return this.run(input.file, (client) =>
      client.sendRequest("textDocument/definition", {
        textDocument: { uri: pathToFileURL(input.file).href },
        position: { line: input.line, character: input.character },
      })
    );
  }

  async references(input: { file: string; line: number; character: number }) {
    return this.run(input.file, (client) =>
      client.sendRequest("textDocument/references", {
        textDocument: { uri: pathToFileURL(input.file).href },
        position: { line: input.line, character: input.character },
        context: { includeDeclaration: true },
      })
    );
  }

  async hover(input: { file: string; line: number; character: number }) {
    return this.run(input.file, (client) =>
      client.sendRequest("textDocument/hover", {
        textDocument: { uri: pathToFileURL(input.file).href },
        position: { line: input.line, character: input.character },
      })
    );
  }

  async documentSymbol(filePath: string) {
    const file = this.resolveFilePath(filePath);
    const uri = pathToFileURL(file).href;
    return this.run(file, (client) =>
      client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      })
    );
  }

  async workspaceSymbol(query: string = "") {
    const clients = await this.getWorkspaceClients();
    const results = await Promise.all(
      clients.map((client) =>
        client.sendRequest("workspace/symbol", { query }).catch(() => [])
      )
    );
    return results.flat();
  }

  async implementation(input: { file: string; line: number; character: number }) {
    return this.run(input.file, (client) =>
      client.sendRequest("textDocument/implementation", {
        textDocument: { uri: pathToFileURL(input.file).href },
        position: { line: input.line, character: input.character },
      })
    );
  }

  async prepareCallHierarchy(input: { file: string; line: number; character: number }) {
    return this.run(input.file, (client) =>
      client.sendRequest("textDocument/prepareCallHierarchy", {
        textDocument: { uri: pathToFileURL(input.file).href },
        position: { line: input.line, character: input.character },
      })
    );
  }

  async incomingCalls(input: { file: string; line: number; character: number }) {
    return this.run(input.file, async (client) => {
      const items = await client.sendRequest("textDocument/prepareCallHierarchy", {
        textDocument: { uri: pathToFileURL(input.file).href },
        position: { line: input.line, character: input.character },
      });
      if (!items?.length) return [];
      return client.sendRequest("callHierarchy/incomingCalls", { item: items[0] });
    });
  }

  async outgoingCalls(input: { file: string; line: number; character: number }) {
    return this.run(input.file, async (client) => {
      const items = await client.sendRequest("textDocument/prepareCallHierarchy", {
        textDocument: { uri: pathToFileURL(input.file).href },
        position: { line: input.line, character: input.character },
      });
      if (!items?.length) return [];
      return client.sendRequest("callHierarchy/outgoingCalls", { item: items[0] });
    });
  }

  private async run<T>(file: string, fn: (client: LSPClient) => Promise<T>): Promise<T[]> {
    const clients = await this.getClients(file);
    const results = await Promise.all(
      clients.map((client) => fn(client).catch(() => null))
    );
    return results.flat().filter((item) => item !== null) as T[];
  }

  async shutdown() {
    await Promise.all(this.clients.map((client) => client.shutdown()));
    this.clients = [];
  }
}
