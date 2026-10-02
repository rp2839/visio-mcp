# Agentic Diagram M0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prove the selected native-file, canvas and live-control stack before production work.

**Architecture:** Disposable probes use small snapshots and bounded message contracts; all evidence flows into one go/no-go decision.

**Tech Stack:** The conditional .NET/React/maxGraph/OfficeIMO/MCP stack in the overview.

**Spec:** [Plan overview and global constraints](2026-10-02-agentic-diagram-implementation.md), [M0 design](../../design/feasibility-and-acceptance.md), source §§13.5/22/26. This subplan inherits all overview constraints.

## Review focus

The native file must be editable, not a flattened page; glue and IDs must survive
a real Visio save; Word must activate the object; previews must include embedded
assets without taint; logs must not corrupt stdio. I01–I05 own the checks below.

## I00 — Reproducible probe dependencies and minimal contracts

**Depends:** Plan reviewed for execution. **Files:** create
`spikes/README.md`, `spikes/contracts/envelope.schema.json`,
`spikes/contract-tests/{package.json,protocol.test.ts}`, `docs/m0/dependencies.json`,
`docs/m0/environment.json`; introduce each probe's lockfiles in its owning package.
No root production solution or `src/` scaffold.

**Interfaces:** probe envelope `{protocolVersion:1,kind,requestId,method,documentId?,sessionId?,params}`;
the doc.apply fixture requires UUID transactionId/baseRevision/atomic:true. These
are isolated prototypes to validate later production schema, not a competing model.

- [ ] Write `protocol.test.ts` validating one mutation fixture and rejecting missing session/transaction ID and atomic:false.
  ```ts
  expect(validate(validApplyFixture)).toBe(true);
  expect(validate(without(validApplyFixture, 'sessionId'))).toBe(false);
  expect(validate(withAtomicFalse(validApplyFixture))).toBe(false);
  ```
  Define these three fixture helpers locally in this file; use fixed UUIDs and baseRevision 0.
- [ ] In `spikes/contract-tests`, run `npm test`; expected red assertions until the schema rules exist. Harness uses Vitest/Ajv; pin its dependencies with all selected probe versions.
- [ ] Implement the minimal schema; resolve actual available package versions from official sources during execution, inspect licence files, record versions/SHAs and test environment; do not guess future package availability.
- [ ] Rerun `npm test`; expected PASS. Record dependency resolution commands and resulting lockfiles; review and checkpoint/commit only this probe setup.

## I01 — Editable native-file round-trip probe

**Depends:** I00. **Files:** create `spikes/vsdx/{VsdxProbe.csproj,Program.cs,ProbeScene.cs}`,
`spikes/vsdx.tests/{VsdxProbe.Tests.csproj,RoundTripTests.cs}`, `docs/m0/evidence/G1/`.

**Interfaces:** `ProbeScene.Write(string path): ProbeManifest`;
`ProbeScene.Read(string path): ProbeManifest`. ProbeManifest holds page size, source
IDs, text/styles/geometry/layer/image hash and endpoint identity. Library types remain
inside this probe; no production types are introduced.

- [ ] Write `RoundTripTests.GeneratedFileContainsIndependentShapesAndGlue` using a fixed UUID and 297×210 mm page converted to points. Assertions:
  ```csharp
  Assert.Equal(5, manifest.DrawableCount); // rect, ellipse, connector, text box, PNG picture
  Assert.Equal(agentId, manifest.RectangleAgentId);
  Assert.Equal(manifest.RectangleId, manifest.ConnectorFromShapeId);
  Assert.Equal("Probe", manifest.RectangleText);
  Assert.Equal(expectedPngHash, manifest.ImageHash);
  ```
  Add named tests `StaticPortSurvives`, `Rotation33Degrees`, `DuplicateUserIdResolved`
  and `SvgSourcePreservation`, each recording unsupported capabilities rather than lying about support.
- [ ] Run `dotnet test spikes/vsdx.tests/VsdxProbe.Tests.csproj`; observe red mapping assertions, then implement minimal scene/export/reload using pinned OfficeIMO. Generate styles/layer/UUID cells and endpoint glue without whole-page rasterisation.
- [ ] Rerun the tests; run `dotnet run --project spikes/vsdx -- --output docs/m0/evidence/G1/generated.vsdx`. Expected: independent editable objects and inspectable metadata; no claim about Visio yet.
- [ ] On Windows execute G1 manual checklist: open without repair, edit text/fill, move target with glue, replace picture, inspect/save User.AgentId, embed/activate/save/reopen in Word. Save `visio-saved.vsdx`, `embedded.docx`, report/screenshots and environment versions.
- [ ] Run tests against `visio-saved.vsdx`. Compare geometry to 0.01 pt/0.01° only in native comparison; verify UUID and image/glue identity exactly. Probe multi-layer policy, group resize and image provenance. Record G1 PASS/FAIL/PARTIAL and backend decision; checkpoint evidence. A material failure stops production work.

## I02 — Canvas interaction and image-preview probe

**Depends:** I00. **Files:** create `spikes/canvas/{package.json,index.html,src/main.ts,src/projection.ts,playwright.config.ts,tests/canvas.spec.ts}`.

**Interfaces:** `project(scene: ProbeSceneDto): void`,
`readProbeState(): ProbeSceneDto`, `renderProbe(): Promise<Uint8Array>`.
ProbeSceneDto uses plain element IDs/bounds/endpoints/asset bytes, no cell objects.

- [ ] Write Playwright `move_resize_rotate_glue_and_picture` assertions:
  ```ts
  expect(after.revision).toBe(before.revision + 1);
  expect(after.connector.from.elementId).toBe(before.connector.from.elementId);
  expect(after.ellipse).toEqual(before.ellipse);
  expect(png.subarray(0, 8)).toEqual(pngMagic);
  ```
  Fixture/interaction helpers are local to the probe and use a bundled PNG.
  Add `gesture_lifecycle_observable_and_cancellable` covering begin/commit/cancel
  for move/resize/rotate/bend and in-place text editing. Assert cancelling restores
  the probe snapshot, and selection/zoom do not activate the gesture hook.
- [ ] Run `npm --prefix spikes/canvas run test:browser`; observe red behaviour before implementing projection/drag/resize/rotation/glue/image rendering.
- [ ] Implement with pinned maxGraph; rerun browser test. Export evidence PNG, canonical probe state and measured timing. Verify native SVG/vector assets don't taint export; test offscreen render rather than only viewport capture.
- [ ] Record G2 outcome/version and checkpoint probe. Slow preferred preview timing alone is not a functional failure.

## I03 — Real stdio MCP to bounded pipe/test host

**Depends:** I00. **Files:** create `spikes/ipc/{IpcProbe.csproj,Program.cs,FrameCodec.cs}`,
`spikes/mcp/{McpProbe.csproj,Program.cs}`, `spikes/ipc.tests/{IpcProbe.Tests.csproj,TransportTests.cs}`.

**Interfaces:** `FrameCodec.ReadAsync(Stream,CancellationToken): Task<JsonDocument>`;
`WriteAsync(Stream,JsonDocument,CancellationToken): Task`;
host stub handles app.hello and doc.summary; shim exposes get_document_summary.

- [ ] Write `PartialReadRoundTrips`, `FrameLengthAbove32MiBRejectedBeforeAllocation`,
  `NonHandshakeFirstFrameRejected`, `StdoutContainsOnlyMcp`, `MissingHostIsNotRunning`.
  ```csharp
  Assert.Equal("not_running", error.Code);
  Assert.True(protocolOnlyStdout);
  Assert.Equal(0, oversizedFramePayloadAllocations);
  ```
- [ ] Run `dotnet test spikes/ipc.tests/IpcProbe.Tests.csproj`; observe red transport outcomes. Implement 4-byte little-endian framing and real SDK stdio tool routing, with stderr logging only.
- [ ] Rerun tests. On Windows launch stub/shim with any compliant MCP client; list/call tool and save transcript; disconnect mid-call; test second-user refusal and 8 MiB frame; record timings without substituting timing for function.
- [ ] Record G3 and checkpoint. Unix fake transport tests do not establish Windows ACLs.

## I04 — Windows/WebView2 operation-to-live-canvas probe

**Depends:** I00/I02. **Files:** create `spikes/webview/{WebViewProbe.csproj,App.xaml,MainWindow.xaml,MainWindow.xaml.cs}`,
`spikes/canvas/src/bridge.ts`, `spikes/webview.tests/{WebViewProbe.Tests.csproj,BridgeTests.cs}`.

**Interfaces:** `ProbeBridge.SendAsync(RequestEnvelope,CancellationToken): Task<ResponseEnvelope>`;
bridge routes hello/apply to the minimal probe store and returns scope/revision.

- [ ] Write `ReadyBeforeApply`, `MismatchedSessionRejected`, `DuplicateTransactionChangesOnce`,
  `WrongOriginAndChildFrameRejected` and `RendererCrashSettlesPendingUnknown`.
  ```csharp
  Assert.Equal(1, response.Revision);
  Assert.Equal("session_mismatch", stale.Error.Code);
  Assert.Equal(1, duplicate.Revision);
  ```
- [ ] Run `dotnet test spikes/webview.tests/WebViewProbe.Tests.csproj` on Windows; red first. Implement fixed virtual origin, message-only bridge, UI dispatcher, readiness and request correlations.
- [ ] Rerun tests; join I03's stdio/pipe path to WebView2/canvas. Record a visible canvas change matching reply revision, asset PNG without taint, blocked navigation and renderer-failure result.
- [ ] Record G4 and checkpoint isolated projects; do not build the whole GUI here.

## I05 — M0 acceptance and backend gate

**Depends:** I01–I04. **Files:** create `docs/m0/{results.md,decision.md}`, write actual evidence links in `docs/m0/environment.json`; modify implementation progress.

**Interfaces:** a machine-readable result per G1–G4: outcome, environment, fixture paths,
commands, manual checker, limitations; decision permits M1 only if all gates PASS.

- [ ] Recheck required G1/Visio/Word evidence and G2–G4 functional results against the D8 checklist. Missing Windows/Office environment is `NOT RUN`, not PASS.
- [ ] Record each result and the chosen backend. If Word alone fails, investigate environment and backend; it still blocks required acceptance. If native backend fails materially, test alternatives against the same scene and repeat G1.
- [ ] Update progress with the recorded decision. Only after all required evidence passes may production tasks create their projects. Checkpoint the go/no-go report; no artificial unit test is needed for the report itself.
