const { spawn } = require("child_process");
const path = require("path");
const { configurationContext, workspaceConfiguration } = require(
  path.join(lumine.packages.resolvePackagePath("ide-client"), "lib", "workspace-configuration"),
);
const { pathToFileURL } = require("url");
const {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} = require("vscode-jsonrpc/node");

const withTimeout = (promise, label, timeout = 10000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
};

class LiveLspClient {
  constructor(adapter, rootPath) {
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.notifications = [];
    this.registrations = [];
    this.progressRequests = [];
    this.stderr = "";
  }

  configurationContext() {
    return configurationContext(this.rootPath, this.launch, this.session);
  }

  configuration(items) {
    return workspaceConfiguration(this.adapter, items, this.configurationContext());
  }

  async start() {
    const launch = await this.adapter.resolveServer({ rootPath: this.rootPath });
    this.launch = launch;
    if (!launch) throw new Error("SOFiSTiK server entry is unavailable");
    this.child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk.toString()));
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
    );
    this.connection.onNotification((method, params) => this.notifications.push({ method, params }));
    this.connection.onNotification("$/progress", (params) =>
      this.notifications.push({ method: "$/progress", params }),
    );
    this.connection.onRequest("workspace/configuration", ({ items }) => this.configuration(items));
    this.connection.onRequest("client/registerCapability", ({ registrations }) => {
      this.registrations.push(...registrations);
      return null;
    });
    this.connection.onRequest("workspace/semanticTokens/refresh", () => null);
    this.connection.onRequest("workspace/diagnostic/refresh", () => null);
    this.connection.onRequest("window/workDoneProgress/create", (params) => {
      this.progressRequests.push(params);
      return null;
    });
    this.connection.onRequest("workspace/workspaceFolders", () => this.folders);
    this.connection.listen();
    const rootUri = pathToFileURL(this.rootPath).href;
    this.folders = [{ uri: rootUri, name: path.basename(this.rootPath) }];
    const initialized = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: this.folders,
      capabilities: {
        window: { workDoneProgress: true },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
        },
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {},
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          diagnostic: { dynamicRegistration: false },
          semanticTokens: {
            requests: { full: { delta: true }, range: true },
            tokenTypes: ["enumMember"],
            tokenModifiers: [],
            formats: ["relative"],
            augmentsSyntaxTokens: true,
            overlappingTokenSupport: false,
            multilineTokenSupport: false,
          },
        },
        general: { positionEncodings: ["utf-16"] },
      },
    });
    this.notify("initialized", {});
    this.notify("workspace/didChangeConfiguration", {
      settings: await this.adapter.getSettings(this.configurationContext()),
    });
    return initialized;
  }

  request(method, params) {
    return withTimeout(this.connection.sendRequest(method, params), `${method}: ${this.stderr}`);
  }

  notify(method, params) {
    return this.connection.sendNotification(method, params);
  }

  open(uri, text, version = 1) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "sofistik", version, text },
    });
  }

  change(uri, text, version = 2) {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  closeDocument(uri) {
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  diagnostics(uri) {
    return this.notifications
      .filter(
        ({ method, params }) => method === "textDocument/publishDiagnostics" && params.uri === uri,
      )
      .map(({ params }) => params);
  }

  async waitFor(check, label) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${label} timed out: ${this.stderr}`);
  }

  async stop() {
    if (!this.child) return;
    try {
      await withTimeout(this.connection.sendRequest("shutdown"), "shutdown", 2000);
      this.notify("exit");
      await withTimeout(this.exited, "server exit", 2000);
    } catch {
      this.child.kill();
      await withTimeout(this.exited, "forced server exit", 2000);
    } finally {
      this.connection?.dispose();
    }
  }
}

exports.LiveLspClient = LiveLspClient;
exports.fileUri = (filePath) => pathToFileURL(filePath).href;
exports.positionParams = (uri, line, character) => ({
  textDocument: { uri },
  position: { line, character },
});
