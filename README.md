# ide-sofistik

SOFiSTiK CADINP language-server adapter.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Offline language intelligence**: provides contextual completions, ordered record keys, declaration previews, compact parameter positions and complete enum lists on hover, record signatures and static diagnostics without a SOFiSTiK installation.
- **Project navigation**: supplies document symbols arranged as programs and commands, project symbols, definitions and references through the language-server client.
- **Directory declarations**: selects the release, language and edition from `sofistik.def` beside each source file.
- **Contextual enum colors**: colors recognized, unquoted enum values while quoted values keep their string colors.
- **Calculation diagnostics**: imports an existing calculation log on request and clears imported findings when the source changes.
- **Bundled server**: ships the git-pinned SOFiSTiK language server and its vocabulary data.

## Installation

To install `ide-sofistik` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-sofistik~master`.

The catalogue and this command select the current preproduction branch, which uses the `ide` hub.

Install `ide` and `language-sofistik`. Add `autocomplete`, `hover`, `linter`, `symbol`, `find-references` and `semantic-tokens` for the corresponding interfaces. The server runs with the editor's Node runtime and needs no separately installed interpreter or SOFiSTiK programs.

## Commands

Commands available in `lumine-workspace`:

- `ide-sofistik:read-calculation-diagnostics`: import existing calculation diagnostics for the saved, unchanged CADINP file.

## Usage

Place `sofistik.def` alongside the source files it describes. Each saved file resolves its release from that adjacent definition, then the newest release under `C:\Program Files\SOFiSTiK`, and finally the newest bundled dataset. Workspace-root and ancestor definitions do not apply to files in subdirectories, even when the adjacent definition is missing. One server session can serve directories with different declarations. A `sofistik.def` can declare `SOF_VERSION = 2026`, `SOF_LANGUAGE = EN` or `DE`, and `SOF_EDITION = professional` or `educational`. Language defaults to English and edition to professional. File headers do not select a release, language or edition. Unsupported releases retain syntax highlighting while release-specific intelligence stays unavailable.

`autocomplete-sofistik`, `linter-sofistik` and `sofistik-environment` are archived and removed from the install catalogue. Uninstall those packages and use `ide-sofistik` with `ide`; keep `autocomplete` and `linter` for the corresponding interfaces. Release, language and edition detection lives in the lightweight `@lumine-code/sofistik-env` library; `sofistik-data` supplies the bundled release fallback. The language grammar continues to own ordinary syntax highlighting and folding, while the language server supplies contextual intelligence through `ide`.

The calculation-diagnostics command reads existing compiler output; it never launches a calculation and does not import or watch logs automatically. Save the source first, then run the command. Static and imported diagnostics appear together in the linter, and editing the source removes the imported findings until they are read again.

Live static findings select the offending variable, value or record in the original source, including open include buffers. Preprocessor substitutions select their complete use site and link their definitions; reusable blocks select the failing invocation and link the exact body location. Original program headers retain their `noqa` suppression scope without appearing as boilerplate related links. ERR-derived rules follow the selected release and use stable module codes such as `G101`, `SL001` and `AQB001`.

Native `IF` and `LOOP` structure is checked after preprocessing, including controls split across includes. Additional release-specific checks cover ASE dead-load and STEP settings, CSA Takeda coefficients, SOFIMSHC boundary bedding and FEABENCH task and moving-load configuration. Runtime expressions and unresolved context remain unknown.

G310 highlights repeated decimal points in numeric atoms such as `1.00.0`, including macro-generated values. Native field prefixes keep number-like names, titles, paths and quoted text out of this check. Use `! noqa: G310` on the source line or `NOQA = G310` in `sofistik.def` to suppress it.

Each feature can be switched off per grammar in the package settings. Turning semantic tokens off leaves the grammar's own colors visible. The adapter provides no formatting, rename or code actions.

## Services

- `ide`: consumed to register and reach the SOFiSTiK language-server sessions.
- `background-tips.provider`: provided to background-tips to explain manual calculation-diagnostics import.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
