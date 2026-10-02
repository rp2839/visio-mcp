**Overall verdict: approve with corrections.** I read the overview, the M0, editor and host subplans, `QUESTIONS.md`, the D5 routing and ordering sections, and source §27. The plan can be executed and its order is sound. I found no dependency cycles. The plan correctly gets these right:

- **M0 before production:** probes stay under `spikes/`, and I05 PASS gates all production work.
- **Single authority:** the frontend engine is the only document owner, and the host only does IO.
- **R1–R4:** cache before revision, including script creates (I10/I21) and reconnect (I30 LiveControl); a frontend-owned per-connection FIFO gate; group bounds exclude routing (I20).
- **Lifecycle races:** I11/I40 test save, open and session switching.
- **Durability:** blobs are stored durably before journal records are written (I51).
- **Office acceptance:** never claimed from Linux (I05/I41).

The issues below are contract-ownership and coverage gaps that should be fixed before execution starts. None reopens the stack or the agreed design.

## Important findings (fix before execution)

**1. Cross-language DTOs have no schema owner.** The overview defines `Projection`, `ExportSnapshot`, `TransactionResult`, `Diagnostic` and `AppError` as TS types (`implementation.md:94-123`). `ResolvedDiff` and `ChangeSet` are described only in prose in I10 (`editor.md:49-52`). But C# consumes them:
- `ExportSnapshotDto` in I40 (`host.md:163`)
- `ResolvedDiffDto` in I51 (`host.md:262`)
- `SnapshotDto`/`ScopeDto` in I11

This contradicts "no independently handwritten property names" (`implementation.md:91-92`).
- **Correction:** I10 puts all of these, plus the envelope, into `contracts/protocol.schema.json` with parity fixtures in `SchemaParityTests.cs`. `Projection` can be defined in I10 even though I12 produces it.

**2. Where export and checkpoint projections come from is unclear.** `captureProjection(snapshot)` belongs to the live `CanvasAdapter` (I12, `editor.md:117`). During a drag, the live canvas holds preview geometry. No queued barrier method returns an `ExportSnapshot`; I40 only says "uses I12 projection at the same immutable revision" (`host.md:168`).
- **Correction:** define one queued barrier, e.g. `CommandEngine.exportSnapshot(scope): Result<ExportSnapshot>` / `doc.exportSnapshot`. It should compute the projection offscreen from the committed snapshot, never from the live canvas.
- **Test:** add `ExportDuringActiveDragUsesCommittedGeometry` (I12 produces, I40 consumes). I31's offscreen renderer can share the same projector.

**3. There is no defined channel from commits to the journal.** I10 exposes only `setProjector(snapshot, diff)`. I51 needs ordered resolved diffs, with created UUIDs, delivered to the host. Reusing the projector would mix projection-failure semantics with durability.
- **Correction:** add an ordered `onCommitted(listener)` sink to I10. Its events carry sequence, session and revision so the host can detect gaps (design D5 events). I51 `recovery.ts` consumes it.
- **Also state:** an MCP reply is not a durability claim, because journal flush is ≤250 ms.

**4. Opening native JSON has no hostile-input protection.** D7 sets limits for native JSON: 64 MiB, depth 128, 1 MiB strings (`host-and-interoperability.md:317`). The I11 LifecycleTests (`host.md:43-49`) test neither those limits nor running embedded asset bytes through `AssetPreparer` (SVG sanitising, raster caps) before publish. `InputLimits.cs` is listed but untested for JSON.
- **Correction:** add `OversizeOrDeepJsonRejectsBeforePublish` and `JsonEmbeddedSvgIsSanitisedBeforePublish` to I11.

**5. No package owns the arrange, z-order or group GUI.** This leaves a §27 gap. §27 requires that the *user* can align/distribute and change z-order. I12's browser test omits these, and its UI is built before `planArrange` exists (I20). I20 creates only command files; its "UI in I50" note covers only structural operations.
- **Correction:** I20 adds toolbar/context actions for align, distribute, gap, z-order and group/ungroup, plus a browser spec, e.g. `src/web/tests/browser/arrange.spec.ts`.

**6. The probe doesn't check for gesture hooks.** R3 depends on the canvas exposing begin/commit/cancel events for drag, resize, rotate and in-place text editing, so `onGestureState` can feed the gate. G2 (I02, `m0.md:75-85`) doesn't test this, so a maxGraph limitation would only show up at I12, after the go decision.
- **Correction:** add `gesture_lifecycle_observable_and_cancellable`, including in-place text editing, to `spikes/canvas/tests/canvas.spec.ts`.

**7. Admission-gate tests are missing two cases** (I30, `host.md:91-107`). The only ordering test covers the 3 s expiry. Missing:
- a gesture that ends before 3 s releases the held mutation, then the later read, in FIFO order;
- a gesture that starts while a request is already held.
- **Correction:** add `gesture_end_releases_fifo_in_order` and `gesture_restart_does_not_extend_beyond_deadline`.

**8. Imported blobs may not be durable before publish.** I51's `BlobBeforeRecord` covers commits only. I40 import (`ImportResult` asset blobs) and I11 JSON open don't require `PutDurableAsync` before `replaceDocument` publishes. A crash after publish could then leave a new-session checkpoint pointing at blobs that were never stored durably.
- **Correction:** state the requirement in I40's "Open/export integration" step and add the test there.

## Minor corrections

- **Field name mismatch:** `editor.md:167` asserts `after.changedIds`, which isn't a `TransactionResult` field. Use `changed` / `visuallyAffectedIds`.
- **Dedup hash:** R2 says the dedup hash covers method, scope, baseRevision and params. I10's "canonical payload hashing (not transport fields)" (`editor.md:89`) is ambiguous. Name the fields explicitly and add `same_id_different_baseRevision_conflicts` and `apply_vs_script_same_id_conflicts`.
- **Who creates sessions:** `createDocumentStore(document, sessionId)` and `replaceDocument` don't say who creates the new sessionId on open, import or recovery. State the owner, and have `replaceDocument` return the new scope.
- **Grid/snap/guides untested:** they appear only in an implementation sentence (`editor.md:138`). Add assertions to `editor.spec.ts`. I50's browser test should also show that hidden/locked layers block canvas selection and editing, not just that the flags toggle.
- **Solution files:** I10 creates `Diagram.Portable.slnx` and I11 creates `Diagram.Windows.slnx`, but no later task adds its projects to them. I52 runs both (`host.md:317`). Each project-creating task should register its projects.
- **Dependency pinning:** the overview says to pin versions in I00, but I00 covers probe dependencies only (`m0.md:38-39`). Production-only tools also need versions and licences recorded: the TS/C# code generator behind `tools/generate-contracts.mjs`, React, xUnit, the Playwright browser and fonts for I31 goldens. Either I00 records them as candidates, or the first task that uses each one does.
- **Undefined DTO:** I21's "prepared-host asset tokens" has no DTO. Define a schema-owned `PreparedAssetRef` (I11 produces it, I21/I50 consume it).
- **Ambiguous wording:** I30 says "identity supplied by host tools" (`host.md:82-83`). It should say "by MCP client tool arguments".
- **Over-serialised (optional):** I20 depends on I12, but its planners are pure. I20 could run in parallel with I11/I12 after I10. Not a defect.

## §27 coverage

| §27 item | Status |
|---|---|
| Align/distribute, z-order (user GUI) | **Gap**: finding 5 |
| Grid/snap/alignment guides usable | **Weak**: no test (minor list) |
| Layers created/hidden/locked | Operations in I20, UI in I50; add the enforcement test |
| PNG/JPG/BMP/SVG via GUI | I12 tests a generic "image". Add one insert per format, or reference I11/I50 tests for BMP and sanitised SVG |
| All others | Owned and evidenced: VSDX save/reopen/ID survival I40/I41, Word I05/I41, MCP read/apply/render/layout I30/I31, logo by ID I50, one-object regression I10/I20/I31/I52 |

## Confirmed sound (no action)

- M0 gating: I00–I05 avoid `src/`, I05 treats missing Office as NOT RUN.
- Cache-before-revision ordering in I10 and I30, including `held_cached_retry_not_rejected_at_admission`.
- Late save/open across sessions: I11 and I40 lifecycle tests.
- Durability: torn tail vs corruption and the R+1 tail (I51).
- Early hostile input for assets (I11), IPC (I30) and packages (I40 PackageGuard before backend parse).
- Exact vs tolerant hashing are kept separate.

## Decisions that actually need the user

1. **Q1 – Windows/Visio/Word acceptance environment and target versions.** This blocks I01's manual step, I05 and therefore all production work.
2. **Q2 – best-effort VSDX import with a compatibility report and Save As.** The plan already assumes the default.
3. **Q3 – SVG fallback.** Only matters if the native SVG probe fails.
4. **Optional – start I10 before Office is available?** The pure, portable library could begin while Q1 is open. The current plan and the source rule say no, so keep that unless the user explicitly waives it.
5. **Execution request and roles:** Codex implements, Claude reviews read-only at package boundaries.

Nothing else needs the user's input. Everything above is a plan correction Codex can make.
