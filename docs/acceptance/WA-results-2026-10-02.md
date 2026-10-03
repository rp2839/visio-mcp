# WA results: 2026-10-02 / 03

## First Windows run (tester report, Visio 16.0.20430, branch at 9ee9d08)

Not a full checklist run. These are the observations reported back, and the fixes made in response.
The fixes have **not** been re-run in Visio yet.

| Finding | Scenario | Observed | Fix | Re-run in Visio |
|---|---|---|---|---|
| Every exported `.vsdx`, including `tests/fixtures/vsdx/app-authored/scene.vsdx`, fails to open with error 271 ("some parts are missing or invalid") | WA-01/WA-02 | **FAIL** | The exporter now writes `visio/windows.xml` plus its relationship and content type. The tester confirmed by hand that adding these makes an exported file open. Regenerated fixture. | NOT RUN |
| The fixture JPEG (a 23-byte header stub) crashes Visio (RPC_E_SERVERFAULT) | WA-05 input | **FAIL** | `Scene.Bytes.Jpeg()` is now a real 64×32 baseline JPEG, checked by `FixtureJpegIsAFullyEncodedBaselineJpeg`; ImageMagick decodes all fixture pictures | NOT RUN |
| Stencil diagram (Circle/Cloud/Pentagon masters, 92 shapes) imports ellipses, clouds and pentagons as rectangles: partial local Geometry sections replaced the master's | import of a Visio-saved file | **FAIL** | Local cells and rows now merge over the master's (`SheetInheritance`); NURBSTo/PolylineTo are evaluated | NOT RUN |
| Theme/QuickStyle and style-sheet colours are not resolved; shapes import white and white text is invisible | import of a Visio-saved file | **FAIL** | Style-sheet chains plus theme colours by QuickStyle index (`ThemeColours`) | NOT RUN |
| ShapeRouteStyle=16 + ConLineRouteExt=1 imports as orthogonal | import of a Visio-saved file | **FAIL** | Route rule: 2, or 0/16 with ConLineRouteExt=1, is straight | NOT RUN |

The import fixes are tested against a synthetic Visio-shaped package (`tests/Diagram.Visio.Tests/VisioAuthored.cs`),
not the tester's 92-shape file, which is not in the repository. Adding that file, or a reduced
copy, under `tests/fixtures/vsdx/visio-saved/` would turn these into regression tests on real Visio output.

## All other scenarios

WA-03, WA-04 and WA-06 … WA-12: **NOT RUN**. Run `visio-word-checklist.md` on the regenerated fixture.
