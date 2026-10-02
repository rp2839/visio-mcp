# D5–D7 — Windows host, native interoperability and persistence

Primary author: Claude, agent-broker task
`e1a324f4-7b00-42c3-a434-c6387ae292fe`, initial artifact
`ba972d80-d8ee-4bdf-ac57-5d10e944194c`.
Integrated and reviewed by Codex. After the spending limit was reset, Claude reviewed
the integrated corrections and agreed to R1–R4 with refinements incorporated here.
The decision record and review provenance are in QUESTIONS.md. The original worker
draft is historical, not a separate normative specification.

Source: spec §§4, 7, 11, 13–17, 19, 21–22, 26. Exact library APIs, ShapeSheet
formulas and Windows pipe flags remain M0 verification items.

## D5. Responsibilities and projects

The WPF host owns window/WebView2 lifecycle, dialogs, file IO, approved-path policy,
asset blobs/library and recovery bytes. It routes messages to the frontend and
calls the stateless Visio adapter on immutable DTOs plus a revision-matched projection
sidecar containing resolved connector geometry and group visual frames. It may retain opaque recovery
snapshots and lifecycle metadata but never maintains a second editable document.
Operations, revisions, undo, rendering and layout belong to the frontend.

Retain the source's projects and add `Diagram.Host.Core` for services without a WPF
reference plus `Diagram.Visio.Abstractions` for backend interfaces. This allows portable
service tests where dependencies support them. Windows ACLs and WebView2 integration
have explicitly Windows-only tests. Only `Diagram.Visio` references OfficeIMO types.

`Diagram.Mcp.exe` translates the source §11.2 tools to internal application methods.
Stdout contains MCP protocol only; diagnostics use stderr. It connects lazily and
does not launch the application or open another editable file. Missing app returns
`not_running`; missing document returns `no_document`; unavailable frontend returns
`not_ready`. Internal lifecycle methods are GUI-only in the MVP.

## D5. Unified IPC/bridge protocol

Use the D1 envelope on both hops, adding `kind:request|response|event` and a
host-stamped `origin:{source,clientLabel,connectionId}` for pipe requests. The host
discards caller-supplied origin. Lifecycle/library methods omit document/session
scope explicitly; document methods require it. Mutations require `sessionId`,
`documentId`, `baseRevision` and `transactionId`. No revision-only degraded mode.
Error body is `{code,message,retryable,details?}` with the D1 codes plus `busy`,
`busy_user_editing`, `path_not_permitted`, `consent_denied`, `dependency_conflict`, `method_not_found` and
`internal_error`. Unknown operation/patch fields are rejected, not ignored.

The pipe uses a 4-byte little-endian unsigned length followed by bounded UTF-8 JSON.
Perform exact partial reads; validate declared size before allocation. Proposed cap:
32 MiB/frame, 16 outstanding calls/connection, eight clients, bounded 64-response
writer queue. One writer per connection prevents interleaved frames. Generate unique
bridge correlations in the host and map them to each pipe request's identity.

The first frame is a version handshake with protocol capabilities and client label;
the server assigns an untrusted-display client label and connection identity. The
shim never auto-retries a mutation on disconnect or generates transaction IDs. D1 session/document/transaction
deduplication persists across pipe reconnections during the same document session;
its key is `(sessionId, documentId, transactionId)`, never a connection identity.
Cache matching commits/noChange results at the queue head after scope validation,
before baseRevision checks. Keep up to 256 mutation results within a bounded byte
budget; capacity pressure can evict earlier results. Report the retention floor.

Default timeouts: reads 10 s, mutations 15 s, renders 30 s, export/save 120 s;
shim transport timeout adds 5 s. Clamp client deadlines. A timeout/disconnect/crash
after dispatch reports an unknown mutation outcome; it is not a rollback claim.
A retry with matching transactionId/payload/baseRevision returns the original result
when retained. On eviction within the same session, reconcile using get_changes
transactionIds or current state if history is unavailable. After a session change,
reconcile current state only; prior session history is not carried over.

## D5. Routing and ordering

| Internal method | Public MCP tool | Owner |
|---|---|---|
| doc.summary | get_document_summary | Frontend snapshot |
| doc.getObjects | get_objects | Frontend snapshot |
| doc.apply | apply_operations | Frontend mutation queue |
| doc.executeScript | execute_script | Frontend compiler + mutation queue |
| doc.getChanges | get_changes | Frontend retained history |
| doc.inspectLayout | inspect_layout | Frontend snapshot |
| doc.render | render_page, render_region | Frontend snapshot/render |
| assets.list | list_assets | Host library merged with document catalogue |
| doc.export | export_document | Path policy → snapshot barrier → renderer/Visio → file IO |

All admitted document reads, mutation commits and lifecycle/snapshot barriers enter
the frontend queue in accepted order. Before admission, external mutations encountering
an active human gesture wait outside the queue at most 3 s (within the 15 s deadline).
Each pipe connection has a bounded FIFO admission gate: its later requests cannot
overtake a held mutation, while another connection's reads can proceed. A gesture
commit/cancel never waits behind that gate. Recheck scope on admission only; at
queue head validate scope, check the transaction cache, then check baseRevision.
An admission-time revision check must never reject a cached post-commit retry.
busy_user_editing means retryable, outcome not_applied.
Async rendering/IO continues outside the queue
after capturing its immutable snapshot. This strengthens consistency beyond a
read that could overtake an earlier accepted mutation. Per-connection forward order
is preserved; across connections the queue determines total order.

Marshal WebView2 calls through the WPF dispatcher and await responses asynchronously.
Host metadata events include editor.ready, doc.opened/closed/committed/dirtyChanged;
events are sequenced and include session/revision so gaps are detected. They do not
become MCP subscription dependencies. No host thread blocks the dispatcher waiting
for a frontend result. D1/D3 define the selected human-gesture interlock; stale-preview
rejection remains only a backstop for mutations admitted before a gesture started.

## D5. Windows and WebView2 boundaries

Use one app instance per Windows user/logon session, with a pipe name scoped by
user SID, logon session and protocol version. A second launch activates the existing
instance. Establish current-user ACLs, reject remote clients and verify peer user/
logon-session ownership on both server and shim sides where supported. M0 verifies
the exact .NET APIs or narrowly scoped native fallback. Fail on pipe-name collision;
do not silently connect to an unknown owner. Same-user executable path is metadata,
not the authentication boundary.

Load the packaged frontend from a fixed virtual HTTPS origin. Allow only that
exact parsed origin in WebMessageReceived, not a string prefix; reject messages
from non-top-level frames. Block arbitrary
navigation/new windows and deny remote resources. Use a message-only bridge with
validated method schemas; no general host objects or script evaluation. Proposed
CSP permits packaged code and local opaque image resources, with no external
connections. Verify release settings and image/export behaviour in M0.

Use same-origin `https://app.agentic-diagram.invalid/assets/<sha256>` host-served
resources. Offscreen render can inline already-approved bytes if necessary to avoid
canvas taint. Asset URLs reveal no filesystem paths. Readiness requires a versioned
editor.ready handshake. Renderer failure settles pending calls with unknown outcomes,
restores the last durable recovery state and issues a fresh session ID.

## D6. Stateless adapter interfaces

`IVsdxExporter.ExportAsync(snapshot, blobResolver, options, cancellation)` returns
package bytes, diagnostics and an element-to-Visio-ID map.
`IVsdxImporter.ImportAsync(validatedStream, options, cancellation)` returns a
candidate canonical snapshot, validated asset blobs, diagnostics and identity report.
Diagnostics include severity, code, page, source shape ID, canonical element ID,
action (`preserved|approximated|dropped|regenerated`) and detail.

The blob resolver supplies bytes by SHA-256 only. No mapper arbitrary-path access.
Backend version/name is recorded with evidence. A Go fallback can be out-of-process
behind these DTO contracts; an exporter without images/glue cannot satisfy the gate.

## D6. Mapping and transform

Canonical unrotated bounds are top-left page points; proposed Visio mapping uses
inches, centre pin and bottom-left origin:

```text
Width = w / 72                  Height = h / 72
LocPinX = Width / 2             LocPinY = Height / 2
PinX = (x + w/2) / 72           PinY = (pageHeight - y - h/2) / 72
Angle = -rotationDeg * pi / 180
```

Verify this mapping, including non-central imported pins and nested group-local
transforms, against real fixtures. Allocate deterministic Visio numeric IDs before
emission so connectors can reference later shapes. Emit in canonical z-order; import
normalises ties deterministically and reports any ambiguity. Native numeric IDs are
not agent identities. Never auto-layout during export.

| Canonical feature | Planned native mapping | Evidence requirement |
|---|---|---|
| Pages/name/size | PageSheet dimensions; persistent page identity | G1 + multipage fixture |
| Basic shapes/custom paths | Native geometry rows, not page bitmap; optional AgentPreset | Every required preset fixture |
| Fill/line/text | Native style/text cells, simple text block | Alpha, dash, arrows, padding, wrapping fixtures |
| Images | Independent foreign-data image shape and embedded bytes | PNG/JPEG/BMP fit, rotation and transparency checks |
| SVG-derived images | Native SVG if verified; otherwise explicit PNG derivation + preserved source | Extended G1 SVG decision; no library-only source dependency |
| Connectors | Native 1-D shape and endpoint glue relationships | Static/dynamic glue under movement in Visio |
| Ports | Native connection rows + stable port-name metadata | Side/custom port round-trip |
| Groups | Native group with local child geometry and sidecar visual frame; canonical group angle zero | Nested/rotated/resized group and frame-normalisation fixtures |
| Layers/membership | Per-page rows + LayerMember; persistent mapping metadata | Multi-membership and flags fixture |
| UUID/alias/assets | User.AgentId, User.AgentAlias, User.AssetId and asset hash | Save/reopen and copy/paste fixtures |
| Locks/hidden | Verified protection/visibility cells + app metadata | Extended G1; diagnostics if not preservable |
| Metadata | Validated string Shape Data/user-cell mapping | Reserved names escaped; string fixture |
| Background/grid/guides | Separate page/background/guide mapping as supported | Explicit capability result; diagnostic if approximated |

Store document/page/layer identities through user metadata or a supported custom
property fallback. Evaluate exact API support in M0. Do not advertise rows of this
matrix as supported merely because the backend has an API with a similar name.

Export validates first, maps and embeds blobs, writes UUIDs and self-reopens the
package to verify counts/references. Fatal mapping/self-check errors abort the save.
For arbitrary imports resolve only the supported subset, producing diagnostics for
every approximated/dropped item. A connector whose target is explicitly dropped
may become a free endpoint with a glue-loss diagnostic. The resulting whole candidate
must validate before publication; malformed invariants are not silently dropped by
the frontend. A failed import leaves the existing document intact.

Glued connector auto-routes imported from Visio are derived geometry; only explicit
app-authored waypoint metadata restores canonical waypoints. Visio-authored manual
routes need a supported import rule or a route-normalisation diagnostic. Store and
validate authored waypoint metadata separately from the exported route sidecar.

On group import, normalise native group angle into the children's page-coordinate
transforms, derive the canonical tight frame and preserve child positions. Report
loose frame margins, group sizing formulas/constraints and altered resize behaviour.
A group's own geometry/text/fill becomes an explicit supported child or a diagnostic
for dropped content. Export uses the revision-matched visual-frame sidecar for native
group-local coordinates. Check group resize behaviour in Visio during M0; static
constant child coordinates alone are not evidence of native resize fidelity.

## D6. Identity and fidelity

Valid unique AgentId values survive unchanged. Copy/paste in Visio may duplicate
them: prefer the original whose recorded page/native-ID reference matches, otherwise
the first deterministic source order; regenerate copies and remap their references,
with diagnostics. Missing/invalid IDs can use UUIDv5 derived from file/document identity,
page and native shape ID, providing repeatability for the same unchanged bytes.
Changed source bytes without saved IDs do not promise stable identity. Resolve alias
collisions explicitly; pending ID write-back is shown separately from user dirty state.

Round-trip classes: exact within geometry/font tolerances; semantically equivalent
with a diagnostic; lossy with a diagnostic. Proposed comparison tolerances are
0.01 pt and 0.01°; order comparison uses rank, not raw zIndex. These tolerant native
comparisons are separate from the exact canonical serialisation comparisons used
to prove unrelated objects remain unchanged during agent operations.

For SVG rasterisation retain the approved vector source in a package-carried inert
asset part or other verified native representation. Reimport can use it only if its
derivative identity/hash still matches the displayed image; a Visio replacement
invalidates stale app provenance. If standalone source preservation cannot be proven,
report lossy round-trip and seek the recorded SVG policy decision rather than claiming
fidelity through the originating machine's asset library. Similar checks prevent
stale AgentPreset metadata overriding geometry edited in Visio.

App-authored supported documents are the round-trip acceptance contract. Arbitrary
VSDX is best effort with a report, not universal lossless preservation. Save As is
the default for a lossy imported file; overwriting requires an explicit choice with
the loss report. Generated output never requires this application to open in Visio.

## D7. File and dirty-state semantics

Save/export captures revision R through a barrier, serialises, writes a temporary
file in the target directory, flushes and atomically replaces/moves it. Keep a `.bak`
when overwriting where supported. IO failure preserves the previous file and leaves
the document dirty. Completion marks revision R saved only in its original session;
if more edits occurred the current document remains dirty. Export to another format
does not mark the primary document saved.

Dirty means semantic revision differs from the saved revision or the session was
recovered unsaved. Missing imported UUID metadata is shown as pending write-back
but does not prompt for unsaved user edits by itself. Open/new/close prompts Save /
Discard / Cancel when dirty and publishes document replacement only as a queue barrier.
Signed/unsupported native content is included in compatibility reporting before
rewriting; do not silently claim its signatures or opaque payloads remain valid.

Native debug/recovery JSON uses `format`, `formatVersion`, canonical `document` and
one content-addressed `assetBlobs` map. `embeddedData` is serialisation-only; live
descriptors use hash resolution. Loading validates schema, limits, references and
blobs and starts a fresh session; stored revision is informational, not concurrency
authority. Undo history need not survive a normal reload in MVP.

## D7. Asset library and single-image replacement

The host maintains a per-user content-addressed immutable blob store and library
catalogue. Sanitise/validate before hashing. Stable `asset:<slug>` IDs match the spec;
descriptors hold name/tags/provenance, MIME, dimensions and hash. Inserting a library
asset pins its descriptor/hash into the document through the same transaction as
the image creation. Changing the library source never silently updates existing
documents. Explicit document-global replacement updates its pinned descriptor and
reports all affected image IDs.

Setting one image's assetId resolves an existing document asset or explicitly
prepares a validated library descriptor before the command queue. If necessary its
registration is part of that atomic transaction. Only that image reference changes;
do not overwrite a shared descriptor under an existing document asset ID for a
single-image replacement. If a library version has the same ID but different pinned
hash, create a distinct document asset version. `list_assets` merges document/library
results with scope/version information and document descriptors winning exact matches.

A bare asset:<slug> resolves to its document-pinned descriptor when present. To use
a newer library version require an explicit library scope/hash and register a stable
document version ID, asset:<slug>~<full-sha256>, returned in the transaction result.
The full hash avoids truncated-hash collisions. Document-global replacement reports
every image visually affected, even if only their shared descriptor changes.

Persist approved original source and bytes inside saved/recovery representations.
`sourcePath` is informational and is never reread automatically. Reference tracking
includes active documents, library, undo/redo and every retained recovery generation;
garbage collection must not remove blobs needed for undo or crash recovery.

## D7. Recovery without replay ambiguity

The frontend emits resolved committed changes, including generated UUIDs, expanded
dependencies and undo/redo effects. The host journals these opaque deterministic
records with session, sequence, revision and checksums; do not replay raw alias-based
commands or operations that generate new IDs. Flush in commit order, batching at
most 250 ms by default. Display the last durable revision; a successful live mutation
response does not itself promise crash durability.

Asset blob bytes and catalogue references needed for recovery must be durable before
flushing any journal record that references their hashes. Live registration can run
after durable two-phase host preparation; do not journal a reference to volatile bytes.

Checkpoint every 50 commits or 60 s and at save: capture revision R through a barrier,
write a new immutable generation and its blob references, then atomically publish a
manifest pointing to it. Retain journal entries newer than R and keep the previous
generation until the manifest is durable. Never truncate records committed during
checkpoint IO. Recovery validates contiguous sequences and checksums; torn tail is
discarded, other corruption stops at the last valid revision with a report.

Restore validated snapshots plus resolved records into a candidate store, then
publish a fresh session. Do not treat journal replay as individual new user actions.
Recovered content remains dirty; original path is preserved. Startup offers recovery;
renderer crash can restore the last durable state automatically with a visible loss
report. Clean close removes only its completed recovery session after safe save/discard.

After restoration, the new session starts with a durable checkpoint of the restored
state and its own journal sequence; it does not continue the old session's chain.

## D7. Proposed resource and path limits

These are conservative POC defaults to measure in M0, not claims of tested limits.

| Input | Proposed limit |
|---|---|
| VSDX package | 100 MiB compressed, 10,000 entries, 512 MiB expanded total |
| Package entry | 64 MiB expanded, maximum compression ratio 200:1 |
| XML | DTD/external entities prohibited, resolver disabled, depth 256, 64 M characters |
| Native JSON | 64 MiB, depth 128, ordinary strings 1 MiB |
| Raster asset | 32 MiB, 16,384 px/side, 64 M decoded pixels |
| SVG | 5 MiB, 50,000 elements plus path/data/decoded raster budgets |
| Preview | 16 M output pixels and 16 MiB encoded bytes, within IPC cap |
| Mutation batch/script | 1,000 operations, 1 MiB UTF-8 source; actual POC target 100 operations |

Stream actual decompression and enforce cumulative counters, not just ZIP headers.
Reject traversal/absolute package names, external relationships and invalid content
types; never extract arbitrary parts to disk. Prevalidate XML with safe settings
before the backend parses it; package size limits alone do not prevent entity
expansion. Prove equivalent backend settings or supply sanitised inert XML and fail
closed on unsupported unsafe parsing. Macros/OLE are never executed.

Decode raster headers with budgets before allocating pixels. SVG uses an allowlist,
disallows scripts/events/foreignObject/external resources and CSS fetches, and limits
embedded data-image decoding. Render as an image, not raw inline document DOM.
Hyperlinks are inert data until the human explicitly opens one.

MCP exports default to the open document directory or an approved export workspace,
with safe generated filenames. Canonicalise paths; reject UNC/device/ADS/reserved
names and reparse escapes. Validate the resolved destination immediately before
write to reduce path races. Outside approved roots or overwrite requires a host UI
choice showing client, path and action; denial/timeout does not write. No shell or
general arbitrary file/network capabilities are exposed. Logs omit asset bytes and
diagram text by default.

## D5–D7 verification

Test pipe fragmentation/limits/handshake, concurrent correlations, reconnect dedup,
schema drift, stale sessions, stdout cleanliness, host absence and late responses.
Windows checks cover peer ACLs, origin rejection, renderer crash, live MCP-to-canvas
update and asset rendering without canvas taint. VSDX fixtures cover each advertised
mapping plus copy/paste IDs, non-central pins, nested groups and unsupported imports.
Crash tests include undo replay, generated IDs, checkpoint tail retention, corrupt
records, durable-revision reporting and blob retention. Hostile input tests cover
ZIP bombs, XXE, external relationships, SVG resources, oversized image headers and
path escapes. All manual acceptance evidence follows [D8](feasibility-and-acceptance.md).
