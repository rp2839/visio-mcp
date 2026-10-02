# Host, Interoperability and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Connect the canonical editor to Windows, MCP, assets, native files and durable recovery, then demonstrate the POC.

**Architecture:** Host services perform bounded IO against immutable snapshots and prepared blobs. All document changes and lifecycle publication pass through the frontend engine; stdio shim is a proxy only.

**Tech Stack:** .NET 10 WPF/WebView2, official C# MCP SDK, OfficeIMO.Visio behind an interface; TS renderer/layout and browser tests.

**Spec:** [Overview/contracts/global constraints](2026-10-02-agentic-diagram-implementation.md), [D5–D7](../../design/host-and-interoperability.md), [D8](../../design/feasibility-and-acceptance.md). Inherits all overview constraints and source §27 acceptance.

## Review focus

Session switching during IO (I11/I40); reconnect/gesture/reply ordering (I30);
missing asset/font or stale sidecar in a preview/export (I31/I40); copied Visio IDs
and stale image provenance (I40/I41); journal/blob/checkpoint crash boundaries (I51).

## I11 — WPF shell, safe assets and JSON lifecycle

**Depends:** I05/I10. **Files:** create
`src/Diagram.App/{Diagram.App.csproj,App.xaml,MainWindow.xaml,MainWindow.xaml.cs}`,
`src/Diagram.Host.Core/{Diagram.Host.Core.csproj,BridgeRouter.cs,SessionCoordinator.cs,AtomicFileWriter.cs,InputLimits.cs,BlobStore.cs,AssetPreparer.cs}`,
`src/web/src/bridge/{BridgeClient,hostServices}.ts`, `Diagram.Windows.slnx`,
`tests/Diagram.Host.Tests/{Diagram.Host.Tests.csproj,LifecycleTests.cs,AssetInputTests.cs}`,
`tests/Diagram.Windows.Tests/{Diagram.Windows.Tests.csproj,BridgeTests.cs}`.
Create `src/web/{index.html,vite.config.ts}` and `src/web/src/bridge/bootstrap.ts`
with a minimal readiness/bridge page for this task. I12 modifies that entrypoint into
the React editor; do not depend on an editor bundle that doesn't exist yet.

**Consumes:** generated contracts and I10 engine methods. **Produces:**
`BridgeClient.request(envelope): Promise<ResponseEnvelope>`;
`BridgeRouter.SendAsync(RequestEnvelope,CancellationToken): Task<ResponseEnvelope>`;
`SessionCoordinator.OpenJsonAsync(path,ExpectedState,ct): Task<Result<SnapshotDto>>`;
`SaveJsonAsync(path,ScopeDto,ct): Task<Result<SavedFile>>`;
`AtomicFileWriter.WriteAsync(path,bytes,ct): Task`;
`AssetPreparer.PrepareAsync(stream,mime,ct): Task<Result<PreparedAsset>>`;
`BlobStore.ReadAsync(sha,ct): Task<ReadOnlyMemory<byte>>`, `PutDurableAsync(bytes,ct): Task<string>`.
ExpectedState is documentId/sessionId/baseRevision. SavedFile includes exact saved
scope/revision/path. PreparedAsset contains validated immutable descriptor/hash;
host preparation completes before registerAsset/image operations commit.
PreparedAsset includes schema-owned PreparedAssetRef and validated blob metadata.
Its host-issued preparationId is an opaque approved-byte capability; importer/script
consumers never interpret it as a filesystem path. I21 consumes the same ref type,
and I50 adds catalogue resolution without inventing a second token DTO.

- [ ] Write LifecycleTests `SaveRevisionRDoesNotCleanRPlus1`, `SaveCannotCleanAnotherSession`,
  `LateOpenCannotReplaceNewSessionOrNewEdits`, `WriteFailurePreservesOriginal`,
  `JsonLoadPreservesImagesAndIds`. Fake editor uses generated SnapshotDto; no host-side
  editable document. Assert previous file bytes unchanged on a simulated pre-replace error.
  Run `dotnet test tests/Diagram.Host.Tests --filter LifecycleTests` red; implement atomic
  same-directory temp/flush/replace, queue barriers and expected revision/session checks;
  rerun green and checkpoint. JSON stores asset blobs once by hash; reload gets fresh session.
  Add `OversizeOrDeepJsonRejectsBeforePublish` for 64 MiB/depth128/ordinary strings1 MiB,
  `JsonEmbeddedSvgIsSanitisedBeforePublish`, `JsonEmbeddedRasterDecodeBudget`,
  `ImportedBlobsDurableBeforePublish` and reference/hash consistency tests. Enforce
  parser budgets before materialising the tree, prepare embedded bytes through
  AssetPreparer, store durably then validate/publish the candidate. Report sanitisation
  and update changed hash descriptors; never reread sourcePath.
- [ ] Write AssetInputTests `RasterHeaderOver64MpxRejectsBeforeDecode`, `SvgExternalResourceRejects`,
  `SanitiseThenHash`, `SourcePathNeverAutomaticallyReread`:
  ```csharp
  Assert.Equal("limit_exceeded", tooLarge.Error.Code);
  Assert.Equal(0, decoderCalls);
  Assert.Equal(expectedSanitisedHash, prepared.Value.Ref.Asset.Sha256);
  ```
  Run `dotnet test tests/Diagram.Host.Tests --filter AssetInputTests` red; implement D7
  limits/MIME/SVG allowlist and durable blob storage now, not only at I51; rerun green.
  M1 local picture insertion can use file picker/prepared descriptor; library UI is I50.
- [ ] On Windows write/run BridgeTests `NotReadyRejects`, `WrongOriginOrChildFrameRejects`,
  `CorrelationsDoNotCollide`, `AppStartsReadyWithA4Snapshot`, `PendingMutationCrashIsUnknown`.
  Implement dispatcher-only WebView2 access and packaged fixed-origin Vite bundle; deny
  navigation/new windows/general host objects. Run `dotnet test tests/Diagram.Windows.Tests --filter BridgeTests`
  and `dotnet build src/Diagram.App` green; record runtime/version and checkpoint.

## I30 — Production IPC, admission gate and live MCP tools

**Depends:** I11/I20/I21. **Files:** create
`src/Diagram.Ipc/{Diagram.Ipc.csproj,FrameCodec.cs,PipeServer.cs,PipeClient.cs,Handshake.cs}`,
`src/Diagram.Mcp/{Diagram.Mcp.csproj,Program.cs,DiagramTools.cs,ToolErrors.cs}`,
`src/web/src/bridge/{RequestRouter,AdmissionGate}.ts`, `contracts/mcp-tools.schema.json`,
`tests/Diagram.Ipc.Tests/{Diagram.Ipc.Tests.csproj,FrameTests.cs,PeerTests.cs}`,
`tests/Diagram.Mcp.Tests/{Diagram.Mcp.Tests.csproj,ToolTests.cs}`,
`src/web/tests/admission.test.ts`, `tests/Diagram.Windows.Tests/LiveControlTests.cs`.

**Interfaces:** `PipeClient.CallAsync(RequestEnvelope,ct): Task<ResponseEnvelope>`;
`PipeServer.StartAsync(RequestHandler,ct): Task`;
`RequestRouter.dispatch(envelope): Promise<ResponseEnvelope>`;
`AdmissionGate.accept(connectionId,envelope): Promise<ResponseEnvelope>`;
`setGestureActive(active): void`. Gate is frontend-owned and fed I12 gesture events;
host supplies connection identity. document mutations go engine.execute/executeScript;
read/snapshot barriers go engine reads. Shim forwards explicit session/document/transaction
identity supplied by MCP client tool arguments, never auto-generates mutation IDs or retries.

- [ ] Write frame/peer/SDK tests `PartialFrames`, `32MiBCap`, `FirstFrameHandshake`,
  `EightClientsSixteenPendingLimit`, `SameUserSessionOnly`, `UnknownMutationTimeout`,
  `StdioHasNoLogs`, `ToolSchemasRequireIdentity`, `AllToolNamesMatchSource`.
  Run `dotnet test tests/Diagram.Ipc.Tests` and `dotnet test tests/Diagram.Mcp.Tests`
  red; implement framing/correlation/current-user pipe checks and official SDK tools;
  rerun green, Windows peer tests and checkpoint. Verify logs/capabilities without exposing document text.
- [ ] Write fake-clock `admission.test.ts`:
  ```ts
  gate.setGestureActive(true);
  const mutation = gate.accept('c1', applyEnvelope);
  const laterRead = gate.accept('c1', summaryEnvelope);
  expect(dispatchedMethods).toEqual([]); // same connection cannot overtake
  await advanceMs(3000);
  expect((await mutation).error.code).toBe('busy_user_editing');
  expect((await laterRead).ok).toBe(true);
  ```
  Local advanceMs uses Vitest fake timers. Add `other_connection_reads_committed_state`,
  `gesture_commit_bypasses_gate`, `held_cached_retry_not_rejected_at_admission`,
  `lifecycle_cancels_gesture`, `no_document_or_session_cannot_cross_gate`.
  Add `gesture_end_releases_fifo_in_order`: ending at 1 s admits mutation then read;
  add `gesture_restart_does_not_extend_beyond_deadline`: successive gesture starts
  cannot reset the held request's original 3 s admission/15 s total deadline.
  Run `npm --prefix src/web test -- tests/admission.test.ts` red; implement per-connection
  FIFO outside engine queue, scope-only admission then engine scope/cache/revision;
  rerun green and checkpoint. Gate caps pending requests via IPC limits, counts 3 s
  inside 15 s mutation deadline; expired request is definitely not_applied.
- [ ] Write Windows LiveControlTests driving a real stdio client → shim → pipe → app.
  Test reconnect after lost committed reply returns identical transactionResult,
  stale human revision remains untouched, changed payload conflicts, script create
  duplicates once, reads show current canonical store. Run
  `dotnet test tests/Diagram.Windows.Tests --filter LiveControlTests` red, connect
  routing/tool mapping and rerun green. M3 render tools can advertise not_ready until
  I31; document assets can list immediately; library catalogue appears at I50.
  Final tool surface includes every source §11.2 tool and no lifecycle/shell endpoint.

## I31 — Semantic queries, render snapshots and layout feedback

**Depends:** I12/I20/I30. **Files:** create `src/web/src/render/{SnapshotRenderer,renderRegion}.ts`,
`src/web/src/layout/inspectLayout.ts`, `src/web/src/bridge/readTools.ts`,
`src/web/tests/{layout.test.ts,browser/render.spec.ts}`, `tests/fixtures/golden/`,
`tests/Diagram.Mcp.Tests/ImageContentTests.cs`.

**Interfaces:** `renderPage(snapshot,options): Promise<Result<RenderResult>>`,
`renderRegion(snapshot,options): Promise<Result<RenderResult>>`;
`inspectLayout(snapshot,projection,measureText): LayoutIssue[]`;
`readSummary(snapshot,options): DocumentSummary`, `readObjects(snapshot,ids): Result<Element[]>`.
RenderResult contains MIME/base64, crop pt bounds, pixel size and actual scope/revision.
RenderOptions format png/jpeg, clean/debug, defaults maxWidth1600/maxHeight1200;
region requires exactly bounds or elementIds plus paddingPt, no ambiguous crop.
LayoutIssue has code/severity/element IDs/page/bounds/evidence.

- [ ] Write layout unit tests for out-of-page, text overflow, dangling endpoint, image
  distortion, crossings ignoring endpoints/group containment, and heuristic overlap/contrast.
  ```ts
  expect(issues.find(i=>i.code==='OUTSIDE_PAGE')?.elementIds).toEqual([outsideId]);
  expect(exactElementHashes(afterInspection)).toEqual(beforeHashes);
  ```
  Run `npm --prefix src/web test -- tests/layout.test.ts` red; implement diagnostic
  pass without mutation; rerun green. Duplicate aliases arrive as import diagnostics,
  not normal canonical state. Report font/measurement uncertainty explicitly.
- [ ] Write browser render tests `SnapshotRevisionNotLiveRevision`, `ImageAndFontReady`,
  `CropIncludesRotatedGroupVisualBounds`, `CleanExcludesHandles`, `DebugOnlyOverlay`,
  `MissingAssetFailsInsteadOfBlank`, `16MPAnd16MiBReject`, `JpegUsesPageBackground`.
  Run `npm --prefix src/web run test:browser -- tests/browser/render.spec.ts` red;
  implement offscreen same-style projection, controlled rasterisation with local blobs;
  rerun green/golden tolerance with pinned fonts/browser and checkpoint.
- [ ] Test SDK response includes MCP image block plus JSON metadata, never hidden text-only
  base64. Run `dotnet test tests/Diagram.Mcp.Tests --filter ImageContentTests` red;
  connect semantic/read/history/render tools and rerun green plus live Windows visual-loop
  test: inspect→region preview→one-object patch leaves other object hashes exact.

## I40 — VSDX mapping, supported import and safe save/export

**Depends:** I01/I20/I30/I31. **Files:** create
`src/Diagram.Visio.Abstractions/{Diagram.Visio.Abstractions.csproj,IVsdxImporter.cs,IVsdxExporter.cs}`,
`src/Diagram.Visio/{Diagram.Visio.csproj,PackageGuard.cs,OfficeImoImporter.cs,OfficeImoExporter.cs,GeometryMap.cs,IdentityMap.cs,CompatibilityReport.cs}`,
`tests/Diagram.Visio.Tests/{Diagram.Visio.Tests.csproj,MappingTests.cs,IdentityTests.cs,PackageGuardTests.cs}`,
`tests/fixtures/vsdx/{app-authored,visio-saved,hostile}/`, `docs/vsdx-compatibility.md`;
extend SessionCoordinator/BridgeRouter for native open and export.

**Interfaces:** `IVsdxImporter.ImportAsync(Stream,ImportOptions,ct): Task<ImportResult>`;
`IVsdxExporter.ExportAsync(ExportSnapshotDto,IAssetBlobSource,ExportOptions,ct): Task<ExportResult>`.
ImportResult = candidate DocumentDto, validated asset blobs, diagnostics, identity report;
ExportResult = package bytes, diagnostics, element/native-ID map. PackageGuard validates
bounded actual decompression and safe XML before backend parse. Never read sourcePath.
Export rejects document/projection scope/revision mismatch; no maxGraph/OfficeIMO types
escape contracts. Snapshot acquisition uses CommandEngine.exportSnapshot via doc.exportSnapshot barrier,
which invokes I12's pure SnapshotProjector on committed state, never live preview cells.
Checkpoints use ordinary engine.snapshot without a projection. Add I40 export test
ExportDuringActiveDragUsesCommittedGeometry against this same barrier.

Perform separately reviewable red/green mapping cycles, using `dotnet test tests/Diagram.Visio.Tests --filter <class>`:

- [ ] **PackageGuardTests:** write bomb/traversal/absolute path/XXE/DTDs/external relationship
  and macro/OLE inertness tests. Assert limit_exceeded/invalid package and zero backend
  calls when unsafe. Red; implement streamed counters and safe XML prevalidation; green.
- [ ] **MappingTests/basic objects:** add page sizes/names, all source presets/custom path,
  independent text, fill/line/dash/arrows/wrap/padding/alpha and bounds/33° rotation fixtures.
  Red; implement stateless native geometry/style/text maps; green with native tolerances
  0.01 pt/0.01° and editable-object inspection. Unknown effects emit diagnostics.
- [ ] **MappingTests/structural:** static/dynamic/unglued endpoints, authored waypoints,
  free points, groups/frame normalisation/local transforms, z-order, multilayers/locks/
  hidden and page/grid/guides fixtures. Red; implement mapping and identity references;
  green. Use observed M0 layer policy. Report dropped target glue and unsupported constraints.
- [ ] **MappingTests/images:** PNG/JPEG/BMP plus verified SVG/fallback source, contain/cover/stretch,
  opacity and edited foreign-data fixtures. Red; implement independent picture objects
  and validated blob extraction; green. Keep original SVG source package-carried if
  fallback approved/proven; do not recover original from stale User.AssetSha256 after
  picture replacement. Self-reopen export verifies counts/IDs/references before save.
- [ ] **IdentityTests:** missing/invalid IDs, copied duplicates, aliases on one page,
  repeated unchanged-byte import UUIDv5, stale AgentPreset/image metadata and group/page/layer IDs.
  Red; implement deterministic collision repair/remapping/diagnostics; green. Persist valid
  identity unchanged. Exact live-state regression hashing is separate from tolerant native comparison.
- [ ] **Open/export integration:** add LifecycleTests for compatibility report/Save As
  loss guard, invalid whole-candidate rejection preserving existing document, save of
  revision R while R+1 remains dirty, late native open versus new edits/session, missing
  blob and stale sidecar. Red; prepare import/IO outside queue, publish through I10
  expected session/revision barrier; green. Add ImportedNativeBlobsDurableBeforePublish:
  persist all validated imported blobs with PutDurableAsync before replacing document
  or creating a new-session checkpoint. A failure keeps the existing document intact.
  MCP export applies path policy at I51 (initial
  approved-root-only path validation belongs here), GUI native save never silently loses unsupported parts.
- [ ] Run full native/parity tests, write actual supported feature matrix with diagnostics
  for unproven rows, optionally independent parser/render oracle. Checkpoint each family
  and final M4 mapping evidence; real Office acceptance is still I41.

## I41 — Native Windows/Office acceptance

**Depends:** I40. **Files:** create `docs/acceptance/{visio-word-checklist.md,WA-results-<date>.md}`,
`docs/acceptance/evidence/WA-01..WA-12/`; append Visio-saved fixture sidecars.

**Interfaces:** exact WA scenarios/environment/result/evidence referenced by D8.

- [ ] Run Windows app-authoring/export, no-repair Visio open, text/fill/move/glue/image
  edits and save/reopen; compare pre-export UUID list via get_objects after reload.
- [ ] Embed/activate/edit/save/reopen in Word; verify both Visio object editability and
  Word reactivation. Include duplicate shape IDs, native group resizing, multi-layer
  policy and image replacement with stale User cells. Unsupported/lossy cases remain visible.
- [ ] Run full fourteen-step source §23 demonstration's native segment. Record actual
  Windows/Visio/Word versions and evidence; missing Office means NOT RUN. Update
  implementation progress only for observed passes, checkpoint evidence; fix failed
  mappings and rerun only affected checks, never substitute library reopening for Office.

## I50 — Pages/layers and approved cross-document asset library

**Depends:** I20/I40. **Files:** create
`src/Diagram.Host.Core/{AssetLibrary.cs,AssetResolver.cs}`, `src/web/src/components/{PageTabs,LayersPanel,AssetsPanel}.tsx`,
`src/web/src/commands/assetVersions.ts`, `tests/Diagram.Host.Tests/AssetLibraryTests.cs`,
`src/web/tests/{assetVersions.test.ts,browser/pages-layers-assets.spec.ts}`.

**Consumes:** AssetPreparer/BlobStore (I11), engine structural operations (I20).
**Produces:** `AssetLibrary.ListAsync(query,tags,ct): Task<IReadOnlyList<LibraryAsset>>`,
`ReplaceSourceAsync(id,prepared,ct): Task<LibraryAsset>`;
`AssetResolver.ResolveAsync(id,scope,hash?,ct): Task<Result<PreparedAsset>>`;
`prepareDocumentAsset(snapshot,prepared): {operations:Operation[], resolvedAssetId:string}`.
library and document scope are explicit; bare slug chooses pinned document version.
New library hash collision gets asset:<slug>~<full-sha256> and result reports it.

- [ ] Write AssetLibraryTests `SourceReplaceDoesNotModifyOpenDocument`, `SanitisedHashStable`,
  `ListReturnsScopeAndVersion`, `DurableBlobBeforeCatalogue`; run
  `dotnet test tests/Diagram.Host.Tests --filter AssetLibraryTests` red. Implement per-user
  catalogue/blob references, names/tags/provenance/dimensions; rerun green and checkpoint.
- [ ] Write assetVersions tests `SingleImageOnly`, `GlobalReplacementReportsAffectedImages`,
  `NewHashSameSlugPinsSeparateVersion`, `InUseDeleteRejects`, `ImportedDocumentWorksWithoutLibrary`:
  ```ts
  expect(changedElementIds).toEqual([imageId]);
  expect(unrelatedHashesAfter).toEqual(unrelatedHashesBefore);
  expect(newId).toBe(`asset:logo~${fullHash}`);
  ```
  Run `npm --prefix src/web test -- tests/assetVersions.test.ts` red; implement prepared
  registration/reference ops, explicit global replacement and hash version IDs; rerun green.
- [ ] Browser tests cover page add/rename/reorder/duplicate/delete/size presets/custom size;
  layer add/rename/delete/assignment/visible/lock/print; asset import/thumbnail/tags/drag,
  rename/replace/delete/copy ID and single/global distinction. Run
  `npm --prefix src/web run test:browser -- tests/browser/pages-layers-assets.spec.ts`
  red; assert hidden objects cannot be selected and locked-layer objects cannot move,
  resize or receive inspector edits; merely toggling flags is insufficient.
  Implement panels against existing engine, connect list_assets and script asset
  preparation; rerun green and checkpoint. No copyrighted vendor stencil copying.

## I51 — Durable recovery and adversarial-boundary hardening

**Depends:** I11/I30/I40/I50. **Files:** create
`src/Diagram.Host.Core/{RecoveryJournal.cs,CheckpointStore.cs,ExportPathPolicy.cs}`,
`src/web/src/commands/recovery.ts`,
`tests/Diagram.Host.Tests/{RecoveryTests.cs,ExportPathTests.cs}`, `src/web/tests/recovery.test.ts`,
`tests/Diagram.Windows.Tests/CrashRecoveryTests.cs`; extend existing input guard tests.

**Interfaces:** `RecoveryJournal.AppendDurableAsync(ResolvedDiffDto,ct): Task<DurableRevision>`;
`CheckpointStore.PublishAsync(SnapshotDto,BlobReferences,journalTail,ct): Task`;
`ReadRecoveryAsync(ct): Task<RecoveryCandidate>`;
`restoreRecovery(candidate): Result<DiagramDocument>` (validate before publish);
`ExportPathPolicy.ResolveAsync(path?,format,scope,clientLabel,ct): Task<Result<ApprovedDestination>>`.
Scope/current source directory is metadata, not a host-side editable document.
recovery.ts subscribes to I10's ordered onCommitted stream and forwards schema-owned
CommittedEvent/resolvedDiff to the host. Sequence/session/revision gaps trigger a
checkpoint; the host does not replay commands or own an editable store. Live MCP
success is not a journal flush acknowledgement; expose last durable revision.
Checkpoint store publishes immutable generation through atomic manifest, retains tail>R
and previous generation. Blob durability precedes referenced journal flush; resolved
patches carry created UUIDs and inverse effects, never raw ID-generating commands.

- [ ] Write fault-injected RecoveryTests for `UndoReplayExact`, `GeneratedIdReplayExact`,
  `BlobBeforeRecord`, `CrashBeforeAfterManifest`, `CheckpointDoesNotLoseTailRPlus1`,
  `TornTailVsMiddleCorruption`, `NewSessionStartsOwnCheckpoint`, `UndoAndRecoveryPreventBlobGc`.
  ```csharp
  Assert.Equal(lastDurableRevision, recovery.Revision);
  Assert.Equal(originalCreatedUuid, recovery.CreatedId);
  Assert.Contains(revisionRPlus1, recovery.ReplayedRevisions);
  ```
  Run `dotnet test tests/Diagram.Host.Tests --filter RecoveryTests` red plus
  `npm --prefix src/web test -- tests/recovery.test.ts`; implement append/flush ≤250 ms,
  checkpoints every 50 commits or 60 s/save, contiguous checked records and candidate
  replay; rerun green. Fresh session/recovery dirty state and loss report required.
- [ ] Write ExportPathTests for omitted path/safe unique name, saved-directory export,
  outside-root/overwrite consent, UNC/device/ADS/reserved names/reparse traversal,
  extension mismatch and late consent after session change. Run
  `dotnet test tests/Diagram.Host.Tests --filter ExportPathTests` red; implement canonical
  root policy, consent timeout deny after 60 s, destination revalidation before write;
  rerun green. Earlier I40 path validation remains fail-closed until this richer UI exists.
- [ ] Extend hostile package/XML/SVG/raster tests from I11/I40, IPC caps/depth, decoded
  resource totals and references, no macro/OLE/script/shell/network execution, inert
  links and content-free logs. Rerun owning guard tests; tighten only where failures
  reveal real gaps. Keep proposed D7 resource caps and record changed defaults with evidence.
- [ ] On Windows run `dotnet test tests/Diagram.Windows.Tests --filter CrashRecoveryTests`:
  kill renderer/host mid-session, restore/report last durable state, reject old agent
  session and re-read/continue. Checkpoint hardening evidence and all applicable failure results.

## I52 — Performance and complete POC demonstration

**Depends:** I31/I41/I50/I51. **Files:** create `src/web/tests/performance/targets.test.ts`,
`tools/demo/{scenario.drawscript,verify-demo.mjs}`, `docs/acceptance/{performance.md,definition-of-done.md}`.

**Interfaces:** reproducible 1–10 page/500-visible-element fixture, timings and exact
object-hash verification; use same canonical serialization from I10. Demo verifier
consumes saved semantic snapshots/transaction reports, not guessed pixel identity.

- [ ] Build benchmark scene and record repeated timings on target Windows machine:
  single edit preferably <100 ms/acceptably <250 ms, 100-operation batch preferably
  <500 ms, 1600×1200 preview preferably <1 s, 500-element summary <250 ms excluding
  transport, VSDX save target <3 s. Run `npm --prefix src/web test -- tests/performance/targets.test.ts`
  and Windows save benchmark; preferred targets are reported, not flaky hard functional gates.
- [ ] Run source §23 complete fourteen-step demo through a real MCP host, including
  human edits, stale revision recovery, visual corrective patch and one approved logo
  swap. Verify unchanged objects exactly, then export/open/edit/glue/Word/reactivate/reload IDs.
- [ ] Attach evidence for every §27 item, failures/skips and supported-subset caveats.
  Run `npm --prefix src/web test`, typecheck/build/browser suites and
  `dotnet test Diagram.Portable.slnx`, `dotnet test Diagram.Windows.slnx` on their supported
  environments. Narrow reruns after fixes, not repeated broad testing without reason.
- [ ] Review the completed branch/source state, update progress with evidence and
  remaining risks, checkpoint final acceptance docs. Declare POC complete only when
  every required criterion has actual evidence; no publishing/deployment is part of this plan.
