# Definition of done (spec §27): evidence map

**The POC is NOT complete.** Every §27 item that depends on Windows, Microsoft Visio or Microsoft
Word lacks the evidence the design requires (D8), because this branch was built and tested only
on a Linux container. The M0 gate is recorded as **NOT PASSED** in `docs/m0/decision.md`, and
production work went ahead **provisionally** at the user's request. Nothing here claims Windows,
Visio or Word acceptance.

Legend:

- **PASS (portable):** automated evidence on Linux, through the same frontend engine, router and host libraries the Windows app uses.
- **PARTIAL:** some of the item is evidenced, and the rest is stated.
- **NOT RUN:** needs Windows, Visio or Word.

| §27 criterion | Status | Evidence | Gap |
|---|---|---|---|
| Windows desktop application starts and shows a usable page-oriented editor | **PARTIAL** | The browser build of the same React/maxGraph editor runs in headless Chromium (`editor.spec.ts`; browser suite 20 tests in 10 specs). The WPF/WebView2 shell compiles (`dotnet build Diagram.Windows.slnx`). | WPF launch NOT RUN; `Diagram.Windows.Tests` always skip as NOT RUN |
| Add/edit/delete shapes, text, connectors and PNG/JPG/BMP/SVG images | **PASS (portable)** | `editor.spec.ts`, `pages-layers-assets.spec.ts`, `structure.test.ts`, `AssetInputTests`, `host-services.spec.ts` | WebView2 file picker NOT RUN |
| Move/resize/rotate, multi-select, align/distribute, z-order, undo/redo | **PASS (portable)** | `gestures.spec.ts`, `arrange.spec.ts`, `geometry.test.ts`, `arrange.test.ts`, `history.test.ts` | — |
| Basic layers can be created, hidden and locked | **PASS (portable)** | `pages-layers-assets.spec.ts`: hidden objects can't be selected; locked-layer objects resist drag, resize, inspector and agent edits | — |
| Grid/snap/alignment guides usable | **PASS (portable)** | `canvas.test.ts` (snap in the planner), `editor.spec.ts`, `gestures.spec.ts` | — |
| Shape fill/line/text properties editable | **PASS (portable)** | `editor.spec.ts` inspector commits, `structure.test.ts` | — |
| Connectors remain attached when connected shapes move | **PARTIAL** | Canonical glue: `editor.spec.ts`, `projection.spec.ts` (the rendered end follows the target), `Structural_GlueWaypointsGroupsLayersLocksHidden` (VSDX `_WALKGLUE`/`Connect`) | Visio-side behaviour NOT RUN (WA-04) |
| Every element has a stable ID | **PASS (portable)** | `transactions.test.ts`, `IdentityTests` (valid IDs kept, copies regenerated, UUIDv5 deterministic) | — |
| DrawScript can create and incrementally modify the live page | **PASS (portable)** | `script.test.ts`, `script.spec.ts`, demo step 2/5 (`demo.spec.ts`) | — |
| MCP can read current semantic state | **PASS (portable)** | `Diagram.Mcp.Tests` (stdio shim ↔ pipe ↔ host), `RequestRouter` reads, demo step 4 | Live MCP client → WPF app NOT RUN (`LiveControlTests`) |
| MCP can apply atomic incremental operations against a base revision | **PASS (portable)** | `transactions.test.ts`, `admission.test.ts`, demo step 7 (`revision_conflict` → `get_changes` → retry) | Same as above |
| MCP can return a PNG/JPEG render of the current page/region | **PASS (portable)** | `render.spec.ts`, golden PNG, demo previews (`docs/acceptance/evidence/demo-2026-10-02/`) | WebView2 renderer NOT RUN |
| MCP can report simple layout defects | **PASS (portable)** | `layout.test.ts` | — |
| Asset library lets an LLM select a known logo by stable asset ID | **PASS (portable)** | `AssetLibraryTests`, `AssetGuardTests`, `assetVersions.test.ts`, demo steps 8–9 | — |
| Supported drawings save as editable `.vsdx` | **PARTIAL** | Native geometry rows (not bitmaps), independent pictures, glue formulas: `MappingTests`. An OfficeIMO oracle loads the result. | "Editable in Visio" NOT RUN (WA-02/03) |
| Supported `.vsdx` drawings can be reopened into the application | **PASS (portable)** | `MappingTests`, `IdentityTests`, `VsdxLifecycleTests` (durable blobs, lossy → Save As), `DemoRoundTripTests` | Visio-saved fixtures do not exist yet |
| Stable IDs survive app → VSDX → **Visio save** → app | **NOT RUN** | app → VSDX → app passes (demo step 14); simulated Visio copy/paste and picture replacement pass (`IdentityTests`, `EditedForeignDataIsStaleProvenance`) | Needs a real Visio save (WA-09) |
| Exported VSDX passes manual Visio editability tests | **NOT RUN** | Checklist ready: `visio-word-checklist.md`; fixture `tests/fixtures/vsdx/app-authored/scene.vsdx` | WA-01…WA-08 |
| Exported VSDX can be embedded/activated in Word | **NOT RUN** | — | WA-10/WA-11 |
| One-object agent correction leaves all unrelated objects unchanged | **PASS (portable)** | `targets.test.ts` (4999 of 5000 byte-identical), `transactions.test.ts`, demo steps 5 and 9 (`verify-demo.mjs`) | — |

## §23 demonstration

`node tools/demo/verify-demo.mjs` reports **11 PASS, 0 FAIL, 3 NOT RUN**. Steps 11–13 need Visio
or Word. The saved run is in `evidence/demo-2026-10-02/verify-demo.txt`. The agent's decisions are
scripted (no real LLM), and steps 10/14 are library-level, with no Visio save in between.

## What is needed to declare the POC complete

1. Run `visio-word-checklist.md` (WA-01…WA-12) on Windows with Visio and Word, and record the versions and evidence.
2. Launch the WPF app. Run the Windows test project once its harness exists; it currently always skips with a NOT RUN reason.
3. Re-measure performance on the target Windows machine.
4. Re-run the §23 demo through a real MCP host (an LLM client) against the WPF app.
