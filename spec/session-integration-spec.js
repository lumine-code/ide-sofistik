const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const until = async (check, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
};

describe("ide-sofistik client sessions", () => {
  let service, root, editors, previousPaths, timeout;

  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
  });

  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });

  beforeEach(async () => {
    jasmine.useRealClock();
    previousPaths = lumine.project.getPaths();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-sofistik-sessions-"));
    editors = [];
    for (const name of ["language-sofistik", "ide-client"])
      await lumine.packages.activatePackage(name);
    await lumine.packages.activatePackage("ide-sofistik");
    service = lumine.packages.getActivePackage("ide-client").mainModule.provideIdeClient();
  });

  afterEach(async () => {
    for (const editor of editors) editor.destroy();
    await lumine.packages.deactivatePackage("symbol");
    await lumine.packages.deactivatePackage("ide-sofistik");
    await lumine.packages.deactivatePackage("ide-client");
    await lumine.packages.deactivatePackage("busy-signal");
    await lumine.packages.deactivatePackage("language-sofistik");
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const open = async (project, version) => {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "sofistik.def"), `SOF_VERSION = ${version}\n`);
    const filePath = path.join(project, "main.dat");
    fs.writeFileSync(filePath, "+PROG ASE\nGRP NO 1 VAL FULL\nEND\n");
    const editor = await lumine.workspace.open(filePath);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.sofistik"));
    editors.push(editor);
    return editor;
  };

  const sessionFor = (editor) =>
    until(async () => {
      const sessions = await service.activeSessionsForEditor(editor);
      return sessions.find(({ adapter }) => adapter.id === "ide-sofistik");
    }, "SOFiSTiK session");

  const symbolTreeFor = (registry, editor, names) =>
    until(async () => {
      const tree = await registry.getFileSymbolTree(editor);
      return tree && JSON.stringify(tree.map(({ name }) => name)) === JSON.stringify(names)
        ? tree
        : null;
    }, "SOFiSTiK symbol tree");

  it("shares hierarchical program and command symbols through the hub after unsaved edits", async () => {
    lumine.project.setPaths([root]);
    const editor = await open(root, "2026");
    const source =
      "+PROG SOFIMSHA\nHEAD Example\nNODE 1 X 0 Y 0\n     2 X 1 Y 0\nNODE 3 X 2 Y 0\nEND\n+PROG ASE\nGRP NO 1 VAL FULL\nEND\n";
    editor.setText(source);
    await sessionFor(editor);
    const main = (await lumine.packages.activatePackage("symbol")).mainModule;
    const registry = main.provideSymbolRegistry();
    const tree = await symbolTreeFor(registry, editor, ["SOFIMSHA", "ASE"]);
    expect(tree[0].tag).toBe("module");
    expect(tree[0].range.serialize()).toEqual([
      [0, 0],
      [6, 0],
    ]);
    expect(tree[0].children.map(({ name }) => name)).toEqual(["HEAD", "NODE", "NODE"]);
    expect(tree[0].children[1].tag).toBe("method");
    expect(tree[0].children[1].range.serialize()).toEqual([
      [2, 0],
      [4, 0],
    ]);
    expect(tree[0].children[2].position.toArray()).toEqual([4, 0]);
    expect(tree[1].children.map(({ name }) => name)).toEqual(["GRP"]);
    expect(tree.every(({ providerName }) => providerName === "Language Server")).toBe(true);
    const flat = await registry.getFileSymbols(editor);
    expect(flat.filter(({ name }) => name === "NODE").map(({ context }) => context)).toEqual([
      "SOFIMSHA",
      "SOFIMSHA",
    ]);
    expect(registry.peekFileSymbolTree(editor)).toBe(tree);

    editor.setText("+PROG AQUA\nHEAD Changed\nCONC NO 1 C 30\nEND\n");
    const changed = await symbolTreeFor(registry, editor, ["AQUA"]);
    expect(changed[0].children.map(({ name }) => name)).toEqual(["HEAD", "CONC"]);
    expect(changed[0].range.serialize()).toEqual([
      [0, 0],
      [4, 0],
    ]);
    expect(fs.readFileSync(editor.getPath(), "utf8")).toBe("+PROG ASE\nGRP NO 1 VAL FULL\nEND\n");
    expect((await registry.getFileSymbols(editor)).some(({ name }) => name === "NODE")).toBe(false);
  });

  it("provides hierarchical symbols for a new untitled buffer", async () => {
    lumine.project.setPaths([root]);
    const editor = await lumine.workspace.open();
    editors.push(editor);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.sofistik"));
    editor.setText("+PROG AQUA\nHEAD Untitled\nCONC NO 1 C 30\nEND\n");
    await sessionFor(editor);
    const main = (await lumine.packages.activatePackage("symbol")).mainModule;
    const tree = await symbolTreeFor(main.provideSymbolRegistry(), editor, ["AQUA"]);
    expect(editor.getPath()).toBeUndefined();
    expect(tree[0].children.map(({ name }) => name)).toEqual(["HEAD", "CONC"]);
    expect(tree[0].children[1].position.toArray()).toEqual([2, 0]);
    expect(tree[0].providerName).toBe("Language Server");
  });

  it("shows server indexing through the shared busy service and clears it on completion", async () => {
    const busyMain = (await lumine.packages.activatePackage("busy-signal")).mainModule;
    const clientMain = lumine.packages.getActivePackage("ide-client").mainModule;
    const registry = busyMain.instance.registry;
    const titles = [];
    const changes = registry.onDidUpdate(() => {
      titles.push(...registry.getTilesActive().map(({ title }) => title));
    });
    const registration = clientMain.consumeBusySignal(busyMain.provideBusySignal());
    try {
      lumine.project.setPaths([root]);
      const editor = await open(root, "2026");
      const session = await sessionFor(editor);
      await session.request("workspace/symbol", { query: "" });
      const prefix = "SOFiSTiK Language Server: Indexing CADINP project";
      await until(() => titles.includes(`${prefix} (Indexed 1 file)`), "indexed file count");
      expect(titles).toContain(`${prefix} (Discovering files)`);
      expect(session.progressTitles.size).toBe(0);
      expect(registry.getTilesActive().some(({ title }) => title.startsWith(prefix))).toBe(false);
      expect(session.state).toBe("running");
      await lumine.packages.deactivatePackage("ide-sofistik");
      await until(() => session.state === "stopped", "server teardown");
      expect(registry.getTilesActive()).toEqual([]);
      expect(registry.providers.size).toBe(0);
    } finally {
      registration.dispose();
      changes.dispose();
    }
  });

  it("routes two project roots to separate server sessions", async () => {
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    fs.mkdirSync(firstRoot);
    fs.mkdirSync(secondRoot);
    lumine.project.setPaths([firstRoot, secondRoot]);
    const first = await open(firstRoot, "2026");
    const second = await open(secondRoot, "2025");
    const firstSession = await sessionFor(first);
    const secondSession = await sessionFor(second);
    expect(firstSession).not.toBe(secondSession);
    expect(firstSession.rootPath).toBe(firstRoot);
    expect(secondSession.rootPath).toBe(secondRoot);
    expect(service.adaptersForEditor(first).map(({ id }) => id)).toContain("ide-sofistik");
  });

  it("shares a workspace session while retaining each source directory's release", async () => {
    lumine.project.setPaths([root]);
    fs.writeFileSync(path.join(root, "sofistik.def"), "SOF_VERSION = 1998\n");
    const first = await open(path.join(root, "first"), "2026");
    const second = await open(path.join(root, "second"), "1999");
    const firstSession = await sessionFor(first);
    const secondSession = await sessionFor(second);
    expect(firstSession).toBe(secondSession);
    expect(firstSession.rootPath).toBe(root);
    const firstUri = pathToFileURL(first.getPath()).href;
    const secondUri = pathToFileURL(second.getPath()).href;
    const firstTokens = await firstSession.request("textDocument/semanticTokens/full", {
      textDocument: { uri: firstUri },
    });
    const secondTokens = await secondSession.request("textDocument/semanticTokens/full", {
      textDocument: { uri: secondUri },
    });
    expect(firstTokens.data).toEqual([1, 13, 4, 0, 0]);
    expect(secondTokens.data).toEqual([]);
    const report = await secondSession.request("textDocument/diagnostic", {
      textDocument: { uri: secondUri },
    });
    expect(
      report.items.some(
        ({ code, message }) => code === "unsupported-project-version" && message.includes("1999"),
      ),
    ).toBe(true);
  });

  it("stops owned sessions when unloaded and reacquires a new package generation", async () => {
    lumine.project.setPaths([root]);
    const editor = await open(root, "2026");
    const previous = await sessionFor(editor);
    const previousPackage = lumine.packages.getActivePackage("ide-sofistik");
    const previousMain = previousPackage.mainModule;
    const packagePath = previousPackage.path;
    await lumine.packages.deactivatePackage("ide-sofistik");
    await until(() => previous.state === "stopped", "server teardown");
    expect(service.adaptersForEditor(editor).some(({ id }) => id === "ide-sofistik")).toBe(false);
    await lumine.packages.unloadPackage("ide-sofistik");
    const current = await lumine.packages.activatePackage(packagePath);
    const currentMain = current.mainModule;
    expect(currentMain).not.toBe(previousMain);
    const replacement = await sessionFor(editor);
    expect(replacement).not.toBe(previous);
    expect(replacement.state).toBe("running");
  });
});
