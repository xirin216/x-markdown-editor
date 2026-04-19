# X Markdown Editor

Windows-first markdown editor built with `Tauri 2`, `React`, `TypeScript`, `Vditor`, and a small `Rust` backend for file operations, search, drag-and-drop classification, and file watching.

## What it does

- Opens `.md` and `.markdown` files from any path on disk
- Opens one workspace folder for recursive markdown search
- Shows a collapsible left sidebar with `Search` and `Outline`
- Edits Markdown in `IR` mode so Markdown markers stay visible while the rendered styling remains readable
- Accepts drag-and-drop for markdown files and one folder workspace
- Builds a Windows `NSIS` installer package

## Development

```powershell
npm.cmd install
npm.cmd run tauri dev
```

`Vditor` static assets are synced automatically before `dev` and `build`.

If you want to sync them manually:

```powershell
npm.cmd run sync:vditor
```

## Build

Frontend only:

```powershell
npm.cmd run build
```

Windows desktop bundle:

```powershell
npm.cmd run package:windows
```

The packaged installer is generated under `src-tauri\target\release\bundle\nsis\`.

## Packaging notes

- Installer target: `NSIS`
- Install mode: `currentUser`
- WebView2: uses Tauri's standard Windows setup flow
- Auto updater: not enabled in v1
- Microsoft Store packaging: not configured in v1
- Code signing: not wired yet, but release flow is structured so a signing step can be inserted later
