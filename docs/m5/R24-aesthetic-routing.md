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
