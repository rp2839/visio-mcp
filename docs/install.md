# Installing, updating and removing Agentic Diagram

This is the per-user install for Windows. It needs no administrator rights and writes only under your profile. It is a set of scripts, not a signed installer: see [Limits](#limits).

## What you need

- Windows 11 with the **.NET 10 Desktop Runtime** (the app is not bundled with its runtime) and the **WebView2 runtime**.
- A release package, `AgenticDiagram-<version>.zip`. Check it against the `.sha256` file beside it before you extract it.

## Install

Extract the zip to a folder, then in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Options: `-OpenWith` lists the app under *Open with* for `.json` and `.vsdx` files (needs a build that has W15); `-RegisterMcp claude|codex|both` registers the MCP companion (below).

The app goes in `%LOCALAPPDATA%\Programs\AgenticDiagram\versions\<version>`. `current` beside it is a link to the active version; the Start menu entry **Agentic Diagram** and any MCP registration name `current`, so they keep working after an update. The app appears in *Settings > Apps* with its version and an uninstall command.

## Update

Run `install.ps1` from the newer package. It:

- refuses if the app (or an agent session using its tools) is running, and tells you to close it;
- replaces the program and leaves your data alone: the picture library, recovery files, settings and window state are in `%LOCALAPPDATA%\AgenticDiagram`, outside the install folder;
- prints what changed since the version you had, from [RELEASE-NOTES.md](../RELEASE-NOTES.md);
- keeps the previous version. To go back, run the older package's `install.ps1 -Force` (the same flag installs the same version again).

An older package is refused without `-Force`, so a stale download cannot quietly downgrade you.

## Uninstall

*Settings > Apps > Agentic Diagram > Uninstall*, or `%LOCALAPPDATA%\Programs\AgenticDiagram\tools\uninstall.ps1`. It asks whether to delete your data (library, recovery files, settings). Run without a console, or with `-KeepData`, it keeps them; `-DeleteData` removes them without asking. It also removes the Start menu entry, the *Open with* entries and any MCP registration the installer made. Your saved `.diagram.json` and `.vsdx` files and `Documents\AgenticDiagram\Exports` are never touched.

## Registering the MCP companion with an agent

The companion is `current\mcp\Diagram.Mcp.exe`. Register it once; an update repoints `current` and the registration keeps working.

```powershell
& "$env:LOCALAPPDATA\Programs\AgenticDiagram\tools\register-mcp.ps1" -Client claude   # Claude Code, user scope
& "$env:LOCALAPPDATA\Programs\AgenticDiagram\tools\register-mcp.ps1" -Client codex    # Codex
& "$env:LOCALAPPDATA\Programs\AgenticDiagram\tools\register-mcp.ps1" -Client print     # commands and a JSON snippet for any other client
```

These run `claude mcp add diagram --scope user -- <exe>` and `codex mcp add diagram -- <exe>` (after removing an earlier `diagram` entry). If the client's command is not on `PATH`, the script prints the line to run yourself. `-Remove` undoes it. Restart the agent session afterwards. The app must be running for tools to work; the companion starts with the agent and connects to it.

## Building a package

```powershell
pwsh -File tools/installer/package.ps1 -Version 0.2.1
```

It needs a `## 0.2.1` section in `RELEASE-NOTES.md`, builds the web UI, publishes the app and companion with that version (the About box shows it), and writes `artifacts/dist/AgenticDiagram-0.2.1.zip` and its `.sha256`. `-SignWith <thumbprint>` signs the app and companion binaries with `signtool.exe` if you have a certificate.

`tools/installer/test-installer.ps1` checks install, update, rollback, the running-app guard, MCP commands (dry run) and uninstall in a scratch folder and a scratch registry key, touching nothing of a real install.

`tools/publish-local.ps1` remains the developer shortcut (named version folders and a Start menu link); it does not register an uninstall entry.

## Limits

- **Not signed, not an MSIX/MSI.** Signing needs a code-signing certificate, and an MSIX or WiX package needs tools not installed here. PowerShell may show a warning for scripts from a downloaded zip: unblock the zip (*Properties > Unblock*) or run with `-ExecutionPolicy Bypass` as above. This is the part of W16 still open.
- The package depends on the installed .NET runtime; a self-contained build is larger (tens of MB) and was not chosen here.
- Update is "run the new package", not a check for updates: nothing contacts a server.
- The uninstall command in Settings runs a PowerShell window rather than a graphical dialog.
