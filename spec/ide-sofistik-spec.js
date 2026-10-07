const { serverContext } = require("./helpers/server-context");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

describe("ide-sofistik adapter", () => {
  let main, directory, edges, editor, adapter, service, session, resolveServer;

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
      isDestroyed: () => false,
    };
    session = {
      adapter: { id: "ide-sofistik" },
      request: jasmine.createSpy("request").and.resolveTo({ imported: 1 }),
    };
    service = {
      registerAdapter: jasmine.createSpy("registerAdapter").and.callFake((value) => {
        adapter = value;
        return { dispose: jasmine.createSpy("disposeRegistration") };
      }),
      reportMissingServer: jasmine.createSpy("reportMissingServer"),
      activeSessionsForEditor: jasmine
        .createSpy("activeSessionsForEditor")
        .and.resolveTo([session]),
      featureEnabled: jasmine.createSpy("featureEnabled").and.returnValue(true),
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

  it("routes the import command to this adapter rather than the first server", async () => {
    const other = { adapter: { id: "another-server" }, request: jasmine.createSpy("otherRequest") };
    service.activeSessionsForEditor.and.resolveTo([other, session]);
    await main.readCalculationDiagnostics();
    expect(other.request).not.toHaveBeenCalled();
    expect(session.request).toHaveBeenCalledOnceWith("workspace/executeCommand", {
      command: "sofistik.readCalculationDiagnostics",
      arguments: [{ uri: pathToFileURL(editor.getPath()).href }],
    });
    expect(service.featureEnabled).toHaveBeenCalledWith(session.adapter, "diagnostics", editor);
  });

  it("uses the editor that dispatched the command", async () => {
    const dispatched = { ...editor, getPath: () => path.join(directory, "clicked.dat") };
    const closest = jasmine.createSpy("closest").and.returnValue({ getModel: () => dispatched });
    await main.readCalculationDiagnostics({ target: { closest } });
    expect(closest).toHaveBeenCalledWith("lumine-text-editor:not([mini])");
    expect(service.activeSessionsForEditor).toHaveBeenCalledWith(dispatched);
    expect(session.request.calls.mostRecent().args[1].arguments[0].uri).toBe(
      pathToFileURL(dispatched.getPath()).href,
    );
  });

  it("returns silently with no editor", async () => {
    lumine.workspace.getActiveTextEditor.and.returnValue(null);
    await main.readCalculationDiagnostics();
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
    expect(session.request).not.toHaveBeenCalled();
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
      expect(service.activeSessionsForEditor).not.toHaveBeenCalled();
      expect(session.request).not.toHaveBeenCalled();
    });
  }

  it("refuses disabled diagnostics and an unavailable server", async () => {
    service.featureEnabled.and.returnValue(false);
    await main.readCalculationDiagnostics();
    expect(session.request).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
    service.activeSessionsForEditor.and.resolveTo([]);
    await main.readCalculationDiagnostics();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(2);
  });

  it("rechecks changes made while waiting for the server", async () => {
    service.activeSessionsForEditor.and.callFake(async () => {
      editor.getFileState = () => "modified";
      return [session];
    });
    await main.readCalculationDiagnostics();
    expect(session.request).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
  });

  it("does not import a replacement path or use a disposed client edge", async () => {
    service.activeSessionsForEditor.and.callFake(async () => {
      editor.getPath = () => path.join(directory, "replacement.dat");
      return [session];
    });
    await main.readCalculationDiagnostics();
    expect(session.request).not.toHaveBeenCalled();
    service.activeSessionsForEditor.and.callFake(async () => {
      edges[0].dispose();
      return [session];
    });
    await main.readCalculationDiagnostics();
    expect(session.request).not.toHaveBeenCalled();
  });

  it("reports server-side import errors with their reason", async () => {
    session.request.and.rejectWith(new Error("No calculation log exists"));
    await main.readCalculationDiagnostics();
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "Unable to read SOFiSTiK calculation diagnostics",
      { detail: "No calculation log exists", dismissable: true },
    );
  });

  it("guards calculation-log import through the real TextEditor buffer before and after saving", async () => {
    await lumine.packages.activatePackage("language-sofistik");
    const filePath = path.join(directory, "actual.dat");
    const source = "+PROG ASE\nEND\n";
    fs.writeFileSync(filePath, source);
    const actual = await lumine.workspace.open(filePath);
    try {
      actual.setGrammar(lumine.grammars.grammarForScopeName("source.sofistik"));
      const target = lumine.views.getView(actual);
      expect(actual.isModified).toBeUndefined();
      expect(actual.getBuffer().isModified).toBeUndefined();
      expect(actual.getFileState()).toBe("unmodified");
      await main.readCalculationDiagnostics({ target });
      expect(service.activeSessionsForEditor).toHaveBeenCalledWith(actual);
      expect(session.request).toHaveBeenCalledTimes(1);

      session.request.calls.reset();
      service.activeSessionsForEditor.calls.reset();
      actual.setText(source + "$ changed\n");
      expect(actual.getFileState()).toBe("modified");
      await main.readCalculationDiagnostics({ target });
      expect(service.activeSessionsForEditor).not.toHaveBeenCalled();
      expect(session.request).not.toHaveBeenCalled();
      expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
        "Save changes to the SOFiSTiK file before reading calculation diagnostics.",
      );

      await actual.save();
      expect(actual.getFileState()).toBe("unmodified");
      await main.readCalculationDiagnostics({ target });
      expect(session.request).toHaveBeenCalledOnceWith("workspace/executeCommand", {
        command: "sofistik.readCalculationDiagnostics",
        arguments: [{ uri: pathToFileURL(filePath).href }],
      });
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
