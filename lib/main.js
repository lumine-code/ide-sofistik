const { CompositeDisposable, Disposable } = require("lumine");
const { pathToFileURL } = require("url");
const { resolveServer } = require("./server");

const setting = (key) => lumine.config.get(`ide-sofistik.${key}`);
module.exports = {
  activate() {
    this.disposables = new CompositeDisposable(
      lumine.commands.add("lumine-workspace", {
        "ide-sofistik:open-parsed-code": {
          description: "Open the current CADINP preprocessor expansion in an unsaved editor.",
          didDispatch: (event) => this.openParsedCode(event),
        },
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

  consumeIde(service) {
    const adapter = {
      id: "ide-sofistik",
      displayName: "SOFiSTiK Language Server",
      grammarScopes: ["source.sofistik"],
      languageId: "sofistik",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-sofistik"],
      restartKeyPaths: ["ide-sofistik.serverPath"],
      async resolveServer(context) {
        const launch = await resolveServer(context, setting("serverPath"));
        if (!launch) {
          service.reportMissingServer("ide-sofistik", {
            description:
              "Reinstall ide-sofistik to restore its bundled language server, or select a server executable or JavaScript entry in Server Path.",
          });
          return null;
        }
        return launch;
      },
      getSettings: () => ({ sofistik: this.serverSettings() }),
    };
    const registration = service.registerAdapter(adapter);
    this.ide = service;
    return new CompositeDisposable(
      registration,
      new Disposable(() => {
        if (this.ide === service) this.ide = null;
      }),
    );
  },

  provideBackgroundTips() {
    return {
      packageName: "ide-sofistik",
      tips: [
        "{% if keys['ide-sofistik:open-parsed-code'] %}Open the current SOFiSTiK preprocessor expansion in an unsaved editor with {{ 'ide-sofistik:open-parsed-code' | keystroke }}{% else %}The IDE SOFiSTiK: Open Parsed Code command opens the current preprocessor expansion in an unsaved CADINP editor, including unsaved source and include edits.{% endif %}",
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

  async openParsedCode(event) {
    const element = event?.target?.closest?.("lumine-text-editor:not([mini])");
    const editor = element?.getModel?.() ?? lumine.workspace.getActiveTextEditor() ?? null;
    if (!editor || editor.isDestroyed?.()) return null;
    const grammar = editor.getGrammar();
    if (grammar?.scopeName !== "source.sofistik") {
      lumine.notifications.addWarning("Select a SOFiSTiK CADINP editor to open its parsed code.");
      return null;
    }
    const service = this.ide;
    if (!service) {
      lumine.notifications.addWarning("Enable ide to open SOFiSTiK parsed code.");
      return null;
    }
    const activation = this.disposables;
    const filePath = editor.getPath();
    const source = editor.getText();
    const isActive = () => this.ide === service && this.disposables === activation;
    const isCurrentSource = () =>
      !editor.isDestroyed?.() &&
      editor.getGrammar() === grammar &&
      editor.getPath() === filePath &&
      editor.getText() === source;
    const changed = () => {
      lumine.notifications.addWarning(
        "The SOFiSTiK source changed while its parsed code was being prepared.",
      );
      return null;
    };
    let parsed;
    try {
      const sessions = await service.activeSessionsForEditor(editor);
      if (!isActive()) return null;
      if (!isCurrentSource()) return changed();
      const session = sessions.find((candidate) => candidate.adapter.id === "ide-sofistik");
      const document = [...(session?.documents.values() || [])].find(
        (candidate) => candidate.editor === editor,
      );
      if (!document) {
        lumine.notifications.addWarning("The SOFiSTiK language server is unavailable.");
        return null;
      }
      // Execute commands have no textDocument parameter, so explicitly join the
      // hub's pending document synchronization and use its URI for untitled inputs.
      await session.waitForDocumentSync(document);
      if (!isActive()) return null;
      const isCurrentDocument = () =>
        isCurrentSource() &&
        session.state === "running" &&
        [...session.documents.values()].includes(document);
      if (!isCurrentDocument()) return changed();
      const version = document.version;
      const result = await session.request("workspace/executeCommand", {
        command: "sofistik.expandPreprocessor",
        arguments: [{ uri: document.uri }],
      });
      if (!isActive()) return null;
      if (
        !isCurrentDocument() ||
        document.version !== version ||
        result?.uri !== document.uri ||
        result?.version !== version
      )
        return changed();
      if (typeof result.text !== "string")
        throw new Error("The SOFiSTiK server returned no parsed code.");
      parsed = lumine.workspace.buildTextEditor();
      parsed.setText(result.text);
      parsed.setGrammar(grammar);
      await lumine.workspace.open(parsed);
      if (!isActive() || !isCurrentDocument() || document.version !== version) {
        parsed.destroy();
        return isActive() ? changed() : null;
      }
      if (result.complete === false)
        lumine.notifications.addWarning("The SOFiSTiK preprocessor expansion is incomplete.", {
          detail: "Some input could not be resolved or an expansion limit was reached.",
          dismissable: true,
        });
      return parsed;
    } catch (error) {
      parsed?.destroy();
      if (!isActive()) return null;
      lumine.notifications.addWarning("Unable to open SOFiSTiK parsed code", {
        detail: error.message,
        dismissable: true,
      });
      return null;
    }
  },

  async readCalculationDiagnostics(event) {
    const element = event?.target?.closest?.("lumine-text-editor:not([mini])");
    const editor = element?.getModel?.() ?? lumine.workspace.getActiveTextEditor() ?? null;
    if (!this.validateImportEditor(editor)) return null;
    const service = this.ide;
    if (!service) {
      lumine.notifications.addWarning("Enable ide to read SOFiSTiK calculation diagnostics.");
      return null;
    }
    const filePath = editor.getPath();
    try {
      const sessions = await service.activeSessionsForEditor(editor);
      if (this.ide !== service || !this.validateImportEditor(editor)) return null;
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
