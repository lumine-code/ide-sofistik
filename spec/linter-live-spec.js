const fs = require("fs");
const os = require("os");
const path = require("path");
const { LiveLspClient, fileUri } = require("./helpers/live-lsp-client");

describe("ide-sofistik bundled CADINP linter", () => {
  let edge, client, directory, uri, timeout;

  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;
  });

  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });

  beforeEach(async () => {
    jasmine.useRealClock();
    const main = (await lumine.packages.activatePackage("ide-sofistik")).mainModule;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ide-sofistik-linter-"));
    fs.writeFileSync(path.join(directory, "sofistik.def"), "SOF_VERSION = 2026\n");
    uri = fileUri(path.join(directory, "main.dat"));
    let adapter;
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose() {} };
      },
      reportMissingServer() {},
    });
    client = new LiveLspClient(adapter, directory);
    await client.start();
  });

  afterEach(async () => {
    await client.stop();
    edge.dispose();
    await lumine.packages.deactivatePackage("ide-sofistik");
    expect(path.dirname(directory)).toBe(os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("expands generated commands and reports stable Ruff-style rules at their program", async () => {
    client.open(uri, "#DEFINE suffix=mb\n+PROG MAXIMA\nLC 1\nco$(suffix) 1\nEND\n");
    const result = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    const findings = result.items.filter((item) => item.source === "sofistik-linter");
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe("MX001");
    expect(findings[0].range.start.line).toBe(1);
    expect(findings[0].data.recordOrigin.range.start.line).toBe(2);
    client.change(uri, "#DEFINE suffix=mb\n+PROG MAXIMA\nco$(suffix) 1\nLC 1\nEND\n", 2);
    const corrected = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(corrected.items.filter((item) => item.source === "sofistik-linter")).toEqual([]);
    expect(client.stderr).toBe("");
  });

  it("applies noqa to the original offending line instead of hiding every use", async () => {
    client.open(uri, "+PROG ASE\nGRP NO #missing ! noqa: G101\nGRP NO #missing\nEND\n");
    const result = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    const findings = result.items.filter((item) => item.source === "sofistik-linter");
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe("G101");
    expect(findings[0].range.start.line).toBe(0);
    expect(findings[0].data.recordOrigin.range.start.line).toBe(2);
    expect(client.stderr).toBe("");
  });

  it("selects release-specific ERR rules through the editor runtime", async () => {
    const definition = path.join(directory, "sofistik.def");
    fs.writeFileSync(definition, "SOF_VERSION = 2018\n");
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: fileUri(definition), type: 2 }],
    });
    client.open(uri, "+PROG DBMERG\nLC NO -1\nEND\n");
    const legacy = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(legacy.items.some(({ code }) => code === "DM001")).toBe(false);
    fs.writeFileSync(definition, "SOF_VERSION = 2025\n");
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: fileUri(definition), type: 2 }],
    });
    const current = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(current.items.some(({ code }) => code === "DM001")).toBe(true);
    fs.writeFileSync(definition, "SOF_VERSION = 2025\nNOQA = DM\n");
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: fileUri(definition), type: 2 }],
    });
    const ignored = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(ignored.items.some(({ code }) => code === "DM001")).toBe(false);
    expect(client.stderr).toBe("");
  });

  it("checks literal parameters while keeping expressions unresolved", async () => {
    client.open(uri, "+PROG BDK\nCTRL SFAC 0.5\nEND\n");
    const initial = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(initial.items.some(({ code }) => code === "BD001")).toBe(true);
    client.change(uri, "+PROG BDK\nCTRL SFAC 0.5*2\nEND\n", 2);
    const expression = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(expression.items.some(({ code }) => code === "BD001")).toBe(false);
    expect(client.stderr).toBe("");
  });
});
