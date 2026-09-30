const fs = require("fs");
const os = require("os");
const path = require("path");
const { LiveLspClient, fileUri, positionParams } = require("./helpers/live-lsp-client");

const SOURCE = "+PROG ASE\nHEAD 'Example'\nLET#size 1\nGRP NO #size VAL FULL\n$ #size\nEND\n";
const itemsOf = (result) => (Array.isArray(result) ? result : result.items);
const targetLine = (target) => (target.range ?? target.targetSelectionRange).start.line;

describe("ide-sofistik bundled language server", () => {
  let main, adapter, edge, client, directory, uri, timeout;

  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;
  });

  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });

  beforeEach(async () => {
    jasmine.useRealClock();
    main = (await lumine.packages.activatePackage("ide-sofistik")).mainModule;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ide-sofistik-live-"));
    fs.writeFileSync(path.join(directory, "sofistik.def"), "SOF_VERSION = 2026\n");
    fs.writeFileSync(path.join(directory, "main.dat"), SOURCE);
    uri = fileUri(path.join(directory, "main.dat"));
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose() {} };
      },
      reportMissingServer() {},
    });
    client = new LiveLspClient(adapter, directory);
  });

  afterEach(async () => {
    await client.stop();
    edge.dispose();
    await lumine.packages.deactivatePackage("ide-sofistik");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("serves every advertised intelligence capability without a SOFiSTiK installation", async () => {
    const { capabilities } = await client.start();
    for (const name of [
      "completionProvider",
      "hoverProvider",
      "signatureHelpProvider",
      "definitionProvider",
      "referencesProvider",
      "documentSymbolProvider",
      "workspaceSymbolProvider",
      "diagnosticProvider",
    ])
      expect(capabilities[name]).toBeTruthy();
    expect(capabilities.semanticTokensProvider).toEqual({
      legend: { tokenTypes: ["enumMember"], tokenModifiers: [] },
      full: true,
      range: true,
    });
    expect(capabilities.executeCommandProvider.commands).toContain(
      "sofistik.readCalculationDiagnostics",
    );
    expect(capabilities.workspace?.workspaceFolders?.supported).not.toBe(true);
    expect(capabilities.documentFormattingProvider).toBeUndefined();
    expect(capabilities.renameProvider).toBeUndefined();
    expect(capabilities.codeActionProvider).toBeUndefined();
    client.open(uri, SOURCE);
    await client.waitFor(() => client.diagnostics(uri).length, "initial diagnostics");

    const completion = await client.request("textDocument/completion", positionParams(uri, 3, 4));
    expect(itemsOf(completion).some(({ label }) => label.toUpperCase() === "VAL")).toBe(true);
    expect(
      itemsOf(completion)
        .slice(0, 5)
        .map(({ label }) => label),
    ).toEqual(["NO", "VAL", "FACS", "PLC", "GAM"]);
    const completionOrder = itemsOf(completion).map(({ sortText }) => sortText);
    expect(completionOrder.every((sortText) => typeof sortText === "string")).toBe(true);
    expect(completionOrder).toEqual([...completionOrder].sort());
    const hover = await client.request("textDocument/hover", positionParams(uri, 3, 10));
    expect(hover?.contents.value).toContain("LET#size 1");
    const parameterHover = await client.request("textDocument/hover", positionParams(uri, 3, 15));
    const enumHover = await client.request("textDocument/hover", positionParams(uri, 3, 19));
    for (const result of [parameterHover, enumHover]) {
      expect(result?.contents.value).toContain("ASE · GRP · VAL /2");
      for (const value of ["FULL", "GLIN", "LIN", "LINE", "NO", "OFF", "OLD", "YES"])
        expect(result.contents.value).toMatch(new RegExp(`\\b${value}\\b`));
      expect(result.contents.value).not.toContain("Slot");
      expect(result.contents.value).not.toContain("SOFiSTiK 2026");
      expect(result.contents.value).not.toContain("type codes");
    }
    const numberUri = fileUri(path.join(directory, "numbers.dat"));
    const numberSource = "+PROG ASE\nGRP NO 1 VAL FULL\nEND\n";
    fs.writeFileSync(path.join(directory, "numbers.dat"), numberSource);
    client.open(numberUri, numberSource);
    const numberHover = await client.request("textDocument/hover", positionParams(numberUri, 1, 7));
    expect(numberHover?.contents.value).toContain("ASE · GRP · NO /1");
    for (const [line, character] of [
      [0, 7],
      [3, 1],
      [3, 12],
      [1, 7],
      [4, 4],
    ])
      expect(
        await client.request("textDocument/hover", positionParams(uri, line, character)),
      ).toBeNull();
    const signature = await client.request(
      "textDocument/signatureHelp",
      positionParams(uri, 3, 19),
    );
    expect(signature.signatures.length).toBeGreaterThan(0);
    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
    expect(symbols.length).toBeGreaterThan(0);
    const workspaceSymbols = await client.request("workspace/symbol", { query: "size" });
    expect(workspaceSymbols.length).toBeGreaterThan(0);
    const definition = await client.request("textDocument/definition", positionParams(uri, 3, 9));
    const targets = Array.isArray(definition) ? definition : [definition];
    expect(targets.some((target) => targetLine(target) === 2)).toBe(true);
    const references = await client.request("textDocument/references", {
      ...positionParams(uri, 3, 9),
      context: { includeDeclaration: true },
    });
    expect(references.length).toBeGreaterThanOrEqual(2);
    const tokens = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    expect(tokens.data).toEqual([3, 17, 4, 0, 0]);
    const rangeTokens = await client.request("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 0 } },
    });
    expect(rangeTokens.data).toEqual(tokens.data);
    const report = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(report.kind).toBe("full");
    expect(Array.isArray(report.items)).toBe(true);
  });

  it("imports a validated existing log manually and clears imported findings on edits", async () => {
    fs.writeFileSync(
      path.join(directory, "main.error_positions"),
      `${JSON.stringify({ errornumber: 123, isError: true, position: { line: 4, text: "Calculated error" } })}\n`,
    );
    await client.start();
    client.open(uri, SOURCE);
    await client.waitFor(() => client.diagnostics(uri).length, "initial diagnostics");
    expect(
      client
        .diagnostics(uri)
        .at(-1)
        .diagnostics.some(({ source }) => source === "sofistik-calculation"),
    ).toBe(false);
    const result = await client.request("workspace/executeCommand", {
      command: "sofistik.readCalculationDiagnostics",
      arguments: [{ uri }],
    });
    expect(result.count).toBe(1);
    const imported = await client.waitFor(
      () =>
        client
          .diagnostics(uri)
          .at(-1)
          ?.diagnostics.find(({ source }) => source === "sofistik-calculation"),
      "imported diagnostics",
    );
    expect(imported.code).toBe(123);
    expect(imported.range.start.line).toBe(3);
    expect(imported.message).toBe("Calculated error");
    client.change(uri, `${SOURCE}ENDLOOP\n`);
    const changed = await client.waitFor(
      () => client.diagnostics(uri).find(({ version }) => version === 2),
      "diagnostics after edit",
    );
    expect(changed.diagnostics.some(({ source }) => source === "sofistik-calculation")).toBe(false);
    expect(changed.diagnostics.some(({ source }) => source === "sofistik")).toBe(true);
    const beforeClose = client.diagnostics(uri).length;
    client.closeDocument(uri);
    await client.waitFor(
      () =>
        client
          .diagnostics(uri)
          .slice(beforeClose)
          .some(({ diagnostics }) => diagnostics.length === 0),
      "cleared diagnostics on close",
    );
  });

  it("keeps separate project releases isolated in separate server processes", async () => {
    const secondRoot = path.join(directory, "other-project");
    fs.mkdirSync(secondRoot);
    fs.writeFileSync(path.join(secondRoot, "sofistik.def"), "SOF_VERSION = 1999\n");
    const second = new LiveLspClient(adapter, secondRoot);
    try {
      await client.start();
      await second.start();
      expect(second.child.pid).not.toBe(client.child.pid);
      const secondUri = fileUri(path.join(secondRoot, "main.dat"));
      client.open(uri, SOURCE);
      second.open(secondUri, SOURCE);
      const firstTokens = await client.request("textDocument/semanticTokens/full", {
        textDocument: { uri },
      });
      const secondTokens = await second.request("textDocument/semanticTokens/full", {
        textDocument: { uri: secondUri },
      });
      expect(firstTokens.data.length).toBeGreaterThan(0);
      expect(secondTokens.data).toEqual([]);
    } finally {
      await second.stop();
    }
  });

  it("ignores source headers when the project definition selects the context", async () => {
    await client.start();
    client.open(uri, `@ SOFiSTiK 1999 DE\n${SOURCE}`);
    const tokens = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    expect(tokens.data).toEqual([4, 17, 4, 0, 0]);
    const report = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(report.items.some(({ message }) => /1999|release.*conflict/i.test(message))).toBe(false);
  });
});
