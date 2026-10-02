# Questions and design decisions

Updated: 2026-10-02. This register separates architectural proposals from actual
disagreement and external acceptance dependencies. The user has no strong stack
preference and authorised recording unresolved questions while design proceeds.

## Questions for the user

No clarification is required to start the design. The following affects future
execution, and can be answered when the user returns:

| ID | Question | Proposed default / impact | Blocks |
|---|---|---|---|
| Q1 | Which Windows environment with desktop Visio and Word will run manual acceptance, and which versions are the target? | Record versions and run the supplied suite on a Windows workstation/VM. Linux-only automated checks cannot establish editable VSDX or Word activation. | Passing M0 and final acceptance; not design drafting |
| Q2 | Is best-effort import with a compatibility report and Save As for lossy VSDX acceptable for this POC? | Yes, matching spec §13.4; never silently overwrite arbitrary imported content when conversion loses features. | Only if the user instead requires arbitrary lossless round-trip |
| Q3 | If native SVG pictures fail the feasibility probe, is an independent PNG picture with preserved SVG source and a rasterisation warning acceptable? | Probe native support first; preserve standalone source and report fallback. Never flatten the page. | SVG export policy after M0; not other design sections |

## Resolved jointly

After the user reset the spending limit, Claude reviewed the integrated design in
task `158c4e3e-244f-4400-b39d-7aa90f924884`. It agreed to R1–R4 with refinements
incorporated into the design. The original positions remain in
[the historical review](collaboration/claude-review.md); the resumed verdicts and
reasoning are preserved in [the consensus review](collaboration/claude-consensus-review.md).
The final consistency check in task `06f06e9e-afd5-4dd6-aa78-812f7edb022b` accepted
the group-rotation syntax and full-hash version IDs. Its remaining correction and
precision edits were applied: admission checks scope only, queue-head cache precedes
revision, rotate fields/pivot semantics are explicit, and cross-session reconciliation
uses current state. [Final review](collaboration/claude-final-consistency.md) preserves
the exact conditional verdict; Codex verified the prescribed edits locally.
There are no remaining cross-agent design disagreements. Q1–Q3 remain for user review.

| ID | Choice | Joint resolution | Required verification |
|---|---|---|---|
| R1 | Mutation session validation | Required explicit documentId, sessionId and client-generated transactionId from read context; no shim-generated IDs or revision-only mode | Missing scope rejects; reopen invalidates old session despite coincident revision numbers |
| R2 | Deduplication scope | `(sessionId, documentId, transactionId)` with method/scope/baseRevision/params hash; queue-head scope validation, then cache check, then revision check | Retry after commit across reconnect returns original result; queued duplicate cannot double-apply; changed payload conflicts |
| R3 | Human gesture versus agent mutation | Per-connection FIFO admission gate holds external mutation outside queue at most 3 s; gesture commits/cancels always enter; old revisions reject after human commit | Same-connection reads do not overtake held mutation; other reads show committed state; expiry is busy_user_editing/not_applied; no queue deadlock |
| R4 | Group bounds authority | Canonical tight bounds derive from descendants' authored geometry only; group rotation zero; rotate/scale expand to descendants; rendered group frames remain sidecar data | Every affected ancestor reported; external rerouting leaves canonical group hash intact; fixed-pivot rotation/scale/import tests |

Claude also agreed to resolved journal replay, atomic recovery manifests retaining
newer journal entries, exact top-level WebView origin checks, whole-candidate import
validation, exact/tolerant hash separation, standalone SVG source preservation,
safe XML prevalidation and pinned asset version semantics. Blob durability must
precede journal flush, and a recovered new session starts from its own checkpoint.

Three review contradictions were corrected: interlock admission now preserves
connection order; deduplication is checked after scope and before revision; group
bounds exclude derived connector routes. These were design corrections, not runtime
test results. No feasibility result or implementation approval is implied by consensus.

## Proposed clarifications to the supplied spec

| ID | Issue | Proposed resolution | Status |
|---|---|---|---|
| A1 | M1 needs editing/undo but command engine is listed in M2 | Minimal canonical engine with source/transactionId is part of M1; M2 expands it | agreed |
| A2 | DrawScript examples use non-UUID `id=` | Interpret as page-scoped alias; add batch pageId; canonical identity remains UUID | agreed |
| A3 | §9 example `hcenter` vs command list `center` | Accept documented synonym | retained in reviewed design |
| A4 | Shape movement reroutes edges vs unaffected-object tests | Derived routes; export snapshot sidecar; explicit connector edits canonical/reported | agreed, including separate exact/tolerant comparisons |
| A5 | Multi-layer visibility/lock and group coordinates undefined | Interim conservative layers; verify Visio semantics in M0; absolute child geometry and R4 derived group frame | agreed subject to M0 layer evidence |
| A6 | `atomic` option vs required atomic batches | Reject atomic:false; optional schema field is const:true | agreed |
| A7 | Retry after a lost mutation response | Same-ID retry first; include transactionId/source in change summaries; R2 reconnect-safe key | agreed |
| A8 | Undo selected earlier transaction could overwrite human edits | Only latest global transaction can be undone; no restored undo history promised | agreed |
| A9 | Two language model/operation definitions could drift | Single JSON Schema bundle plus cross-language runtime fixtures | accepted shared foundation |
| A10 | Imported identities can duplicate after Visio copy/paste | Preserve one valid UUID, regenerate copies with diagnostics and remap references | Claude proposal accepted by Codex |
| A11 | Host library versus live asset catalogue | Immutable blobs; host library; pinned document versions; explicit scope/hash for newer library version; full-hash version IDs | agreed |
| A12 | Source MCP inputs omit session/document/transaction identity | Add required documentId/sessionId/transactionId to mutation tools and reject missing identity | agreed spec refinement; original source retained |
| A13 | Source group fields do not define frame/angle semantics | Derive canonical bounds, constrain rotationDeg to zero, expand group transforms, reject direct field patches | agreed spec refinement |
| A14 | Group normalisation makes absolute rotation ambiguous | Explicit structured deltaDeg versus angleDeg; group by= syntax; shape/text/image angle= absolute or by= relative; pivot only for groups | agreed; final precision edits applied |

Spec-default decisions do not need new user answers: no app auto-launch, no additional
MCP lifecycle tools, local same-user pipe access with ACLs, backup on overwrite, and
no extra agent-enable UI toggle in this POC. They remain reviewable design choices.

## Feasibility risks rather than design disputes

OfficeIMO mapping of editable glue, user cells, images and complex presets remains
unproven; maxGraph export/interaction and the WebView2/MCP path likewise require
M0. Library documentation is not pass evidence. Any failure triggers a recorded
adapter/backend decision before product development proceeds.
