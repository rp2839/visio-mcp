# R24 Aesthetic Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic aesthetic route scoring, explicit crossing policy, and a read-only Beautify preview that commits the accepted route set atomically with one undo.

**Architecture:** Reuse R26's merged connector-contact geometry as a shared pure module. Preserve R19's ordinary planner and ordering. Explicit Beautify uses a separate bounded aesthetic profile, including occupied-run grid tracks and lexicographic crossing costs. Preview sends exact proposed route points plus base revision; the engine validates and commits those exact points atomically without a second search or coordinate rounding.

**Tech Stack:** TypeScript, React, JSON Schema, generated TypeScript/C# contracts, Vitest, Playwright, .NET contract and Windows tests.

**Spec:** `docs/design/R24-aesthetic-routing.md`; issue #63.

## Global Constraints

- PR #90 (R26) is merged; the branch must include merge commit `81a1a80ccb6ea9653fc2b06dbf59fe7c56f32e3c` or its descendant before implementation.
- Preserve R19 ordinary routing exactly, including after setting crossing policies: 1 quality point per point of route length, 24 per bend, current shared-run cost, and connector-ID ordering.
- Keep R26 diagnostics unchanged: 4 pt near-miss and shape-clearance threshold, 2 pt short-run threshold, 0.5 pt overlap tolerance, 10 pt alongside minimum. Beautify's target track spacing is 6 pt.
- Only explicit Beautify uses aesthetic costs or priority ordering. Use lexicographic `(policyCrossings, qualityPoints)` inside A* and 80,000 expanded states per target search.
- Hard constraints, Frozen routes, locked elements/layers, static ports, R16 joins and R21 constraints always win; skip infeasible targets and continue. Unprocessed target routes remain occupied; a failed Manual conversion is reverted.
- Send exact proposed route points and base revision in one undoable transaction. Commit validates and applies those points; no route re-search or rounded hash comparison.
- Optional fields preserve existing document serialization and schema version 1; generate TS/C# contracts from JSON Schema.
- Do not modify `IMPLEMENTATION_PROGRESS.md`; GitHub issue #63 is the status/ownership record.

## Review Focus

- PR #90 is merged; preserve its finding codes, evidence and 4 pt diagnostic threshold while extracting shared contact classification.
- A route can overlap its own adjacent search edges at grid nodes; count a geometric contact once using merged intervals and R26's endpoint tolerance.
- A candidate may improve crossing count while worsening path length or deviation; compare the lexicographic score and hysteresis exactly as specified.
- A target can be infeasible while another is routable; retain the failed target's advisory and still apply the feasible subset.
- Preview and commit preserve exact route points. Preview uses canonical measured label rectangles; commit validates submitted paths against the unchanged base revision and hard constraints without rerunning route search.
- The aesthetic A* grid includes occupied-run coordinates ±6 pt. Measure expanded states on the 60/60 fixture.
- Crossing costs are lexicographic inside A*, not only in finished-route ranking. A no-crossing detour beats a shorter route with one crossing.
- Track-quality benefits exceed deviation cost: a 100 pt overlapping pair must separate to 6 pt.
- Shape-clearance and short-route scoring thresholds align with R26 at 4 pt and 2 pt.

---

## File map

- Create `src/web/src/layout/routeContacts.ts`: shared pure connector-contact classification extracted from R26.
- Modify `src/web/src/layout/inspectRoutes.ts`: adapt shared contacts to existing stable diagnostics and evidence.
- Create `src/web/src/layout/routeQuality.ts`: the R24 score types, constants, deterministic metrics and score function.
- Modify `src/web/src/layout/obstacleRoute.ts` and `routePlanner.ts`: opt-in search costs and target-only Beautify planning; leave normal no-policy behavior unchanged.
- Modify `contracts/document.schema.json` and `contracts/operations.schema.json`: optional document/connector crossing policy, routing priority, required side, defaults operation and Beautify operation. Modify `contracts/protocol.schema.json` for the required-side route finding; regenerate TS/C# DTOs.
- Modify `src/web/src/commands/planPatch.ts`, `CommandEngine.ts`, and `commands/routes.ts`: validate policy and required-side requests, carry exact proposed routes and base revision in an atomic Beautify plan, validate without replanning, and bypass broad hard-route preflight only for skipped targets with no mutation.
- Create `src/web/src/editor/beautifyPreview.ts` and `src/web/src/components/BeautifyDialog.tsx`; modify `EditorModel.ts`, `components/PageCanvas.tsx`, and `editor/appCommands.ts` for preview overlay, stale state, accept/cancel and menu entry.
- Modify `src/Diagram.Mcp/OperationCatalog.cs` and `src/Diagram.Mcp/DiagramTools.cs` for operation and finding descriptions. Add Visio import/export round-trip tests that verify route geometry survives while unsupported R24 policy metadata is dropped.
- Add focused tests beside route planner, operations, editor and browser behavior; update `docs/m5/R24-aesthetic-routing.md` with exact results and remaining limits.

### Task 1: Extract shared R26 connector-contact classifier

**Files:**
- Create: `src/web/src/layout/routeContacts.ts`
- Modify: `src/web/src/layout/inspectRoutes.ts`
- Test: `src/web/tests/inspectRoutes.test.ts`
- Test: `src/web/tests/routeContacts.test.ts`

**Interfaces:**
- Consumes: routes `{ connectorId: string; points: readonly Point[]; mode: RouteMode; joinConnectorIds: readonly string[] }[]`.
- Produces: `classifyRouteContacts(routes): RouteContact[]`; each contact has sorted connector IDs, both segment indices, `classification`, and a point, overlap interval or gap as appropriate. R26 maps these values to its existing finding codes/evidence.

- [ ] Add `routeContacts.test.ts` cases for perpendicular crossings regardless of hop rendering, collinear overlap, T-join, endpoint contact, shared-end overlap, near miss at 3.99 pt, not-near-miss at 4 pt, endpoint tolerance, declared R16 joins, and adjacent segments that touch only at a route vertex; verify stable output under input order reversal. Test the separate 6 pt Beautify track target in Task 2.
- [ ] Run `npm --prefix src/web test -- tests/routeContacts.test.ts` and confirm the new classifier tests fail before the module exists.
- [ ] Move only pure segment/contact geometry from R26 `inspectRoutes.ts` to `routeContacts.ts`; retain `NEAR_PT=4`, `OVERLAP_PT=0.5`, `ALONGSIDE_PT=10`, and `SHORT_PT=2`. Export `TRACK_SPACING_PT=6` as a planner target, separate from diagnostic thresholds.
- [ ] Adapt `inspectRoutes` to map returned contacts to unchanged R26 codes, thresholds and evidence; preserve the R26 expected fixture byte-for-byte.
- [ ] Run `npm --prefix src/web test -- tests/routeContacts.test.ts tests/inspectRoutes.test.ts tests/routePlanner.test.ts` and `npm --prefix src/web run typecheck`; expect all focused tests and typecheck to pass.
- [ ] Commit `refactor: share route contact classification`.

### Task 2: Add deterministic opt-in route quality scoring

**Files:**
- Create: `src/web/src/layout/routeQuality.ts`
- Modify: `src/web/src/layout/obstacleRoute.ts`
- Modify: `src/web/src/layout/routePlanner.ts`
- Test: `src/web/tests/routeQuality.test.ts`
- Test: `src/web/tests/routePlanner.test.ts`

**Interfaces:**
- Consumes: `RouteQualityInput { route, previous?, otherRoutes, labelRects, obstacleRects, crossingsPolicy }`.
- Produces: `scoreRoute(input): { policyCrossings: number; qualityPoints: number }`; `planRoutes` gains optional `beautifyTargets?: ReadonlySet<string>` and `costProfile?: 'legacy' | 'aesthetic'`. No arguments means the exact current R19 behavior.

- [ ] Test each fixed score term: route length, bend, crossing, overlap, near-miss deficit, label intersection, clearance deficit, short-run deficit and reversal; assert weights and units from the spec.
- [ ] Test symmetric route deviation with collinear-interval merging, its 0.1-points/pt weight, 48-point hysteresis boundary, and lexicographic policy-crossing comparison.
- [ ] Add the two-connector 100 pt overlapping-run regression: Beautify must separate them by 6 pt. Fail if deviation/hysteresis prevents the move.
- [ ] Add an A* regression proving a long route with no crossing beats a shorter route with one crossing.
- [ ] Run `npm --prefix src/web test -- tests/routeQuality.test.ts` and confirm failure.
- [ ] Implement pure `scoreRoute`, lexicographic A* cost `(policyCrossings, qualityPoints)`, deterministic completed-path costs, and priority/difficulty/span/ID ordering for Beautify. Reuse measured text bounds for all visible text/connector labels.
- [ ] Add aesthetic-only x/y grid lines at each occupied route run coordinate ±6 pt. Keep the current grid and cost arithmetic unchanged for ordinary routing. Count states on the 60/60 and denser fixtures; do not exceed 80,000 per search.
- [ ] Charge each geometric crossing once. Ensure a no-crossing detour always beats a crossing route regardless of quality cost; `allow` leaves the crossing component at zero.
- [ ] Add planner tests proving PSGL/Lego/R05 routes and change IDs remain unchanged with absent and configured policies across ordinary edits; only explicit Beautify uses policy/priority. Verify 6 pt tracks, long crossing-free detour, 100 pt overlap case, and stable 80,000-state skips.
- [ ] Run `npm --prefix src/web test -- tests/routeQuality.test.ts tests/routePlanner.test.ts tests/routeModes.test.ts` and `npm --prefix src/web run typecheck`; expect all pass.
- [ ] Commit `feat: score aesthetic connector routes`.

### Task 3: Add optional routing policy and required-side contracts

**Files:**
- Modify: `contracts/document.schema.json`
- Modify: `contracts/operations.schema.json`
- Modify: `contracts/protocol.schema.json`
- Generate: `src/web/src/contracts/generated.ts`, `src/Diagram.Core.Contracts/Generated/Contracts.g.cs`
- Modify: `src/web/src/commands/planPatch.ts`
- Modify: `src/web/src/commands/CommandEngine.ts`
- Test: `src/web/tests/contracts.test.ts`
- Test: `src/web/tests/routePlanner.test.ts`

**Interfaces:**
- Consumes: `routingDefaults.crossing?: 'avoid'|'allow'`, connector `routingPolicy.crossing?: 'avoid'|'allow'`, `routingPolicy.priority?: -100..100`, endpoint `requiredSide?: north|east|south|west`.
- Produces: `setRoutingDefaults` and `beautify` operation DTOs. Static ports on a contradictory required side fail `invalid_request` with `details.reason='routing_side_conflict'`, connector ID and endpoint. An unreachable required side returns `ROUTE_REQUIRED_SIDE_UNRESOLVED`.

- [ ] Add contract tests for valid defaults, overrides, priorities at -100/100, rejected out-of-range values, required sides, invalid static-port conflicts, and rejection of connector-only policy fields on shapes/text.
- [ ] Run focused schema/operation tests and confirm the new fields/operations are rejected before schema edits.
- [ ] Split shared element `RoutingPolicy` from connector-only `ConnectorRoutingPolicy`; extend document/connector/endpoint schemas and add `ROUTE_REQUIRED_SIDE_UNRESOLVED` to `contracts/protocol.schema.json`. Add `setRoutingDefaults` and `beautify` operation schemas with base revision and explicit proposed route points; regenerate TS/C# contracts using `npm --prefix src/web run generate`.
- [ ] Implement `setRoutingDefaults` as one document diff. It affects future explicit Beautify calls only; prove an unrelated ordinary edit changes only its edited connector. Validate `requiredSide` against fixed ports during operation planning and apply hard-route preflight to explicit constraints.
- [ ] Add UI-accessible connector fields in Task 6; do not change line style/colour semantics.
- [ ] Run `npm --prefix src/web test -- tests/contracts.test.ts tests/routePlanner.test.ts`, `npm --prefix src/web run generate:check`, and `npm --prefix src/web run typecheck`; expect all pass.
- [ ] Commit `feat: add connector crossing policies and priority`.

### Task 4: Implement exact, read-only Beautify planning

**Files:**
- Create: `src/web/src/editor/beautifyPreview.ts`
- Modify: `src/web/src/layout/routePlanner.ts`
- Test: `src/web/tests/beautifyPreview.test.ts`

**Interfaces:**
- Produces: `buildBeautifyPreview(document, pageId, targetIds, options): Promise<BeautifyPreview>` with `baseRevision`, sorted `targets`, exact `proposedRoutes`, `skipped`, and `changedCount`. Preview passes the canonical measured label rectangles to the planner.

- [ ] Test preview route count and exact proposed points, deterministic ordering, selected-only versus page materialization, Manual/Frozen/locked skips, shared label measurements, and no document/advisory mutation.
- [ ] Test that one infeasible or budget-exhausted connector is skipped while a feasible target still receives a proposed route.
- [ ] Run `npm --prefix src/web test -- tests/beautifyPreview.test.ts` and confirm failure.
- [ ] Implement the preview using one document snapshot and the Task 2 planner profile; skip unchanged/unfeasible targets and retain their exact current route/advisory.
- [ ] Test exact proposal serialization and deterministic target ordering; no coordinate rounding is used in the preview-to-commit path.
- [ ] Run the focused suite and typecheck; expect all pass.
- [ ] Commit `feat: plan revision-bound beautification previews`.

### Task 5: Commit Beautify atomically and add editor preview

**Files:**
- Modify: `src/web/src/commands/planPatch.ts`
- Modify: `src/web/src/commands/CommandEngine.ts`
- Modify: `src/web/src/editor/EditorModel.ts`
- Create: `src/web/src/components/BeautifyDialog.tsx`
- Modify: `src/web/src/components/PageCanvas.tsx`
- Modify: `src/web/src/editor/appCommands.ts`

- Test: `src/web/tests/beautify.test.ts`
- Test: label-sensitive preview and exact transaction commit
- Test: `src/web/tests/browser/beautify.spec.ts`

**Interfaces:**
- Consumes: the exact Task 4 preview and `beautify` operation with its base revision and exact proposed route points.
- Produces: one `TransactionResult` whose `changed`/`routeChanges` list contains only committed target IDs; the existing transaction stack provides exact undo/redo.

- [ ] Add engine tests for stale revision rejection, invalid proposed-route rejection, exact preview-to-commit point equality including a nearby measured label, target-only commit, one undo/redo, explicit Manual-to-Automatic conversion, and Frozen/locked skips.
- [ ] Add a transaction test with one newly infeasible target and one feasible target; assert the infeasible route is untouched, the feasible one commits, and broad R22 preflight does not reject the batch.
- [ ] Run `npm --prefix src/web test -- tests/beautify.test.ts` and confirm failure.
- [ ] Implement `beautify` apply so base revision and all proposed paths are validated before any diff; apply supplied points directly; add upserts only for changed eligible routes and avoid unresolved updates for skipped targets.
- [ ] Add `Preview Beautify` in Arrange menu and selected/page dialog; draw exact candidate paths, changed count and skip reasons; disable acceptance on stale snapshot and close without mutation on cancel.

- [ ] Add Playwright coverage for no-side-effect preview, page/selection scope, exact preview overlay, stale revision, accepted undo, skipped Manual recovery and continuing past infeasible targets.
- [ ] Run `npm --prefix src/web test -- tests/beautify.test.ts tests/beautifyPreview.test.ts` and `npm --prefix src/web run test:browser -- tests/browser/beautify.spec.ts`; expect all pass.
- [ ] Commit `feat: add previewed beautify command`.

### Task 6: Add routing policy controls

**Files:**
- Modify: `src/web/src/components/Inspector.tsx`
- Modify: `src/web/src/components/Toolbar.tsx` or the document settings dialog
- Modify: `src/web/src/editor/appCommands.ts` for Edit > Routing defaults
- Test: policy controls and ordinary-edit compatibility

- [ ] Add controls for document/connector crossing policy, priority and endpoint required side. Route all edits through the existing transaction path.
- [ ] Prove that setting a policy followed by an unrelated ordinary edit preserves every other route.
- [ ] Update MCP operation catalog and `DiagramTools.cs` descriptions for `setRoutingDefaults`, `beautify` proposed routes and `ROUTE_REQUIRED_SIDE_UNRESOLVED`.
- [ ] Commit `feat: expose routing policy controls`.

### Task 7: Verify regressions, documentation and platform contracts

**Files:**
- Modify: `docs/m5/R24-aesthetic-routing.md`
- Test: route, inspect, browser, transaction, contract and fixture suites above
- No tracker-file edits.

**Interfaces:**
- Produces: reproducible R24 acceptance evidence and a clear list of `PASS`, `FAIL`, or `NOT RUN` for real Visio and dense fixtures.

- [ ] Compare ordinary-routing PSGL, Lego, R05 baselines and R26 expected diagnostics against the merged #90 baseline; no diagnostic threshold changes are expected.
- [ ] Run `npm --prefix src/web test`, `npm --prefix src/web run typecheck`, `npm --prefix src/web run generate:check`, and `npm --prefix src/web run build`.
- [ ] Run `dotnet test Diagram.Portable.slnx --configuration Release`; run `dotnet test Diagram.Windows.slnx --configuration Release` and real Visio acceptance separately when available.
- [ ] Run the 60/60 and denser deterministic routing fixtures, record expanded-state counts, route changes, and preview wall-clock measurements; verify no route exceeds 80,000 expanded states.
- [ ] Run native Visio import/export round-trip coverage with non-default crossing policy, priority and requiredSide. Confirm route geometry survives and document unsupported metadata drops.
- [ ] Record implementation commits, test totals, Visio round-trip behavior, manual Visio status and remaining dynamic-anchor/fan-out limits in `docs/m5/R24-aesthetic-routing.md` and issue #63.
- [ ] Run full web and portable .NET suites again if any preceding edit changes code; commit `test: record R24 aesthetic routing evidence`.

## Self-review

- Every R24 issue scope item is covered by score terms, policies, shared contact analysis, preview or an explicit limit (dynamic glue-anchor symmetry and named-port creation).
- R26 stays the source of contact semantics and thresholds; its public finding codes and fixtures remain stable.
- Ordinary route planning and target ordering remain unchanged for every policy configuration; only explicit Beautify uses aesthetic scoring and priority ordering.
- Preview routes are committed exactly against their base revision; R22's broad preflight cannot turn one skipped target into a failed multi-target Beautify.
- Native Visio preserves route geometry while dropping unsupported R24 policy metadata, as verified by round-trip tests.
- PR #90 is merged and is present in the feature branch before implementation begins.
