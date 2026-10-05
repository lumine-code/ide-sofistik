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

  it("expands generated commands and reports stable Ruff-style rules at the offending command", async () => {
    client.open(uri, "#DEFINE suffix=mb\n+PROG MAXIMA\nLC 1\nco$(suffix) 1\nEND\n");
    const result = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    const findings = result.items.filter((item) => item.source === "sofistik-linter");
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe("MX001");
    expect(findings[0].range).toEqual({
      start: { line: 2, character: 0 },
      end: { line: 2, character: 2 },
    });
    expect(findings[0].data.programAnchor.range.start.line).toBe(1);
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
    expect(findings[0].range).toEqual({
      start: { line: 2, character: 7 },
      end: { line: 2, character: 15 },
    });
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

  it("selects a scalar use site and exposes its definition through related locations", async () => {
    client.open(uri, "#DEFINE humidity = 110\n+PROG AQB\nEIGE RH $(humidity)\nEND\n");
    const result = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    const issue = result.items.find(({ data }) => data?.rule === "aqb-creep-humidity-range");
    expect(issue.range).toEqual({
      start: { line: 2, character: 8 },
      end: { line: 2, character: 19 },
    });
    expect(issue.relatedInformation.some(({ location }) => location.range.start.line === 0)).toBe(
      true,
    );
    expect(client.stderr).toBe("");
  });

  it("receives included-file findings and their retraction through related document reports", async () => {
    const included = fileUri(path.join(directory, "values.inc"));
    fs.writeFileSync(path.join(directory, "values.inc"), "LET#a #missing\n");
    client.open(uri, '+PROG TEMPLATE\n#INCLUDE "values.inc"\nEND\n');
    const result = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    const findings = result.relatedDocuments[included].items.filter(({ code }) => code === "G101");
    expect(findings.length).toBe(1);
    expect(findings[0].range).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 14 },
    });
    client.change(uri, "+PROG TEMPLATE\nEND\n", 2);
    const corrected = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(corrected.relatedDocuments[included].items).toEqual([]);
    expect(client.stderr).toBe("");
  });

  it("checks new CSA coefficient bounds only in their verified release", async () => {
    const definition = path.join(directory, "sofistik.def");
    fs.writeFileSync(definition, "SOF_VERSION = 2025\n");
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: fileUri(definition), type: 2 }],
    });
    client.open(uri, "+PROG CSA\nTASK TYPE PHNG\nEXPO OPT SMAT MTYP MTAK TAY 1.2\nEND\n");
    const old = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(old.items.some(({ code }) => code === "CS005")).toBe(false);
    fs.writeFileSync(definition, "SOF_VERSION = 2026\n");
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: fileUri(definition), type: 2 }],
    });
    const current = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    const issue = current.items.find(({ code }) => code === "CS005");
    expect(issue.range).toEqual({
      start: { line: 2, character: 28 },
      end: { line: 2, character: 31 },
    });
    expect(client.stderr).toBe("");
  });

  it("reports an unclosed native IF at its opener and clears it after correction", async () => {
    client.open(uri, "+PROG TEMPLATE\nIF 1\nLET#a 1\nEND\n");
    const initial = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    const issue = initial.items.find(({ code }) => code === "G309");
    expect(issue.range).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 2 },
    });
    client.change(uri, "+PROG TEMPLATE\nIF 1\nLET#a 1\nENDIF\nEND\n", 2);
    const corrected = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(corrected.items.some(({ code }) => code === "G309")).toBe(false);
    expect(client.stderr).toBe("");
  });
});
