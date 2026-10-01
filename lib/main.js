const { CompositeDisposable, Disposable } = require("lumine");
const { pathToFileURL } = require("url");
const { resolveServer } = require("./server");

const setting = (key) => lumine.config.get(`ide-sofistik.${key}`);
module.exports = {
  activate() {
    this.disposables = new CompositeDisposable(
      lumine.commands.add("lumine-workspace", {
        "ide-sofistik:read-calculation-diagnostics": {
          description: "Read existing calculation diagnostics for the saved, unchanged file.",
          didDispatch: (event) => this.readCalculationDiagnostics(event),
        },
      }),
    );
  },

  deactivate() {
    this.disposables?.dispose();
    this.disposables = null;
  },

  serverSettings() {
    return {
      textCase: setting("textCase") || "upper",
      encoding: setting("encoding") || "utf-8",
    };
  },

  consumeIdeClient(service) {
    const adapter = {
      id: "ide-sofistik",
      displayName: "SOFiSTiK Language Server",
      grammarScopes: ["source.sofistik"],
      languageId: "sofistik",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-sofistik"],
      restartKeyPaths: ["ide-sofistik.serverPath"],
      async resolveServer(context) {
        const launch = await resolveServer(setting("serverPath"));
        if (!launch) {
          service.reportMissingServer("ide-sofistik", {
            description:
              "Reinstall ide-sofistik to restore its bundled language server, or select a server executable or JavaScript entry in Server Path.",
          });
          return null;
        }
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
      },
      getSettings: () => ({ sofistik: this.serverSettings() }),
      getWorkspaceConfiguration: (section) => {
        if (!section) return { sofistik: this.serverSettings() };
        return section === "sofistik" ? this.serverSettings() : undefined;
      },
    };
    const registration = service.registerAdapter(adapter);
    this.ideClient = service;
    return new CompositeDisposable(
      registration,
      new Disposable(() => {
        if (this.ideClient === service) this.ideClient = null;
      }),
    );
  },

  provideBackgroundTips() {
    return {
      packageName: "ide-sofistik",
      tips: [
        "{% if keys['ide-sofistik:read-calculation-diagnostics'] %}Read existing SOFiSTiK calculation diagnostics with {{ 'ide-sofistik:read-calculation-diagnostics' | keystroke }}{% else %}The IDE SOFiSTiK: Read Calculation Diagnostics command imports an existing calculation log for a saved, unchanged CADINP file. Editing the file clears those imported findings.{% endif %}",
      ],
    };
  },

  validateImportEditor(editor) {
    if (!editor || editor.isDestroyed?.()) return false;
    let reason;
    if (editor.getGrammar()?.scopeName !== "source.sofistik")
      reason = "Select a SOFiSTiK CADINP file to read its calculation diagnostics.";
    else if (!editor.getPath())
      reason = "Save the SOFiSTiK file before reading calculation diagnostics.";
    else if (editor.getFileState() !== "unmodified")
      reason = "Save changes to the SOFiSTiK file before reading calculation diagnostics.";
    if (reason) lumine.notifications.addWarning(reason);
    return !reason;
  },

  async readCalculationDiagnostics(event) {
    const element = event?.target?.closest?.("lumine-text-editor:not([mini])");
    const editor = element?.getModel?.() ?? lumine.workspace.getActiveTextEditor() ?? null;
    if (!this.validateImportEditor(editor)) return null;
    const service = this.ideClient;
    if (!service) {
      lumine.notifications.addWarning(
        "Enable ide-client to read SOFiSTiK calculation diagnostics.",
      );
      return null;
    }
    const filePath = editor.getPath();
    try {
      const sessions = await service.activeSessionsForEditor(editor);
      if (this.ideClient !== service || !this.validateImportEditor(editor)) return null;
      if (editor.getPath() !== filePath) {
        lumine.notifications.addWarning(
          "The active SOFiSTiK file changed while its server was starting.",
        );
        return null;
      }
      const session = sessions.find((candidate) => candidate.adapter.id === "ide-sofistik");
      if (!session) {
        lumine.notifications.addWarning("The SOFiSTiK language server is unavailable.");
        return null;
      }
      if (!service.featureEnabled(session.adapter, "diagnostics", editor)) {
        lumine.notifications.addWarning(
          "Enable SOFiSTiK diagnostics before reading the calculation log.",
        );
        return null;
      }
      return await session.request("workspace/executeCommand", {
        command: "sofistik.readCalculationDiagnostics",
        arguments: [{ uri: pathToFileURL(filePath).href }],
      });
    } catch (error) {
      lumine.notifications.addWarning("Unable to read SOFiSTiK calculation diagnostics", {
        detail: error.message,
        dismissable: true,
      });
      return null;
    }
  },
};
