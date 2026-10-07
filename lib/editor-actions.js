function editorForEvent(event) {
  const element = event?.target?.closest?.("lumine-text-editor:not([mini])");
  return element?.getModel?.() ?? lumine.workspace.getActiveTextEditor() ?? null;
}

function validateImportEditor(editor) {
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
}

function commandContext(owner) {
  const service = owner.ide;
  const activation = owner.disposables;
  const signal = AbortSignal.any([owner.commandAbort.signal, owner.ideAbort.signal]);
  return {
    service,
    signal,
    isActive: () => !signal.aborted && owner.ide === service && owner.disposables === activation,
  };
}

function unavailable() {
  lumine.notifications.addWarning("The SOFiSTiK language server is unavailable.");
  return null;
}

async function openParsedCode(owner, event) {
  const editor = editorForEvent(event);
  if (!editor || editor.isDestroyed?.()) return null;
  const grammar = editor.getGrammar();
  if (grammar?.scopeName !== "source.sofistik") {
    lumine.notifications.addWarning("Select a SOFiSTiK CADINP editor to open its parsed code.");
    return null;
  }
  if (!owner.ide) {
    lumine.notifications.addWarning("Enable ide to open SOFiSTiK parsed code.");
    return null;
  }
  const { service, signal, isActive } = commandContext(owner);
  const changed = () => {
    lumine.notifications.addWarning(
      "The SOFiSTiK source changed while its parsed code was being prepared.",
    );
    return null;
  };
  let parsed;
  try {
    const response = await service.requestForDocument(editor, {
      adapterId: "ide-sofistik",
      method: "workspace/executeCommand",
      signal,
      params: ({ uri }) => ({ command: "sofistik.expandPreprocessor", arguments: [{ uri }] }),
    });
    if (!isActive()) return null;
    if (!response) return unavailable();
    const { result, document, isCurrent } = response;
    if (!isCurrent() || result?.uri !== document.uri || result?.version !== document.version)
      return changed();
    if (typeof result.text !== "string")
      throw new Error("The SOFiSTiK server returned no parsed code.");
    parsed = lumine.workspace.buildTextEditor({ autoHeight: false });
    parsed.setText(result.text);
    parsed.setGrammar(grammar);
    await lumine.workspace.open(parsed);
    if (!isActive() || !isCurrent()) {
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
    if (error.code === "IDE_DOCUMENT_CHANGED") return changed();
    lumine.notifications.addWarning("Unable to open SOFiSTiK parsed code", {
      detail: error.message,
      dismissable: true,
    });
    return null;
  }
}

async function readCalculationDiagnostics(owner, event) {
  const editor = editorForEvent(event);
  if (!validateImportEditor(editor)) return null;
  if (!owner.ide) {
    lumine.notifications.addWarning("Enable ide to read SOFiSTiK calculation diagnostics.");
    return null;
  }
  const { service, signal, isActive } = commandContext(owner);
  let declined = false;
  try {
    const response = await service.requestForDocument(editor, {
      adapterId: "ide-sofistik",
      method: "workspace/executeCommand",
      feature: "diagnostics",
      signal,
      validate: () => {
        declined = !validateImportEditor(editor);
        return !declined;
      },
      params: ({ uri }) => ({
        command: "sofistik.readCalculationDiagnostics",
        arguments: [{ uri }],
      }),
    });
    if (!isActive()) return null;
    if (!response) return declined ? null : unavailable();
    return response.result;
  } catch (error) {
    if (!isActive()) return null;
    if (error.code === "IDE_FEATURE_DISABLED")
      lumine.notifications.addWarning(
        "Enable SOFiSTiK diagnostics before reading the calculation log.",
      );
    else
      lumine.notifications.addWarning("Unable to read SOFiSTiK calculation diagnostics", {
        detail: error.message,
        dismissable: true,
      });
    return null;
  }
}

module.exports = { openParsedCode, readCalculationDiagnostics, validateImportEditor };
