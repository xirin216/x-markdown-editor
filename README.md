# X Markdown Editor
X Markdown Editor is a Windows-first Markdown editor for opening, editing, searching, and printing `.md` and `.markdown` files from anywhere on disk. It is built as a Tauri desktop application with a React frontend and a small Rust backend for native file operations, file watching, workspace search, system font discovery, and Windows packaging.
A Korean version of this document is available in [README.ko.md](README.ko.md).

## Features
* Open `.md` and `.markdown` files directly from disk.
* Register as a Windows file association target for Markdown files.
* Open a workspace folder and search Markdown files recursively.
* Use a collapsible left panel for Search and Outline navigation.
* Edit Markdown with a Milkdown and Crepe based editor surface.
* Toggle the formatting toolbar from the top bar.
* Preview raw HTML blocks in Markdown while sanitizing rendered HTML.
* Hide native spellcheck underlines in the editor surface.
* Drag and drop Markdown files or one workspace folder.
* Watch opened files and workspace files for external changes.
* Choose a system font from a searchable, paginated font browser.
* Persist editor font, text size, page width, toolbar visibility, and related editor settings.
* Print with editor width, font family, and text size applied to the print layout.
* Build a Windows NSIS installer and a portable executable for GitHub Releases
## Libraries
Frontend:
* React 19
* React DOM
* TypeScript
* Vite
* Milkdown Crepe, Kit, and React bindings
* DOMPurify
* Tauri JavaScript API
* Tauri dialog plugin API
  Backend and desktop:

* Tauri 2
* Rust
* Serde and serde\_json
* notify
* walkdir
* font-kit
* winreg on Windows
* tempfile for Rust tests
## Languages
* TypeScript and JSX for the frontend application.
* CSS for layout, editor styling, responsive settings UI, and print styling.
* Rust 2021 for native commands, file watching, file classification, workspace search, system font listing, and launch argument handling.
* JSON and TOML for Tauri, npm, and Cargo configuration.
## Development Environment
Recommended environment:
* Windows 10 or Windows 11
* Node.js with npm
* Rust stable toolchain
* Microsoft C++ Build Tools or Visual Studio Build Tools for Rust/Tauri builds
* WebView2 Runtime
* NSIS tooling as managed by the Tauri bundler
  The app is configured as a Tauri 2 desktop app with a Vite dev server at `http://localhost:1420`.
## Install Dependencies

```powershell
npm.cmd install
```

## Run In Development
Run the full Tauri desktop app:

```powershell
npm.cmd run tauri dev
```

Run only the Vite frontend server:

```powershell
npm.cmd run dev
```

## Build
Build the frontend only:

```powershell
npm.cmd run build
```

Run Rust tests:

```powershell
cd src-tauri
cargo test
```

Build the Windows desktop installer and portable executable:

```powershell
npm.cmd run package:windows
```

The same Windows packaging command is also available through:

```powershell
build-windows.bat
```

The generated NSIS installer and portable executable are written to:

```text
src-tauri\target\release\bundle\nsis\
```

## Windows Packaging Notes
* Bundle target: NSIS
* Portable output: `X-Markdown-Editor-<version>-x64-portable.exe`
* Install mode: per-machine
* Expected install location: Program Files
* Administrator permission: required during installation
* File associations: `.md` and `.markdown`
* Code signing: not configured
* Auto updater: not configured
