# I02 — Canvas interaction and image-preview probe (G2)

Disposable probe. maxGraph `@maxgraph/core` 0.24.0, Vite 8.3.2, `@playwright/test` 1.63.0
(exact versions in `package-lock.json`).

`src/projection.ts` projects a plain `ProbeSceneDto` into maxGraph and turns committed model
changes into plain intents (`geometry`, `rotation`, `text`, `connect`). The probe store
(`src/main.ts`) applies them as one revision per gesture and re-projects. No maxGraph cells
leave the projection module. `src/render.ts` renders the immutable snapshot in a detached
offscreen graph, serialises its SVG and rasterises it to PNG with `canvas.toBlob`. That call
throws on a tainted canvas, so it doubles as the taint check.

## Findings

- **Connectable vertices swallow move drags.** With `setConnectable(true)`, dragging from a
  vertex centre starts a new edge. The production editor must create connectors from an
  explicit tool or port handles and keep `setConnectable(false)` for moves; re-gluing existing
  endpoints via `EdgeHandler` works.
- **`SelectionHandler.start` runs on pointer-down**, before any drag. The gesture hook arms on
  handler start and begins only after the pointer passes the drag tolerance, so selection clicks
  and zoom don't activate the interlock.
- **`CellEditorHandler.startEditing` calls `stopEditing` internally.** The text gesture must
  begin after the original call returns.
- Rotation via the handle, resize, move, endpoint re-glue and in-place text all commit as one
  revision each; cancel restores the store snapshot.

## Commands and results

Environment: Ubuntu 24.04, Node 24.21.0. Pre-installed Chromium 141.0.7390.37
(`/opt/pw-browsers/chromium`; Playwright 1.63's own bundled revision 1243 was not downloaded).

```sh
cd spikes/canvas && npm ci
PROBE_CHROMIUM=/opt/pw-browsers/chromium npm run test:browser
```

- Red: with the store's commit listener disabled, both behavioural tests failed (revision stayed 0).
- Green: 3/3 pass; `--repeat-each=3` gives 6/6.
- Evidence: `docs/m0/evidence/G2/{render.png,render-svg-asset.png,probe-state.json,timing.json}`.
  Offscreen render about 270 ms; commit+project about 2–7 ms (one sample run, headless Linux, not
  the target machine).
