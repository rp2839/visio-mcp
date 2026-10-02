# D2–D4 — Editor, command engine and agent feedback

Author: Codex. Review: Claude reviewed the integrated design; R1–R4 resolutions and
review refinements are recorded in QUESTIONS.md. Source: spec §§5–10, 12, 14–15,
18, 21.

## D2. Canonical invariants

Retain the source schema's document/pages/layers/elements/assets, shape/text/image/
connector/group discriminated unions and plain-text styling. JSON is the interchange
form; validated internal maps can accelerate lookup without changing that form.
Schema version and application protocol version are independent.

- Element UUIDs are document-wide unique; page/layer identities are also stable.
  Aliases are unique within a page, case-sensitive. Display names may repeat.
- Coordinates use points with a top-left origin, x rightward and y downward.
  Rotation is clockwise about the element centre. Values must be finite; dimensions
  are positive except connector bounds derived from endpoints. Negative positions
  are legal and cause out-of-page diagnostics, not silent clipping.
- Units convert at the input boundary: mm = 72/25.4 pt; cm = 72/2.54 pt;
  inch = 72 pt; px = 0.75 pt. Retain numeric precision; round only for display/export.
- Layer membership refers to layers on the same page. An element is visible if
  it is not hidden and all assigned layers are visible; it is locked if it or any
  assigned layer is locked. With no assigned layers it uses normal page defaults.
  Printable/snap/glue policy is conservative across membership: every assigned layer
  must allow the relevant action. Hiding a layer does not delete objects.
  This is an interim policy: verify real Visio multi-layer visibility/print/lock
  semantics in extended M0 before claiming fidelity.
- Group children belong to the same page, have at most one parent and form an
  acyclic forest. Store children in page coordinates; a group transform explicitly
  expands to descendant geometry changes. No hidden second coordinate system.
  Nonempty groups have engine-computed bounds and rotationDeg fixed at zero. Direct
  group bounds/rotationDeg patches are invalid; inspector changes become operations.
  Bounds are the deterministic tight union of descendant canonical geometry: rotated
  rectangles for shapes/text/images; authored fallback bounds, waypoints and free
  endpoints for connectors. Never use auto-routes in canonical group bounds.
  Descendant geometry edits recompute and report every affected ancestor group.
- Shape and image assets must exist. Asset bytes are host-owned, immutable and
  identified by hash; the canonical catalogue contains IDs and metadata.
- Glued endpoints reference same-page existing elements/ports. Dynamic glue routes
  to the perimeter; static ports remain fixed in the element's local coordinates
  under rotation. Free endpoints use points. Reject incompatible endpoint fields.
- zIndex gives deterministic stacking; ties are invalid in committed state or
  normalised by an explicit reorder operation. Reordering may change intervening
  objects' order metadata and reports those IDs.

The spec's layer `active` reference has no schema field: add a UI insertion-layer
choice per page, outside semantic document state. The spec's `id=elexon` DrawScript
syntax creates an alias, not a non-UUID identity. Source requirements and these
clarifications are tracked in [QUESTIONS.md](QUESTIONS.md).

## D2. Targeting and operations

Resolve a UUID first, then an exact page-scoped alias, then an exact display-name
match. Mutations without page scope may use UUID only. Return candidate UUIDs for
ambiguous names; a quoted string does not authorise guessing. Internally normalise
targets to UUIDs before committing and retain alias-to-ID mappings for batch creates.

Define operations for create shape/text/image/connector; property patch; move;
resize; rotate; delete; duplicate; group/ungroup; align/distribute/set-gap; z-order;
page add/rename/size/reorder/delete/duplicate; layer add/set/assign/delete; and asset
registration/reference replacement/catalogue edits. The public union is explicit,
not an arbitrary property-path or JSON Patch interpreter. Additive page operations
cover every page-tab action in spec §8.6 even though DrawScript exposes fewer commands.

Nested patches merge only supplied leaves; arrays replace atomically. Omission
means preserve; null clears only a schema-defined nullable property. ID/kind are
immutable. Geometry changes update only targeted elements plus explicit structural
dependencies. Cannot delete an in-use asset without replacing references. Removing
a layer unassigns its members and reports those IDs after an explicit GUI preview.

Deleting a connected shape defaults to `dependency_conflict` with dependent connector
IDs unless the batch explicitly deletes or detaches those connectors. Group deletion
requires an explicit subtree choice. Duplication creates fresh UUIDs, copies content,
and clones internal connector relationships only within the selected duplication set;
references outside it remain external only if explicitly requested and valid.

Shape movement changes the target geometry. Canonical connector endpoint references
remain unchanged; auto-routed geometry is derived in the canvas/render adapter, so
connected connector semantic hashes remain stable. User-authored waypoints are
canonical and do not change automatically. If an explicit operation changes a
connector or group descendant, include it in changed IDs; never hide side effects.

For connectors, base `bounds` is authored fallback geometry for free/unresolved
endpoints, not an authoritative cached auto-route extent. Queries and renders expose
computed `visualBounds` separately. Derived route points/visual bounds carry the
snapshot revision and are never written back during projection. This avoids stale
connector bounds being mistaken for current visible geometry in semantic summaries.

Align uses axis-aligned visual bounds of selected objects; distribution preserves
the first/last ordered objects and divides available edge-to-edge space equally.
`set-gap` keeps the first object's position and places following objects using the
requested edge gap. Input order breaks equal-position ties. Do not auto-layout the
rest of the page. Groups are a single arrangement target and expand descendant
transforms. Reject mixed-page selections and conflicts such as selecting both a
group and one of its descendants.

Group move translates descendant geometry, free connector points and waypoints;
glued endpoints retain their references. Group rotate applies an angular delta to
descendants about an optional explicit pivot (default current group centre), then
recomputes group bounds; the group's own rotation remains zero. GUI previews compute
each step from the gesture-start snapshot and fixed pivot, not the previous preview.
Successive opposite rotations without an explicit common pivot need not restore the
original position because the tight-box centre may drift; exact Undo uses stored
inverse changes. The inspector displays zero group orientation and a relative
rotation control. Shape/text/image rotate continues to set their absolute angle.

Structured rotate operates on one explicit target per operation. Use angleDeg for
absolute shape/text/image orientation, or deltaDeg for relative rotation of any
supported target. The two fields are mutually exclusive. Group angleDeg is rejected
with invalid_request/group_rotation_requires_delta. For a group, optional
pivot:{xPt,yPt} selects the page-coordinate rotation centre; otherwise use the
current group centre. Reject pivot for non-group targets, whose rotation is about
their own centre and does not orbit their position. Multi-target rotation uses
explicit operations in one batch; avoid an implicit shared-pivot selection transform.

Uniform scaling is supported. Nonuniform scaling is supported only when every
descendant rectangle is axis-aligned (rotation a multiple of 90 degrees); axes swap
at 90/270 degrees. Otherwise reject with invalid_request/nonuniform_group_scale and
lock the GUI aspect ratio. Stroke widths/font sizes do not scale. Recompute all
ancestor bounds; reject a batch that removes a group's last child without explicit
ungroup/delete. Canonical group geometry excludes routing; projection/export can
carry a different visual frame that includes rendered connector routes.

## D2. Atomic transaction lifecycle

1. Validate envelope/version/limits before admission.
2. At the queue head verify session/document, then check cached transaction identity
   and payload (matching returns its original result; mismatch is transaction_id_conflict),
   then check baseRevision. This order is mandatory for post-commit retries.
3. Clone only affected state into a candidate; resolve and apply operations in
   order, making earlier creates available to later commands.
4. Recompute group bounds and validate final references, locks, alias uniqueness and
   geometry invariants; computed bounds use the same exact deterministic function.
5. Calculate actual diff and inverses, preserving unrelated serialised objects.
6. Commit candidate and increment revision once; append history and invalidate redo.
7. Project to canvas and return the result. A projection failure keeps canonical
   state committed and triggers projection rebuild; do not replay the mutation.

Validation errors leave state/history/revision unchanged. A valid no-op returns
`noChange:true` with unchanged revision and no undo step. Lock/unlock layer/object
controls are explicit operations; locked geometry/style cannot be changed by ordinary
patching. Inputs do not support implicit lock bypass.

Undo/redo apply stored inverse/forward changes as new revisions through the same
queue, restoring IDs and references. Never rewind revision counters. The MVP undo
button undoes the latest document transaction, regardless of source. The drawer's
"undo transaction" is enabled only if that transaction is still at the stack head;
selective undo across later human edits is out of scope. Asset blobs referenced by
undo/recovery snapshots are retained until their retention window expires.

Keep bounded transaction summaries and inverse records. `get_changes` includes
transactionId, source, revision, description, created/changed/deleted IDs and
non-element changes. M1 emits these fields from its first transaction.
If sinceRevision predates retention, return `history_unavailable`, earliest available
revision and guidance to obtain a full summary. Restart/open creates a new session;
revision history across sessions is not promised.

D2 owns the canonical serialisation/hash function used for mutation regressions:
sort object keys deterministically, retain exact validated numeric/string/array
values, and exclude derived routes, visual bounds and sidecars. Engine-computed group
bounds are canonical and included. Native-file comparison has a separate explicitly
tolerant comparator; it cannot be used to prove unchanged objects during a live patch.

## D3. GUI and canvas projection

Implement the source's menu/toolbar, Shapes/Assets left panel, finite centre page,
Style/Text/Geometry/Arrange/Layers inspector, page tabs and optional script/transaction
drawer. No built-in provider-specific chat. One page is sufficient for M1; multipage,
advanced page-tab actions and complete asset/layer controls arrive by M5.

`CanvasAdapter` exposes mount/unmount, projectSnapshot, projectDiff, selection,
viewport and interaction callbacks. It translates UUIDs to cells internally and
never returns maxGraph cell types through model/command APIs. Maintain a projection
guard so programmatic updates do not become new GUI transactions. Disable/replace
maxGraph's independent undo as a persistence authority.

Drag/resize/rotate and bend edits are transient previews until gesture completion;
the gesture becomes one canonical transaction. Inspector commits, keyboard nudges,
paste/duplicate and arrange invoke the same operations. On revision conflict discard
preview and refresh current state, with a clear status message. Selection and zoom
are local UI state. Copy/paste regenerates identities and remaps selected internal
links using the duplication rules. Text commits are coalesced per edit session.

Pointer drag/resize/rotate/bend previews and in-place text edit sessions activate the
D1 interlock; selection, zoom and rubber-band selection do not. GUI Undo/Redo waits
until the gesture commits or cancels. Open/close/recovery barriers explicitly cancel
previews before replacing state. External requests use the per-connection admission
gate, never a queue-blocking wait. Snapshot reads report committed geometry only.

Shapes are small preset definitions, not OfficeIMO masters. The three initial
libraries reuse supported presets and original generic IT icons. Custom paths are
restricted SVG geometry; external scripts/resources are never evaluated. Imported
unsupported shapes get compatibility diagnostics and must not masquerade as an
editable supported preset.

Implement physical-unit rulers, grid/snap, alignment guides, fit page/selection and
pointer-centred zoom. Equal-spacing guides are best effort per spec. Snap computes
the committed coordinates in the interaction planner rather than allowing a second
canvas-only adjustment. Hover handles show static ports; dynamic glue is default.
Port positions and canonical endpoint data survive projection rebuilds.

## D4. DrawScript

Use a small lexer and deterministic parser with line/column spans, followed by a
typed compiler; never evaluate source as JavaScript or shell. Preserve quoted JSON
escapes, comments outside quotes and the unit/color/bool rules in spec §9.4. The
compiler produces the exact operation union above, plus source maps for diagnostics.
`Validate` plans against a captured revision without committing; `Run` recompiles
against its submitted revision and executes one atomic transaction.

Resolve `page use` as compiler context, without changing GUI active page or revision.
Aliases such as `id=elexon` become alias fields on fresh-UUID elements; explicit UUID
creation, if supported, uses a separate `uuid=` field validated for uniqueness.
Endpoint syntax `elexon.south` resolves the whole alias first, then the last-dot
port suffix; dotted aliases that make this ambiguous require quoted alias and an
explicit endpoint field. Accept `hcenter` as the source example's synonym for
`center`, and document both rather than leaving sample scripts invalid.

Absolute and delta move forms cannot be mixed in one command. Degrees are explicit
angle values. Dimensions require units; do not infer the UI's display-unit preference.
For groups use `rotate <id> by=<degrees>` for a relative rotation, with optional pivot;
reject group `angle=` with a diagnostic directing the caller to `by=` rather than
silently interpreting an absolute angle as a delta. The initial `angle=` syntax
remains absolute for shape/text/image objects. This group-specific addition is
recorded as a refinement of the source language, not a change to canonical IDs.
`by=` is also valid for shape/text/image targets and compiles to deltaDeg about their
own centres. `angle=` compiles to angleDeg. Reject mixed angle=/by=. Group pivots use
paired `pivotX=`/`pivotY=` with physical units; reject a missing half or a pivot on a
non-group target. For example, `rotate assembly by=30deg pivotX=50mm pivotY=40mm`.
`asset import` resolves only approved host-managed files and stages validated bytes
before compiling catalogue changes. It offers no general-purpose file reads.
`asset replace` defaults to a selected image's asset reference; global catalogue
replacement is a distinct explicit action with affected-reference preview.

## D4. Rendering and layout

Render an immutable model snapshot using the same CanvasAdapter style/geometry
mapping in an offscreen page. Exclude selection handles, editor chrome and snap guides
in clean mode. Debug ID labels/bounds are overlays only. Await asset loading and text
layout before rasterising; reject missing assets rather than returning a blank logo.
Host-owned asset URLs are same-origin opaque identifiers; no remote fetching.

Render result metadata includes revision/session/document/page, crop bounds in pt,
pixel dimensions and scale. Maintain aspect ratio inside maxWidth/maxHeight; region
selection uses rotated/group visual bounds plus padding. PNG supports transparency;
JPEG uses a declared page-background colour. Enforce pixel/byte budgets and cancel
queued work safely. A render finishing after an edit remains labelled with the
older captured revision, rather than claiming to show current state.

`inspect_layout` works on the same snapshot and returns code, severity, relevant
UUIDs, page bounds and evidence. Check out-of-page, near-zero dimensions, dangling
endpoints, image aspect distortion and text clipping. Geometry overlaps/connector
crossings are warnings with exclusions for group containment and connector endpoints.
Text measurement uses the frontend renderer's loaded fonts; report uncertainty when
font fallback changes measurement. Low contrast is a heuristic and is not a claim
of accessibility certification. Duplicate aliases are import/validation diagnostics;
normal committed state cannot contain them.

## Verification criteria

Mandatory tests include one-logo patch with 20-object hash comparison; nested style
patch preservation; atomic failure at the last operation; create-and-reference within
a batch; stale human/agent race; alias ambiguity; group/reference integrity; exact
inverse restoration with a higher revision; duplicate transaction delivery; and
source-script/API equivalent results. Alignment touches only selected geometry and
declared group descendants; derived connector routing does not rewrite connector data.

Add retry-after-commit across pipe reconnect, queued duplicate delivery, missing
session identity, same-ID different payload, held-mutation FIFO/read order, interlock
expiry and no-deadlock gesture commit scenarios. Group tests cover ancestor change
reporting, rotations around a fixed pivot, rejecting unsupported scaling, empty-group
rejection and an external shape movement that changes a grouped connector's route
without changing canonical group/connector hashes.

Browser checks cover adapter feedback-loop suppression, actual GUI gesture commits,
snap/glue, locked layers, z-order/groups, render crops and font/image readiness. Golden
images use pinned fonts/browser plus a stated raster tolerance. Measure spec §18
targets with 500 visible objects after correctness and M0 have passed.
