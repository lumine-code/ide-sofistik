const { CompositeDisposable, Disposable } = require("lumine");
const { resolveServer } = require("./server");

const setting = (key) => lumine.config.get(`ide-sofistik.${key}`);
function commandAvailable(owner, event, saved = false) {
  const editor = event.currentTarget?.getModel?.();
  return Boolean(
    owner.ide &&
    editor &&
    !editor.isDestroyed?.() &&
    editor.getGrammar()?.scopeName === "source.sofistik" &&
    (!saved || (editor.getPath() && editor.getFileState() === "unmodified")),
  );
}
module.exports = {
  activate() {
    this.commandAbort = new AbortController();
    this.disposables = new CompositeDisposable(
      lumine.commands.add('lumine-text-editor[data-grammar~="sofistik"]:not([mini])', {
        "ide-sofistik:open-parsed-code": {
          description: "Open the current CADINP preprocessor expansion in an unsaved editor.",
          isAvailable: (event) => commandAvailable(this, event),
          didDispatch: (event) => this.openParsedCode(event),
        },
        "ide-sofistik:read-calculation-diagnostics": {
          description: "Read existing calculation diagnostics for the saved, unchanged file.",
          isAvailable: (event) => commandAvailable(this, event, true),
          didDispatch: (event) => this.readCalculationDiagnostics(event),
        },
      }),
    );
  },

  deactivate() {
    this.commandAbort?.abort();
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
    this.ideAbort?.abort();
    const edgeAbort = new AbortController();
    this.ideAbort = edgeAbort;
    this.ide = service;
    lumine.commands.invalidateAvailability();
    return new CompositeDisposable(
      registration,
      new Disposable(() => {
        edgeAbort.abort();
        if (this.ideAbort === edgeAbort) {
          this.ide = null;
          this.ideAbort = null;
          lumine.commands.invalidateAvailability();
        }
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
    return require("./editor-actions").validateImportEditor(editor);
  },

  openParsedCode(event) {
    return require("./editor-actions").openParsedCode(this, event);
  },

  readCalculationDiagnostics(event) {
    return require("./editor-actions").readCalculationDiagnostics(this, event);
  },
};
