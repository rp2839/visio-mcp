# VSDX compatibility (I40)

**Status: library-level evidence only.** Every row below has been checked by
`tests/Diagram.Visio.Tests` (direct OPC writer/reader, plus OfficeIMO.Visio 3.4.4 as an independent
loader). **No row has been opened in Microsoft Visio or Word.** Those checks belong to I41 and
are recorded as NOT RUN in `docs/acceptance/visio-word-checklist.md`. "Round-trips" means the
app exports, re-imports and compares within the native tolerances (0.01 pt, 0.01°). It does not
mean that Visio renders the result identically.

Backend: the direct OPC writer/reader (`src/Diagram.Visio`), chosen in `docs/m0/decision.md`.
OfficeIMO has no picture API, so it is used only as a test oracle and no OfficeIMO types reach
the contracts.

## Pipeline

| Stage | Where | Guarantee |
| --- | --- | --- |
| Package guard | `PackageGuard.ValidateAsync` | It counts the real decompressed bytes per entry and in total (≤ 64 MiB per entry, ≤ 512 MiB in total, ratio ≤ 200, ≤ 10 000 entries, ≤ 100 MiB compressed). It rejects traversal, absolute or drive names, DTDs/entities, external relationships and XML deeper than 256 levels. All of this runs **before** any mapper sees the bytes. |
| Import | `DirectVsdxImporter` | Builds one whole candidate document plus SHA-256-keyed blobs and diagnostics. It never reads `sourcePath`. |
| Host open | `VsdxCoordinator.OpenAsync` | Every blob is re-prepared (sniffed, SVG sanitised) and made durable before `doc.replace` is called with the expected session and revision. A lossy import is published dirty with no save path, so the next save is a Save As. |
| Export | `VsdxCoordinator.ExportAsync` | One `doc.exportSnapshot` barrier (committed document + pure projection). The exporter rejects a revision or scope mismatch (`projection_failed`), self-checks by re-importing (counts, IDs and references) and writes atomically. The revision is marked clean only when nothing was dropped. |

## Feature matrix

| Feature | Export → Visio cells | Import | Evidence |
| --- | --- | --- | --- |
| Pages: name, order, size | `pages.xml` `PageSheet` PageWidth/Height; `AgentPageId` | ✓ IDs preserved | `BasicObjects_*` |
| Grid | XGridSpacing + `AgentGrid` JSON | ✓ | `Structural_*` |
| Guides | `AgentGuides` JSON only (`guides_metadata` approximated) | ✓ from metadata; Visio guide shapes are dropped (`guide_shape`) | — |
| Page background colour | `AgentBackground` only (`page_background` approximated) | ✓ from metadata; background pages are dropped (`background_page`) | — |
| Layers: name, visible, lock, print, snap, glue | `Layer` section + `LayerMember`; `AgentLayerIds` | ✓ including multi-layer membership | `Structural_*` |
| Presets (15) and custom paths | Native `Geometry` sections (RelMoveTo/RelLineTo/RelCubBezTo), editable, never a bitmap | ✓ preset restored while `AgentGeomHash` matches. A Visio edit gives `custom` + `stale_preset` | `BasicObjects_*`, `ExportWritesNativeEditableGeometryNotABitmap`, `UnknownEffects*` |
| Other Visio geometry rows | — | ArcTo/EllipticalArcTo → cubic; Ellipse → 4 cubics; NURBS/Polyline/Spline → lines (`geometry_row` approximated) | `UnknownEffects*` |
| Rounded rectangle radius | geometry + `AgentCornerRadius` | ✓ | `BasicObjects_*` |
| Bounds, rotation | PinX/PinY/Width/Height/LocPin/Angle | ✓ ≤ 0.01 pt / 0.01° (30° and 33° fixtures) | `BasicObjects_*`, `Structural_*` |
| Flip | FlipX/FlipY = 0 | folded into placement, `flip` approximated | `UnknownEffects*` |
| Fill colour/opacity | FillForegnd + FillForegndTrans | ✓ **normalised**: `#RRGGBBAA` alpha folds into `fillOpacity` (Visio has one transparency) | `BasicObjects_*` |
| Line colour, weight, dash (solid/dash/dot/dashDot), cap | LineColor/LineWeight/LinePattern/LineCap; join/cap in `AgentLineStyle` | ✓; other Visio patterns → nearest (`line_pattern`) | `BasicObjects_*` |
| Text: value, font, size, bold/italic, colour, H/V align, padding, wrap | `Text`, `Character`, `Paragraph`, margins; wrap in `AgentTextWrap` | ✓ | `BasicObjects_*` |
| Independent text element | text-only shape + `AgentKind=text` | ✓ | `BasicObjects_*` |
| Metadata key/values | `Property` section (`Prop.*`) | ✓ | `BasicObjects_*` |
| Locked / hidden | LockMove*/LockSize*/... + `AgentLocked`; geometry NoShow + `AgentHidden` | ✓ | `Structural_*` |
| Aliases | `AgentAlias` | ✓; a duplicate on a page is dropped (`duplicate_alias`) | `CopiedDuplicates*` |
| Connectors: dynamic glue | `_WALKGLUE` BegTrigger/EndTrigger, `Connect` to PinX | ✓ | `Structural_*` |
| Connectors: static port glue | `PAR(PNT(...))` formulas, `Connect` to `Connections.X<n>`; named connection rows | ✓ default and custom ports | `Structural_*` |
| Free endpoints, waypoints | BeginX/EndX + polyline geometry; `AgentWaypoints`, `AgentRoute` | ✓ | `Structural_*` |
| Arrows | BeginArrow/EndArrow: none 0, open 1, triangle 4, circle 20, diamond 22 | ✓; other Visio arrow codes → nearest (`arrow_head`) | `Structural_*` |
| Connector labels | connector `Text` | ✓ | `Structural_*` |
| Glue to a missing target | — | endpoint frozen at its point (`glue_lost`) | — |
| Groups | `Type="Group"` with child shapes in group-local coordinates; frame = projected visual bounds | ✓ children, R4 derived bounds, rotation 0. A group's own geometry/text is dropped (`group_own_content`) | `Structural_*` |
| Z-order | document order + `AgentZ` | ✓ | `Structural_*` |
| PNG / JPEG / BMP pictures | Independent `Foreign` shapes with media parts; fit via Img* cells; opacity via Image Transparency | ✓ hash-verified blobs, `contain`/`cover`/`stretch` | `Images_*` |
| SVG pictures | PNG derivative rendered by the frontend (`asset.rasterize`) as the picture; original SVG carried at `visio/media/source-<sha16>.svg` via a custom relationship (`svg_rasterised` approximated). With no derivative the picture is omitted (`svg_no_fallback`, error/dropped, never marked clean) | ✓ original SVG restored while the picture bytes are unchanged | `Images_*`, `SvgUsesFrontendRaster*` |
| Picture replaced in Visio | — | new bytes become a new asset (`asset:image~<sha>`, `stale_image_provenance`). The stale `AssetSha256` cell is never used to resurrect the old image | `EditedForeignDataIsStaleProvenance` |
| Other picture formats (EMF/WMF/GIF/TIFF) | — | dropped (`picture_format`) | — |
| Masters | — | cells inherited from masters (`masters_inherited` approximated) | — |
| Macros (`vbaProject.bin`), OLE embeddings | — | inert: never executed or loaded (`macro_inert`, `ole_inert` dropped) | `MacrosAndOleAreInertDiagnostics`, `LossyImportRequiresSaveAs*` |

## Identity

- Valid `AgentId` UUIDs for elements, pages, layers and the document are kept unchanged.
- **Copies** (Visio copy/paste duplicates an `AgentId`): the shape whose `AgentNativeRef` still
  matches keeps the UUID. The others get a deterministic UUIDv5 (`duplicate_agent_id`,
  regenerated), and connectors glued to a copy follow the copy.
- **Missing or invalid IDs** are derived as UUIDv5 from the package hash and the native
  shape/page position, so importing the same bytes twice gives the same IDs
  (`MissingIdsAreDeterministicForUnchangedBytes`).
- `ImportResult.Identity` reports preserved, regenerated and generated counts.

## Not done yet / unproven

- Visio itself has opened none of this output. No-repair open, editing, glue behaviour and Word
  embedding are I41 (NOT RUN).
- Line join, guides, page background and text wrap round-trip only through `Agent*` User cells;
  Visio does not render them natively.
- MCP export path policy (approved roots, consent) is I51 (`ExportPathPolicy`).
