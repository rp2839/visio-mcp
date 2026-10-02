# D5–D8 design (revised to align with the Codex drafts), plus review of the 10 boundary decisions

**Sources read:** `agentic-visio-mvp-spec.md` (cited below as §N), `viso-app.intro`, `docs/design/architecture.md` (§ "Common request contract", module table), `docs/design/editor-and-commands.md` (D2/D3) and `docs/design/QUESTIONS.md` (A1–A10).

**Not read**, because of the budget: `feasibility-and-acceptance.md`, `README.md`, the progress files, and the rest of `architecture.md` from "Request ordering" onward. Please diff my D8 against `feasibility-and-acceptance.md` before merging.

**Labels used below:**
- **[UNVERIFIED]**: an outside fact I couldn't check offline.
- **[X-AGENT]**: needs Codex's agreement.
- **Spec delta (proposed)**: a change to the spec. These go to QUESTIONS.md, not silently into the design.

---

## Part 1 — Review of the Codex boundary decisions

| # | Decision | Verdict | Corrections |
|---|---|---|---|
| 1 | Frontend owns the canonical state | **Agree** | Add one sentence to `architecture.md` saying the VSDX adapter's C# DTO is a transient, immutable snapshot that is never cached. The host also holds the **cross-document asset library**. That is user state, not document state (see #11). |
| 2 | Minimal engine in M1 (QUESTIONS A1) | **Agree** | M1's engine must already emit `TransactionRecord`s with `transactionId` and `source`. The recovery journal (D7.4) and the gesture-to-transaction path depend on them, and adding them later would change the record schema. |
| 3 | `id=` creates an alias (A2) | **Agree, with one correction** | `editor-and-commands.md:45` says "Mutations without page scope may use UUID only". But the spec's own agent flows (Appendix A, §12) work by alias. **Correction:** `apply_operations` and `execute_script` accept a batch-level `pageId` (DrawScript's `page use` sets it). Alias and name targets then resolve inside that page. With no `pageId`, only UUIDs are accepted, so the rule stays as Codex wrote it. Needs a D1 MCP schema change **[X-AGENT]**. |
| 4 | Auto-routing is derived, so connector hashes stay stable (A4) | **Agree, with two corrections** | (a) **Export needs route geometry that the host can't compute.** `doc.snapshot` for export/save MUST return a non-canonical `projection` sidecar alongside the document: `{connectorId → {routePoints[], visualBounds, revision}}`. It isn't hashed or persisted. D6 writes the route into the connector's geometry, and Visio re-routes dynamic connectors anyway **[UNVERIFIED]**. (b) **Import:** for glued connectors, Visio's route geometry is treated as derived and dropped. Only `User.AgentWaypoints` (written by our exporter for user-authored waypoints) becomes canonical `waypoints`. A Visio-authored manual route gets a `VSDX_ROUTE_DERIVED` info diagnostic. |
| 5 | Reject `atomic:false` (A6) | **Agree** | Keep `atomic` in the MCP schema as `const: true` (optional), so spec §11.2 inputs remain valid. Rejection returns `invalid_request` with `details.reason:"atomic_false_unsupported"`. Record it as a spec delta. |
| 6 | Revision check at the queue head, no async I/O inside the queue | **Agree; it constrains D5/D7, and I've adopted it** | All host I/O runs **outside** the queue turn: (i) **asset import is two-phase**: the host stores and sanitises the blob first and returns the sha, and only then is the `registerAsset`/`set assetId` mutation enqueued; (ii) save/export takes a **synchronous snapshot barrier**, and serialisation and writing happen afterwards; (iii) journal append is fire-and-forget after commit, accepting a ≤250 ms durability window; (iv) consent dialogs never block the queue. |
| 7 | `transactionId` dedup scoped to the session, with reconciliation after an unknown timeout (A7) | **Agree, with corrections** | (a) Reconciliation should **first** retry with the **same** `transactionId`. While the cache entry exists this is exact, and it's cheap. Only on `session_mismatch`, or when the cache has evicted the entry, should the client re-read via `get_changes`. `architecture.md:98` currently says to retry with a new identifier, so it needs adjusting. (b) This only works if `get_changes` summaries **include `transactionId` and `source`**. Add both to the summary DTO **[X-AGENT D2]**. (c) Make the dedup scope `(sessionId, origin.clientId)`, where the host stamps `clientId`, so two shims can't collide. (d) Cache size: 256 per session. |
| 8 | Only the latest transaction can be undone (A8) | **Agree** | One side effect: recovery doesn't restore undo history (D7.4). State that in the GUI after a recovery. |
| 9 | Conservative multi-layer rules (visible only if all layers are visible; locked if any is locked) | **Agree only as interim; fidelity risk** | What Visio actually does with multi-layer membership is **[UNVERIFIED]**, and I'm not sure "all must be visible" matches it. If it doesn't, the editor render and Visio will disagree after a round trip. **Correction:** add check S1-13 (one shape on two layers; hide one, then the other; lock one; non-print one) and adopt Visio's observed rule. Until then, keep Codex's rule, but the D6 import emits `VSDX_LAYER_POLICY_UNVERIFIED` (info) on shapes that belong to more than one layer. |
| 10 | Group children stored in absolute page coordinates (A5) | **Agree** | This matches my earlier recommendation. D6 converts to Visio's group-local coordinates. **Open:** are group `bounds` stored or derived from the union of the children? I recommend **derived and validated**: commits are rejected if a group's bounds differ from the union of its descendants' rotated visual bounds by more than 0.01 pt. Group rotation expands into rotating each descendant about the group centre, as Codex says. |
| 11 | (Extra) Asset catalogue in `architecture.md:48`: "page, layer and asset catalogue changes" pass through the queue | **Clarify** | Two catalogues: the **document** asset catalogue is canonical and queued. The **library** (cross-document, `asset:<slug>` ids, §8.2 and Risk 6) is host-owned and is not a document. `list_assets` returns both (D7.3). **[X-AGENT D1/D2]** |
| 12 | (Extra) zIndex ties are invalid in committed state | **Agree** | D6 keeps the ordinal-id tie-break only as a defence for imported data. On import, the order is normalised and ties are never produced. |
| 13 | (Extra) Error codes | **Adopt Codex's list as the base** | I've renamed my D5 codes to match. I propose adding: `busy` (retryable), `busy_user_editing` (retryable), `editor_crashed` (outcome unknown for mutations), `path_not_permitted`, `consent_denied`, `dependency_conflict` (already used in editor-and-commands), and `frame_too_large`. Every error carries `retryable: boolean`. |

---


## Part 3 — Items for QUESTIONS.md

**Proposed clarifications (D5–D8):**
- **B1:** batch-level `pageId` for alias targeting (Part 1 #3).
- **B2:** projection sidecar for export, and connector routes treated as derived on import (Part 1 #4).
- **B3:** same-id retry first, with `transactionId` included in `get_changes` (Part 1 #7).
- **B4:** multi-layer policy decided by M0 S1-13 (Part 1 #9).
- **B5:** group bounds derived and validated (Part 1 #10).
- **B6:** library vs document asset catalogues; `embeddedData` serialisation-only (Part 1 #11, D7.3).
- **B7:** additional error codes (Part 1 #13).
- **B8:** two-phase asset import; journal append fire-and-forget.
- **B9:** gesture interlock (`busy_user_editing`).

**Questions for the user** (Q1/Q2 already exist):
- **U3:** should the shim auto-launch the app? Recommend no.
- **U4:** should MCP be able to open, close or save documents? Recommend no.
- **U5:** is same-user pipe access sufficient? Recommend yes.
- **U6:** keep a `.bak` on overwrite? Recommend yes.
- **U7:** an "Allow agent edits" toggle? Recommend yes, default on.
- **U8:** is SVG rasterisation in VSDX acceptable if native SVG fails?

**[UNVERIFIED] outside facts:**
- OfficeIMO coverage (user/document cells, glue, image cells, guides, parser limits, cross-platform);
- Visio SVG support;
- Visio multi-layer semantics;
- Visio re-routing behaviour;
- ShapeSheet cell names and enum values;
- .NET 10 pipe options;
- WebView2 APIs, message ordering and size limits;
- MCP SDK API details.

## Part 4 — Consensus checklist

- [ ] Part 1 verdicts #1, #2, #5, #6, #8, #10, #12 accepted as written.
- [ ] #3 batch `pageId` added to the MCP/operation schema (D1/D2).
- [ ] #4 projection sidecar in `doc.snapshot`, plus the import rule for derived routes (D2/D4/D6).
- [ ] #7 dedup scope `(sessionId, clientId)`; same-id retry first; `transactionId` and `source` in `get_changes`; `architecture.md:98` amended.
- [ ] #9 interim layer policy kept, with S1-13 deciding the final rule.
- [ ] #11 split between library and document catalogues.
- [ ] #13 error-code additions merged into `architecture.md:102`.
- [ ] Gesture interlock agreed with D3.
- [ ] Shared semantic-hash function owned by D2 and used by the D6 tests.
- [ ] D8 reconciled with `feasibility-and-acceptance.md` (I haven't reviewed that file).
- [ ] Disagreements still open after Codex's reply are logged in QUESTIONS.md with both positions and the safe interim behaviour.
