# Implementation progress

Updated: 2026-10-02. Branch `claude/eager-goodall-f9jmub`.

**Status: all packages I00–I52 are implemented to the extent possible on Linux. The POC is NOT
complete.**

- The M0 gate is **NOT PASSED**: Windows, Visio and Word acceptance has not been run (`docs/m0/decision.md`).
- Production packages went ahead **provisionally** at the user's request.
- Every Windows/WebView2/Visio/Word check is recorded as **NOT RUN**. Library reopening was never substituted for Office acceptance.
- The §27 evidence map is in [docs/acceptance/definition-of-done.md](docs/acceptance/definition-of-done.md).

| ID | Package | Status | Commit | Evidence (Linux) | Not run / remaining |
|---|---|---|---|---|---|
| I00 | Contracts and pinned probe dependencies | done | 9dcfb86 | `spikes/contract-tests` 16/16 | — |
| I01 | M0 VSDX round-trip probe | done (portable) | 19abf2b | `spikes/vsdx.tests` 9/9; backend decision: direct OPC (OfficeIMO has no picture API, so it is used as an oracle only) | Visio/Word open (G1) |
| I02 | M0 maxGraph canvas probe | done | 210f24c | `spikes/canvas` 7/7, including real-pointer gestures and an offscreen PNG | — |
| I03 | M0 stdio MCP → pipe probe | done (portable) | e18f5ff | `spikes/ipc.tests` 11/11 | Windows named-pipe ACLs |
| I04 | M0 WebView2 bridge probe | partial | c17670a | portable bridge rules 11/11; WPF compiles | WebView2 run |
| I05 | M0 results and decision | recorded | 61351e8 | `docs/m0/results.md`, `decision.md`: **gate NOT PASSED** | G1–G4 on Windows |
| I10 | Contracts, canonical store, engine, history | done | 4cad0a0 | schema bundle → generated TS/C# (+ Ajv standalone); `Diagram.Contracts.Tests` 16/16 parity | — |
| I11 | Host core and WPF shell | done (portable) | 1436955 | atomic IO, blob store, asset preparer, JSON lifecycle, bridge router (`Diagram.Host.Tests`) | WPF launch |
| I12 | Canvas projection and React editor | done | 17eb705 | `editor.spec.ts`, `gestures.spec.ts`, `canvas.test.ts` | — |
| I20 | Full mutations, groups, arrange | done | aad9d67 | `targets`/`structure`/`geometry`/`arrange` tests, `arrange.spec.ts` | — |
| I21 | DrawScript and drawers | done | 4f00b5c | `script.test.ts`, `script.spec.ts`, `docs/drawscript.md` | — |
| I30 | Production IPC, admission gate, MCP tools | done (portable) | 443acb6 | `Diagram.Ipc.Tests` 9, `Diagram.Mcp.Tests` 7, `admission.test.ts` | live MCP client → WPF (`LiveControlTests`) |
| I31 | Render, region crops, layout inspection | done | da1a789 | `render.spec.ts` with golden PNG, `layout.test.ts` | WebView2 renderer |
| I40 | VSDX mapping, guarded import, native open/export | done (library level) | 252163f | `Diagram.Visio.Tests` (mapping, identity, package guard, OfficeIMO oracle), `VsdxLifecycleTests`, [compatibility matrix](docs/vsdx-compatibility.md) | any Visio open or save |
| I41 | Visio/Word acceptance | **NOT RUN** | 9215222 | [checklist](docs/acceptance/visio-word-checklist.md), app-authored fixture | WA-01…WA-12 |
| I50 | Pages/layers and asset library | done | e113071 | `AssetLibraryTests`, `AssetGuardTests`, `assetVersions.test.ts`, `pages-layers-assets.spec.ts` | — |
| I51 | Durable recovery and boundary hardening | done (portable) | 5b92f9c | `RecoveryTests` 9, `ExportPathTests` 20, `recovery.test.ts` 6, [hardening notes](docs/recovery-and-hardening.md) | `CrashRecoveryTests` (Windows), NTFS junctions |
| I52 | Performance and §23 demo | done (portable) | this commit | [performance](docs/acceptance/performance.md); `verify-demo.mjs`: 11 PASS / 0 FAIL / 3 NOT RUN | Windows timings; Visio/Word demo steps 11–13; a real LLM client |

## Final test run (2026-10-02, Linux x64, Node 24.21.0, .NET 10.0.112, Chromium 141)

| Suite | Command | Result |
|---|---|---|
| .NET portable | `dotnet test --solution Diagram.Portable.slnx` | **149 passed**: Contracts 16, Host 76, Ipc 9, Mcp 7, Visio 41 |
| Web unit | `npm --prefix src/web test` | **134 passed** (16 files) |
| Web browser | `PW_CHROMIUM=/opt/pw-browsers/chromium npm --prefix src/web run test:browser` | **20 passed** (10 specs) |
| Typecheck / build / contracts | `tsc --noEmit`, `vite build`, `generate-contracts --check` | clean |
| Windows | `dotnet build Diagram.Windows.slnx` | builds. `dotnet test` cannot launch on Linux (no Microsoft.WindowsDesktop.App); its tests always skip as NOT RUN |
| §23 demo | `node tools/demo/verify-demo.mjs` (after the browser demo and `DemoRoundTripTests`) | 11 PASS, 0 FAIL, 3 NOT RUN |

## How red/green was shown

Where tests were written after the code, the red state was demonstrated by **mutation**: a
guard was disabled, the owning test failed, and the guard was restored. This was done for these
groups:

- VSDX lifecycle: Save As and lossy-clean guards.
- Asset library and asset guard.
- Recovery: blob-before-record, head regression, compaction, torn tail.
- Export path policy: links, late consent, alternate data streams.
- Incremental canvas projection.
- Demo verifier: tampered evidence makes two steps FAIL.

New tests also found real bugs, which were fixed:

- Elements stayed selected after their layer was hidden.
- *Add page* threw before the UI state refreshed.
- Single-edit canvas latency was 355 ms (full rebuild); now 23 ms.
- `-0`/`0` geometry hashes differed, so ellipses re-imported as `custom`.
- The Windows test stubs would have passed with empty bodies on Windows; they now always skip as NOT RUN.

## Environment notes

- The Microsoft .NET download host is blocked here, so the Ubuntu `dotnet-sdk-10.0` 10.0.112 is used. `global.json` selects the Microsoft.Testing.Platform runner.
- Playwright uses the pre-installed Chromium through `PW_CHROMIUM`; browsers are never downloaded.
- The app and VSDX tests use Server GC (see performance.md).

## Design inputs

- [Design progress](DESIGN_PROGRESS.md)
- [Feasibility and acceptance design](docs/design/feasibility-and-acceptance.md)
- [Implementation plan](docs/superpowers/plans/2026-10-02-agentic-diagram-implementation.md)
- [Questions](docs/design/QUESTIONS.md)
