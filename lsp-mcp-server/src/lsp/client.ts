import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js";
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types";
import { pathToFileURL, fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";
import { EventEmitter } from "events";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { LANGUAGE_EXTENSIONS } from "./language.js";

const DIAGNOSTICS_DEBOUNCE_MS = 150;

export interface LSPServerHandle {
  process: ChildProcessWithoutNullStreams;
  initialization?: Record<string, any>;
}

export type Diagnostic = VSCodeDiagnostic;

export class LSPClient extends EventEmitter {
  private connection: ReturnType<typeof createMessageConnection>;
  private diagnostics = new Map<string, Diagnostic[]>();
  private files: Record<string, number> = {};

  constructor(
    public readonly serverID: string,
    public readonly root: string,
    private server: LSPServerHandle
  ) {
    super();

    this.connection = createMessageConnection(
      new StreamMessageReader(server.process.stdout as any),
      new StreamMessageWriter(server.process.stdin as any)
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const filePath = path.normalize(fileURLToPath(params.uri));
      this.diagnostics.set(filePath, params.diagnostics);
      this.emit("diagnostics", { path: filePath, diagnostics: params.diagnostics });
    });

    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("workspace/configuration", async () => [this.server.initialization ?? {}]);
    this.connection.onRequest("client/registerCapability", async () => {});
    this.connection.onRequest("client/unregisterCapability", async () => {});
    this.connection.onRequest("workspace/workspaceFolders", async () => [
      {
        name: "workspace",
        uri: pathToFileURL(this.root).href,
      },
    ]);
  }

  async initialize() {
    this.connection.listen();

    await this.connection.sendRequest("initialize", {
      rootUri: pathToFileURL(this.root).href,
      processId: this.server.process.pid,
      workspaceFolders: [
        {
          name: "workspace",
          uri: pathToFileURL(this.root).href,
        },
      ],
      initializationOptions: this.server.initialization ?? {},
      capabilities: {
        window: {
          workDoneProgress: true,
        },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
        },
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
          },
          publishDiagnostics: {
            versionSupport: true,
          },
        },
      },
    });

    await this.connection.sendNotification("initialized", {});

    if (this.server.initialization) {
      await this.connection.sendNotification("workspace/didChangeConfiguration", {
        settings: this.server.initialization,
      });
    }
  }

  async openFile(filePath: string) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(this.root, filePath);
    const text = await fs.readFile(absolutePath, "utf-8");
    const extension = path.extname(absolutePath);
    const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext";

    const version = this.files[absolutePath];
    if (version !== undefined) {
      await this.connection.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(absolutePath).href, type: 2 }],
      });

      const next = version + 1;
      this.files[absolutePath] = next;
      await this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri: pathToFileURL(absolutePath).href, version: next },
        contentChanges: [{ text }],
      });
      return;
    }

    await this.connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(absolutePath).href, type: 1 }],
    });

    this.diagnostics.delete(absolutePath);
    await this.connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(absolutePath).href,
        languageId,
        version: 0,
        text,
      },
    });
    this.files[absolutePath] = 0;
  }

  async sendRequest(method: string, params: any): Promise<any> {
    return this.connection.sendRequest(method, params);
  }

  getDiagnostics(filePath?: string): Diagnostic[] | Map<string, Diagnostic[]> {
    if (filePath) {
      return this.diagnostics.get(path.normalize(filePath)) ?? [];
    }
    return this.diagnostics;
  }

  async shutdown() {
    this.connection.end();
    this.connection.dispose();
    this.server.process.kill();
  }
}
