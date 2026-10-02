# D8 — Feasibility gates and acceptance evidence

Authors: Claude (host/native-format gate design) and Codex (delivery/coverage
integration). Status: jointly reviewed design, including Claude's resumed review.
Source: spec §§13.5,
18, 21–23, 26–27. No gate has been executed during design.

## M0: isolated probes before product scaffolding

Each probe records package versions/commits, licences, commands, environment and
fixtures in `spikes/<name>/README.md`. Disposable code must not silently become the
production architecture. Portable probes can run on Linux; Windows-specific probes
and real Office acceptance run on Windows. All four probes must pass before M1.

| Gate | Smallest useful experiment | Required pass evidence | Failure response |
|---|---|---|---|
| G1: native VSDX | Generate rectangle/text, ellipse, styled orthogonal glued connector, layer, PNG and UUID user cell; load after a Visio save | No repair prompt; separately editable objects; connector follows move; image stays independent; UUID retained; Word embeds/activates; app reload reads fields | Pause production work; document missing feature and evaluate backend alternatives |
| G2: canvas | Use pinned maxGraph to create/move/resize/rotate/connect, display image and export PNG | Measured canonical bounds; intact endpoint semantics; readable preview; no model/cell leakage | Test alternate canvas adapter against same DTOs |
| G3: MCP/IPC | One official C# stdio tool routed through bounded pipe framing to a test host | MCP host receives structured result; unavailable host, malformed frame and disconnect handled; logs on stderr | Fix transport/envelope before building full tool surface |
| G4: WebView2 | WPF test host sends typed operation to a tiny frontend store/canvas | UI visibly updates; revision/changed IDs match; ready handshake, document mismatch and duplicate delivery handled | Resolve bridge/lifecycle model before full shell |

Run G1 first or alongside the other isolated probes; a material G1 failure prevents
the full application even if the other probes succeed. Alternative backends must
pass the same contract, including images/glue and persistent IDs. A library being
able to write ZIP/XML does not meet G1.

The initial spec's G1 fixture is deliberately small. Add an early extended mapping
matrix before offering unsupported production presets: rotation, all required basic
shapes, static/dynamic ports, curved/orthogonal/straight routes, text wrapping,
groups and SVG-derived images. SVG may remain a separate vector asset or be
rasterised with a diagnostic, but whole-page flattening is never accepted.
Include Claude's extended checks: a shape belonging to two layers (hide each, lock
one and disable printing on one); Visio rerouting versus canonical user waypoints;
33° rotation; alpha fill; contain-fit image; hidden shape; document identity; and
copy/paste identity collisions. Record observed layer rules before claiming fidelity.
Check native group resizing and normalisation of group frames/angles; verify that
canonical connector/group hashes do not depend on derived routing geometry.

Record evidence under `docs/m0/environment.json`, `docs/m0/results.md`,
`docs/m0/decision.md` and `docs/m0/evidence/G1..G4/`. The environment includes Windows,
Visio, Word, WebView2, .NET and Node versions. Visio-saved binary fixtures get a
sidecar identifying the producing Office version. M4/M5 use `docs/acceptance/`.

Do not gate M0 on an optional performance preference alone: all four functional
probes and required desktop acceptance must pass. Transport timing, large-frame,
second-user rejection, navigation lock and renderer-crash checks supply additional
boundary evidence. Word activation failure remains a failed acceptance check;
investigate environment/backend causes without assuming which is responsible.

## Delivery sequence

The [implementation register](../../IMPLEMENTATION_PROGRESS.md) supplies IDs,
owners and dependencies. After M0, M1 introduces a minimal canonical engine with
one-page editing/undo. M2 expands operation coverage, groups/arrange and scripts.
M3 adds production live MCP, snapshots/history and visual inspection. M4 implements
the verified native mappings and reports unsupported import content. M5 completes
pages/layers/assets/recovery, input hardening, performance and the business diagram
demonstration. Validation and safe IO begin with the first input boundary.

## Requirement coverage

| Source definition-of-done items (§27) | Design coverage | Implementation evidence |
|---|---|---|
| Windows startup and page-oriented editor | D1, D3, D5 | I11–I12 Windows launch and usability checks |
| Shapes/text/connectors and PNG/JPG/BMP/SVG; geometry/style | D2–D3, D6–D7 | I12, I20, I40 and I50 tests plus GUI checks |
| Multi-select, arrange, z-order, undo/redo | D2–D3 | I20 semantic and browser tests |
| Layers, grid/snap/alignment guides | D2–D3 | I12, I50 locked/hidden and snap scenarios |
| Glued connectors follow moved shapes | D2–D3, D6 | G1/G2; I12/I40 real-Visio movement |
| Every element stable ID; survives Visio save | D2, D6 | G1; I40/I41 UUID and duplicate-ID fixtures |
| DrawScript incremental live editing | D2, D4 | I21 parser/API equivalence and live transaction |
| MCP semantic reads and atomic base-revision edits | D1–D2, D5 | I30 cross-process tests and human/agent race |
| MCP page/region previews and simple layout defects | D4–D5 | I31 revision-labelled image and diagnostic fixtures |
| Asset library/logo selection by ID | D2–D3, D7 | I50 one-logo replacement and catalogue tests |
| Editable VSDX export and supported reopen | D6 | G1; I40 feature matrix and I41 desktop checks |
| Word embedded object activates for editing | D6, D8 | G1; I41 manual Word/Visio report |
| One-object correction preserves all unrelated objects | D2, D4 | I10/I20/I30 object-hash regression suite |

## Automated evidence

Use unit tests for the operation invariants and language grammar, browser integration
for genuine canvas interactions, .NET integration for pipes/host mappings, and fixture
round-trips for VSDX. Negative tests must exercise atomic rollback, stale revisions,
locked objects, malformed assets/packages, unsupported constructs and late responses.
An independent native parser is useful additional evidence when feasible, but does
not replace Visio acceptance. Compare visual exports with pinned fonts and a stated
raster tolerance, not universal exact-pixel equality.

Every mutation's tests snapshot unaffected object serialisation and check only
declared dependencies may change. Images require both reference correctness and
rendered evidence. Bounds-only tests cannot prove correct company-logo selection.

## Manual evidence and final demonstration

Record Windows, Visio and Word versions; input/generated/Visio-saved VSDX fixtures;
UUID/user-cell before and after; and a signed-off checklist with screenshots or
screen recording. Verify shapes and text can be edited independently, connectors
stay glued under movement, images remain distinct and Word activation opens an
editable Visio object. Mere screenshots or an app-rendered SVG cannot establish this.

Run the full fourteen-step spec §23 architecture-diagram demonstration, including
agent creation, visual correction, human move/fill change, revision recovery, one
logo swap, VSDX export and round-trip via Visio/Word. Map every §27 criterion to an
actual result in `docs/acceptance/`, with failed/skipped checks stated explicitly.

## Performance evidence

Measure on a recorded target Windows machine at 1–10 pages and 500 visible elements.
Targets retain spec §18: ordinary mutation preferably <100 ms, acceptably <250 ms;
100-operation batch preferably <500 ms; 1600×1200 preview preferably <1 s; semantic
summary <250 ms excluding MCP transport; native save target <3 s with correctness
preferred. Record repeated timings and UI responsiveness rather than one favourable
sample. Do not defer native correctness work to optimise beyond these targets.
