# MCP tools

`Diagram.Mcp` is a stdio MCP server (official C# SDK 2.2.0). It connects lazily to the running
app over a per-user named pipe. It never launches the app, opens files, generates transaction IDs
or retries a request. Stdout carries MCP protocol only; diagnostics go to stderr.

Client configuration: command `dotnet path/to/Diagram.Mcp.dll`, or the published `Diagram.Mcp.exe`.
`AGENTIC_DIAGRAM_PIPE` overrides the pipe name (used by tests).

| Tool | Internal method | Notes |
|---|---|---|
| `get_document_summary` | `doc.summary` | Call first. Without `documentId`/`sessionId` it reads the current document (`app.current`). |
| `get_objects` | `doc.getObjects` | Full canonical objects by UUID. |
| `apply_operations` | `doc.apply` | **Requires** `documentId`, `sessionId`, caller-generated UUID `transactionId`, `baseRevision`. Atomic only. |
| `execute_script` | `doc.executeScript` | Same identity rules; returns the compiled operations too. |
| `render_page` / `render_region` | `doc.render` | MCP image block plus JSON metadata: revision, crop in pt, pixel size. |
| `inspect_layout` | `doc.inspectLayout` | Issues with code, severity, element IDs, bounds and evidence. |
| `list_assets` | `assets.list` | Document and per-user library assets, with scope and version. |
| `get_changes` | `doc.getChanges` | Transaction summaries since a revision; `history_unavailable` past retention. |
| `export_document` | `doc.export` | vsdx/svg/png/jpeg. Approved locations only; others need consent in the app. |

## Concurrency and retries

- Every mutation is checked at the queue head in this order: scope (document/session), then the
  transaction cache, then `baseRevision`. Retrying the identical payload with the same
  `transactionId` returns the original result, even across reconnects and even when
  `baseRevision` is now stale. Reusing an ID with a different payload returns
  `transaction_id_conflict`.
- A completed human edit makes an older agent batch return `revision_conflict` (with changes since
  the expected revision). The app never rebases automatically.
- While the human is dragging or editing text, mutations wait up to 3 s, then return
  `busy_user_editing` (retryable, `not_applied`). Requests on the same connection keep FIFO order.
- A timeout or disconnect after dispatch returns `outcome: "unknown"`, never a rollback claim.
  Retry the same `transactionId`, or reconcile with `get_changes`.
- Reopening or recovering a document starts a new session; old-session requests fail with
  `session_mismatch`.

## Assets

`list_assets` returns document assets (`scope: "document"`, `version: "pinned"`, or the
12-character hash prefix for `asset:<slug>~<sha256>` versions, plus `usedBy`) and per-user
library assets (`scope: "library"`, an integer `version`). Library entries include:

- `documentAssetId`: the ID the asset will have in this document. It is
  `asset:<slug>~<full-sha256>` when the document already pins that slug with different bytes.
- `preparedRef`: a host-issued capability that is valid for 30 minutes.

To use a library asset, either:

- run `execute_script` with `preparedAssetRefs: {"logo": <preparedRef>}` and `asset import ref=logo`, or
- run `apply_operations` with `{"op":"registerAsset","asset": <preparedRef.asset>}` in the same batch as the
  `set`/`create` that uses it.

The host checks both forms before forwarding: unknown, expired, foreign or modified refs are
rejected, and a `registerAsset` hash that is not in the approved blob store returns `not_found` with
`outcome: "not_applied"`. Because this check runs at the host boundary, a cached retry that still
carries an expired ref is also refused. Retry within 30 minutes, or call `list_assets` again for a
fresh ref.
