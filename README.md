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

Planned stack: React + TypeScript + maxGraph, a .NET 10 WPF/WebView2 host, OfficeIMO.Visio
and the official C# MCP SDK.

## Status

Early stage. The design and implementation plan are done. Package **I00** (pinned probe
dependencies and a minimal request-envelope schema) is complete. Next are the M0 feasibility
probes, which must prove that editable `.vsdx` files with glued connectors work in real
Visio and Word before any production code is written.
See [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md).

## Layout

| Path | Contents |
|---|---|
| [`agentic-visio-mvp-spec.md`](agentic-visio-mvp-spec.md) | Original MVP specification |
| [`docs/design/`](docs/design/README.md) | Agreed architecture and design decisions |
| [`docs/superpowers/plans/`](docs/superpowers/plans/2026-10-02-agentic-diagram-implementation.md) | Implementation plan (packages I00–I52) |
| [`docs/m0/`](docs/m0/) | Pinned dependency versions and run environments |
| [`spikes/`](spikes/README.md) | Disposable M0 feasibility probes |

## Running the contract tests

Requires Node.js 24.

```sh
cd spikes/contract-tests
npm ci
npm test
```

## Licence

[MIT](LICENSE)
