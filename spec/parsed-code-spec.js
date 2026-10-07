const path = require("node:path");
const { pathToFileURL } = require("node:url");

describe("ide-sofistik parsed code", () => {
  let main, edge, editor, grammar, document, service, parsed, source, response, result;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-sofistik")).mainModule;
    grammar = { scopeName: "source.sofistik" };
    source = "#DEFINE humidity=65\n+PROG AQB\nEIGE RH $(humidity)\nEND\n";
    editor = {
      getGrammar: () => grammar,
      getPath: () => path.join(__dirname, "model.dat"),
      getText: () => source,
      getFileState: () => "modified",
      isDestroyed: () => false,
    };
    document = { uri: pathToFileURL(editor.getPath()).href, version: 3, text: source };
    result = {
      uri: document.uri,
      version: 3,
      text: "+PROG AQB\nEIGE RH 65\nEND\n",
      complete: true,
    };
    response = {
      document,
      result,
      isCurrent: () => source === document.text && document.version === 3,
    };
    service = {
      registerAdapter: () => ({ dispose() {} }),
      requestForDocument: jasmine
        .createSpy("requestForDocument")
        .and.callFake(async () => response),
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

  it("requests the synchronized adapter document and opens an unsaved expansion", async () => {
    expect(await main.openParsedCode()).toBe(parsed);
    const [target, options] = service.requestForDocument.calls.mostRecent().args;
    expect(target).toBe(editor);
    expect(options.adapterId).toBe("ide-sofistik");
    expect(options.method).toBe("workspace/executeCommand");
    expect(options.params(document)).toEqual({
      command: "sofistik.expandPreprocessor",
      arguments: [{ uri: document.uri }],
    });
    expect(options.signal.aborted).toBeFalse();
    expect(parsed.setText).toHaveBeenCalledWith(result.text);
    expect(parsed.setGrammar).toHaveBeenCalledWith(grammar);
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });
  it("uses the hub's untitled URI without requiring a saved source", async () => {
    editor.getPath = () => undefined;
    document.uri = result.uri = "untitled:lumine-source.dat";
    expect(await main.openParsedCode()).toBe(parsed);
    const options = service.requestForDocument.calls.mostRecent().args[1];
    expect(options.params(document).arguments).toEqual([{ uri: document.uri }]);
  });
  it("uses the editor that dispatched the command", async () => {
    lumine.workspace.getActiveTextEditor.and.returnValue(null);
    const closest = jasmine.createSpy("closest").and.returnValue({ getModel: () => editor });
    expect(await main.openParsedCode({ target: { closest } })).toBe(parsed);
    expect(closest).toHaveBeenCalledWith("lumine-text-editor:not([mini])");
    expect(service.requestForDocument.calls.mostRecent().args[0]).toBe(editor);
  });
  it("returns quietly without a surface and explains a wrong grammar", async () => {
    lumine.workspace.getActiveTextEditor.and.returnValue(null);
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
    lumine.workspace.getActiveTextEditor.and.returnValue(editor);
    grammar = { scopeName: "source.python" };
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
    expect(service.requestForDocument).not.toHaveBeenCalled();
  });
  it("explains a missing IDE service or server", async () => {
    service.requestForDocument.and.resolveTo(null);
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "The SOFiSTiK language server is unavailable.",
    );
    edge.dispose();
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "Enable ide to open SOFiSTiK parsed code.",
    );
  });
  for (const invalid of [{ uri: "untitled:another.dat" }, { version: 2 }]) {
    it(`refuses a response for the wrong ${invalid.uri ? "document" : "version"}`, async () => {
      Object.assign(result, invalid);
      expect(await main.openParsedCode()).toBeNull();
      expect(lumine.workspace.buildTextEditor).not.toHaveBeenCalled();
    });
  }
  it("refuses a response that the hub marks stale", async () => {
    response.isCurrent = () => false;
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.workspace.buildTextEditor).not.toHaveBeenCalled();
  });
  it("cancels requests when their consumed service edge disappears", async () => {
    service.requestForDocument.and.callFake(async (_, options) => {
      edge.dispose();
      expect(options.signal.aborted).toBeTrue();
      return response;
    });
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.workspace.buildTextEditor).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });
  it("opens an incomplete expansion when uncertainty metadata is unavailable", async () => {
    result.complete = false;
    expect(await main.openParsedCode()).toBe(parsed);
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "The SOFiSTiK preprocessor expansion is incomplete.",
      {
        detail:
          "Some input could not be resolved, a directive is unsupported, or an expansion limit was reached.",
        dismissable: true,
      },
    );
  });
  it("preserves runtime APPLY input without an incomplete preprocessor warning", async () => {
    result.complete = false;
    result.text = '+PROG CSM\nEND\n+apply "[c] main_csm.dat"\n';
    result.uncertainties = [
      { kind: "apply", start: result.text.indexOf("+apply"), end: result.text.length },
    ];
    expect(await main.openParsedCode()).toBe(parsed);
    expect(parsed.setText).toHaveBeenCalledWith(result.text);
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });
  it("warns about incomplete preprocessing alongside runtime APPLY input", async () => {
    result.complete = false;
    result.text = '+apply "generated.dat"\n';
    result.uncertainties = [
      { kind: "include", start: 0, end: 0 },
      { kind: "apply", start: 0, end: result.text.length },
    ];
    expect(await main.openParsedCode()).toBe(parsed);
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "The SOFiSTiK preprocessor expansion is incomplete.",
      {
        detail:
          "Some input could not be resolved, a directive is unsupported, or an expansion limit was reached.",
        dismissable: true,
      },
    );
  });
  it("reports a stale source rejected by the hub", async () => {
    service.requestForDocument.and.rejectWith(
      Object.assign(new Error("changed"), { code: "IDE_DOCUMENT_CHANGED" }),
    );
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "The SOFiSTiK source changed while its parsed code was being prepared.",
    );
  });
  it("reports a server error without opening an editor", async () => {
    service.requestForDocument.and.rejectWith(new Error("Expansion failed."));
    expect(await main.openParsedCode()).toBeNull();
    expect(lumine.workspace.buildTextEditor).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "Unable to open SOFiSTiK parsed code",
      { detail: "Expansion failed.", dismissable: true },
    );
  });
  it("destroys the new editor if its source changes while it opens", async () => {
    lumine.workspace.open.and.callFake(async () => {
      source = "changed";
      return parsed;
    });
    expect(await main.openParsedCode()).toBeNull();
    expect(parsed.destroy).toHaveBeenCalledTimes(1);
  });
});
