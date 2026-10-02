# M0 spikes

Disposable feasibility probes (packages I00–I04 of the
[M0 plan](../docs/superpowers/plans/2026-10-02-agentic-diagram-m0.md)). Nothing here is
production code: no `src/` project or production solution may reference these folders.

| Folder | Package | Purpose |
|---|---|---|
| `contracts/` | I00 | Minimal probe request envelope schema. Prototype input to I10's production schema, not a competing model. |
| `contract-tests/` | I00 | Vitest + Ajv checks of the envelope schema. |
| `vsdx/`, `vsdx.tests/` | I01 | Planned: editable native-file round trip. |
| `canvas/` | I02 | Planned: maxGraph interaction and PNG preview. |
| `ipc/`, `mcp/`, `ipc.tests/` | I03 | Planned: stdio MCP → framed pipe → test host. |
| `webview/`, `webview.tests/` | I04 | Planned: WebView2 → live canvas operation. |

Pinned versions, licences and hashes: [docs/m0/dependencies.json](../docs/m0/dependencies.json).
Where and how each probe actually ran: [docs/m0/environment.json](../docs/m0/environment.json).
Each probe introduces its own lockfile when it is built; do not add dependencies
that are not pinned there.

## Probe envelope (v1)

`{protocolVersion: 1, kind: "request", requestId, method, documentId?, sessionId?, params}`.
Requests only; response and event schemas belong to the packages that first need them
(I03/I04). For every method, `params` must not contain `documentId` or `sessionId`.

For `doc.apply`: `kind` must be `request`; `documentId` and `sessionId` are required
UUIDs at the top level only (duplicating scope in `params` is rejected); `params`
requires a UUID `transactionId`, a non-negative integer `baseRevision`, `atomic: true`
and an `operations` array (operation shapes are opaque at this stage), with an
optional UUID `pageId`.

## Running the contract tests

Requires Node.js 24.21.0 (see dependencies.json).

```sh
cd spikes/contract-tests
npm ci
npm test
```
