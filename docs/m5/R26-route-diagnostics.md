# R26 routing diagnostics

Issue #65. Builds on R16 #11 (joins and hops), R19 #58 (route provenance), R22 #61 (routing policy) and R23 #62 (levels).

`inspect_layout` now says what is wrong with how connectors are drawn, and what only looks wrong but is drawn on purpose. Every routing finding has element ids, page, bounds, severity, and evidence with a `classification` and `intended` (true for things drawn on purpose). Nothing here changes the document.

## Finding codes

The stable list is `ROUTE_FINDING_CODES` in `src/web/src/layout/inspectRoutes.ts`; the `inspect_layout` tool description names every code (a unit test checks it does).

| Code | Severity | Classification | What it means |
|---|---|---|---|
| `CONNECTOR_CROSSES_SHAPE` | warning | `obstacle_crossing` | Through a shape it is not attached to. Evidence now carries the obstacle policy of each shape (`automatic`, `avoid`, `forbidden`) and the route provenance. |
| `CONNECTOR_CROSSES_CONTAINER` | info, intended | `container_boundary` | Through a frame that holds one of its ends: it enters or leaves the container. Was reported as a shape crossing. |
| `CONNECTOR_CROSSES_BACKGROUND` | info, intended | `background_decoration` | Over a backdrop covering at least 20% of the page. Was reported as a shape crossing. |
| `CONNECTOR_PASSES_OVER_SHAPE` | info | `lower_level` (rule) | Over a shape on a lower level (R23). |
| `CONNECTORS_CROSS` | info | `crossing`, or `hopped` (intended) | Two connectors cross; `hopped` when a line hop draws the crossing, with `hopsOver` naming the one that hops. One finding per pair, with the points. |
| `CONNECTOR_JOIN` | info, intended | `t_join` | A branch joined to a trunk (R16). Joined connectors are never judged against each other, as hops ignore them. |
| `CONNECTOR_TOUCHES_CONNECTOR` | warning | `endpoint_contact` | An end lies on another connector without a join: it looks like a junction that is not there. |
| `CONNECTORS_OVERLAP` | warning | `collinear_overlap` or `collinear_shared_end` | Runs printed on top of each other (within 0.5 pt), so they read as one line. |
| `CONNECTORS_TOO_CLOSE` | info | `parallel_near_miss` | Parallel runs 0.5 to 4 pt apart for at least 10 pt; suggests moving a run 8 pt away. |
| `ROUTE_SHORT_SEGMENT` | warning | `near_zero_segment` | A run under 2 pt: a kink. Suggests straightening. |
| `ROUTE_REDUNDANT_VERTEX` | info | `redundant_vertex` | Corners that do not turn. Suggests removing them. |
| `ROUTE_EXCESS_BENDS` | info | `excess_bends` | At least 2 more bends than the router would draw now (a kept route gone stale). Suggests re-routing. |
| `ROUTE_TOO_CLOSE_TO_SHAPE` | warning or info | `runs_on_outline` (gap up to 1 pt) or `tight_clearance` (under 4 pt) | A run alongside a shape it is not attached to for at least 10 pt. Suggests moving the run. |

`UNRESOLVED_ROUTE`, `ROUTING_AVOIDANCE_VIOLATION`, `ROUTE_SIDE_PREFERENCE_RELAXED`, `UNGLUED_CONNECTOR_END` and `DANGLING_CONNECTOR` are unchanged and are part of the list.

### What is not judged, and why

- **Manual and frozen routes** (R20) are drawn that way on purpose, so their shape (short runs, bends, corners, clearance) is not judged. Crossings and overlaps with other connectors still are, because they are visible whoever drew them. Route-shape findings carry `routeMode` and `provenance`.
- **Curved connectors** are drawn by maxGraph from control points, so their line is not known; they are left out of connector-to-connector checks.
- **Without drawn routes** (a host with no drawing surface), connector-to-connector and route-shape checks are skipped and the report's note says so, instead of guessing from straight lines.
- What the router ignores is what the inspector calls intended: a frame round an end, a page-size backdrop, a lower level, `passThrough`. An explicit `avoid` or `forbidden` policy makes any of them a real crossing again.

## The overlay

View, **Show route diagnostics** (off by default). It draws over the canvas and takes no pointer input:

- rings at crossings, joins and touching ends;
- dashed boxes round short runs, redundant corners, runs too close to a shape or to another connector, and the shapes a connector passes through;
- grey for drawn on purpose, orange for warnings, red for errors, blue for advice; intended crossings with no place to mark (backdrop, container, lower level) are only counted;
- a legend with "N to look at, M on purpose" and a count per code. Each marker's tooltip is the finding's message.

`EditorModel.routeDiagnostics()` runs the same `inspectLayout` on the live canvas projection, cached per revision and page.

## Live and hidden projections

The live canvas and the hidden projector (`exportSnapshot`, used by MCP) both use `MaxGraphAdapter` and the same planner, and `inspectRoutes` is a pure function of the page and the drawn routes, so the findings are identical. The browser spec checks this on both fixtures.

## Fixtures and the recorded expected set

`tests/fixtures/diagrams/lego-infra.operations.json` and `psgl-swimlane.operations.json` are the R15 Lego and R08 PSGL drawings (`artifacts/lego-infra/ops.json`, `artifacts/swimlane/ops.json`) with fixed ids, so findings can name elements. `tests/fixtures/diagrams/r26-route-diagnostics.expected.json` records every routing finding (code, severity, classification, ids) for both; `route-diagnostics.spec.ts` compares against it (`R26_RECORD=1` rewrites it after a deliberate router change).

| Fixture | Recorded |
|---|---|
| Lego (67 connectors) | 51 backdrop crossings (intended), 9 too close to a shape (6 on the outline), 8 short segments, 5 ends touching a bus line without a join, 2 crossings, 1 collinear overlap, 1 redundant corner |
| PSGL (15 connectors) | 15 backdrop and 11 container crossings (intended), 3 crossings, 3 short segments, 2 redundant corners, 1 too close to a shape |

**PSGL adaptation.** Today the PSGL drawing cannot be replayed as it was saved. R22 refuses any transaction that uses a fixed port when it would leave a connector without a clear route, and four PSGL connectors (`c2`, `c3`, `c4`, `c7`) cannot be routed whatever their glue. The fixture gives those four dynamic glue, and the spec adds them in a second transaction without fixed ports, where they are allowed and reported as `UNRESOLVED_ROUTE`. The refusal applies to every connector the transaction leaves unrouted, not only those on fixed ports, so an agent rebuilding this drawing in one transaction would be refused outright. That is R22 behaviour and is not changed here.

## Verification

| Test | What it shows |
|---|---|
| `tests/inspectRoutes.test.ts` (15) | each code on exact hand-made routes: crossing; hopped crossing as intended with the hopping connector; a T-join is a join and not a crossing or a touch; an unjoined end on a route; overlap and shared-end overlap; a 2 pt near miss with the run to move; nothing for runs far apart or meeting at an end; a 1 pt kink; redundant corners; manual and frozen routes not judged; a kept detour round a deleted shape (4 bends, 0 if re-routed); tight clearance and runs on an outline; container, backdrop and wall crossings with the wall's policy; an `avoid` backdrop is a real crossing; no route checks without drawn routes; every code is in the tool help |
| `tests/browser/route-diagnostics.spec.ts` (3) | both fixtures: the live canvas and the hidden projection give the same findings, equal to the recorded set, which includes collinear overlap, short segments and tight clearance; in the editor, a hopped crossing and a T-join are reported as intended; the overlay is off by default, shows both as intended (legend "0 to look at, 2 on purpose"), leaves revision and document unchanged, and turns off again |

Full regression on the branch (main d63d752 plus R26): web unit 656, typecheck clean, browser 191, Contracts 50, Ipc 33, Host 224, Visio 168, Mcp 14, Windows 184 passed with 13 opt-in probes skipped.

## Limits

- **Cramped connector labels** are not checked yet.
- **Beautify preview** (current against proposed routes) belongs to R24, which can reuse these classifications.
- **Thresholds are fixed**: 0.5 pt overlap, 4 pt near, 10 pt alongside, 2 pt short, 2 extra bends. They are constants in `inspectRoutes.ts`, not preferences.
- **Excess bends** compares with a fresh plan of the same page, so it finds stale kept routes, not routes the router itself draws badly.
- The overlay legend sits in the top-right corner of the canvas and can cover part of a large drawing.
- A person has not yet judged the overlay or the findings on screen.
