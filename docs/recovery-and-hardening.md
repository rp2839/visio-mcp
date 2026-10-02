# Recovery and boundary hardening (I51)

## Durable recovery

| Piece | Where | Behaviour |
| --- | --- | --- |
| Forwarding | `src/web/src/commands/recovery.ts` `RecoveryForwarder` | Subscribes to the engine's ordered `CommittedEvent` stream and sends each resolved diff to `host.recoveryAppend`, serialised. A sequence or session gap, a refused append, a degraded listener, a lifecycle replace, 50 commits or 60 s with pending commits each trigger a checkpoint (`host.recoveryCheckpoint`). `lastDurableRevision` reports what the host has flushed; a live MCP success is **not** a durability acknowledgement. |
| Journal | `RecoveryJournal` | One file per session, `[u32 length][sha256][CommittedEvent JSON]`, written with WriteThrough and fsync'd before acknowledging. A record must extend the session's durable head (`previousRevision == head`, increasing sequence), otherwise `checkpoint_required`. Asset hashes it introduces must already be durable in the blob store (`BlobBeforeRecord`). |
| Checkpoints | `CheckpointStore` | Immutable `gen-N.json` files plus an atomic `manifest.json` (current and previous generation, with hashes). Records newer than the checkpoint are kept (`CheckpointDoesNotLoseTailRPlus1`), and the head never moves backwards. |
| Reading | `CheckpointStore.ReadRecoveryAsync` | Returns the newest readable generation (falling back to the previous one) plus the session's contiguous tail. A torn final record is ignored (`torn_tail`, info). Middle corruption stops at the last good record (`journal_corrupt`, error, lossy). |
| Restore | `restoreRecovery` + host `recovery.restore` | The frontend replays resolved after-values with no command re-execution and no ID generation. Each record's before-values must match, and the result is schema- and invariant-validated before `replaceDocument` publishes it as a **new, dirty session**, so old agent sessions get `session_mismatch` and must re-read. |
| Blob GC | `CheckpointStore.ReferencedBlobs` | Hashes in retained checkpoints plus every before/after asset hash in the journals, so undo and recovery keep their bytes. |

Evidence: `tests/Diagram.Host.Tests/RecoveryTests.cs` (9 tests, including crash injection before and after the manifest) and `src/web/tests/recovery.test.ts` (6 tests). The process-kill tests on Windows are in `tests/Diagram.Windows.Tests/CrashRecoveryTests.cs`, which always skips as **NOT RUN**.

## MCP export destinations

`ExportPathPolicy` and `ExportService` (`doc.export`):

- **No path:** a unique safe name (`<title>-r<revision>.<ext>`) in the saved document's folder, or in the per-user export workspace.
- **Refused outright:**
  - UNC, device (`\\?\`, `\\.\`) and alternate-data-stream paths
  - reserved device names (CON, PRN, AUX, NUL, COM*, LPT*)
  - `.`/`..` segments, trailing dots or spaces, wildcard characters, relative paths
  - any symlink, junction or reparse point on the way to the destination
  - an extension that doesn't match the format
- **Needs consent in the app:** a destination outside the approved roots, or an overwrite. Consent times out after 60 s and then denies. The session must still be current after consent, otherwise `session_mismatch`.
- **Before writing:** the destination is checked again (a new file, link or directory blocks the write).
- An export never marks the document saved and never changes its save path.

Evidence: `tests/Diagram.Host.Tests/ExportPathTests.cs` (20 cases). Windows path syntax is checked on strings; reparse traversal is checked with a real symlink on Linux. NTFS junctions have not been exercised (Windows NOT RUN).

## Boundary checks already in place

| Boundary | Guard | Tests |
| --- | --- | --- |
| VSDX packages | `PackageGuard`: actual decompressed bytes, ratio, entries, traversal, DTD/XXE, external relationships, depth; macros and OLE stay inert | `PackageGuardTests` |
| SVG/raster input | `AssetPreparer`/`SvgSanitiser`: sniffing, header-only dimensions, pixel/byte budgets, scripts, event handlers and external references stripped or rejected | `AssetInputTests`, `AssetLibraryTests.SanitisedHashStable` |
| Native JSON | streaming depth/string pre-scan before parsing; hash-verified embedded blobs | `LifecycleTests` |
| Pipe | 4-byte framing with a 32 MiB cap, handshake first, ≤ 8 clients, ≤ 16 pending requests per connection, origin stamped by the host | `Diagram.Ipc.Tests` |
| MCP asset references | host-issued, unexpired, unmodified prepared refs only; `registerAsset` hashes must be durable blobs | `AssetGuardTests` |
| GUI-only methods | `doc.snapshot`, `doc.exportSnapshot`, `doc.markSaved`, `doc.replace`, `asset.rasterize` and `recovery.restore` are refused from the pipe | `HostRequestHandlerTests` |

Not done: there is no structured logging yet, so "content-free logs" has nothing to verify.
