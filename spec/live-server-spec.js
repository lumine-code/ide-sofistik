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

  it("reports completed indexing from the default git-pinned server launch", async () => {
    await client.start();
    expect(client.child.spawnargs).toContain(
      require.resolve("@lumine-code/sofistik-language-server/bin/cli.js"),
    );
    await client.request("workspace/symbol", { query: "size" });
    const progress = await client.waitFor(() => {
      const values = client.notifications
        .filter(({ method }) => method === "$/progress")
        .map(({ params }) => params);
      return values.some(({ value }) => value.kind === "end") ? values : null;
    }, "completed indexing progress");
    expect(client.progressRequests.length).toBe(1);
    expect(progress.every(({ token }) => token === client.progressRequests[0].token)).toBe(true);
    expect(progress[0].value).toEqual({
      kind: "begin",
      title: "Indexing CADINP project",
      message: "Discovering files",
      cancellable: false,
    });
    expect(progress.at(-2).value).toEqual({ kind: "report", message: "Indexed 1 file" });
    expect(progress.at(-1).value).toEqual({ kind: "end" });
    expect(progress.filter(({ value }) => value.kind === "end").length).toBe(1);
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
      expect(result?.contents.kind).toBe("plaintext");
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
    const recordHover = await client.request("textDocument/hover", positionParams(uri, 3, 1));
    expect(recordHover?.contents.kind).toBe("plaintext");
    expect(recordHover?.contents.value).toMatch(/^ASE · GRP\n\nNO, VAL, FACS, PLC, GAM/);
    for (const [line, character] of [
      [0, 7],
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

  it("advances positional GRP slots and leaves quoted enum values to string highlighting", async () => {
    const records = ["GRP NUMB 57 OFF SPRI", "GRP NUMB 58 OPTI 'OFF' ETYP 'SPRI'"];
    const source = ["+PROG WING", ...records, "END", ""].join("\n");
    fs.writeFileSync(path.join(directory, "main.dat"), source);
    await client.start();
    client.open(uri, source);
    const expected = [1, 12, 3, 0, 0, 0, 4, 4, 0, 0];
    const full = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    expect(full.data).toEqual(expected);
    const range = await client.request("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } },
    });
    expect(range.data).toEqual(expected);
    const quotedRange = await client.request("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } },
    });
    expect(quotedRange.data).toEqual([]);
    for (const [index, record] of records.entries()) {
      for (const [value, parameter, position] of [
        [index === 0 ? "57" : "58", "NUMB", 1],
        ["OFF", "OPTI", 2],
        ["SPRI", "ETYP", 3],
      ]) {
        const result = await client.request(
          "textDocument/hover",
          positionParams(uri, index + 1, record.indexOf(value) + 1),
        );
        expect(result?.contents.value.split("\n")[0]).toBe(
          `WING · GRP · ${parameter} /${position}`,
        );
      }
    }
  });

  it("serves comma alternatives as one GRP slot while advancing the next slot once", async () => {
    const cases = [
      {
        record: "GRP NUMB 31+#grp YES BEAM,GLN SING",
        tokens: [1, 17, 3, 0, 0, 0, 4, 4, 0, 0, 0, 5, 3, 0, 0, 0, 4, 4, 0, 0],
      },
      {
        record: "GRP NUMB 32+#grp YES, OFF BEAM, GLN SING",
        tokens: [1, 17, 3, 0, 0, 0, 5, 3, 0, 0, 0, 4, 4, 0, 0, 0, 6, 3, 0, 0, 0, 4, 4, 0, 0],
      },
      {
        record: "GRP NUMB 33+#grp YES BEAM,'GLN' SING",
        quoted: "GLN",
        tokens: [1, 17, 3, 0, 0, 0, 4, 4, 0, 0, 0, 11, 4, 0, 0],
      },
    ];
    const source = ["+PROG WING", ...cases.map(({ record }) => record), "END", ""].join("\n");
    fs.writeFileSync(path.join(directory, "main.dat"), source);
    await client.start();
    client.open(uri, source);
    const full = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    expect(full.data).toEqual(cases.flatMap(({ tokens }) => tokens));
    for (const [index, { record, tokens, quoted }] of cases.entries()) {
      const line = index + 1;
      const range = await client.request("textDocument/semanticTokens/range", {
        textDocument: { uri },
        range: { start: { line, character: 0 }, end: { line: line + 1, character: 0 } },
      });
      expect(range.data).toEqual([line, ...tokens.slice(1)]);
      for (const [value, parameter, activeParameter] of [
        ["YES", "OPTI", 1],
        ["OFF", "OPTI", 1],
        ["BEAM", "ETYP", 2],
        ["GLN", "ETYP", 2],
        ["SING", "GDIV", 3],
      ]) {
        const start = record.indexOf(value);
        if (start < 0) continue;
        const hover = await client.request(
          "textDocument/hover",
          positionParams(uri, line, start + 1),
        );
        expect(hover?.contents.value.split("\n")[0]).toBe(
          `WING · GRP · ${parameter} /${activeParameter + 1}`,
        );
        const signature = await client.request(
          "textDocument/signatureHelp",
          positionParams(uri, line, start + 1),
        );
        expect(signature?.activeParameter).toBe(activeParameter);
        const completion = await client.request(
          "textDocument/completion",
          positionParams(uri, line, start + 2),
        );
        const item = itemsOf(completion).find(({ label }) => label === value);
        expect(item?.kind).toBe(20);
        expect(item?.textEdit.range).toEqual({
          start: { line, character: start },
          end: { line, character: start + 2 },
        });
        const valueTokens = await client.request("textDocument/semanticTokens/range", {
          textDocument: { uri },
          range: {
            start: { line, character: start },
            end: { line, character: start + value.length },
          },
        });
        expect(valueTokens.data).toEqual(value === quoted ? [] : [line, start, value.length, 0, 0]);
      }
    }
  });

  it("shows complete ordered LC and TRAI record keys from each file's release and language", async () => {
    const english = path.join(directory, "records-en");
    const german = path.join(directory, "records-de");
    const unsupported = path.join(directory, "records-unsupported");
    for (const child of [english, german, unsupported]) fs.mkdirSync(child);
    fs.writeFileSync(path.join(english, "sofistik.def"), "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\n");
    fs.writeFileSync(path.join(german, "sofistik.def"), "SOF_VERSION = 2025\nSOF_LANGUAGE = DE\n");
    fs.writeFileSync(path.join(unsupported, "sofistik.def"), "SOF_VERSION = 1999\n");
    const englishSource = "+PROG SOFILOAD\nLC NO 1\nTRAI\nEND\n";
    const germanSource = "+PROG ASE\nLC\nENDE\n";
    const englishPath = path.join(english, "main.dat");
    const germanPath = path.join(german, "main.dat");
    const unsupportedPath = path.join(unsupported, "main.dat");
    fs.writeFileSync(englishPath, englishSource);
    fs.writeFileSync(germanPath, germanSource);
    fs.writeFileSync(unsupportedPath, englishSource);
    const englishUri = fileUri(englishPath);
    const germanUri = fileUri(germanPath);
    const unsupportedUri = fileUri(unsupportedPath);
    await client.start();
    client.open(englishUri, englishSource);
    client.open(germanUri, germanSource);
    client.open(unsupportedUri, englishSource);
    const lcKeys =
      "NO, TYPE, FACT, FACD, DLX, DLY, DLZ, GAMU, GAMF, PSI0, PSI1, PSI2, PS1S, GAMA, CRIT, CRI1, CRI2, CRI3, TITL";
    const trainKeys =
      "TYPE, P1, P2, P3, P4, P5, P6, P7, P8, P9, PFAC, PFAV, WIDT, PHI, PHIS, V, FUGA, XCON, YEX, DIR, DIRT, FRB, DAB, BOGI, FRBO, DABO, WHEE, FRWH, DAWH";
    for (const [documentUri, line, heading, keys, length] of [
      [englishUri, 1, "SOFILOAD · LC", lcKeys, 2],
      [englishUri, 2, "SOFILOAD · TRAI", trainKeys, 4],
      [germanUri, 1, "ASE · LC", "NR, FAKT, NRG, KVON, KBIS, KDEL, TRAG, PLF", 2],
      [englishUri, 1, "SOFILOAD · LC", lcKeys, 2],
    ]) {
      const result = await client.request(
        "textDocument/hover",
        positionParams(documentUri, line, 1),
      );
      expect(result?.contents).toEqual({ kind: "plaintext", value: `${heading}\n\n${keys}` });
      expect(result?.range).toEqual({
        start: { line, character: 0 },
        end: { line, character: length },
      });
    }
    expect(
      await client.request("textDocument/hover", positionParams(unsupportedUri, 1, 1)),
    ).toBeNull();
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

  it("keeps adjacent releases and languages separate inside one server process", async () => {
    fs.writeFileSync(path.join(directory, "sofistik.def"), "SOF_VERSION = 1999\n");
    const english = path.join(directory, "english");
    const german = path.join(directory, "german");
    fs.mkdirSync(english);
    fs.mkdirSync(german);
    fs.writeFileSync(path.join(english, "sofistik.def"), "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\n");
    fs.writeFileSync(
      path.join(german, "sofistik.def"),
      "SOF_VERSION = 2025\nSOF_LANGUAGE = DE\nSOF_EDITION = educational\n",
    );
    const englishUri = fileUri(path.join(english, "main.dat"));
    const germanUri = fileUri(path.join(german, "main.dat"));
    const germanSource = "+PROG ASE\nGRUP NR 1 WERT VOLL\nENDE\n";
    await client.start();
    const pid = client.child.pid;
    client.open(englishUri, SOURCE);
    client.open(germanUri, germanSource);
    for (const [documentUri, line, character, expected, absent] of [
      [englishUri, 3, 4, "NO", "NR"],
      [germanUri, 1, 5, "NR", "NO"],
      [englishUri, 3, 4, "NO", "NR"],
    ]) {
      const completion = await client.request(
        "textDocument/completion",
        positionParams(documentUri, line, character),
      );
      const labels = itemsOf(completion).map(({ label }) => label);
      expect(labels).toContain(expected);
      expect(labels).not.toContain(absent);
      const report = await client.request("textDocument/diagnostic", {
        textDocument: { uri: documentUri },
      });
      expect(report.items.some(({ code }) => code === "unsupported-project-version")).toBe(false);
    }
    const englishTokens = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri: englishUri },
    });
    const germanTokens = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri: germanUri },
    });
    expect(englishTokens.data).toEqual([3, 17, 4, 0, 0]);
    expect(germanTokens.data).toEqual([1, 15, 4, 0, 0]);
    expect(client.child.pid).toBe(pid);
  });

  it("refreshes nested definitions without applying parent definitions to sibling files", async () => {
    fs.writeFileSync(
      path.join(directory, "sofistik.def"),
      "SOF_VERSION = 1999\nSOF_LANGUAGE = DE\n",
    );
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const definitionPath = path.join(first, "sofistik.def");
    const definitionUri = fileUri(definitionPath);
    const firstUri = fileUri(path.join(first, "main.dat"));
    const secondUri = fileUri(path.join(second, "main.dat"));
    fs.writeFileSync(definitionPath, "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\n");
    fs.writeFileSync(path.join(second, "sofistik.def"), "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\n");
    await client.start();
    await client.waitFor(
      () => client.registrations.some(({ method }) => method === "workspace/didChangeWatchedFiles"),
      "recursive file watcher registration",
    );
    const registration = client.registrations.find(
      ({ method }) => method === "workspace/didChangeWatchedFiles",
    );
    expect(
      registration.registerOptions.watchers.some(
        ({ globPattern }) =>
          globPattern.pattern?.startsWith("**/") && globPattern.pattern.includes("def"),
      ),
    ).toBe(true);
    client.open(firstUri, SOURCE);
    client.open(secondUri, SOURCE);
    await client.request("textDocument/diagnostic", { textDocument: { uri: firstUri } });

    fs.writeFileSync(definitionPath, "SOF_VERSION = 1998\nSOF_LANGUAGE = DE\n");
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: definitionUri, type: 2 }],
    });
    const unsupported = await client.request("textDocument/diagnostic", {
      textDocument: { uri: firstUri },
    });
    expect(
      unsupported.items.some(
        ({ code, message }) => code === "unsupported-project-version" && message.includes("1998"),
      ),
    ).toBe(true);
    const firstTokens = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri: firstUri },
    });
    const secondTokens = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri: secondUri },
    });
    expect(firstTokens.data).toEqual([]);
    expect(secondTokens.data).toEqual([3, 17, 4, 0, 0]);

    const publishedBeforeDeletion = client.diagnostics(firstUri).length;
    fs.unlinkSync(definitionPath);
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: definitionUri, type: 3 }],
    });
    await client.waitFor(
      () => client.diagnostics(firstUri).length > publishedBeforeDeletion,
      "diagnostics after adjacent definition deletion",
    );
    const fallback = await client.request("textDocument/diagnostic", {
      textDocument: { uri: firstUri },
    });
    expect(fallback.items.some(({ message }) => /1998|1999/.test(message))).toBe(false);
    const completion = await client.request(
      "textDocument/completion",
      positionParams(firstUri, 3, 4),
    );
    expect(itemsOf(completion).map(({ label }) => label)).toContain("NO");
  });

  it("ignores source headers when the adjacent definition selects the context", async () => {
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
