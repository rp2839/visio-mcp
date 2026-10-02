# M0 go/no-go decision

Date: 2026-10-02.

## Gate status: **NOT PASSED**

The plan allows M1 only when G1–G4 all PASS, including desktop Visio/Word acceptance. G1 and G3
are PARTIAL and G4 is NOT RUN, because no Windows/Office environment exists yet (Q1). This is not
a PASS.

## Backend decision (provisional)

- **VSDX export/import: direct OPC writer/reader** (I01 `ProbeScene` approach), behind
  `IVsdxExporter`/`IVsdxImporter`. OfficeIMO.Visio is kept as an independent parser for tests,
  not as the exporter, because it has no picture support. Visio acceptance of the direct writer is
  still unproven.
- Canvas: maxGraph 0.24.0 with the interaction constraints in [results.md](results.md).
- MCP: official C# SDK 2.2.0 stdio shim + 4-byte LE framed named pipe.
- Host: WPF + WebView2 1.0.4258.31 with the exact-origin, message-only bridge.

## How production work proceeds

The user asked for the whole project to be built ("run through the implementation tasks in order
and build the project according to the design"). Production packages I10–I52 therefore go ahead
on the parts that can be built and tested on Linux, recorded as **provisional**:

- Nothing is marked as Windows/Visio/Word accepted. I05, I41 and every Windows-only test stay
  NOT RUN until the Q1 machine runs them.
- A G1/G4 failure on Windows may force changes to the VSDX mapping (I40) or the host shell
  (I11/I30). The design already isolates these behind adapters, so the canonical engine, editor
  and script packages should not need changes.

To clear the gate, run `docs/m0/evidence/G1/manual-checklist.md` and the G4 steps in
`spikes/webview/README.md` on Windows, then update this file.
