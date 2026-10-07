const path = require("path");
const { pathToFileURL } = require("url");

describe("ide-sofistik parsed code", () => {
  let main, edge, editor, grammar, document, session, service, parsed;

  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-sofistik")).mainModule;
    grammar = { scopeName: "source.sofistik" };
    editor = {
      getGrammar: () => grammar,
      getPath: () => path.join(__dirname, "model.dat"),
      getText: () => "#DEFINE humidity=65\n+PROG AQB\nEIGE RH $(humidity)\nEND\n",
      getFileState: () => "modified",
      isDestroyed: () => false,
    };
    document = { editor, uri: pathToFileURL(editor.getPath()).href, version: 3 };
    session = {
      adapter: { id: "ide-sofistik" },
      state: "running",
      documents: new Map([[document.uri, document]]),
      waitForDocumentSync: jasmine.createSpy("waitForDocumentSync").and.resolveTo(),
      request: jasmine.createSpy("request").and.callFake(async () => ({
        uri: document.uri,
        version: document.version,
        text: "+PROG AQB\nEIGE RH 65\nEND\n",
        complete: true,
        uncertainties: [],
      })),
    };
    service = {
      registerAdapter: () => ({ dispose() {} }),
      activeSessionsForEditor: jasmine
        .createSpy("activeSessionsForEditor")
        .and.resolveTo([session]),
    };
    edge = main.consumeIde(service);
    parsed = {
      setText: jasmine.createSpy("setText"),
      setGrammar: jasmine.createSpy("setGrammar"),
      destroy: jasmine.createSpy("destroy"),
    };
    spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(editor);
    spyOn(lumine.workspace, "buildTextEditor").and.returnValue(parsed);
    spyOn(lumine.workspace, "open").and.resolveTo(parsed);
    spyOn(lumine.notifications, "addWarning");
  });

  afterEach(async () => {
    edge.dispose();
    await lumine.packages.deactivatePackage("ide-sofistik");
  });

  it("joins document synchronization and opens an unsaved expansion from the correct adapter", async () => {
    const other = { adapter: { id: "other" }, request: jasmine.createSpy("otherRequest") };
    service.activeSessionsForEditor.and.resolveTo([other, session]);
    let synchronized;
    session.waitForDocumentSync.and.returnValue(
      new Promise((resolve) => {
        synchronized = resolve;
      }),
    );
    const opened = main.openParsedCode();
    await Promise.resolve();
    expect(session.waitForDocumentSync).toHaveBeenCalledWith(document);
    expect(session.request).not.toHaveBeenCalled();
    synchronized();
    expect(await opened).toBe(parsed);
    expect(other.request).not.toHaveBeenCalled();
    expect(session.request).toHaveBeenCalledOnceWith("workspace/executeCommand", {
      command: "sofistik.expandPreprocessor",
      arguments: [{ uri: document.uri }],
    });
    expect(parsed.setText).toHaveBeenCalledWith("+PROG AQB\nEIGE RH 65\nEND\n");
    expect(parsed.setGrammar).toHaveBeenCalledWith(grammar);
    expect(lumine.workspace.open).toHaveBeenCalledWith(parsed);
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  it("uses the hub's untitled URI without requiring a saved source", async () => {
    editor.getPath = () => undefined;
    document.uri = "untitled:lumine-source.dat";
    expect(await main.openParsedCode()).toBe(parsed);
    expect(session.request.calls.mostRecent().args[1].arguments).toEqual([
      { uri: "untitled:lumine-source.dat" },
    ]);
  });

  it("uses the editor that dispatched the command", async () => {
    lumine.workspace.getActiveTextEditor.and.returnValue(null);
    const closest = jasmine.createSpy("closest").and.returnValue({ getModel: () => editor });
    expect(await main.openParsedCode({ target: { closest } })).toBe(parsed);
    expect(closest).toHaveBeenCalledWith("lumine-text-editor:not([mini])");
    expect(service.activeSessionsForEditor).toHaveBeenCalledWith(editor);
  });

  it("returns quietly without a surface and explains a wrong grammar", async () => {
    lumine.workspace.getActiveTextEditor.and.returnValue(null);
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
    lumine.workspace.getActiveTextEditor.and.returnValue(editor);
    grammar = { scopeName: "source.python" };
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
    expect(service.activeSessionsForEditor).not.toHaveBeenCalled();
  });

  it("explains missing IDE service and server", async () => {
    service.activeSessionsForEditor.and.resolveTo([]);
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "The SOFiSTiK language server is unavailable.",
    );
    edge.dispose();
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "Enable ide to open SOFiSTiK parsed code.",
    );
    expect(lumine.workspace.buildTextEditor).not.toHaveBeenCalled();
  });

  it("refuses source changes while the server starts", async () => {
    service.activeSessionsForEditor.and.callFake(async () => {
      editor.getText = () => "+PROG ASE\nEND\n";
      return [session];
    });
    expect(await main.openParsedCode()).toBeNull();
    expect(session.request).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
  });

  it("refuses a newer document generation even if its text was restored", async () => {
    session.request.and.callFake(async () => {
      const result = { uri: document.uri, version: document.version, text: "old", complete: true };
      document.version++;
      return result;
    });
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.workspace.buildTextEditor).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
  });

  for (const invalid of [{ uri: "untitled:another.dat", version: 3 }, { version: 2 }]) {
    it(`refuses a response for the wrong ${invalid.uri ? "document" : "version"}`, async () => {
      session.request.and.resolveTo({ uri: document.uri, text: "old", ...invalid });
      expect(await main.openParsedCode()).toBeNull();
      expect(lumine.workspace.buildTextEditor).not.toHaveBeenCalled();
    });
  }

  it("does not open a result through a disposed service edge", async () => {
    session.request.and.callFake(async () => {
      edge.dispose();
      return { uri: document.uri, version: document.version, text: "old" };
    });
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.workspace.buildTextEditor).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  it("opens an incomplete expansion unchanged and explains the missing input", async () => {
    session.request.and.resolveTo({
      uri: document.uri,
      version: document.version,
      text: "+PROG AQB\nEIGE RH $(missing)\nEND\n",
      complete: false,
      uncertainties: [{ start: 10, end: 28, kind: "macro" }],
    });
    expect(await main.openParsedCode()).toBe(parsed);
    expect(parsed.setText).toHaveBeenCalledWith("+PROG AQB\nEIGE RH $(missing)\nEND\n");
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "The SOFiSTiK preprocessor expansion is incomplete.",
      {
        detail: "Some input could not be resolved or an expansion limit was reached.",
        dismissable: true,
      },
    );
  });

  it("reports a server error without opening an editor", async () => {
    session.request.and.rejectWith(new Error("Document changed during analysis."));
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.workspace.buildTextEditor).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "Unable to open SOFiSTiK parsed code",
      { detail: "Document changed during analysis.", dismissable: true },
    );
  });

  it("destroys the new editor if the source changes while it opens", async () => {
    lumine.workspace.open.and.callFake(async () => {
      editor.getText = () => "changed";
      return parsed;
    });
    expect(await main.openParsedCode()).toBeNull();
    expect(parsed.destroy).toHaveBeenCalledTimes(1);
  });
});
