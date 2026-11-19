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

describe("ide-sofistik IDE sessions", () => {
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
    for (const name of ["language-sofistik", "ide"]) await lumine.packages.activatePackage(name);
    await lumine.packages.activatePackage("ide-sofistik");
    service = lumine.packages.getActivePackage("ide").mainModule.provideIde();
  });

  afterEach(async () => {
    for (const editor of editors) editor.destroy();
    await lumine.packages.deactivatePackage("symbol");
    await lumine.packages.deactivatePackage("ide-sofistik");
    await lumine.packages.deactivatePackage("ide");
    await lumine.packages.deactivatePackage("busy-signal");
    await lumine.packages.deactivatePackage("language-sofistik");
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const open = async (project, version, filename = "main.dat") => {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "sofistik.def"), `SOF_VERSION = ${version}\n`);
    const filePath = path.join(project, filename);
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
    expect(tree.every(({ providerName }) => providerName === "SOFiSTiK Language Server")).toBe(
      true,
    );
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
    expect(tree[0].providerName).toBe("SOFiSTiK Language Server");
  });

  it("opens parsed code from unsaved source and include edits using the source definition", async () => {
    lumine.project.setPaths([root]);
    const editor = await open(root, "2026");
    const original = fs.readFileSync(editor.getPath(), "utf8");
    fs.writeFileSync(path.join(root, "sofistik.def"), "SOF_VERSION = 2026\nHUMIDITY = 65\n");
    const includedPath = path.join(root, "humidity.inc");
    fs.writeFileSync(includedPath, "EIGE RH 110\n");
    const included = await lumine.workspace.open(includedPath);
    editors.push(included);
    included.setGrammar(editor.getGrammar());
    included.setText("EIGE RH $(humidity) + 1\n");
    await sessionFor(included);
    const source = '+PROG AQB\n#INCLUDE "humidity.inc"\nEND\n';
    editor.setText(source);
    await sessionFor(editor);
    const main = lumine.packages.getActivePackage("ide-sofistik").mainModule;
    const parsed = await main.openParsedCode({ target: editor.getElement() });
    expect(parsed).not.toBeNull();
    if (parsed) editors.push(parsed);
    expect(parsed.getPath()).toBeUndefined();
    expect(parsed.getText()).toContain("EIGE RH 65 + 1\n");
    expect(parsed.getText()).not.toContain("#INCLUDE");
    expect(parsed.getGrammar()).toBe(editor.getGrammar());
    expect(editor.getText()).toBe(source);
    expect(fs.readFileSync(editor.getPath(), "utf8")).toBe(original);
    expect(fs.readFileSync(includedPath, "utf8")).toBe("EIGE RH 110\n");
  });

  it("opens parsed code for an untitled CADINP editor through the hub URI", async () => {
    lumine.project.setPaths([root]);
    const editor = await lumine.workspace.open();
    editors.push(editor);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.sofistik"));
    const source = "#DEFINE humidity=65\n+PROG AQB\nEIGE RH $(humidity)\nEND\n";
    editor.setText(source);
    await sessionFor(editor);
    const main = lumine.packages.getActivePackage("ide-sofistik").mainModule;
    const parsed = await main.openParsedCode({ target: editor.getElement() });
    expect(parsed).not.toBeNull();
    if (parsed) editors.push(parsed);
    expect(parsed.getPath()).toBeUndefined();
    expect(parsed.getText()).toContain("EIGE RH 65\n");
    expect(parsed.getText()).not.toContain("#DEFINE");
    expect(parsed.getGrammar()).toBe(editor.getGrammar());
    expect(editor.getText()).toBe(source);
  });

  it("expands and watches an explicit include outside the source directory", async () => {
    lumine.project.setPaths([root]);
    const sourceDirectory = path.join(root, "sources");
    const editor = await open(sourceDirectory, "2026");
    const includeDirectory = path.join(root, "[includes]");
    fs.mkdirSync(includeDirectory);
    const includePath = path.join(includeDirectory, "humidity.inc");
    fs.writeFileSync(includePath, "EIGE RH 65\n");
    editor.setText('+PROG AQB\n#INCLUDE "../[includes]/humidity.inc"\nEND\n');
    const session = await sessionFor(editor);
    expect(session.rootPath).toBe(sourceDirectory);
    const expand = () =>
      session.request("workspace/executeCommand", {
        command: "sofistik.expandPreprocessor",
        arguments: [{ uri: pathToFileURL(editor.getPath()).href }],
      });
    const result = await expand();
    expect(result.complete).toBe(true);
    expect(result.text).toContain("EIGE RH 65\n");

    await until(() => {
      const { manager } = session;
      const registrations = manager.dynamicCapabilities.get(session);
      return [...(registrations?.values() || [])].some(
        ({ method, registerOptions }) =>
          method === "workspace/didChangeWatchedFiles" &&
          registerOptions.watchers.some(({ globPattern }) =>
            manager.globMatches(globPattern, includePath),
          ),
      );
    }, "external include watch");
    await lumine.project.getWatcherPromise(root);
    fs.writeFileSync(includePath, "EIGE RH 70\n");
    const updated = await until(async () => {
      const expansion = await expand();
      return expansion.text.includes("EIGE RH 70\n") ? expansion : null;
    }, "updated external include expansion");
    expect(updated.complete).toBe(true);
  });

  it("scrolls a long parsed expansion inside the unsaved editor's viewport", async () => {
    lumine.project.setPaths([root]);
    const workspaceElement = lumine.views.getView(lumine.workspace);
    const originalStyle = workspaceElement.style.cssText;
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "360px";
    jasmine.attachToDOM(workspaceElement);
    const waitForLayout = (editor) =>
      until(() => {
        // Flush the pane mount and editor measurements even when the test
        // window is occluded and animation frames are paused.
        lumine.views.performDocumentUpdate();
        const element = editor.getElement();
        const component = element.component;
        const client = component.refs.clientContainer;
        return (
          element.isConnected &&
          component.hasInitialMeasurements &&
          client.offsetHeight > 0 &&
          component.getClientContainerHeight() === client.offsetHeight
        );
      }, "parsed editor layout");

    try {
      const editor = await lumine.workspace.open();
      editors.push(editor);
      editor.setGrammar(lumine.grammars.grammarForScopeName("source.sofistik"));
      const source =
        "#DEFINE humidity=65\n+PROG AQB\n" + "EIGE RH $(humidity)\n".repeat(250) + "END\n";
      editor.setText(source);
      await sessionFor(editor);
      await waitForLayout(editor);
      const sourceViewportHeight = editor.getElement().getBoundingClientRect().height;

      const main = lumine.packages.getActivePackage("ide-sofistik").mainModule;
      const parsed = await main.openParsedCode({ target: editor.getElement() });
      expect(parsed).not.toBeNull();
      if (!parsed) return;
      editors.push(parsed);
      parsed.update({ smoothScrolling: false });
      await waitForLayout(parsed);
      const element = parsed.getElement();
      const component = element.component;
      expect(parsed.getPath()).toBeUndefined();
      expect(parsed.getText()).toContain("EIGE RH 65\n".repeat(250));
      expect(element.getBoundingClientRect().height).toBeCloseTo(sourceViewportHeight, 0);
      expect(component.getScrollContainerClientHeight()).toBeLessThan(component.getContentHeight());
      expect(component.getMaxScrollTop()).toBeGreaterThan(0);

      const initialScrollTop = element.getScrollTop();
      element.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }),
      );
      expect(element.getScrollTop()).toBeGreaterThan(initialScrollTop);
      expect(component.renderedScrollTop).toBeGreaterThan(initialScrollTop);
      expect(editor.getText()).toBe(source);
    } finally {
      workspaceElement.style.cssText = originalStyle;
    }
  });

  it("shows server indexing through the shared busy service and clears it on completion", async () => {
    const busyMain = (await lumine.packages.activatePackage("busy-signal")).mainModule;
    const ideMain = lumine.packages.getActivePackage("ide").mainModule;
    const registry = busyMain.instance.registry;
    const titles = [];
    const changes = registry.onDidUpdate(() => {
      titles.push(...registry.getTilesActive().map(({ title }) => title));
    });
    const registration = ideMain.consumeBusySignal(busyMain.provideBusySignal());
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

  it("shares the same server session between files in one directory", async () => {
    lumine.project.setPaths([root]);
    const directory = path.join(root, "sources");
    const first = await open(directory, "2026");
    const second = await open(directory, "2026", "secondary.dat");
    const firstSession = await sessionFor(first);
    const secondSession = await sessionFor(second);
    expect(firstSession).toBe(secondSession);
    expect(firstSession.rootPath).toBe(directory);
  });

  it("starts separate sessions for source directories within one Lumine project", async () => {
    lumine.project.setPaths([root]);
    fs.writeFileSync(path.join(root, "sofistik.def"), "SOF_VERSION = 1998\n");
    const firstDirectory = path.join(root, "[a] first");
    const secondDirectory = path.join(root, "[b] second");
    const first = await open(firstDirectory, "2026");
    const second = await open(secondDirectory, "1999");
    const firstSession = await sessionFor(first);
    const secondSession = await sessionFor(second);
    expect(firstSession).not.toBe(secondSession);
    expect(firstSession.rootPath).toBe(firstDirectory);
    expect(secondSession.rootPath).toBe(secondDirectory);
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
      report.items.some(({ code, message }) => code === "G302" && message.includes("1999")),
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
