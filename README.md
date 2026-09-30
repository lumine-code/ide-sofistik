# ide-sofistik

SOFiSTiK CADINP language-server adapter.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Offline language intelligence**: provides contextual completions, declaration previews, compact parameter positions and complete enum lists on hover, record signatures and static diagnostics without a SOFiSTiK installation.
- **Project navigation**: supplies document and project symbols, definitions and references through the language-server client.
- **One project release**: uses the root `sofistik.def`, the newest installed release, or the newest bundled dataset for the entire directory.
- **Contextual enum colors**: layers recognized enum values over the grammar's highlighting without replacing ordinary syntax colors.
- **Calculation diagnostics**: imports an existing calculation log on request and clears imported findings when the source changes.
- **Bundled server**: ships the git-pinned SOFiSTiK language server and its vocabulary data.

## Installation

To install `ide-sofistik` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-sofistik`.

Install `ide-client` and `language-sofistik`. Add `autocomplete`, `hover`, `linter`, `symbol`, `find-references` and `semantic-tokens` for the corresponding interfaces. The server runs with the editor's Node runtime and needs no separately installed interpreter or SOFiSTiK programs.

## Commands

Commands available in `lumine-workspace`:

- `ide-sofistik:read-calculation-diagnostics`: import existing calculation diagnostics for the saved, unchanged CADINP file.

## Usage

Open each SOFiSTiK project directory as an editor project root. One server uses one release for all files in that directory. It resolves the release from the root `sofistik.def`, then the newest release under `C:\Program Files\SOFiSTiK`, and finally the newest bundled dataset. A `sofistik.def` can declare `SOF_VERSION = 2026`, `SOF_LANGUAGE = EN` or `DE`, and `SOF_EDITION = professional` or `educational`. Language defaults to English and edition to professional. File headers do not select a release, language or edition. Unsupported releases retain syntax highlighting while release-specific intelligence stays unavailable.

`autocomplete-sofistik`, `linter-sofistik` and `sofistik-environment` are archived and removed from the install catalogue. Uninstall those packages and use `ide-sofistik` with `ide-client`; keep `autocomplete` and `linter` for the corresponding interfaces. Release, language and edition detection lives in the shared SOFiSTiK data library, without the former environment service or its settings. The language grammar continues to own ordinary syntax highlighting and folding, while the language server supplies contextual intelligence through `ide-client`.

The calculation-diagnostics command reads existing compiler output; it never launches a calculation and does not import or watch logs automatically. Save the source first, then run the command. Static and imported diagnostics appear together in the linter, and editing the source removes the imported findings until they are read again.

Each feature can be switched off per grammar in the package settings. Turning semantic tokens off leaves the grammar's own colors visible. The adapter provides no formatting, rename or code actions.

## Services

- `ide-client`: consumed to register and reach the SOFiSTiK language-server sessions.
- `background-tips.provider`: provided to background-tips to explain manual calculation-diagnostics import.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
