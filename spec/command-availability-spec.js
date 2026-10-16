describe("SOFiSTiK command availability", () => {
  let main, editor, edge, grammar;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-sofistik")).mainModule;
    editor = await lumine.workspace.open();
    grammar = { scopeName: "source.sofistik" };
    spyOn(editor, "getGrammar").and.callFake(() => grammar);
    editor.getElement().setAttribute("data-grammar", "source sofistik");
    edge = main.consumeIde({ registerAdapter: () => ({ dispose() {} }) });
  });
  afterEach(async () => {
    edge.dispose();
    await lumine.packages.deactivatePackage("ide-sofistik");
  });
  const available = (editor, command) => lumine.commands.canDispatch(editor.getElement(), command);
  it("keeps unsaved expansion available but requires saved unchanged source for diagnostics", () => {
    spyOn(editor, "getText").and.throwError("Availability must not scan source");
    expect(available(editor, "ide-sofistik:open-parsed-code")).toBe(true);
    expect(available(editor, "ide-sofistik:read-calculation-diagnostics")).toBe(false);
    spyOn(editor, "getPath").and.returnValue("C:/work/model.dat");
    const state = spyOn(editor, "getFileState").and.returnValue("modified");
    expect(available(editor, "ide-sofistik:read-calculation-diagnostics")).toBe(false);
    state.and.returnValue("unmodified");
    expect(available(editor, "ide-sofistik:read-calculation-diagnostics")).toBe(true);
  });
  it("rejects a different grammar or a disconnected hub without initializing a server", () => {
    grammar = { scopeName: "source.js" };
    expect(available(editor, "ide-sofistik:open-parsed-code")).toBe(false);
    grammar = { scopeName: "source.sofistik" };
    const changed = jasmine.createSpy("availability changed");
    const lease = lumine.commands.onDidChange(changed);
    edge.dispose();
    expect(available(editor, "ide-sofistik:open-parsed-code")).toBe(false);
    expect(changed).toHaveBeenCalled();
    lease.dispose();
  });
});
