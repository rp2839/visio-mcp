# Agentic Visio-like Drawing Tool — MVP Proof-of-Concept Specification

**Status:** Draft implementation specification  
**Research snapshot:** 1 October 2026  
**Primary target:** Windows desktop  
**Primary interoperability format:** Microsoft Visio `.vsdx`  
**Primary use case:** IT/business architecture, infrastructure, network and process diagrams that are created and refined jointly by a human and an LLM.

---

## 1. Purpose

Build a desktop drawing application that combines the deterministic, editable object model of a basic Visio/CAD-style editor with an agent interface designed for incremental LLM control.

The proof of concept must demonstrate three things:

1. **Human editing is practical:** a user can construct and refine a professional diagram using familiar shape, connector, text, image, layer, alignment and formatting controls.
2. **Agent editing is deterministic and incremental:** an LLM can create and modify individual drawing objects without regenerating the entire drawing or changing unrelated elements.
3. **Visio interoperability is real:** supported drawings can be opened from and saved to native `.vsdx` with shapes, connectors, text and images remaining editable in Microsoft Visio rather than being flattened into a picture.

The application is not intended to reproduce all of Microsoft Visio in the MVP. It should instead implement the subset most useful for technical/business diagrams and make that subset unusually easy for an LLM to control.

---

## 2. Product principles

### 2.1 Object identity is more important than generative redraw

Every drawable object has a persistent ID. An agent instruction such as “replace the ESG logo”, “move the database box 5 mm to the right”, or “make these three boxes the same width” must resolve to explicit object IDs and result in a small mutation transaction.

The default behaviour must **never** be to regenerate an existing page from scratch.

### 2.2 One document model, multiple interfaces

The same canonical document model must drive:

- the interactive GUI;
- the scripting language;
- MCP tools;
- Visio import/export;
- PNG/JPEG/SVG previews;
- undo/redo;
- change history.

The GUI and the agent must therefore be peers operating on the same objects, not separate rendering pipelines.

### 2.3 Structured operations are canonical; text scripting is convenience syntax

The reliable machine interface should be a typed operation schema. A small text language (“DrawScript” in this specification) compiles into those operations.

This allows:

- robust MCP JSON schemas;
- compact scripts for LLMs and humans;
- validation before changes are committed;
- deterministic replay and testing.

### 2.4 Visual review is a first-class agent capability

The LLM must be able to request a rendered page or region as PNG/JPEG and compare the visual result with the semantic object state. The app should also provide machine-readable layout diagnostics so the model does not have to infer every defect from pixels.

### 2.5 Native Visio means editable Visio objects

For the supported MVP subset, `.vsdx` output must contain editable Visio shapes, text, connectors and image objects. Exporting a single SVG/PNG wrapped inside a `.vsdx` is not acceptable.

---

## 3. Research findings that inform the design

## 3.1 Microsoft Visio interaction model

The useful Visio interaction patterns for this project are:

- **Shapes/stencils panel:** Visio organises reusable shapes into stencils and lets users drag shapes onto a page.
- **Finite drawing pages:** multi-page documents use page tabs; pages have physical dimensions suitable for Word/print workflows.
- **Selection and direct manipulation:** click/multi-select, drag, resize handles, rotation, keyboard nudging and z-order.
- **Connectors and glue:** connectors remain attached when shapes move; Visio distinguishes point/static glue from dynamic shape-to-shape glue. Common connector styles are straight, right-angle and curved.
- **Visual aids:** rulers, grid, guides, snapping, dynamic alignment guides and equal-spacing guides.
- **Arrange commands:** align left/centre/right/top/middle/bottom, distribute horizontally/vertically and auto-align/space.
- **Format Shape:** fill, line, transparency, line width/dash/caps/arrows and text/font/paragraph controls.
- **Layers:** per-page layers can control visible, print, active, lock, snap, glue and colour properties.
- **Shape metadata:** Shape Data and user-defined ShapeSheet cells allow non-visible metadata to travel with shapes.

These are more important to this product than Visio-specific advanced functions such as data graphics, engineering templates, VBA, themes, advanced ShapeSheet formulas or specialised organisational-chart behaviour.

## 3.2 Similar applications

### diagrams.net / draw.io

Relevant patterns:

- left shape library, centre canvas, right formatting/geometry panel;
- pages, layers, grid/rulers/snap;
- strong connector routing and interaction;
- import/export and a mature diagramming interaction model;
- its embed protocol supports autosave, export and incremental `patch`/`diffSync` messages.

The current draw.io core repository is Apache-2.0, with separate terms applying to icon/stencil assets. The current draw.io Desktop shell is GPL-3.0-only, so it should not simply be copied into this project without intentionally accepting that licence. The draw.io project also notes that it is designed largely as an application rather than as a finely customisable editor framework.

### maxGraph

maxGraph is the actively maintained TypeScript successor to mxGraph, the graph library behind draw.io. It is Apache-2.0 and explicitly targets developers building custom diagramming applications. It supplies vertices, edges, direct manipulation, custom shapes/stencils, edge routing and automatic layouts while allowing the application to own the surrounding UI and document model.

**Recommendation:** use maxGraph as the MVP canvas/interaction engine rather than forking the entire draw.io application.

### LibreOffice Draw

Useful reference for general-purpose vector drawing: layers, grouping, alignment/distribution, pictures, connectors/glue points and line styles. It confirms that a relatively small set of drawing primitives can cover much of the required business-diagram workload.

### Fabric.js / Konva / SVG-Edit / JointJS / React Flow / Excalidraw

These are useful component or design references but not the preferred primary engine:

- **Fabric.js:** excellent freeform interactive canvas and image/vector manipulation, but diagram connection/routing semantics would require more custom work.
- **Konva:** strong interactive Canvas scene graph and transformations; similarly requires diagram semantics to be built.
- **JointJS:** mature SVG diagramming model with strong nodes/links/ports; MPL-2.0 and a viable fallback if maxGraph proves unsuitable.
- **React Flow:** strong node/edge editor but biased towards graphs rather than general page-oriented drawing.
- **SVG-Edit:** useful vector-editing code/ideas but less suitable for connector-heavy diagrams.
- **Excalidraw:** excellent interaction and agent examples, but its hand-drawn/infinite-canvas model is not the target aesthetic or precision model.

## 3.3 Agentic diagram projects

Two existing patterns are particularly relevant:

- **Cisco Network Sketcher** exposes a drawing/design command language through a local MCP server, proving the practicality of an LLM driving a specialised diagram engine via MCP.
- **excalidraw-mcp** exposes semantic operations (`add`, `remove`, `restyle`, `reposition`, `connect`, etc.) and keeps coordinate/binding integrity inside the server. Its atomic-operation approach is the correct pattern for preventing accidental whole-diagram regeneration.

The application should follow this semantic mutation model rather than asking the LLM to emit raw XML, SVG or VSDX.

## 3.4 VSDX feasibility

`.vsdx` is an Open Packaging Convention ZIP/XML format documented by Microsoft. Important current open-source options include:

- **OfficeIMO.Visio** (MIT): COM-free .NET library that currently exposes VSDX creation/loading/editing, pages, shapes, connectors, text, styles, layers, Shape Data, containers, headless image export and validation/inspection APIs. Its code exposes explicit shape IDs and connector construction. This is the preferred MVP backend because it matches the proposed .NET desktop/MCP stack.
- **vsdx-go** (BSD-3-Clause): a new 2026 Go library claiming read/edit/write/render support for pages, shapes, connectors, masters, styles, layers, user cells, protection, stencil reading, formula evaluation and routing. It is promising but very young; use as an independent test/reference implementation or fallback rather than the initial core dependency.
- **svgtovisio** (MIT): a new converter that builds editable VSDX from SVG or draw.io via a neutral scene model. It is valuable reference code and a possible fallback exporter. Its current documented limitations include skipping SVG `<image>` and `<foreignObject>`, so it cannot by itself satisfy the bitmap/logo requirement.
- **Python `vsdx`** (BSD-3-Clause): useful for opening/editing/saving existing VSDX files and for test fixtures/template-based experimentation.
- **Apache POI XDGF**: VSDX read-only.
- **LibreOffice `libvisio`**: robust reading/conversion, not a VSDX writer.

The state of open-source VSDX support means interoperability must be validated at the start of the project, before substantial UI work.

---

## 4. Recommended MVP architecture

### 4.1 Technology stack

**Desktop host and backend**

- .NET 10
- WPF desktop host (Windows-first POC)
- Microsoft WebView2 for the editor web UI
- OfficeIMO.Visio for VSDX import/export and independent rendering/inspection where useful
- Official Model Context Protocol C# SDK for MCP
- Named pipes for local desktop-app ↔ MCP-shim IPC

**Editor frontend**

- TypeScript
- React
- Vite
- maxGraph (`@maxgraph/core`)
- Zod or JSON Schema validation for shared operation/document DTOs

Why Windows-first: the primary acceptance environment is one where Microsoft Visio and Word can be used to validate exported files and Word embedding. The architecture should avoid unnecessary Windows-only assumptions in the document model so a later Electron/Avalonia/web host remains possible.

### 4.2 Process model

```text
              LLM host (ChatGPT / Copilot / Claude / coding agent)
                                |
                           MCP over stdio
                                |
                       +------------------+
                       | Diagram.Mcp.exe  |
                       | MCP proxy/shim   |
                       +------------------+
                                |
                         local named pipe
                                |
+------------------------------------------------------------------+
|                         Desktop application                       |
|                                                                  |
|  +----------------------+       +------------------------------+  |
|  | .NET host services   |       | WebView2 / React editor      |  |
|  |                      | JSON  |                              |  |
|  | File I/O             |<----->| DocumentStore (canonical)    |  |
|  | VSDX adapter         |       | CommandEngine                |  |
|  | MCP IPC broker       |       | DrawScript parser            |  |
|  | asset persistence    |       | maxGraph adapter             |  |
|  +----------------------+       | renderer/layout analyser     |  |
|                                 +------------------------------+  |
+------------------------------------------------------------------+
```

### 4.3 Why a separate MCP executable

Most MCP desktop/client configurations launch a command as a stdio server. The drawing itself, however, belongs to an already running GUI process.

Therefore:

- `Diagram.Mcp.exe` is the program configured in the LLM’s MCP settings;
- it connects to the running drawing application over a per-user named pipe;
- the desktop app remains the owner of current document state;
- tool calls mutate the live document and are reflected in the canvas immediately;
- if the app is not running or no document is open, tools return a clear structured error.

Do not let a second invisible MCP process open a separate copy of the file and race with the GUI.

---

## 5. Canonical document model

The canonical model lives in the editor frontend while a document is open. It is serialisable as JSON and is independent of maxGraph and VSDX implementation details.

Use **points** (1/72 inch) as canonical physical coordinates. Accept `mm`, `cm`, `in`, `pt` and `px` at API/script boundaries; define `px` as 1/96 inch.

### 5.1 Document

```ts
interface DiagramDocument {
  schemaVersion: 1;
  id: string;                 // UUID
  title: string;
  revision: number;           // monotonic transaction revision
  pages: Page[];
  assets: Asset[];
  metadata: Record<string, string>;
  source?: {
    format: 'vsdx' | 'native-json';
    path?: string;
  };
}
```

### 5.2 Page

```ts
interface Page {
  id: string;
  name: string;
  widthPt: number;
  heightPt: number;
  background: Paint;
  grid: {
    visible: boolean;
    spacingPt: number;
    snap: boolean;
  };
  guides: Guide[];
  layers: Layer[];
  elements: Element[];
}
```

Default new page: A4 landscape unless changed by the user.

### 5.3 Layer

```ts
interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  printable: boolean;
  snap: boolean;
  glue: boolean;
  colourOverride?: string;
}
```

Model `element.layerIds: string[]` even if the MVP UI primarily assigns one layer. This allows imported Visio multi-layer membership to be retained.

### 5.4 Base element

```ts
interface ElementBase {
  id: string;                 // stable UUID, canonical identity
  alias?: string;             // optional human-friendly unique alias, e.g. "ers"
  name?: string;              // display name; need not be unique
  kind: ElementKind;
  layerIds: string[];
  zIndex: number;
  locked: boolean;
  hidden: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  rotationDeg: number;
  metadata: Record<string, string>;
}
```

### 5.5 Shape

MVP presets:

- rectangle
- rounded rectangle
- ellipse/circle
- diamond
- triangle
- hexagon
- parallelogram
- cylinder/database
- cloud
- callout
- generic SVG path/custom stencil

```ts
interface ShapeElement extends ElementBase {
  kind: 'shape';
  geometry: {
    preset?: string;
    svgPath?: string;
    cornerRadiusPt?: number;
  };
  style: ShapeStyle;
  text?: TextBlock;
  ports?: Port[];
}
```

### 5.6 Text

Support both text inside shapes and independent text boxes.

```ts
interface TextBlock {
  value: string;
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  colour: string;
  horizontalAlign: 'left'|'center'|'right';
  verticalAlign: 'top'|'middle'|'bottom';
  wrap: boolean;
  paddingPt: number;
}
```

Rich text runs are out of scope for MVP; one text style per object is sufficient.

### 5.7 Image

```ts
interface ImageElement extends ElementBase {
  kind: 'image';
  assetId: string;
  fit: 'contain'|'cover'|'stretch';
  opacity: number;
  preserveAspectRatio: boolean;
}
```

Required raster formats: PNG, JPEG, BMP.  
Also support SVG assets because logos are commonly available in vector form and vector-first output is a core goal.

### 5.8 Asset

```ts
interface Asset {
  id: string;
  name: string;
  mimeType: string;
  sha256: string;
  sourcePath?: string;
  embeddedData?: string;      // base64 or package-local reference
  tags: string[];
  provenance?: string;
}
```

A stable asset library is a product feature, not an implementation detail. It addresses the “wrong logo” failure mode directly: the LLM should select `asset:corona-energy-logo` rather than inventing or searching for another image.

### 5.9 Connector

```ts
interface ConnectorElement extends ElementBase {
  kind: 'connector';
  from: Endpoint;
  to: Endpoint;
  route: 'straight'|'orthogonal'|'curved';
  waypoints: Point[];
  style: LineStyle;
  label?: TextBlock;
}

interface Endpoint {
  elementId?: string;
  port?: 'north'|'east'|'south'|'west'|'auto'|string;
  point?: Point;              // free endpoint if not glued
  glue: 'dynamic'|'static'|'none';
}
```

Moving a connected shape must cause the maxGraph adapter to reroute the connector while retaining endpoint semantics.

### 5.10 Group/container

Support simple groups in the MVP:

```ts
interface GroupElement extends ElementBase {
  kind: 'group';
  childIds: string[];
}
```

Visio containers/swimlanes are post-MVP unless they fall out cheaply from OfficeIMO/maxGraph support.

---

## 6. Style model

### Shape style

- fill: none or solid colour
- fill opacity
- stroke: none or colour
- stroke width in points
- dash preset
- line cap/join
- optional shadow (stretch goal)

### Connector style

- colour
- width
- dash
- start arrow
- end arrow
- route type

### Text style

- font family
- font size
- bold/italic/underline
- colour
- horizontal/vertical alignment
- wrap
- padding

Do not implement gradients, glow, bevel, 3-D, pattern fills or rich text in the first POC unless VSDX round-trip work makes them essentially free.

---

## 7. Stable identity and mutation rules

This is the most important non-visual requirement.

### 7.1 IDs

- Every element gets a UUID when created.
- The UUID never changes during normal editing.
- Optional `alias` values are intended for scripts/LLMs and must be unique within the page when present.
- Display `name` values are not assumed unique.

### 7.2 VSDX persistence

When exporting to VSDX, preserve the canonical element UUID in a user-defined ShapeSheet cell, for example:

- `User.AgentId`
- `User.AgentAlias`
- `User.AssetId` where relevant

When importing:

1. if `User.AgentId` exists and is valid, use it;
2. otherwise generate a UUID;
3. write the generated UUID when the file is next saved.

This prevents the LLM from losing references after a Visio round trip.

### 7.3 Revisioning

Each committed edit transaction increments `document.revision` by one.

Agent mutations must include `baseRevision`.

If the document changed since the agent read it:

```json
{
  "error": "revision_conflict",
  "expected": 41,
  "actual": 44,
  "changesSinceExpected": [ ... ]
}
```

The agent then re-reads the affected state rather than overwriting a human’s changes.

### 7.4 Atomicity

An agent operation batch is atomic:

- validate all targets/properties first;
- either apply all operations or none;
- record one undo action;
- return a list of changed/created/deleted IDs.

### 7.5 No ambiguous destructive resolution

If an agent targets a name rather than an ID/alias and multiple elements match, return an ambiguity error with candidate IDs. Never guess for destructive or mutating operations.

---

## 8. GUI specification

The UI should resemble the useful parts of Visio/diagrams.net without cloning the Microsoft ribbon.

### 8.1 Main window layout

```text
+--------------------------------------------------------------------------------+
| Menu: File Edit View Insert Arrange Agent Help                                 |
| Toolbar: Select Connector Text Rect Ellipse Image | Undo Redo | Zoom           |
+------------------+-------------------------------------------+-----------------+
| Shapes / Assets  |                                           | Inspector       |
|                  |               DRAWING PAGE                |                 |
| Basic Shapes     |                                           | Style           |
| Flowchart        |        rulers / grid / guides             | Geometry        |
| Network          |                                           | Text            |
| Assets / Logos   |                                           | Arrange         |
|                  |                                           | Layers          |
+------------------+-------------------------------------------+-----------------+
| Page 1 | + |                                                  | zoom | status   |
+--------------------------------------------------------------------------------+
| Optional Agent / Script drawer                                                 |
+--------------------------------------------------------------------------------+
```

### 8.2 Left panel: Shapes and Assets

Tabs:

- **Shapes**
- **Assets**

MVP shape libraries:

- Basic
- Flowchart
- Architecture/IT

The IT library can initially contain generic server, database, cloud, application and user icons rather than vendor-specific copyrighted stencils.

Assets tab:

- import PNG/JPG/BMP/SVG;
- thumbnail preview;
- name and tags;
- drag to page;
- context menu: Rename, Replace source, Delete, Copy asset ID.

Important behaviour: replacing an asset updates all image elements referencing that asset only when the user explicitly chooses “replace asset globally”; replacing a single selected image changes only its `assetId`.

### 8.3 Canvas

Required:

- finite white page on neutral workspace;
- page shadow/border;
- pan with middle mouse/space-drag;
- mousewheel/trackpad zoom centred on pointer;
- fit page / fit selection / 100%;
- rulers;
- grid;
- grid snap;
- alignment guides;
- equal-spacing guides where feasible;
- rectangle/lasso multi-select;
- selection handles;
- resize;
- rotation;
- keyboard arrow nudge;
- Shift+arrow larger nudge;
- Delete;
- copy/paste/duplicate;
- Ctrl/Cmd modifier behaviour familiar to desktop drawing applications.

### 8.4 Connector UX

- dedicated connector tool;
- connection handles/ports shown on hover/selection;
- drag endpoint to shape edge or explicit port;
- dynamic glue by default;
- optional static north/east/south/west glue;
- reroute when shapes move;
- selectable connector with bend handles for orthogonal routes;
- line/arrow formatting in inspector.

### 8.5 Right inspector

Use tabs or collapsible sections.

**Style**

- fill colour/none/opacity
- line colour/width/dash
- arrows where applicable

**Text**

- font
- size
- bold/italic/underline
- colour
- horizontal/vertical alignment

**Geometry**

- X, Y
- width, height
- rotation
- lock aspect ratio
- units display selector (mm/cm/in/pt)

**Arrange**

- align left/centre/right
- align top/middle/bottom
- distribute horizontal/vertical
- bring forward/send backward
- bring to front/send to back
- group/ungroup

**Layers**

- layer assignment
- add/rename/delete layer
- visible
- lock
- printable

### 8.6 Page tabs

At bottom:

- add page
- rename page
- reorder page
- duplicate page
- delete page

Page size properties:

- A4 portrait/landscape
- A3 portrait/landscape
- Letter
- custom width/height

### 8.7 Agent/script drawer

A collapsible lower or right-side panel:

- script editor;
- `Validate` button;
- `Run` button;
- last transaction result;
- current document revision;
- changed IDs;
- Undo transaction.

Do **not** build a provider-specific chat UI in the MVP. The external LLM connects through MCP. The script drawer is for testing, transparency and manual automation.

---

## 9. DrawScript language

“DrawScript” is a working name.

### 9.1 Design goals

- line-oriented and easy for an LLM to emit;
- explicit IDs/aliases;
- typed physical units;
- unspecified properties remain unchanged;
- commands compile into the same typed operations used by MCP;
- entire script executes as one transaction by default.

### 9.2 Examples

```text
page use "Architecture"

add shape id=elexon type=roundedRect x=90mm y=25mm w=70mm h=20mm
set elexon text="Elexon"
set elexon fill="#FFFFFF" stroke="#53606F" strokeWidth=1pt

add shape id=dip type=roundedRect x=90mm y=65mm w=70mm h=25mm
set dip text="Data Integration Platform (DIP)"

add image id=corona asset="asset:corona-energy-logo" x=25mm y=125mm w=45mm h=20mm fit=contain

connect id=elexon_dip from=elexon.south to=dip.north route=orthogonal endArrow=triangle

align hcenter elexon dip
set-gap vertical elexon dip 20mm
```

Incremental correction:

```text
set corona asset="asset:corona-energy-logo-v2"
move corona dx=3mm dy=0mm
```

Only `corona` may change.

### 9.3 Initial command set

Document/page:

- `page add`
- `page use`
- `page rename`
- `page size`

Create:

- `add shape`
- `add text`
- `add image`
- `connect`
- `group`

Modify:

- `set <id> property=value ...`
- `move <id> x= y=`
- `move <id> dx= dy=`
- `resize <id> w= h=`
- `rotate <id> angle=`
- `delete <id>`
- `duplicate <id> as=<new-id>`

Arrange:

- `align left|center|right|top|middle|bottom <ids...>`
- `distribute horizontal|vertical <ids...>`
- `set-gap horizontal|vertical <ids...> <distance>`
- `z front|back|forward|backward <ids...>`

Layer:

- `layer add`
- `layer set`
- `layer assign`

Asset:

- `asset import`
- `asset replace`

### 9.4 Parsing rules

- UTF-8.
- One command per physical line.
- `#` starts a comment outside a quoted string.
- Strings use double quotes with JSON-style escapes.
- IDs use `[A-Za-z_][A-Za-z0-9_.-]*` aliases or quoted UUIDs.
- Dimensions require units unless a command explicitly inherits document units.
- Colours accept `#RRGGBB`, `#RRGGBBAA` and `none`.
- Boolean values: `true`, `false`.
- Parsing/validation errors include line/column and do not mutate the document.

### 9.5 `set` semantics

`set` is a patch, not a replacement.

This:

```text
set esg stroke="#333333"
```

must not alter fill, text, geometry, layer, z-order, asset or any other property.

---

## 10. Operation API

The scripting language compiles to a typed operation array.

Example:

```json
{
  "baseRevision": 18,
  "atomic": true,
  "operations": [
    {
      "op": "set",
      "target": "6d3c...",
      "patch": {
        "style": { "stroke": "#333333" }
      }
    },
    {
      "op": "move",
      "target": "5f91...",
      "delta": { "xPt": 8.5039, "yPt": 0 }
    }
  ]
}
```

Result:

```json
{
  "previousRevision": 18,
  "revision": 19,
  "created": [],
  "changed": ["6d3c...", "5f91..."],
  "deleted": [],
  "warnings": []
}
```

All GUI commands that affect multiple objects should use the same transaction mechanism where practical.

---

## 11. MCP server specification

### 11.1 Transport

POC default: **stdio** MCP executable configured in the LLM host, proxying to the GUI via named pipe.

Optional later: localhost Streamable HTTP endpoint.

### 11.2 Tools

#### `get_document_summary`

Purpose: compact semantic context.

Inputs:

- `pageId?`
- `includeGeometry?: boolean` default true
- `includeStyle?: boolean` default false
- `includeHidden?: boolean` default false

Returns:

- document ID/revision;
- pages;
- layer summary;
- element list with ID, alias/name, type, bounds, text, connection relationships;
- asset IDs referenced.

This should normally be the first tool the LLM calls.

#### `get_objects`

Inputs:

- `ids: string[]`

Returns complete canonical objects for targeted inspection.

#### `apply_operations`

Inputs:

- `baseRevision`
- `operations[]`
- `atomic` default true

Returns transaction result and concise summaries of changed objects.

This is the canonical mutation tool.

#### `execute_script`

Inputs:

- `baseRevision`
- `script`
- `atomic` default true

Compiles DrawScript then executes the resulting operations.

Return both parsed operations and result so the LLM can see exactly what occurred.

#### `render_page`

Inputs:

- `pageId`
- `format: png|jpeg`
- `maxWidth?` default 1600
- `maxHeight?` default 1200
- `mode: clean|debug` default clean

Returns MCP image content plus metadata.

`debug` render overlays small object IDs/aliases and bounding boxes so a model can correlate pixels with semantic elements.

#### `render_region`

Inputs:

- `pageId`
- bounds or element IDs
- padding
- format
- clean/debug

Useful for reviewing a small correction without spending vision/context budget on the entire page.

#### `inspect_layout`

Returns machine-readable warnings such as:

- element outside page;
- overlapping non-container shapes;
- text overflow/clipping;
- zero-size or near-zero-size objects;
- connector crossing through unrelated shape;
- unglued/dangling connector;
- image aspect distortion;
- duplicate alias;
- hidden object on visible required layer;
- inaccessible/low-contrast text where cheaply calculable.

Each issue must include element IDs and bounds.

#### `list_assets`

Inputs:

- `query?`
- `tags?`

Returns known asset IDs, names, types, dimensions and thumbnails/preview references where practical.

This should be the preferred way for an LLM to choose company logos.

#### `get_changes`

Inputs:

- `sinceRevision`

Returns transaction summaries since that revision. Enables the model to recover from human edits without rereading a large document.

#### `export_document`

Inputs:

- `format: vsdx|svg|png|jpeg`
- `path?`

For security, arbitrary paths should not be accepted by default from remote/untrusted MCP clients. Prefer exporting to the open document’s directory or an application-approved workspace unless explicitly authorised.

### 11.3 Optional MCP resources

Post-MVP or if trivial with the SDK:

- `diagram://current/summary`
- `diagram://current/page/{pageId}/preview.png`

Do not make resource subscriptions a dependency for the MVP; normal tool calls and revision numbers are sufficient.

---

## 12. Agent workflow

Expected LLM loop:

1. `get_document_summary`
2. optionally `list_assets`
3. `apply_operations` or `execute_script`
4. `inspect_layout`
5. `render_page` or `render_region`
6. visually assess result
7. apply small correction transaction if required

The important property is that steps 6–7 modify only explicitly targeted objects.

Example request:

> “The ESG logo is wrong. Use the correct ESG Global logo and leave everything else unchanged.”

Expected tools:

1. find target object ID from summary;
2. list/search assets for ESG;
3. apply one `set image.assetId` operation at current revision;
4. render a region around that logo;
5. return success.

A test must assert that every unrelated element serialises identically before and after the operation.

---

## 13. VSDX import/export contract

### 13.1 Scope

MVP supports modern `.vsdx` only.

Out of scope initially:

- legacy binary `.vsd`;
- macros (`.vsdm`) as an authoring target;
- arbitrary third-party Visio add-in data;
- complete ShapeSheet formula fidelity;
- data graphics;
- complex themes/effects;
- every master/stencil feature.

### 13.2 Export requirements

For app-created supported content:

- page sizes/names are preserved;
- shapes are editable Visio shapes;
- text remains editable;
- fill/line/text styling maps to Visio equivalents;
- connectors remain connectors and remain glued after moving a connected shape in Visio;
- PNG/JPEG/BMP/SVG-derived images are represented as image/foreign-data shapes rather than flattening the whole page;
- supported layers map to Visio layers;
- z-order is retained;
- object UUID is stored in `User.AgentId`;
- alias is stored in `User.AgentAlias` where present;
- no hidden app-specific dependency is required to open the VSDX in Visio.

### 13.3 Import requirements

Import the supported subset into the canonical model:

- pages;
- simple/master-backed shapes that can be represented;
- text;
- bounds and rotation;
- fill/line/text styles where supported;
- connectors and endpoint relationships;
- images;
- layers;
- app user cells.

Unsupported constructs must produce diagnostics. Do not silently discard them.

Example:

```json
{
  "severity": "warning",
  "code": "VSDX_UNSUPPORTED_EFFECT",
  "page": "Page-1",
  "shapeId": "42",
  "detail": "Glow effect is not represented in the editor and will not be preserved on generated export."
}
```

### 13.4 Round-trip policy for arbitrary existing VSDX

The MVP **does not promise lossless arbitrary Visio round-tripping**.

Two classes of file should be distinguished:

1. **App-authored/supported VSDX:** expected to round-trip through app → Visio → app within the supported feature set.
2. **Arbitrary imported VSDX:** opened on a best-effort basis with a compatibility report. Saving may create a normalised VSDX containing the supported model, not a byte-preserving edit of every unknown Visio feature.

A later production phase can investigate preserving untouched unknown XML/package parts to improve fidelity.

### 13.5 Technical gate: VSDX spike

Before implementing the full editor, the coding agent must build a throwaway validation harness using OfficeIMO.Visio that generates one page containing:

- rectangle with text;
- ellipse;
- right-angle connector glued between shapes;
- line/fill/text styles;
- layer membership;
- one PNG logo;
- one user cell containing a UUID.

Then verify manually in Visio:

- file opens without repair prompt;
- objects are editable;
- moving the shape keeps connector attached;
- image remains an image object;
- UUID user cell survives save/reopen;
- file can be inserted/embedded in Word as a Visio object and later edited on a Visio-equipped workstation.

Then load the Visio-saved file back through OfficeIMO and verify the supported fields.

If this spike fails materially, evaluate `vsdx-go` and `svgtovisio` before building more UI.

---

## 14. Rendering and visual feedback

### 14.1 Editor render

Use maxGraph/SVG/browser rendering for the MCP `render_page` result because it should match what the user sees.

Rasterise to PNG/JPEG at a controlled resolution in the frontend or host.

### 14.2 VSDX render oracle

Where useful, OfficeIMO’s headless SVG/PNG export can render the generated VSDX separately. A test can compare:

- editor render;
- VSDX-backend render.

Large differences indicate mapping defects before a human opens Visio.

### 14.3 Debug render

Debug mode should optionally show:

- element ID/alias labels;
- bounding boxes;
- connector endpoint markers;
- page/layer name;
- coordinates for selected objects.

These overlays must not be part of exported document content.

---

## 15. Undo, redo and change history

### 15.1 Transactions

All edits use transactions:

```ts
interface TransactionRecord {
  revision: number;
  timestamp: string;
  source: 'gui'|'script'|'mcp'|'import';
  description: string;
  operations: Operation[];
  inverseOperations: Operation[];
  changedIds: string[];
}
```

### 15.2 Undo rules

- One agent script/tool batch = one undo step.
- Multi-object GUI actions such as align/distribute = one undo step.
- Undo/redo also increments the live revision or otherwise participates safely in concurrency checks; do not rewind revision numbers.

### 15.3 Transaction viewer

The Agent panel should show the last few transactions so a user can see exactly what the LLM changed.

---

## 16. File persistence

Public formats:

- `.vsdx` — primary interoperable editable format
- `.png`, `.jpg`, `.svg` — export

Development/native format:

- optional `.diagram.json` containing the canonical model for debugging and lossless POC recovery.

The JSON format is not intended to compete with VSDX; it is a useful test/debug representation and recovery format while VSDX mapping matures.

Autosave can initially use `.diagram.json` in an application recovery directory rather than rewriting VSDX after every mouse movement.

---

## 17. Security and robustness

### MCP

- MCP server is local-only by default.
- stdio shim accepts no arbitrary network connections.
- named pipe is per-user and validates client ownership where feasible.
- do not expose shell execution.
- do not accept arbitrary filesystem paths without workspace/user approval.

### Files/assets

- defend against ZIP bombs and excessive VSDX package sizes;
- set XML depth/entity/size limits;
- limit raster dimensions and decoded pixel counts;
- sanitise SVG before display/import;
- prevent path traversal when unpacking package parts;
- never execute embedded macros or OLE content;
- imported hyperlinks are data only unless user invokes them.

### Scripting

DrawScript is declarative; it has no loops, arbitrary file reads, process execution, network calls or general-purpose code evaluation in the MVP.

---

## 18. Performance targets for POC

Target document: 1–10 pages, up to 500 visible elements on a page.

- drag/resize: interactive at normal desktop frame rates;
- ordinary single transaction reflected in UI: <100 ms preferred, <250 ms acceptable;
- 100-operation agent batch: <500 ms preferred;
- page preview at 1600×1200: <1 second preferred;
- document summary for 500 elements: <250 ms excluding MCP transport;
- VSDX save for 500-element document: <3 seconds target, but correctness is more important in POC.

Do not optimise beyond these targets before interoperability and correctness are proven.

---

## 19. Suggested repository structure

```text
/
  README.md
  docs/
    architecture.md
    drawscript.md
    vsdx-compatibility.md
    mcp-tools.md

  src/
    Diagram.App/                 # .NET WPF host + WebView2
    Diagram.Core.Contracts/      # C# DTOs shared by host/MCP/VSDX adapter
    Diagram.Visio/               # OfficeIMO mapping/import/export
    Diagram.Mcp/                 # stdio MCP proxy executable
    Diagram.Ipc/                 # named pipe protocol/client/server

    web/
      src/
        model/                   # canonical TypeScript model
        commands/                # Operation schemas + CommandEngine
        script/                  # DrawScript parser/compiler
        canvas/                  # maxGraph adapter
        render/                  # PNG/JPEG/debug render
        layout/                  # diagnostics
        components/              # React UI
        bridge/                  # WebView2 message protocol

  tests/
    Diagram.Visio.Tests/
    Diagram.Mcp.Tests/
    Diagram.Ipc.Tests/
    web-tests/
    fixtures/
      vsdx/
      assets/
      golden/
```

Generate C# and TypeScript DTOs from one JSON Schema/OpenAPI-like contract if practical; otherwise include contract snapshot tests that fail on incompatible drift.

---

## 20. Open-source component shortlist

| Project | Licence | Use in this project | Recommendation |
|---|---|---|---|
| maxGraph | Apache-2.0 | Canvas, graph interaction, routing, shapes | **Primary editor engine** |
| OfficeIMO.Visio | MIT | VSDX create/load/edit/save/render/validate | **Primary VSDX backend; validate early** |
| MCP C# SDK | official open-source SDK | stdio MCP server/proxy | **Primary MCP implementation** |
| draw.io core | Apache-2.0 plus asset terms | UX reference; possible fallback editor | Reference/fallback, not initial base |
| draw.io Desktop | GPL-3.0-only current wrapper | Desktop shell reference | Do not copy unless GPL is intentionally acceptable |
| vsdx-go | BSD-3-Clause | independent VSDX parser/writer/reference | Validation oracle/fallback |
| svgtovisio | MIT | VSDX writer/reference, scene-model ideas | Reference/fallback; current image limitation |
| Python `vsdx` | BSD-3-Clause | test fixtures/template experiments | Secondary tool |
| libvisio | MPL-2.0 | import/render comparison | Read/conversion oracle |
| Fabric.js | MIT | alternative freeform canvas | Fallback if vector editing outweighs graph semantics |
| JointJS | MPL-2.0 | alternative SVG graph editor | Viable fallback |
| Excalidraw MCP | MIT | agent operation design reference | Architectural reference |
| Cisco Network Sketcher | repository-specific open-source terms | MCP/command-language design reference | Architectural reference |

Before distributing the product, perform a formal dependency and asset-licence review. In particular, do not assume that diagramming libraries’ bundled icon/stencil collections have identical terms to their source code.

---

## 21. Testing strategy

## 21.1 Unit tests

Document/model:

- ID uniqueness;
- alias resolution;
- units conversion;
- style validation;
- bounds validation.

Commands:

- every operation type;
- patch leaves unspecified properties unchanged;
- atomic rollback on error;
- inverse operation correctness;
- revision conflict handling;
- ambiguous target handling.

DrawScript:

- parsing;
- quoting/escaping;
- typed dimensions;
- comments;
- line/column errors;
- command compilation.

## 21.2 Canvas adapter tests

- model → maxGraph cell creation;
- maxGraph user movement → model operation;
- selection and multi-selection;
- resize/rotation;
- connector endpoint integrity;
- z-order;
- grouping;
- layer visibility/locking.

## 21.3 VSDX tests

Fixtures should include both app-generated and manually created Visio files.

Automated:

- generate VSDX;
- reopen with OfficeIMO;
- verify pages/elements/styles/UUID user cells;
- package/schema validation where available;
- independent parse through `vsdx-go` in CI or a secondary validation job if feasible.

Manual acceptance in real Visio:

- no repair warning;
- edit shape text;
- change fill;
- move shape;
- connector remains glued;
- replace image;
- save/reopen;
- insert/activate within Word.

## 21.4 Visual tests

Golden-image fixtures for:

- simple shape page;
- architecture diagram;
- connector routing;
- logo/image placement;
- text wrapping;
- alignment/distribution.

Allow small raster tolerance rather than exact pixel equality across rendering environments.

## 21.5 Agent regression tests

These are mandatory because they encode the product’s differentiator.

### Test: replace only one logo

1. Build document with 20 objects.
2. Snapshot semantic hashes of every object.
3. Run operation changing one image asset.
4. Assert only target object hash and document revision changed.

### Test: small style correction

“Make the ERS box outline 1.5pt.”

Assert position, fill, text, connections and every other object are unchanged.

### Test: alignment

Align three selected objects horizontally.

Assert only geometry of those objects changes.

### Test: revision race

1. Agent reads revision 10.
2. Human moves a shape; revision 11.
3. Agent submits mutation with base revision 10.
4. Mutation is rejected and human change remains intact.

### Test: ambiguous target

Two objects named “Server”. Agent targets `Server`. Mutation fails with candidates; no change committed.

### Test: visual review loop

Agent creates a page, calls `inspect_layout`, renders image, then applies a corrective patch. Verify second patch touches only named objects.

---

## 22. MVP milestones

### M0 — technical feasibility gates

Deliver throwaway/isolated spikes, not production UI.

1. OfficeIMO VSDX generation/round-trip spike described in section 13.5.
2. maxGraph spike: create/move/resize/connect/image/render PNG.
3. MCP C# spike: stdio tool → named pipe → running test host → response.
4. WebView2 bridge spike: C# sends an operation to web editor and sees live canvas update.

**Exit criterion:** all four work. If VSDX fails, stop and re-evaluate backend before proceeding.

### M1 — editor shell

- WPF host/WebView2;
- React/maxGraph canvas;
- one page;
- shapes/text/images/connectors;
- selection, move, resize, rotate;
- basic Style/Geometry/Text inspector;
- undo/redo;
- JSON debug save/load.

### M2 — deterministic command engine

- canonical model;
- typed operations;
- transaction/revision system;
- DrawScript;
- arrange commands;
- stable aliases/IDs;
- agent transaction viewer.

### M3 — MCP live control

- `Diagram.Mcp.exe`;
- named-pipe proxy;
- document summary;
- get objects;
- apply operations;
- execute script;
- render page/region;
- layout inspection;
- asset listing.

### M4 — VSDX integration

- new VSDX export;
- supported VSDX import;
- UUID user-cell persistence;
- connectors/glue;
- images;
- layers;
- compatibility diagnostics;
- Visio/Word manual acceptance suite.

### M5 — POC hardening/demo

- multi-page;
- layers UI;
- asset library;
- file recovery;
- security limits;
- performance pass;
- end-to-end demonstration scenario.

---

## 23. POC demonstration scenario

The final POC should be demonstrated with an architecture diagram similar to a real business wiki diagram:

1. Human opens a blank A4 landscape page.
2. LLM creates four labelled system/company blocks, connectors and annotations through MCP.
3. UI visibly updates during/after each transaction.
4. LLM requests PNG preview and notices one alignment problem.
5. LLM aligns only the affected elements.
6. Human manually drags one element and changes one fill colour.
7. LLM reads changes since its previous revision and preserves the human edit.
8. Human asks the LLM to replace one company logo using the local asset library.
9. Only that image object changes.
10. Document saves as `.vsdx`.
11. File opens in Visio with editable objects.
12. Moving a connected shape in Visio keeps its connector attached.
13. VSDX is embedded into a Word document and remains activatable/editable as a Visio object on a workstation with Visio.
14. VSDX is reopened in the POC and agent IDs still resolve.

This single demonstration validates the core value proposition more effectively than a large number of extra drawing features.

---

## 24. Explicit MVP non-goals

Do not implement these unless required by a feasibility spike:

- collaborative multi-user editing;
- cloud accounts/storage;
- built-in LLM/provider credentials;
- freehand drawing;
- complex Bézier node editing;
- full CAD constraints/dimensions;
- 3-D shapes;
- Visio VBA/macros;
- full ShapeSheet editor;
- data-linked diagrams;
- data graphics;
- automatic BPMN/UML validation;
- rich text runs;
- real-time multi-user cursors;
- arbitrary legacy `.vsd` import;
- lossless preservation of every unsupported arbitrary VSDX feature.

---

## 25. Architectural risks and mitigations

### Risk 1: open-source VSDX libraries are less mature than their feature lists suggest

**Mitigation:** VSDX is milestone zero. Test with real desktop Visio and independent parsers before committing to the UI architecture.

### Risk 2: maxGraph is still 0.x

maxGraph is active and feature-rich but its public API can still change.

**Mitigation:** isolate all maxGraph calls behind `CanvasAdapter`; never let maxGraph cell objects leak into the canonical document model or MCP API.

### Risk 3: imported Visio documents contain constructs outside the canonical model

**Mitigation:** compatibility diagnostics and an explicit supported-subset contract. Do not claim general lossless round-trip in the POC.

### Risk 4: UI and VSDX render differ

**Mitigation:** visual golden tests plus optional independent OfficeIMO render comparison; prefer simple supported styles in MVP.

### Risk 5: agent accidentally changes too much

**Mitigation:** stable IDs, patch semantics, base revisions, atomic transactions, ambiguity errors, changed-ID results and regression tests that hash untouched objects.

### Risk 6: logos/assets become another hallucination vector

**Mitigation:** local asset library with stable IDs; MCP `list_assets`; never ask the LLM to synthesize a corporate logo when an approved asset exists.

### Risk 7: a monolithic editor fork becomes difficult to maintain

**Mitigation:** use maxGraph as a library and own the surrounding UI/model. Keep draw.io as a UX/protocol reference rather than the application base.

---

## 26. Coding-agent implementation rules

The coding agent implementing this specification should follow these constraints:

1. **Do the M0 spikes first.** Do not scaffold the entire product until VSDX and live MCP/UI control are demonstrated.
2. **Keep the canonical model library-independent.** No maxGraph or OfficeIMO types in public model/operation schemas.
3. **Use tests before adding mutation behaviours.** Every agent operation needs a “unrelated objects unchanged” assertion where applicable.
4. **Do not add features outside the MVP merely because a dependency supports them.**
5. **Prefer explicit compatibility warnings over silent loss.**
6. **Never implement agent editing as regenerated SVG/XML.** Use typed operations against persistent IDs.
7. **Keep the MCP server provider-neutral.** It must work with any standards-compliant MCP host that can launch/configure the server.
8. **Keep the app usable without an LLM.** Human GUI editing is a complete first-class path.
9. **Treat imported SVG/images and VSDX as untrusted input.** Apply strict resource limits.
10. **Record dependency versions and licences at the commit used for the POC.** Several relevant projects are evolving quickly in 2026.

---

## 27. Definition of done for the MVP POC

The POC is complete when all of the following are true:

- [ ] Windows desktop application starts and shows a usable page-oriented editor.
- [ ] User can add/edit/delete shapes, text, connectors and PNG/JPG/BMP/SVG images.
- [ ] User can move/resize/rotate objects, multi-select, align/distribute, change z-order and use undo/redo.
- [ ] Basic layers can be created, hidden and locked.
- [ ] Grid/snap/alignment guides are usable.
- [ ] Shape fill/line/text properties are editable.
- [ ] Connectors remain attached when connected shapes move.
- [ ] Every element has a stable ID.
- [ ] DrawScript can create and incrementally modify the live page.
- [ ] MCP can read current semantic state.
- [ ] MCP can apply atomic incremental operations against a base revision.
- [ ] MCP can return a PNG/JPEG render of the current page/region.
- [ ] MCP can report simple layout defects.
- [ ] Asset library allows an LLM to select a known logo by stable asset ID.
- [ ] Supported drawings save as editable `.vsdx`.
- [ ] Supported `.vsdx` drawings can be reopened into the application.
- [ ] Stable IDs survive app → VSDX → Visio save → app round trip.
- [ ] Exported VSDX passes manual Visio editability tests.
- [ ] Exported VSDX can be embedded/activated in Word in the target environment.
- [ ] Regression test proves a one-object agent correction leaves all unrelated objects unchanged.

---

# Appendix A — Example MCP editing session

### 1. Model reads the document

```json
get_document_summary({"includeGeometry": true})
```

Response excerpt:

```json
{
  "revision": 27,
  "page": {
    "id": "p1",
    "name": "Architecture",
    "elements": [
      {
        "id": "77aa...",
        "alias": "esg_logo",
        "kind": "image",
        "assetId": "asset:esg-old",
        "bounds": {"x": 420, "y": 300, "width": 120, "height": 52}
      }
    ]
  }
}
```

### 2. Model finds approved asset

```json
list_assets({"query": "ESG Global"})
```

Response:

```json
{
  "assets": [
    {
      "id": "asset:esg-global-primary",
      "name": "ESG Global — Primary Logo",
      "mimeType": "image/svg+xml"
    }
  ]
}
```

### 3. Model applies one patch

```json
apply_operations({
  "baseRevision": 27,
  "operations": [
    {
      "op": "set",
      "target": "77aa...",
      "patch": {"assetId": "asset:esg-global-primary"}
    }
  ]
})
```

Response:

```json
{
  "previousRevision": 27,
  "revision": 28,
  "changed": ["77aa..."],
  "created": [],
  "deleted": []
}
```

### 4. Model verifies visually

```json
render_region({
  "pageId": "p1",
  "elementIds": ["77aa..."],
  "paddingPt": 30,
  "format": "png",
  "mode": "clean"
})
```

No whole-page regeneration occurs at any stage.

---

# Appendix B — Source/reference list

The following sources were useful in preparing this specification. URLs should be rechecked at implementation time because active open-source projects can change rapidly.

## Microsoft Visio

- Visio file format reference: https://learn.microsoft.com/en-us/office/client-developer/visio/visio-file-format-reference
- ShapeSheet cells reference: https://learn.microsoft.com/en-us/office/client-developer/visio/cells-visio-shapesheet-reference
- Shapes window/stencils: https://support.microsoft.com/en-us/visio/use-the-shapes-window-to-organize-and-find-shapes
- Layers: https://support.microsoft.com/en-us/visio/use-layers-to-set-properties-for-multiple-shapes
- Connectors/glue: https://support.microsoft.com/en-us/visio/glue-or-unglue-connectors
- Connector styles: https://support.microsoft.com/en-us/visio/add-connectors-between-visio-shapes
- Format Shape: https://support.microsoft.com/en-us/visio/format-a-shape-in-visio
- Align/position: https://support.microsoft.com/en-us/visio/align-and-position-shapes-in-a-diagram
- Rulers/grid/guides: https://support.microsoft.com/en-us/visio/video-choose-the-right-view-for-the-task

## Editor/diagram engines

- maxGraph: https://github.com/maxGraph/maxGraph
- maxGraph docs: https://maxgraph.github.io/
- draw.io core: https://github.com/jgraph/drawio
- draw.io embed protocol: https://www.drawio.com/docs/reference/embed-mode/
- Fabric.js: https://github.com/fabricjs/fabric.js

## VSDX

- OfficeIMO: https://github.com/EvotecIT/OfficeIMO
- vsdx-go: https://github.com/wijnberg-net/vsdx-go
- svgtovisio: https://github.com/McMarius11/svgtovisio
- Python vsdx: https://github.com/dave-howard/vsdx
- LibreOffice libvisio: https://git.libreoffice.org/libvisio/
- Apache POI XDGF: https://poi.apache.org/components/diagram/

## MCP/agent patterns

- Official MCP C# SDK: https://github.com/modelcontextprotocol/csharp-sdk
- Cisco Network Sketcher: https://github.com/cisco-open/network-sketcher
- Excalidraw MCP: https://github.com/dtour/excalidraw-mcp

---

# Appendix C — Decision summary

For the POC, the recommended combination is:

- **React + TypeScript + maxGraph** for the purpose-built editor;
- **WPF + WebView2 on .NET 10** as the Windows desktop host;
- **OfficeIMO.Visio** as the initial VSDX backend, guarded by an immediate real-Visio feasibility spike;
- **official C# MCP SDK + a separate stdio proxy executable** for external LLM control;
- **typed atomic operations + persistent IDs + revision checks** as the central agent architecture;
- **DrawScript** as a compact human/LLM-facing layer over those operations;
- **local asset IDs** as the solution to repeatable, correct logo selection;
- **PNG/JPEG clean/debug renders plus layout diagnostics** for the model’s visual self-review loop.

If the M0 VSDX spike proves OfficeIMO inadequate, stop and evaluate `vsdx-go` and the `svgtovisio` VSDX builder before continuing. If maxGraph proves too limiting for freeform vector requirements, retain the canonical model/command/MCP/VSDX architecture and replace only the `CanvasAdapter` with Fabric.js or JointJS.
