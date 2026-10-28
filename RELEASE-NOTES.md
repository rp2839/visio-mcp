# Release notes

Newest first. `tools/installer/package.ps1` refuses to build a version that has no section here, and the installer shows the sections newer than the version being replaced.

## 0.2.1 - unreleased

- An agent can keep editing while you drag or type. Only what you are working on is protected: a text edit locks that element's text, and a drag, resize, rotate or bend locks that shape's size and position and its attached connectors. Everything else, including the position of a box you are typing in, stays editable. A refused edit names the locked ids. Your own drag or edit is no longer thrown away because an agent changed something unrelated meanwhile. `show_document` on the tab already in front no longer reports `busy_user_editing`.

## 0.2.0

- Install, update and uninstall scripts for a per-user install (`tools/installer`). An update keeps your library, recovery files and settings.
- `import_visio` opens a Visio drawing as a background reference document.
- Help menu with a keyboard shortcut list, About and a command palette (Ctrl+Shift+P).
- Automatic connector routes are kept when you move something unrelated, follow a moved end without rerouting, and a connector that cannot be routed is flagged (`UNRESOLVED_ROUTE`).
- Connectors remember their route (saved in the file), can be frozen or set manual from the Inspector, and Re-route plans an automatic one again. Files saved with this cannot be opened by earlier versions.
- Select an orthogonal connector and drag the handle on any inner run to slide it sideways (snaps to the grid, shape centre-lines, guides and parallel connectors; hold Alt to turn snapping off; Escape cancels). Arrow keys nudge a focused handle, and the Inspector has a position field for each run. DrawScript: `move-segment`.
- Dragging a run on an automatic connector pins just that run: the router keeps planning the rest and holds the pinned run. Double-click or right-click a handle (or use the Inspector) to pin or release a run; Reset to Automatic drops the pins. DrawScript: `pin-segment`, `unpin-segment`. Files with pinned runs cannot be opened by earlier versions.
- Branches that join a connector (drag a connector end onto a line, or use the Inspector) and stay on it when it moves, and connectors that hop over the ones they cross. Both are saved to Visio and read back.

## 0.1.0

- First version installed by `tools/publish-local.ps1`.
