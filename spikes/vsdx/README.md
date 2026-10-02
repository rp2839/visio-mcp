# I01 — Editable native-file round-trip probe (G1)

Disposable probe. Not production code.

## Backend finding

OfficeIMO.Visio 3.4.4 (pinned in `docs/m0/dependencies.json`) emits shapes, User cells,
layer membership and `Connect` glue, but exposes **no picture / ForeignData API**.
`OfficeImoCapabilityIsRecorded` records this. The design says an exporter without images
cannot pass G1, so this probe evaluates the alternative it allows: a small **direct OPC/VSDX
writer and reader** (`ProbeScene.cs`) using only `System.IO.Compression` and `System.Xml.Linq`.
OfficeIMO stays useful as an independent parser: `docs/m0/evidence/G1/officeimo-crosscheck.txt`
shows OfficeIMO loading the generated file (4 shapes, 1 glued connector, AgentIds, no
validation issues).

## What the direct writer emits

| Feature | Native representation |
|---|---|
| Page 297×210 mm | `PageSheet` PageWidth/PageHeight (inches) |
| Rectangle, ellipse | Native Geometry rows (MoveTo/LineTo, Ellipse), fill/line cells, named N/E/S/W Connection rows |
| Text box | Separate shape, NoFill/NoLine geometry, `<Text>` |
| PNG picture | `Type="Foreign"` shape, `ForeignData` → `visio/media/image1.png` relationship; Img* cells |
| Connector | 1-D shape, ObjType 2, `_WALKGLUE` Begin/End formulas, `_XFTRIGGER` triggers, `Connects` (PinX/ToPart 3 = dynamic, `Connections.Xn`/ToPart 100+n = static port) |
| Identity | `User.AgentId` (STR) + `User.AgentNativeRef` (page:nativeId) for copy detection |
| Layer | PageSheet `Layer` row + `LayerMember` cell |
| SVG source | PNG derivative + inert `visio/media/source1.svg` via custom relationship, guarded by `User.AssetSha256`/`User.SvgSourceSha256` |
| Rotation | `Angle = -deg·π/180` about central LocPin |

## Commands and results (Linux, automated only)

```sh
dotnet test spikes/vsdx.tests/VsdxProbe.Tests.csproj     # red 9/9 on stubs → green 9/9
dotnet run --project spikes/vsdx -- --output docs/m0/evidence/G1/generated.vsdx
```

## Not yet established

No Visio or Word was available. Nothing here shows that Visio opens the file without a repair
prompt, that glue follows a moved shape, that User cells survive a Visio save, that the custom
SVG-source relationship survives a Visio save, or that Word activation works. Those checks are
in `docs/m0/evidence/G1/manual-checklist.md` and stay **NOT RUN**.
