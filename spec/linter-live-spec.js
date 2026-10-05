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

  it("expands generated commands and reports stable numeric rules at their program", async () => {
    client.open(uri, "#DEFINE suffix=mb\n+PROG MAXIMA\nLC 1\nco$(suffix) 1\nEND\n");
    const result = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    const findings = result.items.filter((item) => item.source === "sofistik-linter");
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe(5001);
    expect(findings[0].range.start.line).toBe(1);
    expect(findings[0].data.recordOrigin.range.start.line).toBe(2);
    client.change(uri, "#DEFINE suffix=mb\n+PROG MAXIMA\nco$(suffix) 1\nLC 1\nEND\n", 2);
    const corrected = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(corrected.items.filter((item) => item.source === "sofistik-linter")).toEqual([]);
    expect(client.stderr).toBe("");
  });

  it("applies noqa to the original offending line instead of hiding every use", async () => {
    client.open(uri, "+PROG ASE\nGRP NO #missing ! noqa: 2001\nGRP NO #missing\nEND\n");
    const result = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    const findings = result.items.filter((item) => item.source === "sofistik-linter");
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe(2001);
    expect(findings[0].range.start.line).toBe(0);
    expect(findings[0].data.recordOrigin.range.start.line).toBe(2);
    expect(client.stderr).toBe("");
  });
});
