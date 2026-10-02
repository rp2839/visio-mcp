# visio-mcp

A Windows desktop diagram editor that a person and an LLM can edit together, with
native Microsoft Visio (`.vsdx`) files that stay editable in Visio rather than being
flattened into a picture.

- **Human editing:** shapes, glued connectors, text, images, layers, align and format,
  on a page-oriented canvas.
- **Agent editing:** an MCP server exposes typed, atomic, revision-checked operations on
  objects with persistent IDs, so an agent can change one object without regenerating
  the drawing. It can also render pages and regions to check its own layout.
- **Visio interoperability:** export and re-import of `.vsdx`, keeping agent IDs in
  Visio user cells across a round trip.

Stack:

- React 19 + TypeScript + maxGraph editor (`src/web`)
- .NET 10 WPF/WebView2 host (`src/Diagram.App`)
- portable host services (`src/Diagram.Host.Core`)
- direct-OPC VSDX mapper (`src/Diagram.Visio`)
- stdio MCP shim built on the official C# MCP SDK (`src/Diagram.Mcp`)

## Status

**All implementation packages (I00–I52) are built and tested on Linux. The POC is not complete:**
Windows, Visio and Word acceptance has **not** been run, and the M0 feasibility gate is recorded
as NOT PASSED. See [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) and the
[definition-of-done evidence map](docs/acceptance/definition-of-done.md).

## Layout

| Path | Contents |
|---|---|
| [`agentic-visio-mvp-spec.md`](agentic-visio-mvp-spec.md) | Original MVP specification |
| [`docs/design/`](docs/design/README.md) | Architecture and design decisions |
| [`docs/superpowers/plans/`](docs/superpowers/plans/2026-10-02-agentic-diagram-implementation.md) | Implementation plan (packages I00–I52) |
| [`contracts/`](contracts) | JSON Schema bundle; TS/C# types are generated from it (`tools/generate-contracts.mjs`) |
| [`src/web/`](src/web) | Editor, command engine, DrawScript, renderer, request router |
| [`src/Diagram.*`](src) | Host core, IPC, MCP shim, VSDX mapping, WPF app |
| [`tests/`](tests) | .NET test projects and VSDX fixtures |
| [`docs/mcp-tools.md`](docs/mcp-tools.md), [`docs/drawscript.md`](docs/drawscript.md), [`docs/vsdx-compatibility.md`](docs/vsdx-compatibility.md) | Reference |
| [`docs/acceptance/`](docs/acceptance) | Performance, Visio/Word checklist, §27 evidence, §23 demo evidence |
| [`tools/demo/`](tools/demo) | §23 scenario and evidence verifier |
| [`spikes/`](spikes/README.md) | M0 feasibility probes |

## Building and testing

Requires Node.js 24 and the .NET 10 SDK.

```sh
# frontend
npm --prefix src/web ci
npm --prefix src/web run check:contracts
npm --prefix src/web run typecheck
npm --prefix src/web test
npm --prefix src/web run test:browser      # set PW_CHROMIUM=<chromium path> to use a local browser
npm --prefix src/web run build             # output is packaged into the WPF app

# .NET (portable projects run anywhere; the WPF app and Windows tests need Windows)
dotnet test --solution Diagram.Portable.slnx
dotnet build Diagram.Windows.slnx

# §23 demo evidence (after the browser suite and the .NET tests)
node tools/demo/verify-demo.mjs
```

The MCP shim (`src/Diagram.Mcp`) connects to the running app over a per-user named pipe. Point an
MCP client at it as a stdio server.

## Licence

[MIT](LICENSE)
