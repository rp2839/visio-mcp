# R24 aesthetic routing evidence

## Task 2 checkpoint — 2026-10-24

Task 2 implementation and the 60-shape / 60-connector performance blocker are ready for review. The initial page-wide
Beautify attempt took 121 seconds. Profiling by inspection found that grid preprocessing tested every grid node and edge
against every obstacle, then rescanned every earlier route segment and label for each candidate edge. Those scans are
now restricted by sorted coordinate indexes and rectangle-local grid ranges. The ordinary route path is unchanged.

The final deterministic 60/60 run completed all 60 target searches in **6,415 ms** (planner time; 7.68 s total Vitest
process duration). It expanded **2,607,811 states total**, with a maximum of **80,000 expanded states for one search**;
the maximum grid was **58,600 cells**, and maximum estimated peak working memory was **7,602,570 bytes**. The 80,000
state limit is inclusive: a search stops before expanding a state beyond the limit. The test asserts all 60 searches,
the per-search state bound and completion under 30 seconds.

## Verification

- `npm --prefix src/web test -- tests/routeQuality.test.ts tests/routePlanner.test.ts` — **48 passed**. This includes
  exact stress-route snapshot comparison, unrelated-edit route retention, the 100 pt overlap separation, and the
  crossing-free detour regression.
- `npm --prefix src/web test -- tests/routePlanner.test.ts -t "all opt-in searches" --silent=false` — **60/60 passed**;
  2,607,811 total expanded states, max 80,000 per search, 58,600 maximum grid cells, 7,602,570 bytes maximum estimated
  peak memory, 6,415 ms measured planner time (7.68 s total Vitest process duration).
- `npm --prefix src/web run typecheck` — **passed** after the final indexing and tolerance adjustments.
- The ordinary-routing stress fixture matches its committed snapshot byte for byte. The full PSGL/Lego regression suite
  has not been run as part of this Task 2 checkpoint.
- Visio native round-trip verification is not applicable to this checkpoint’s web-only search-preprocessing change and
  remains part of the later final acceptance run.

## Performance implementation notes

- Obstacle rectangles mark only the grid coordinate spans they intersect, preserving the open-interior boundary rules.
- Occupied route segments are sorted by axis coordinate for crossing, overlap and near-track queries. Previous-route
  runs and text-label candidates use the same bounded lookup approach.
- The A* budget check no longer records an artificial 80,001st expanded state.
- No denser-than-60/60 fixture has been measured yet. The 60/60 acceptance test protects elapsed time, expansion limit,
  grid size, and estimated memory for this deterministic workload.

## Task 7 acceptance — 2026-10-26

### Native Visio routing metadata and geometry

- **PASS — round-trip regression:** `StructuralTests.R24RoutingMetadataLossIsReportedAndAutomaticGeometryRoundTrips` verifies the four exported connector points against the VSDX geometry rows, then imports the package and verifies the exact advisory coordinates return on an Automatic connector with no waypoints.
- **PASS — explicit loss diagnostics:** export reports `routingDefaults.crossing`, `routingPolicy.crossing`, `routingPolicy.priority`, `from.requiredSide`, `to.requiredSide`, and `routing.beautified` as `ROUTING_POLICY_NOT_NATIVE` informational diagnostics. The crossing defaults, connector policy, required sides and Beautified marker are absent after import. The route advisory is carried in `AgentAdvisory`, so the next planner pass has the same route geometry while the missing marker permits normal straightening.
- **PASS — normal straightening after marker loss:** the web planner regression `allows normal straightening when Visio import preserves advisory geometry but drops the Beautified marker` confirms that an imported unmarked detour is eligible for the normal 48 pt straightening rule.

### Regression and stress results

- **PASS — R05 pinned reference:** `ReferenceFixtureRegressionTests.SixtyTwoObjectsPreserveSemanticsAndDetectVisibleRegressionsThroughMcpAndNativeVisio` passed. It checked the committed editor/Visio screenshot hashes, 62 object identities and semantics, and native Visio save/reopen through MCP.
- **PASS — PSGL/Lego diagnostic fixtures:** the browser `route-diagnostics.spec.ts` checks the `psgl-swimlane` and `lego-infra` fixture findings and matched the expected R26 codes in the full browser suite (196 passed after Task 6).
- **NOT RUN — owner Lego file:** `C:\Dev\vsdx\Lego Infrastructure - v2.vsdx` is not present, so `LegoJunctionTests` returns without exercising the owner’s drawing.
- **PASS — 60/60 deterministic Beautify searches:** 60 searched; max 80,000 expansions per search; 1,219,378 total expansions; max 47,200 grid cells; max estimated peak memory 6,317,119 bytes; 5,414 ms planner time.
- **PASS — denser 60/90 deterministic workload:** 90 searched; max 80,000 expansions per search; 3,275,703 total expansions; max 71,896 grid cells; max estimated peak memory 8,418,364 bytes; 41,350 ms planner time. Both workloads stay within the 80,000 per-search cap.

### Verification

- `pnpm exec vitest run` — **725 passed** after the marker-loss regression was added.
- `pnpm run typecheck`, `pnpm run generate:check`, and `pnpm run build` — **passed**. Build retains the existing maxgraph `eval` and large-chunk warnings. The full Playwright suite passed **196/196** after Task 6; Task 7 reran the three PSGL/Lego diagnostic tests and all passed.
- `dotnet test Diagram.Portable.slnx --configuration Release` — **490 passed** across contract, IPC, MCP, host, and Visio projects.
- `dotnet test tests/Diagram.Visio.Tests/Diagram.Visio.Tests.csproj --configuration Release --filter FullyQualifiedName~VisioAcceptanceTests` — **4 passed** using Microsoft Visio **16.0 build 20430**; exported files opened without repair and Visio save/reopen preserved the recorded identities and geometry.
- `dotnet test tests/Diagram.Windows.Tests/Diagram.Windows.Tests.csproj --configuration Release --filter FullyQualifiedName~ReferenceFixtureRegressionTests` — **1 passed**.
- The first full Windows solution run reported `FrameTests.ThirtyTwoMiBCap` failing because its process-wide allocation counter observed two allocations from concurrent tests. The test passed alone (1/1). The Windows UI test host then ran without results for about 12 minutes and was interrupted; the full Windows suite is therefore **NOT RUN to completion**.

### Remaining acceptance limits

The owner Lego VSDX file is unavailable here, and the full Windows UI suite did not complete. The targeted R05 and real-Visio checks passed. The broader editor/browser suite passed after Task 6; the final Task 7 web rerun passed 725/725.
