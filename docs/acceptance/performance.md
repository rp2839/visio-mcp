# Performance (spec §18, I52)

**Status: measured on a Linux development container, NOT on the target Windows machine.** The
design (D8) asks for repeated timings on a recorded Windows workstation, which is NOT RUN. The
numbers below give a portable baseline and show where the costs are. Preferred targets are
reported here, not used as hard pass/fail gates. The automated tests assert only generous
ceilings.

Environment (2026-10-02): Linux 6.18 x64 container, 4 vCPU Intel Xeon @ 2.80 GHz, Node 24.21.0,
.NET 10.0.112 (Release build for the VSDX numbers), headless Chromium 141.

Fixture: `src/web/tests/performance/fixture.ts` (C# twin in `PerformanceTests.cs`). It has 10
pages × 500 visible elements (90 % shapes with text, 10 % glued connectors), 5000 elements in
all, and is fully reproducible.

| Target (§18) | Preferred / acceptable | Measured (median / p95) | Where | Met? |
|---|---|---|---|---|
| Ordinary mutation, engine only (5000-element document) | < 100 ms / < 250 ms | 84 ms / 113–138 ms | `tests/performance/targets.test.ts` | preferred (median) |
| Ordinary mutation including the canvas update and paint (500 elements on the page) | < 100 ms / < 250 ms | 23 ms / 30–37 ms | `tests/browser/performance.spec.ts` | preferred |
| 100-operation batch | < 500 ms | 67–77 ms / 93–97 ms | targets.test.ts | preferred |
| 500-element creation batch with canvas | (batch < 500 ms) | 405–463 ms | performance.spec.ts | preferred, narrowly |
| 1600×1200 preview of a 500-element page | < 1 s | 320–365 ms | performance.spec.ts | preferred |
| Semantic summary of 500 elements, excluding transport | < 250 ms | 9–11 ms / 16–23 ms | targets.test.ts | preferred |
| VSDX save, 5000 elements, including the self-check reimport | < 3 s | 1.66–1.84 s (0.79–0.86 s without the self-check); import 0.72–0.86 s | `tests/Diagram.Visio.Tests/PerformanceTests.cs` (`-c Release`) | preferred |

## Changes made because of these measurements

1. **Incremental canvas projection** (`MaxGraphAdapter.projectChanges`). Previously every commit
   rebuilt every cell on the page: a one-object edit with 500 elements took **355 ms**, which
   failed the acceptable target. Changed cells are now updated in place, giving **23 ms**. Page,
   layer, asset, z-order and group changes, and out-of-order inserts, still use the full
   rebuild. `tests/browser/projection.spec.ts` checks that after a mix of incremental edits the
   rendered cell states equal those of a full re-projection, and that connectors follow moved
   shapes. Removing the in-place geometry update makes that test fail.
2. **VSDX export.** Export used to build and re-parse XML only to hash geometry; it now computes
   `GeometryMap.ExportHash` directly. `GeometryHashTests` proves this equals the old hash for all
   15 presets at three sizes. That check also found a real bug: `-0` and `0` hashed differently,
   so ellipses re-imported as `custom`. Page XML is now parsed in parallel, and the app and
   VSDX tests use Server GC. Export went from **3.3 s** to **1.7–1.8 s**.

## Not measured

- The target Windows machine, the WPF/WebView2 transport, and UI responsiveness during a human
  drag with 500 elements (Windows NOT RUN).
- Memory use under Server GC on a desktop session. .NET's dynamic adaptation is on by default and
  should keep the heap small, but this is unverified on Windows.

## How to reproduce

```sh
npm --prefix src/web test -- tests/performance          # writes src/web/perf-results/performance-engine.json
npm --prefix src/web run test:browser -- tests/browser/performance.spec.ts   # perf-results/performance-browser.json
dotnet test --project tests/Diagram.Visio.Tests/Diagram.Visio.Tests.csproj -c Release -- --filter-class "*PerformanceTests"
```
