# Canonical Engine and Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build the canonical editing library, manual canvas and declarative automation without library-owned document state.

**Architecture:** Pure planners produce validated candidates and resolved diffs; one synchronous commit point applies them inside a serial queue. All GUI and script edits enter that engine.

**Tech Stack:** TypeScript, JSON Schema/Ajv, React/maxGraph, Vitest and Playwright; generated C# DTOs for host consumers.

**Spec:** [Overview/contracts/global constraints](2026-10-02-agentic-diagram-implementation.md), [D2–D4](../../design/editor-and-commands.md). Inherits all overview constraints. Production tasks depend on I05 PASS.

## Review focus

Queue-head dedup/revision ordering (I10), gesture/agent conflicts (I12), derived
group geometry versus routed connectors (I20), script aliases/quoting/unit errors
(I21), and exact preservation of objects not targeted (every mutation test cycle).

## I10 — Canonical state, queue, patching and inverse history

**Depends:** I05. **Files:** create
`contracts/{document,operations,protocol}.schema.json`, `contracts/fixtures/{valid-apply,invalid-apply}.json`,
`tools/generate-contracts.mjs`, `src/web/{package.json,tsconfig.json,vitest.config.ts}`,
`src/web/src/contracts/generated.ts`, `src/web/src/model/{validate,store,canonical}.ts`,
`src/web/src/commands/{CommandEngine,planPatch,history}.ts`,
`src/web/tests/{contracts,transactions,history}.test.ts`, `src/web/tests/support/engine.ts`,
`src/Diagram.Core.Contracts/{Diagram.Core.Contracts.csproj,Generated/}`,
`tests/Diagram.Contracts.Tests/{Diagram.Contracts.Tests.csproj,SchemaParityTests.cs}`,
`Diagram.Portable.slnx`. Generator emits both language DTOs from one schema bundle.

**Interfaces produced:**

```ts
validateDocument(value: unknown): Result<DiagramDocument>;
canonicalSerialize(value: DiagramDocument | Element): string;
createDocumentStore(document: DiagramDocument, sessionId: string): DocumentStore;
DocumentStore.snapshot(): Snapshot;
CommandEngine.execute(req: MutationRequest, source: 'gui'|'script'|'mcp'): Promise<Result<TransactionResult>>;
CommandEngine.executeScript(req: ScriptRequest, compile: ScriptCompiler): Promise<Result<TransactionResult>>;
CommandEngine.undo(req: UndoRequest): Promise<Result<TransactionResult>>;
CommandEngine.redo(req: UndoRequest): Promise<Result<TransactionResult>>;
CommandEngine.snapshot(scope: Scope): Promise<Result<Snapshot>>;
CommandEngine.exportSnapshot(scope: Scope): Promise<Result<ExportSnapshot>>;
CommandEngine.getChanges(scope: Scope, sinceRevision: number): Promise<Result<ChangeSet>>;
CommandEngine.replaceDocument(doc: DiagramDocument, expected: Scope & {baseRevision:number}): Promise<Result<Snapshot>>;
CommandEngine.markSaved(scope: Scope, revision: number, path: string): Promise<Result<void>>;
CommandEngine.setProjector(project: (snapshot: Snapshot, diff: ResolvedDiff) => Result<void>): void;
CommandEngine.setSnapshotProjector(project: (snapshot: Snapshot) => Result<Projection>): void;
CommandEngine.onCommitted(listener: (event: CommittedEvent) => void): () => void;
```

UndoRequest is Scope + transactionId/baseRevision. ResolvedDiff contains explicit
upserts/deletes for elements/pages/layers/assets, source, transactionId, previousRevision
and revision. ChangeSet contains transaction summaries and earliest retained revision;
ScriptCompiler compiles source against the current snapshot into operations/source
spans without side effects, including supplied preparedAssetRefs in its context.
I21 supplies that compiler. `executeScript` hashes source
and checks cache before invoking it, so duplicate creates don't allocate new live IDs.
Retain 256 cached results under a 16 MiB total budget and 1,000 history summaries as
initial POC defaults, reporting retention floors; byte pressure may evict earlier entries.

CommittedEvent contains sequence, documentId, sessionId, revision and resolvedDiff.
It is emitted in commit order independently of projection success and is forwarded
by recovery.ts as doc.committed to host journal services. Host detects sequence gaps.
Listener failure cannot roll back a committed transaction; it flags recovery degraded
and requests a checkpoint. A tool result is not a durability acknowledgment; flush
can lag up to 250 ms. Export snapshot invokes a synchronous queued barrier and the
pure snapshot projector from I12. Ordinary checkpoint snapshot excludes projection.
The engine owns new session UUID creation on startup/replace/recovery, resets session
history/cache and returns the new scope; host/shim cannot reuse or substitute it.
The store's sessionId constructor argument is supplied by the engine session factory.

Test support `createTestEngine({document?,revision?})` returns engine, store, documentId,
sessionId and fixed UUID IDs; `request(operations, overrides?)` adds a fresh fixed-sequence
transaction UUID and current scope/baseRevision. `seedDocument(20)` contains one image,
19 ordinary shapes and two approved asset descriptors; richer fixtures are local to
owning tests. Test support exports `exactElementHashes(snapshot)` using canonicalSerialize.

Do the following independent red/green cycles in order:

I10 defines all overview wire types (including future Projection/ExportSnapshot,
CommittedEvent/ResolvedDiff/ChangeSet and PreparedAssetRef) in protocol.schema.json.
SchemaParityTests covers each shared DTO and envelope, not just one apply example.
Pin the actual TS/C# generators and test dependencies in the common dependency record
and register contracts/portable tests in Diagram.Portable.slnx.

- [ ] **Schema/unit validation:** write `contracts.test.ts` rejecting unknown operation/patch fields, NaN/Infinity, duplicate UUID/alias and atomic:false; accepting mm→pt conversion and one valid batch. Run `npm --prefix src/web test -- tests/contracts.test.ts` red; implement validation/generated DTOs and `toPoints(value,unit)` in `model/validate.ts`; rerun green and C# fixture parity (`dotnet test tests/Diagram.Contracts.Tests`). Checkpoint contracts.
- [ ] **Incremental commit/rollback:** write `transactions.test.ts`:
  ```ts
  const before = store.snapshot();
  const r = await engine.execute(request([{op:'set',target:ids.image,patch:{assetId:'asset:logo-v2'}}]), 'mcp');
  expect(r.ok && r.value.changed).toEqual([ids.image]);
  expect(store.snapshot().revision).toBe(before.revision + 1);
  expect(hashesExcept(store.snapshot(), ids.image)).toEqual(hashesExcept(before, ids.image));
  ```
  Define hashesExcept locally using exactElementHashes. Add `late_invalid_operation_rolls_back_all`,
  `nested_stroke_patch_preserves_other_leaves`, `create_then_reference`, `no_op_has_no_history`.
  Run `npm --prefix src/web test -- tests/transactions.test.ts` red; implement staged
  planner/validation/commit/diff in listed command files; rerun green and checkpoint.
- [ ] **Session/cache/revision ordering:** in that test file add `missing_identity_rejects`,
  `cached_retry_after_commit`, `same_id_changed_payload_conflicts`, `queued_duplicate_commits_once`,
  `reopen_same_revision_rejects_old_session`, `uncached_stale_revision_preserves_human_edit`:
  ```ts
  const req = request([{op:'set',target:ids.shape,patch:{name:'New name'}}]);
  const original = await engine.execute(req,'mcp');
  const retry = await engine.execute(req,'mcp');
  expect(retry).toEqual(original); // baseRevision is stale, but cache wins
  ```
  Add `same_id_different_baseRevision_conflicts` and `apply_vs_script_same_id_conflicts`.
  Hash method, document/session/page scope, baseRevision and normalized caller params,
  script source/prepared refs for script requests; exclude requestId/deadline/origin
  and compiled UUIDs. This is the same hash boundary specified in the overview.
  Run same targeted command red; implement queue-head scope→cache→revision order,
  canonical payload hashing (not transport fields), Result errors and bounded cache;
  rerun green and checkpoint. Add projection-failure test: committed state remains,
  result is projectionStatus failed, retry doesn't recommit.
- [ ] **History/inverses/barriers:** write `history.test.ts` proving Undo restores exact
  element serialization with a higher revision, redo is cleared by new edit, retention
  eviction returns history_unavailable, and snapshot/replace/markSaved respect queue/session;
  replaceDocument also checks expected revision so an import finishing late cannot
  discard edits made during IO in the same session:
  ```ts
  expect(restoredElementJson).toBe(originalElementJson);
  expect(afterUndo.revision).toBe(afterEdit.revision + 1);
  expect(markSavedForOldSession.ok).toBe(false);
  ```
  Run `npm --prefix src/web test -- tests/history.test.ts` red; implement resolved
  forward/inverse records and queued read/lifecycle barriers; rerun green, typecheck,
  C# parity and checkpoint. Minimal one-page engine is now M1-ready.

  Add ordered `onCommitted` tests for sequence/session/revision/resolved IDs and
  commit delivery despite projector failure. A failed durability listener cannot
  roll back state; it records recovery-degraded status and schedules a checkpoint.

## I12 — Canvas projection and manual editing

**Depends:** I10/I11. **Files:** create `src/web/playwright.config.ts`; modify I11's
`src/web/{index.html,vite.config.ts}`,
`src/web/src/{main.tsx,App.tsx}`, `src/web/src/canvas/{CanvasAdapter,MaxGraphAdapter,SnapshotProjector,GestureController}.ts`,
`src/web/src/components/{Toolbar,Inspector,ShapesPanel,PageCanvas}.tsx`,
`src/web/tests/{canvas.test.ts,browser/editor.spec.ts}`. Add typecheck/build/browser
scripts defined by the overview; serve packaged output through I11's fixed origin.

**Consumes:** store/engine/snapshot/Result from I10; BridgeClient from I11.
**Produces:** `CanvasAdapter.project(snapshot): Result<void>`,
`SnapshotProjector.project(snapshot): Result<Projection>`, `setSelection(ids): void`,
`dispose(): void`; `GestureController.begin(kind,scope,ids): GestureToken`,
`preview(token,operations): void`, `commit(token): Promise<Result<TransactionResult>>`,
`cancel(token): void`, `isActive(): boolean`. Callback adapter emits typed intents,
never cells; inspector uses current revision and units; no independent maxGraph undo.
SnapshotProjector computes routes/group visual frames from the supplied immutable
canonical snapshot in an isolated model, never from live drag/text preview cells.
Register it through engine.setSnapshotProjector; I31's offscreen renderer reuses the
same mapping. ExportSnapshot scope/revision must match its projection.

- [ ] Write canvas unit tests `projection_does_not_emit_edits`, `cell_types_do_not_escape`,
  `gesture_is_one_transaction`, `stale_preview_is_discarded`, `glue_survives_projection`,
  `ExportDuringActiveDragUsesCommittedGeometry`:
  ```ts
  adapter.project(store.snapshot());
  expect(intentCalls).toHaveLength(0);
  expect(afterGesture.revision).toBe(beforeGesture.revision + 1);
  expect(afterGesture.connector.from.elementId).toBe(beforeGesture.connector.from.elementId);
  ```
  Run `npm --prefix src/web test -- tests/canvas.test.ts` red; implement projection
  guards/interaction translation/gesture snapshots; rerun green and checkpoint.
- [ ] Write browser `manual_edit_without_llm` covering create rectangle/text/image/connector,
  multi-selection, move/resize/rotate, Style/Text/Geometry inspector, Undo/Redo, Delete,
  copy/paste UUID remapping, pan/zoom and finite A4 page. Assert canonical state from
  a test-only read API plus visible canvas; no mutation shortcut bypasses engine.
  Run `npm --prefix src/web run test:browser -- tests/browser/editor.spec.ts` red;
  implement components/tools/basic original stencils/rulers/grid/snap/alignment guides;
  rerun green and `npm --prefix src/web run build`; checkpoint usable M1 UI.
  Include each PNG/JPEG/BMP/sanitised-SVG insertion and assert independent image
  object/hash. Assert grid toggle visibility, snap coordinates equal configured
  spacing, unit-labelled rulers and visible alignment guide when edges align.
- [ ] Add `long_text_edit_and_drag_stale_backstop`: active text edit/drag allows local
  commit/cancel, lifecycle replacement cancels previews and an already-admitted stale
  edit cannot overwrite human state. Run browser command red; connect gesture state
  to I30's later admission interface via `onGestureState(active)` callback defined
  here; rerun green. Interlock routing itself is tested in I30.

## I20 — Full mutations, groups, arrange and dependency planning

**Depends:** I12. **Files:** extend `contracts/operations.schema.json` and generated DTOs;
create `src/web/src/commands/{resolveTarget,geometry,groups,arrange,structure}.ts`,
`src/web/tests/{targets,geometry,groups,arrange,structure}.test.ts`;
create `src/web/src/components/ArrangePanel.tsx`, extend Toolbar/Inspector context
menus, create `src/web/tests/browser/arrange.spec.ts`.

**Interfaces:** `resolveTarget(snapshot,pageId?,target): Result<string>`;
`planOperations(snapshot,operations): Result<PlannedTransaction>` (candidate, resolvedDiff,
inverses and affected IDs); `deriveGroupBounds(document,groupId): Bounds`;
`planArrange(snapshot,operation): Result<Operation[]>`. The engine alone publishes
the candidate. Every target is resolved to UUID before diff/journal generation.

- [ ] **Targets/patch/create/delete:** tests `page_aliases_do_not_collide`, `ambiguous_name_has_candidates`,
  `delete_glued_target_requires_detach_or_delete`, `locked_target_rejects`, `duplicate_remaps_internal_links`,
  `kind_and_id_immutable`. Run `npm --prefix src/web test -- tests/targets.test.ts tests/structure.test.ts`
  red; implement corresponding planner families and schema; rerun green/parity; checkpoint.
- [ ] **Geometry/groups:** tests `fixed_pivot_rotate_and_inverse`, `descendant_edit_reports_ancestors`,
  `external_reroute_keeps_group_hash`, `rotationDeg_zero`, `reject_group_angleDeg`,
  `reject_nonuniform_scale_rotated_leaf`, `reject_empty_group`, `ancestor_and_descendant_selection_conflicts`.
  ```ts
  expect(after.group.rotationDeg).toBe(0);
  expect(after.changed).toEqual(expect.arrayContaining([leafId, groupId]));
  expect(groupHashAfterExternalReroute).toBe(groupHashBefore);
  ```
  Run `npm --prefix src/web test -- tests/geometry.test.ts tests/groups.test.ts` red;
  implement move/resize/rotate deltaDeg versus angleDeg, group-only pivot and canonical-only
  bounds; rerun green and checkpoint. Group frames never include auto-routes; do not scale fonts/strokes.
- [ ] **Arrange/order:** tests `align_changes_only_selected_geometry`, `distribute_preserves_ends`,
  `gap_preserves_first`, `reorder_reports_intervening_ids`, `mixed_page_rejects`.
  Run `npm --prefix src/web test -- tests/arrange.test.ts` red; implement align/distribute/gap/z
  according to D2 using deterministic input tie ordering; rerun green and checkpoint.
- [ ] **Arrange/group GUI:** write `browser/arrange.spec.ts` using real selection,
  toolbar/inspector/context controls for align/distribute/gap/front/back/group/ungroup.
  Assert expected selected geometry/z-order and exact hashes of unrelated objects;
  group operations report descendants/ancestors and one Undo restores the action.
  Run `npm --prefix src/web run test:browser -- tests/browser/arrange.spec.ts` red;
  implement ArrangePanel and actions against existing planners, rerun green and checkpoint.
- [ ] **Structural operations:** extend structure tests for page add/rename/size/reorder/duplicate/delete,
  layer add/set/assign/delete and asset register/ref replacement. Deleting a page or layer
  resolves dependencies explicitly; duplicate IDs and cross-page references cannot commit.
  Run structure tests red; implement operation families now (UI in I50), regenerate
  schema/DTOs, rerun full frontend tests/parity and checkpoint. Hash unrelated elements
  for every mutation test, except explicitly reported structural ancestors/dependencies.

## I21 — DrawScript and transparent transaction drawer

**Depends:** I20. **Files:** create `src/web/src/script/{lexer,parser,compiler}.ts`,
`src/web/src/components/{ScriptDrawer,TransactionDrawer}.tsx`,
`src/web/tests/{script.test.ts,browser/script.spec.ts}`; extend compiler injection in engine.

**Consumes:** I10's ScriptCompiler/executeScript and I20 planner/target resolution.
**Produces:** `compile(source,context:{snapshot:Snapshot,newUuid:()=>string,preparedAssetRefs?:Record<string,PreparedAssetRef>}): Result<CompiledScript>`;
CompiledScript is operations plus source spans; `validateScript` plans against a
captured revision without commit. Run invokes engine.executeScript so scope/cache
checks precede compilation. Byte limits applied before parsing.

- [ ] Write parser/compiler tests for every source §9 command family plus group by=/pivot;
  quoted `#`, JSON escapes, dotted alias/port ambiguity, typed dimensions/colors/bools,
  hcenter synonym, mixed angle=/by= rejection and unknown fields:
  ```ts
  expect(compile('set logo stroke="#333333"', context).ok).toBe(true);
  expect(badScript.error.details.line).toBe(2);
  expect(exactElementHashes(store.snapshot())).toEqual(beforeHashes); // validate never commits
  ```
  Create local script scene fixture with logo alias as a shape and an image alias separately.
  Run `npm --prefix src/web test -- tests/script.test.ts` red; implement lexer/parser/compiler
  without eval/network/loops; rerun green and checkpoint.
- [ ] Add `script_equals_typed_operations`, `one_batch_one_undo`, `duplicate_script_create_retries_once`,
  `page_use_is_context_only`, `asset_prepare_precedes_commit`, `1001_operations_reject`.
  Run script tests red; connect compile injection, prepared-host asset tokens (I50 supplies
  catalogue/UI; I11 already prepares durable refs) and Validate/Run drawer. Entire script is one atomic batch; errors have
  original spans. Rerun green, script browser scenario and checkpoint.
- [ ] Browser tests show revision, created/changed/deleted IDs, warnings and source;
  selected earlier transaction cannot selectively undo over a later human change.
  Run `npm --prefix src/web run test:browser -- tests/browser/script.spec.ts`;
  expected PASS; build/typecheck and update M2 evidence.
