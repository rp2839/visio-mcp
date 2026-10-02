# M0 results

Date: 2026-10-02. Environment: [environment.json](environment.json). Each gate lists its
outcome, evidence, commands, who checked it, and limitations. A gate needing Windows/Office that
did not run is **NOT RUN**, not PASS.

| Gate | Outcome | Automated evidence (Linux) | Manual checker | Missing for PASS |
|---|---|---|---|---|
| G1 native VSDX | **PARTIAL — Office NOT RUN** | `spikes/vsdx.tests` 9/9; `generated.vsdx`; OfficeIMO cross-load | none | Visio open without repair, glue follows move, User cells survive save, Word activation ([checklist](evidence/G1/manual-checklist.md)) |
| G2 canvas | **PASS (functional, headless Chromium)** | `spikes/canvas/tests/canvas.spec.ts` 3/3; render PNGs | automated only | WebView2-hosted re-check happens in G4 |
| G3 MCP/IPC | **PARTIAL — Windows NOT RUN** | `spikes/ipc.tests` 11/11; stdio transcript | automated only | Windows pipe ACLs, second-user refusal, logon-session pipe name |
| G4 WebView2 | **NOT RUN** | bridge rules 11/11 (fake channel); `bridge.spec.ts` 4/4; WPF shell compiles | none | Any run in real WebView2 |

## Backend findings

1. **OfficeIMO.Visio 3.4.4 cannot write pictures.** It has no ForeignData/picture API, so it
   cannot satisfy G1 as the exporter. The probe's **direct OPC/VSDX writer/reader** emits every
   required feature: native geometry, User cells, `Connects` glue with `_WALKGLUE` formulas, layer
   rows, and ForeignData PNG pictures with relationships. OfficeIMO independently parses the
   output, so it stays useful as a test oracle and possible importer helper.
2. **maxGraph 0.24.0 works but needs care.** Disable `setConnectable` for moves (a vertex-centre
   drag otherwise creates an edge). Arm gestures on handler start and begin them after drag
   tolerance. Begin text gestures after `startEditing` returns.
3. **The MCP SDK 2.2.0 stdio server is clean.** With console logging on stderr, stdout carries
   only JSON-RPC. Under .NET 10 the test projects need `global.json` → Microsoft.Testing.Platform.

## Remaining limitations

- No Windows, Visio, Word or WebView2 runtime was available (Q1 still open).
- .NET SDK 10.0.112 was used instead of the pinned 10.0.401 (Microsoft download host blocked).
- Timings are single samples from a headless container, not target-machine performance evidence.
