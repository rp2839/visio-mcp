# Agentic Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Do not start execution until the user requests implementation.

**Goal:** Deliver the specified Windows diagram editor with deterministic human/agent editing and proven editable Visio interoperability.

**Architecture:** One TypeScript document store and command queue own committed state. Canvas, scripting and MCP use the same operations; the Windows host owns IO and stateless VSDX mapping. Feasibility probes precede production projects.

**Tech Stack:** .NET 10, WPF/WebView2, React/TypeScript/Vite/maxGraph, OfficeIMO.Visio and official C# MCP SDK. Pin exact dependency versions in I00; those choices remain conditional on M0.

**Spec:** [Original MVP spec](../../../agentic-visio-mvp-spec.md), [agreed architecture](../../design/architecture.md), [editor design](../../design/editor-and-commands.md), [host design](../../design/host-and-interoperability.md), [feasibility design](../../design/feasibility-and-acceptance.md), [decisions](../../design/QUESTIONS.md).

Status: Claude reviewed with corrections; Codex has integrated those corrections.
Author: Codex. No implementation tasks, dependency installs or runtime checks have
been executed. [Review and disposition](../../design/collaboration/implementation-review-disposition.md).

## Global constraints

The following source rules apply to every subplan:

- "Do the M0 spikes first."
- "Keep the canonical model library-independent."
- "Never implement agent editing as regenerated SVG/XML."
- "Keep the MCP server provider-neutral."
- "Treat imported SVG/images and VSDX as untrusted input."
- "Record dependency versions and licences at the commit used for the POC."

Canonical coordinates are points (1/72 inch), px is 1/96 inch; element identities
are UUIDs, aliases are page-scoped. App/schema protocol v1, atomic batches only;
mutation identity and R1–R4 follow the agreed design, including its recorded source
refinements. No production scaffolding until all M0 functional gates pass, including
desktop Visio/Word acceptance. No cloud/provider credentials or general scripting.

## Review focus

These usage/failure cases receive explicit tests in their owning tasks:

1. Retry after a committed mutation with a lost reply: cache before revision check; test I10/I30, including reconnect and queued duplicates.
2. Long human text/drag session with queued agent work: bounded FIFO admission without blocking gesture commit; test I12/I30.
3. Save/open completing after document switch: never mark a different session clean or publish a stale import; test I11/I40.
4. Crash between blob persistence and journal/checkpoint publication: recover only contiguous durable records and retain newer tail; test I51.
5. Visio copying shapes and changing image bytes while old User cells persist: regenerate duplicate IDs and reject stale image provenance; test I40/I41.

## Plans and package ownership

| Subplan | Packages | Deliverable |
|---|---|---|
| [M0 feasibility](2026-10-02-agentic-diagram-m0.md) | I00–I05 | Versioned probes, native-file evidence and recorded go/no-go |
| [Canonical engine and editor](2026-10-02-agentic-diagram-editor.md) | I10, I12, I20, I21 | Independently testable library and usable manual editor |
| [Host, integration and delivery](2026-10-02-agentic-diagram-host.md) | I11, I30, I31, I40, I41, I50, I51, I52 | Windows shell, live MCP, native files and acceptance |

Execute according to dependencies, not file order. Each package has independently
reviewable red/green verification. Repeated mutation families in I20 and IO mappings
in I40 have separate test cycles and commit boundaries specified in those packages.

```text
I00 → I01, I02, I03; I02 → I04; I01–I04 → I05 (all M0 acceptance)
I05 → I10 → I11 → I12 → I20 → I21
I11 + I20 + I21 → I30; I12 + I20 + I30 → I31
I01 + I20 + I30 + I31 → I40 → I41
I20 + I40 → I50; I11 + I30 + I40 + I50 → I51
I31 + I41 + I50 + I51 → I52
```

Proposed implementer is Codex, Claude reviews contract/native-format/failure semantics.
The broker currently permits read-only workers: do not assign Claude direct writes
unless that capability changes. Native execution with Claude at package boundaries
is recommended because state/transport/adapter interfaces are tightly coupled.
The user has authorised plan creation/review, not implementation.

## File map and contracts

These paths are **planned**, not files that currently exist. Links above point to
existing design documents; code paths below are deliberately written as code.

| Path | Responsibility / creating task |
|---|---|
| `spikes/` | Isolated probe projects only; I00–I04 |
| `contracts/{document,operations,protocol,mcp-tools}.schema.json` | Library-independent authoritative wire schema; I10, extended I20/I30 |
| `src/web/src/contracts/generated.ts` | Schema-derived TS DTOs; I10 |
| `src/Diagram.Core.Contracts/Generated/` | Schema-derived C# DTOs; I10 |
| `src/web/src/model/` | Validation, store, exact serialization/hash; I10 |
| `src/web/src/commands/` | Queue, planner, diffs, history, mutation families; I10/I20 |
| `src/web/src/canvas/` | maxGraph projection and interaction translation; I12 |
| `src/web/src/script/` | Lexer/parser/compiler; I21 |
| `src/web/src/render/`, `layout/` | Revision-labelled previews/diagnostics; I31 |
| `src/Diagram.App/`, `Diagram.Host.Core/` | Windows shell, safe IO, assets, recovery; I11/I50/I51 |
| `src/Diagram.Ipc/`, `Diagram.Mcp/` | Bounded pipe protocol/stdio shim; I30 |
| `src/Diagram.Visio/`, `Diagram.Visio.Abstractions/` | Snapshot mapping, diagnostics and fallback seam; I40 |
| `tests/fixtures/`, `docs/m0/`, `docs/acceptance/` | Reproducible machine/manual evidence; tasks as specified |

I10 owns every cross-boundary definition in the schema bundle, including Scope,
Snapshot, Projection, ExportSnapshot, TransactionResult, TransactionRecord,
ResolvedDiff, ChangeSet, Diagnostic, AppError, RequestEnvelope, ResponseEnvelope,
CommittedEvent, PreparedAssetRef, PreparedAsset and all method outcomes/options.
Protocol definitions belong in contracts/protocol.schema.json; document/operation
unions belong in their respective files. I11/I20/I30/I31/I40/I50/I51 extend those
same definitions when adding fields/methods and update TS/C# parity fixtures together.
TS types here describe schema intent, not separately handwritten wire DTOs.

Use source §5 DTO names as the schema's public types: DiagramDocument, Page, Layer,
Element, Asset, Operation and TransactionRecord. Schema generation defines TS and
C# equivalents; no independently handwritten property names. Additional contracts:

```ts
type Scope = { documentId: string; sessionId: string; pageId?: string };
type MutationRequest = Scope & {
  transactionId: string; baseRevision: number; atomic?: true;
  operations: Operation[];
};
type PreparedAssetRef = { preparationId: string; asset: Asset; expiresAt: string };
type PreparedAsset = { ref: PreparedAssetRef };
type ScriptRequest = Omit<MutationRequest, 'operations'> & {
  script: string; preparedAssetRefs?: Record<string, PreparedAssetRef>;
};
type ElementChanges = { created: string[]; changed: string[]; deleted: string[] };
type TransactionResult = ElementChanges & {
  transactionId: string; previousRevision: number; revision: number;
  noChange: boolean; changedPageIds: string[]; changedLayerIds: string[];
  changedAssetIds: string[]; visuallyAffectedIds: string[]; warnings: Diagnostic[];
  projectionStatus: 'applied' | 'failed';
};
type Snapshot = Scope & { revision: number; document: DiagramDocument };
type Projection = Scope & { revision: number;
  connectors: Record<string, { routePoints: Point[]; visualBounds: Bounds }>;
  groupVisualBounds: Record<string, Bounds>;
};
type ExportSnapshot = Snapshot & { projection: Projection };
type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
```

Diagnostic is the D6 severity/code/page/source-shape/element/action/detail DTO.
AppError is code/message/retryable/details with outcome when delivery is uncertain.
Point/Bounds use source canonical x/y/width/height fields in pt; the explicitly named
operation pivot is `{xPt,yPt}`. C# serializer camel-cases these exact properties.
RequestEnvelope places documentId/sessionId at the top level; params contains
pageId, transactionId, baseRevision and operations/script/preparedAssetRefs. Adapters
split the flat request type without duplicating scope in params; conflicting scope
copies are invalid. The cache hash uses explicit caller params/source, not regenerated
IDs or refreshed preparation tokens. Optional preparedAssetRefs are stable caller
input: repeat the original refs on retry. Verify expiry/host ownership only after
the queue-head cache miss. Script source import names refer to those prepared refs;
the compiler never opens paths or performs IO.

RequestEnvelope adds protocolVersion/kind/requestId/method/params and validated scope;
origin is host-stamped telemetry, never an idempotency key. Events carry sequence,
session and revision. Tool schemas retain source tool names and add agreed mutation IDs.

## Verification conventions and execution hygiene

Commands are instructions for future executors, not claims that today's folder is
buildable. Run from repository root unless stated. Each package creates its harness
configuration with its first test; setup is part of that package, not production
scaffolding before M0. npm scripts in `src/web/package.json`: `test` = `vitest run`,
`test:browser` = `playwright test`, `typecheck` = `tsc --noEmit`, `build` = `vite build`.
.NET tests use xUnit and target net10.0, except App/Windows tests target net10.0-windows.
Create portable `Diagram.Portable.slnx` and Windows `Diagram.Windows.slnx` after I05;
never claim WPF/Visio/Word acceptance from Linux.

Each task creating a .NET project registers it in the appropriate solution: contracts,
Host.Core, IPC, MCP and Visio plus portable tests in Diagram.Portable.slnx; App and
Windows tests in Diagram.Windows.slnx along with needed portable references. Probe
projects stay isolated from both. The first production task introducing a dependency
records its resolved version/commit/licence in docs/m0/dependencies.json and lockfiles,
including code generators, React, xUnit, Playwright browser and pinned golden fonts.
I00 pins probe versions; it does not silently authorise unpinned production tools.

Per task: write the named failing behaviour test; run its command and observe a
behavioural failure (not merely a broken environment); implement the defined interface;
rerun and record results; review diff and commit only if valid git metadata is available.
This workspace currently lacks usable git metadata; do not fabricate commit evidence
or initialise/change repository state implicitly. During execution use isolation when
available and record local checkpoints if git remains unavailable.

Update [implementation progress](../../../IMPLEMENTATION_PROGRESS.md) with task status,
exact command, environment, fixture paths, results and limitations. Never check a manual
acceptance box based on automated library reopening. Any incompatible contract change
updates schema, both generated languages, fixture examples and consumers together.

## Definition-of-done mapping

| Source §27 criteria | Plan packages |
|---|---|
| Windows startup, practical page-oriented editor | I11/I12 |
| Shapes/text/connectors/PNG/JPG/BMP/SVG, geometry/styles | I10/I12/I20/I40/I50 |
| Multi-selection, arrange, z-order, undo/redo | I10/I12/I20 |
| Layers, grid/snap/guides | I12/I50 |
| Glue follows moves, stable IDs, Visio ID retention | I01/I02/I20/I40/I41 |
| DrawScript incremental edits | I21 |
| MCP semantic reads and atomic revision-checked edits | I30 |
| MCP page/region images and layout diagnostics | I31 |
| Stable approved asset/logo selection | I50 |
| Editable supported VSDX export/reopen | I01/I40/I41 |
| Word activation/editability | I05/I41 |
| One-object correction preserves unrelated objects | I10/I20/I30/I50 |

## Current external decisions

Q1 requires a Windows/Visio/Word machine before I05 can pass. Q2 retains the specified
best-effort arbitrary import policy; Q3 decides acceptable SVG fallback only if the
native probe fails. Independent probes may be prepared before those answers;
production cannot bypass required native acceptance. User review of this plan and
an execution request are the next handoff, not an automatic code-writing phase.
