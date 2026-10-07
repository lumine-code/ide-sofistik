const { serverContext } = require("./helpers/server-context");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

describe("ide-sofistik adapter", () => {
  let main, directory, edges, editor, adapter, service, resolveServer;

  beforeEach(async () => {
    const pkg = await lumine.packages.activatePackage("ide-sofistik");
    main = pkg.mainModule;
    const resolver = require("../lib/server").resolveServer;
    resolveServer = (configuredPath) =>
      resolver(serverContext({ rootPath: directory }), configuredPath);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ide-sofistik-spec-"));
    edges = [];
    editor = {
      getGrammar: () => ({ scopeName: "source.sofistik" }),
      getPath: () => path.join(directory, "source.dat"),
      getFileState: () => "unmodified",
      getText: () => "",
      isDestroyed: () => false,
    };
    service = {
      registerAdapter: jasmine.createSpy("registerAdapter").and.callFake((value) => {
        adapter = value;
        return { dispose: jasmine.createSpy("disposeRegistration") };
      }),
      reportMissingServer: jasmine.createSpy("reportMissingServer"),
      requestForDocument: jasmine
        .createSpy("requestForDocument")
        .and.callFake(async (target, options) => {
          if (!options.validate()) return null;
          return {
            result: { imported: 1 },
            document: { uri: pathToFileURL(target.getPath()).href, version: 1 },
            isCurrent: () => true,
          };
        }),
    };
    spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(editor);
    spyOn(lumine.notifications, "addWarning");
    edges.push(main.consumeIde(service));
  });

  afterEach(async () => {
    for (const edge of edges) edge.dispose();
    for (const key of ["serverPath", "textCase", "encoding"])
      lumine.config.unset(`ide-sofistik.${key}`);
    await lumine.packages.deactivatePackage("ide-sofistik");
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("registers the project-root adapter and disposes only its service edge", () => {
    expect(adapter.id).toBe("ide-sofistik");
    expect(adapter.grammarScopes).toEqual(["source.sofistik"]);
    expect(adapter.languageId).toBe("sofistik");
    expect(adapter.sessionScope).toBe("project-root");
    expect(adapter.restartKeyPaths).toEqual(["ide-sofistik.serverPath"]);
    expect(adapter.settingsKeyPaths).toEqual(["ide-sofistik"]);
    const registration = service.registerAdapter.calls.mostRecent().returnValue;
    edges[0].dispose();
    expect(registration.dispose).toHaveBeenCalledTimes(1);
    expect(main.ide).toBeNull();
  });

  it("keeps a replacement client edge when an older provider disappears", () => {
    const replacement = { ...service, registerAdapter: () => ({ dispose() {} }) };
    edges.push(main.consumeIde(replacement));
    edges[0].dispose();
    expect(main.ide).toBe(replacement);
  });

  it("forwards completion and file-reading settings without installation settings", () => {
    lumine.config.set("ide-sofistik.textCase", "lower");
    expect(adapter.getSettings()).toEqual({
      sofistik: { textCase: "lower", encoding: "utf-8" },
    });
    expect(adapter.getWorkspaceConfiguration).toBeUndefined();
  });

  it("uses uppercase completions and UTF-8 by default", () => {
    expect(main.serverSettings()).toEqual({
      textCase: "upper",
      encoding: "utf-8",
    });
  });

  it("launches a configured JavaScript entry with the editor's Node runtime", async () => {
    const entry = path.join(directory, "server.js");
    fs.writeFileSync(entry, "");
    lumine.config.set("ide-sofistik.serverPath", entry);
    const launch = await adapter.resolveServer(serverContext({ rootPath: directory }));
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([entry, "--stdio"]);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(launch.cwd).toBe(directory);
    expect(launch.transport).toBe("stdio");
  });

  it("launches a configured executable directly and never falls back from a bad path", async () => {
    const launch = await resolveServer(process.execPath);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["--stdio"]);
    expect(launch.env).toBeUndefined();
    await expectAsync(resolveServer(path.join(directory, "missing.js"))).toBeRejected();
    await expectAsync(resolveServer("relative/server.js")).toBeRejectedWithError(/absolute path/);
  });

  it("resolves the git-pinned bundled entry without a separately installed Node", async () => {
    const launch = await resolveServer("");
    expect(launch.command).toBe(process.execPath);
    expect(fs.existsSync(launch.args[0])).toBe(true);
    expect(launch.args[0]).toContain("sofistik-language-server");
    expect(launch.args[1]).toBe("--stdio");
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("declares only implemented feature switches, without editor-side LSP providers", () => {
    const pkg = require("../package.json");
    expect(Object.keys(pkg.configSchema.features.properties)).toEqual([
      "diagnostics",
      "autocomplete",
      "hover",
      "signature",
      "definition",
      "references",
      "symbols",
      "semanticTokens",
    ]);
    for (const feature of Object.values(pkg.configSchema.features.properties)) {
      expect(feature.default).toBe(true);
      expect(feature.scopeResolution).toBe("grammar");
    }
    expect(Object.keys(pkg.providedServices)).toEqual(["background-tips.provider"]);
    expect(adapter.managedServer).toBeUndefined();
    expect(adapter.installServer).toBeUndefined();
    expect(main.provideBackgroundTips().packageName).toBe(pkg.name);
    expect(main.provideBackgroundTips().tips[0]).toContain("{% else %}");
  });

  it("routes import through the synchronized document API and diagnostics switch", async () => {
    expect(await main.readCalculationDiagnostics()).toEqual({ imported: 1 });
    const [target, options] = service.requestForDocument.calls.mostRecent().args;
    expect(target).toBe(editor);
    expect(options.adapterId).toBe("ide-sofistik");
    expect(options.feature).toBe("diagnostics");
    expect(options.method).toBe("workspace/executeCommand");
    expect(options.params({ uri: "file:///synchronized.dat" })).toEqual({
      command: "sofistik.readCalculationDiagnostics",
      arguments: [{ uri: "file:///synchronized.dat" }],
    });
  });

  it("uses the editor that dispatched the import command", async () => {
    const dispatched = { ...editor, getPath: () => path.join(directory, "clicked.dat") };
    const closest = jasmine.createSpy("closest").and.returnValue({ getModel: () => dispatched });
    await main.readCalculationDiagnostics({ target: { closest } });
    expect(closest).toHaveBeenCalledWith("lumine-text-editor:not([mini])");
    expect(service.requestForDocument.calls.mostRecent().args[0]).toBe(dispatched);
  });

  it("returns silently with no editor", async () => {
    lumine.workspace.getActiveTextEditor.and.returnValue(null);
    await main.readCalculationDiagnostics();
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
    expect(service.requestForDocument).not.toHaveBeenCalled();
  });

  for (const [reason, change] of [
    ["wrong grammar", () => (editor.getGrammar = () => ({ scopeName: "source.python" }))],
    ["unsaved", () => (editor.getPath = () => null)],
    ["modified", () => (editor.getFileState = () => "modified")],
  ]) {
    it(`explains why a ${reason} document cannot import calculation diagnostics`, async () => {
      change();
      await main.readCalculationDiagnostics();
      expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
      expect(service.requestForDocument).not.toHaveBeenCalled();
    });
  }

  it("explains disabled diagnostics and an unavailable server", async () => {
    service.requestForDocument.and.rejectWith(
      Object.assign(new Error("disabled"), { code: "IDE_FEATURE_DISABLED" }),
    );
    await main.readCalculationDiagnostics();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
    service.requestForDocument.and.resolveTo(null);
    await main.readCalculationDiagnostics();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(2);
  });

  it("revalidates saved-source preconditions after synchronization", async () => {
    service.requestForDocument.and.callFake(async (_, options) => {
      editor.getFileState = () => "modified";
      expect(options.validate()).toBeFalse();
      return null;
    });
    expect(await main.readCalculationDiagnostics()).toBeNull();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
  });

  it("discards results from a disposed service edge", async () => {
    service.requestForDocument.and.callFake(async (_, options) => {
      edges[0].dispose();
      expect(options.signal.aborted).toBeTrue();
      return { result: { imported: 1 } };
    });
    expect(await main.readCalculationDiagnostics()).toBeNull();
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  it("reports server-side import errors with their reason", async () => {
    service.requestForDocument.and.rejectWith(new Error("No calculation log exists"));
    await main.readCalculationDiagnostics();
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "Unable to read SOFiSTiK calculation diagnostics",
      { detail: "No calculation log exists", dismissable: true },
    );
  });

  it("guards a real TextEditor before and after saving", async () => {
    await lumine.packages.activatePackage("language-sofistik");
    const filePath = path.join(directory, "actual.dat");
    fs.writeFileSync(filePath, "+PROG ASE\nEND\n");
    const actual = await lumine.workspace.open(filePath);
    try {
      actual.setGrammar(lumine.grammars.grammarForScopeName("source.sofistik"));
      const target = lumine.views.getView(actual);
      expect(await main.readCalculationDiagnostics({ target })).toEqual({ imported: 1 });
      service.requestForDocument.calls.reset();
      actual.setText("+PROG ASE\nEND\n$ changed\n");
      await main.readCalculationDiagnostics({ target });
      expect(service.requestForDocument).not.toHaveBeenCalled();
      await actual.save();
      expect(await main.readCalculationDiagnostics({ target })).toEqual({ imported: 1 });
    } finally {
      actual.destroy();
    }
  });

  it("registers its workspace command synchronously and removes it on deactivation", async () => {
    const target = lumine.views.getView(lumine.workspace);
    const names = () => lumine.commands.findCommands({ target }).map(({ name }) => name);
    expect(names()).toContain("ide-sofistik:open-parsed-code");
    expect(names()).toContain("ide-sofistik:read-calculation-diagnostics");
    await lumine.packages.deactivatePackage("ide-sofistik");
    expect(names()).not.toContain("ide-sofistik:open-parsed-code");
    expect(names()).not.toContain("ide-sofistik:read-calculation-diagnostics");
    const current = await lumine.packages.activatePackage("ide-sofistik");
    main = current.mainModule;
    expect(names()).toContain("ide-sofistik:open-parsed-code");
    expect(names()).toContain("ide-sofistik:read-calculation-diagnostics");
  });
});

describe("ide-sofistik shared server resolution", () => {
  it("uses the configured server without reading an invalid managed installation", async () => {
    const getManagedServer = jasmine
      .createSpy("getManagedServer")
      .and.throwError("The managed installation is corrupt.");
    const context = serverContext({ rootPath: __dirname, getManagedServer });
    const { resolveServer: resolveWithContext } = require("../lib/server");
    const launch = await resolveWithContext(context, process.execPath);
    expect(launch.command).toBe(process.execPath);
    expect(launch.version).toBeUndefined();
    expect(getManagedServer).not.toHaveBeenCalled();
  });

  it("preserves an unavailable selection as null", async () => {
    const { resolveServer: resolveWithContext } = require("../lib/server");
    const resolver = { select: jasmine.createSpy("select").and.resolveTo(null) };
    expect(await resolveWithContext({ rootPath: __dirname, resolver }, "")).toBeNull();
  });
});
