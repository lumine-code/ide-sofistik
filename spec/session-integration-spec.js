const fs = require("fs");
const os = require("os");
const path = require("path");

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
      await lumine.packages.activatePackage(
        lumine.packages.resolvePackagePath(name) || path.resolve(__dirname, "../..", name),
      );
    await lumine.packages.activatePackage("ide-sofistik");
    service = lumine.packages.getActivePackage("ide-client").mainModule.provideIdeClient();
  });

  afterEach(async () => {
    for (const editor of editors) editor.destroy();
    await lumine.packages.deactivatePackage("ide-sofistik");
    await lumine.packages.deactivatePackage("ide-client");
    await lumine.packages.deactivatePackage("language-sofistik");
    lumine.project.setPaths(previousPaths);
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
