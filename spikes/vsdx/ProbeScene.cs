using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;

namespace VsdxProbe;

/// <summary>
/// Direct OPC/VSDX writer and reader for the G1 probe scene. OfficeIMO.Visio 3.4.4 has
/// no picture API (see <see cref="OfficeImoCapabilities"/>), so this probe evaluates the
/// alternative backend the design permits: emitting the native parts directly.
/// Canonical units: points, top-left origin, clockwise degrees. Visio: inches,
/// bottom-left origin, counter-clockwise radians.
/// </summary>
public static class ProbeScene
{
    internal static readonly XNamespace V = "http://schemas.microsoft.com/office/visio/2012/main";
    internal static readonly XNamespace R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private static readonly XNamespace Pr = "http://schemas.openxmlformats.org/package/2006/relationships";
    private static readonly XNamespace Ct = "http://schemas.openxmlformats.org/package/2006/content-types";
    private const string ImageRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
    private const string SvgSourceRel = "http://schemas.agentic-diagram.invalid/relationships/svg-source";
    private static readonly Guid IdNamespace = Guid.Parse("4b0c9a52-5f0e-4c47-9d0c-2f6a0f1d7e11");
    private static readonly string[] PortNames = ["north", "east", "south", "west"];

    public static readonly byte[] SamplePng = TinyPng.Create(4, 4, (0x1F, 0x77, 0xB4));
    public static readonly byte[] AlternatePng = TinyPng.Create(4, 4, (0xD6, 0x27, 0x28));
    public static readonly string SamplePngSha256 = Sha256(SamplePng);
    public const string SampleSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 4 4\"><rect width=\"4\" height=\"4\" fill=\"#1F77B4\"/></svg>";

    public static ProbeSceneDto Default(Guid rectangleId)
    {
        const double mm = 72 / 25.4;
        var ellipse = Guid.Parse("a0000000-0000-4000-8000-000000000002");
        var text = Guid.Parse("a0000000-0000-4000-8000-000000000003");
        var picture = Guid.Parse("a0000000-0000-4000-8000-000000000004");
        var connector = Guid.Parse("a0000000-0000-4000-8000-000000000005");
        return new ProbeSceneDto(
            297 * mm, 210 * mm,
            [
                new(rectangleId, ProbeKind.Rectangle, 72, 72, 144, 72, "Probe", "#1F77B4"),
                new(ellipse, ProbeKind.Ellipse, 360, 72, 144, 72, "Target", "#FFFFFF"),
                new(text, ProbeKind.TextBox, 72, 216, 216, 36, "Independent text"),
                new(picture, ProbeKind.Picture, 360, 216, 72, 72),
            ],
            connector, rectangleId, ellipse,
            PictureBytes: SamplePng);
    }

    public static ProbeManifest Write(string path, ProbeSceneDto scene)
    {
        var png = scene.PictureBytes ?? SamplePng;
        var nativeIds = new Dictionary<Guid, int>();
        var next = 1;
        foreach (var e in scene.Elements) nativeIds[e.AgentId] = next++;
        nativeIds[scene.ConnectorId] = next++;

        var shapes = new XElement(V + "Shapes");
        foreach (var e in scene.Elements)
        {
            var rot = e.Kind == ProbeKind.Rectangle ? scene.RectangleRotationDeg : 0;
            shapes.Add(TwoDShape(scene, e, nativeIds[e.AgentId], rot, png));
        }
        var (connectorShape, connects) = Connector(scene, nativeIds);
        shapes.Add(connectorShape);

        var page = new XElement(V + "PageContents",
            new XAttribute(XNamespace.Xmlns + "r", R), new XAttribute(XNamespace.Xml + "space", "preserve"),
            shapes, connects);

        var pageRels = new List<(string Id, string Type, string Target)> { ("rId1", ImageRel, "../media/image1.png") };
        if (scene.SvgSource is not null) pageRels.Add(("rId2", SvgSourceRel, "../media/source1.svg"));

        using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
        {
            WriteXml(zip, "[Content_Types].xml", ContentTypes());
            WriteXml(zip, "_rels/.rels", Rels(("rId1", "http://schemas.microsoft.com/visio/2010/relationships/document", "visio/document.xml")));
            WriteXml(zip, "visio/document.xml", DocumentXml());
            WriteXml(zip, "visio/_rels/document.xml.rels", Rels(("rId1", "http://schemas.microsoft.com/visio/2010/relationships/pages", "pages/pages.xml")));
            WriteXml(zip, "visio/pages/pages.xml", PagesXml(scene));
            WriteXml(zip, "visio/pages/_rels/pages.xml.rels", Rels(("rId1", "http://schemas.microsoft.com/visio/2010/relationships/page", "page1.xml")));
            WriteXml(zip, "visio/pages/page1.xml", new XDocument(page));
            WriteXml(zip, "visio/pages/_rels/page1.xml.rels", Rels([.. pageRels]));
            WriteBytes(zip, "visio/media/image1.png", png);
            if (scene.SvgSource is not null) WriteBytes(zip, "visio/media/source1.svg", Encoding.UTF8.GetBytes(scene.SvgSource));
        }
        return Read(path);
    }

    private static XElement TwoDShape(ProbeSceneDto scene, ProbeElement e, int id, double rotationDeg, byte[] png)
    {
        double w = e.Width / 72, h = e.Height / 72;
        var shape = new XElement(V + "Shape",
            new XAttribute("ID", id),
            new XAttribute("NameU", e.Kind.ToString()), new XAttribute("Name", e.Kind.ToString()),
            new XAttribute("Type", e.Kind == ProbeKind.Picture ? "Foreign" : "Shape"),
            new XAttribute("LineStyle", 0), new XAttribute("FillStyle", 0), new XAttribute("TextStyle", 0),
            Cell("PinX", (e.X + e.Width / 2) / 72), Cell("PinY", (scene.PageHeightPt - e.Y - e.Height / 2) / 72),
            Cell("Width", w), Cell("Height", h), Cell("LocPinX", w / 2), Cell("LocPinY", h / 2),
            Cell("Angle", -rotationDeg * Math.PI / 180));

        switch (e.Kind)
        {
            case ProbeKind.Rectangle:
            case ProbeKind.Ellipse:
                shape.Add(Cell("LineWeight", 1.0 / 72), Cell("LineColor", "#000000"), Cell("LinePattern", 1),
                    Cell("FillForegnd", e.Fill ?? "#FFFFFF"), Cell("FillPattern", 1), Cell("ObjType", 1));
                break;
            case ProbeKind.TextBox:
                shape.Add(Cell("LinePattern", 0), Cell("FillPattern", 0), Cell("ObjType", 1));
                break;
            case ProbeKind.Picture:
                shape.Add(Cell("ImgOffsetX", 0), Cell("ImgOffsetY", 0), Cell("ImgWidth", w), Cell("ImgHeight", h),
                    Cell("LinePattern", 0), Cell("FillPattern", 0), Cell("ObjType", 1));
                break;
        }
        if (e.Kind == ProbeKind.Rectangle) shape.Add(Cell("LayerMember", "0"));

        var user = new XElement(V + "Section", new XAttribute("N", "User"),
            UserRow("AgentId", e.AgentId.ToString()),
            UserRow("AgentNativeRef", $"0:{id}"));
        if (e.Kind == ProbeKind.Picture)
        {
            user.Add(UserRow("AssetSha256", Sha256(png)));
            if (scene.SvgSource is not null) user.Add(UserRow("SvgSourceSha256", Sha256(Encoding.UTF8.GetBytes(scene.SvgSource))));
        }
        shape.Add(user);

        if (e.Kind is ProbeKind.Rectangle or ProbeKind.Ellipse)
        {
            // Static ports as named native connection rows (N, E, S, W) in local coordinates.
            var conn = new XElement(V + "Section", new XAttribute("N", "Connection"));
            (double X, double Y)[] pts = [(w / 2, h), (w, h / 2), (w / 2, 0), (0, h / 2)];
            for (var i = 0; i < 4; i++)
                conn.Add(new XElement(V + "Row", new XAttribute("T", "Connection"), new XAttribute("IX", i), new XAttribute("N", PortNames[i]),
                    Cell("X", pts[i].X), Cell("Y", pts[i].Y)));
            shape.Add(conn);
            shape.Add(Geometry(e.Kind, w, h));
        }
        if (e.Kind == ProbeKind.TextBox) shape.Add(Geometry(ProbeKind.Rectangle, w, h, noShow: true));
        if (e.Kind == ProbeKind.Picture)
            shape.Add(new XElement(V + "ForeignData", new XAttribute("ForeignType", "Bitmap"), new XAttribute("CompressionType", "PNG"),
                new XElement(V + "Rel", new XAttribute(R + "id", "rId1"))));
        if (e.Text is not null) shape.Add(new XElement(V + "Text", e.Text));
        return shape;
    }

    private static XElement Geometry(ProbeKind kind, double w, double h, bool noShow = false)
    {
        var g = new XElement(V + "Section", new XAttribute("N", "Geometry"), new XAttribute("IX", 0),
            Cell("NoFill", noShow ? 1 : 0), Cell("NoLine", noShow ? 1 : 0), Cell("NoShow", 0), Cell("NoSnap", 0));
        if (kind == ProbeKind.Ellipse)
        {
            g.Add(new XElement(V + "Row", new XAttribute("T", "Ellipse"), new XAttribute("IX", 1),
                Cell("X", w / 2), Cell("Y", h / 2), Cell("A", w), Cell("B", h / 2), Cell("C", w / 2), Cell("D", h)));
            return g;
        }
        (double, double)[] pts = [(0, 0), (w, 0), (w, h), (0, h), (0, 0)];
        for (var i = 0; i < pts.Length; i++)
            g.Add(new XElement(V + "Row", new XAttribute("T", i == 0 ? "MoveTo" : "LineTo"), new XAttribute("IX", i + 1),
                Cell("X", pts[i].Item1), Cell("Y", pts[i].Item2)));
        return g;
    }

    private static (XElement Shape, XElement Connects) Connector(ProbeSceneDto scene, Dictionary<Guid, int> ids)
    {
        var from = scene.Elements.Single(e => e.AgentId == scene.ConnectorFrom);
        var to = scene.Elements.Single(e => e.AgentId == scene.ConnectorTo);
        var (bx, by) = PortPoint(scene, from, scene.ConnectorFromPort, toward: to);
        var (ex, ey) = PortPoint(scene, to, scene.ConnectorToPort, toward: from);
        double dx = ex - bx, dy = ey - by, len = Math.Sqrt(dx * dx + dy * dy);
        int id = ids[scene.ConnectorId], fromId = ids[from.AgentId], toId = ids[to.AgentId];
        var walk = "_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)";
        var shape = new XElement(V + "Shape",
            new XAttribute("ID", id), new XAttribute("NameU", "Dynamic connector"), new XAttribute("Name", "Dynamic connector"),
            new XAttribute("Type", "Shape"), new XAttribute("LineStyle", 0), new XAttribute("FillStyle", 0), new XAttribute("TextStyle", 0),
            Cell("PinX", (bx + ex) / 2), Cell("PinY", (by + ey) / 2), Cell("Width", len), Cell("Height", 0),
            Cell("LocPinX", len / 2), Cell("LocPinY", 0), Cell("Angle", Math.Atan2(dy, dx)),
            Cell("BeginX", bx, walk), Cell("BeginY", by, walk), Cell("EndX", ex, walk), Cell("EndY", ey, walk),
            Cell("BegTrigger", 2, $"_XFTRIGGER(Sheet.{fromId}!EventXFMod)"),
            Cell("EndTrigger", 2, $"_XFTRIGGER(Sheet.{toId}!EventXFMod)"),
            Cell("ObjType", 2), Cell("ShapeRouteStyle", 16), Cell("ConFixedCode", 0), Cell("GlueType", 0),
            Cell("LineWeight", 1.0 / 72), Cell("LineColor", "#333333"), Cell("LinePattern", 1), Cell("EndArrow", 13),
            new XElement(V + "Section", new XAttribute("N", "User"),
                UserRow("AgentId", scene.ConnectorId.ToString()),
                UserRow("AgentNativeRef", $"0:{id}"),
                UserRow("AgentFromPort", scene.ConnectorFromPort ?? ""),
                UserRow("AgentToPort", scene.ConnectorToPort ?? "")),
            new XElement(V + "Section", new XAttribute("N", "Geometry"), new XAttribute("IX", 0),
                new XElement(V + "Row", new XAttribute("T", "MoveTo"), new XAttribute("IX", 1), Cell("X", 0), Cell("Y", 0)),
                new XElement(V + "Row", new XAttribute("T", "LineTo"), new XAttribute("IX", 2), Cell("X", len), Cell("Y", 0))));
        var connects = new XElement(V + "Connects",
            Connect(id, "BeginX", fromId, scene.ConnectorFromPort),
            Connect(id, "EndX", toId, scene.ConnectorToPort));
        return (shape, connects);
    }

    private static XElement Connect(int fromSheet, string fromCell, int toSheet, string? port)
    {
        var portIx = port is null ? -1 : Array.IndexOf(PortNames, port);
        return new XElement(V + "Connect",
            new XAttribute("FromSheet", fromSheet), new XAttribute("FromCell", fromCell),
            new XAttribute("FromPart", fromCell == "BeginX" ? 9 : 12),
            new XAttribute("ToSheet", toSheet),
            // Dynamic glue: whole shape (PinX, ToPart 3). Static: connection row X{IX+1} (ToPart 100+IX).
            new XAttribute("ToCell", portIx < 0 ? "PinX" : $"Connections.X{portIx + 1}"),
            new XAttribute("ToPart", portIx < 0 ? 3 : 100 + portIx));
    }

    private static (double X, double Y) PortPoint(ProbeSceneDto scene, ProbeElement e, string? port, ProbeElement toward)
    {
        double cx = (e.X + e.Width / 2) / 72, cy = (scene.PageHeightPt - e.Y - e.Height / 2) / 72;
        double hw = e.Width / 144, hh = e.Height / 144;
        port ??= Math.Abs(toward.X - e.X) >= Math.Abs(toward.Y - e.Y)
            ? (toward.X > e.X ? "east" : "west")
            : (toward.Y > e.Y ? "south" : "north");
        return port switch
        {
            "north" => (cx, cy + hh),
            "south" => (cx, cy - hh),
            "east" => (cx + hw, cy),
            _ => (cx - hw, cy),
        };
    }

    public static ProbeManifest Read(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        var m = new ProbeManifest();
        var pages = LoadXml(zip, "visio/pages/pages.xml");
        var pageSheet = pages.Root!.Element(V + "Page")!.Element(V + "PageSheet")!;
        m.PageWidthPt = CellValue(pageSheet, "PageWidth") * 72;
        m.PageHeightPt = CellValue(pageSheet, "PageHeight") * 72;
        var layerNames = pageSheet.Elements(V + "Section").Where(s => (string?)s.Attribute("N") == "Layer")
            .Elements(V + "Row").ToDictionary(r => (string)r.Attribute("IX")!, r => CellString(r, "Name") ?? "");

        var page = LoadXml(zip, "visio/pages/page1.xml");
        var rels = LoadXml(zip, "visio/pages/_rels/page1.xml.rels").Root!.Elements(Pr + "Relationship")
            .ToDictionary(r => (string)r.Attribute("Id")!, r => (Type: (string)r.Attribute("Type")!, Target: (string)r.Attribute("Target")!));
        var shapes = page.Root!.Element(V + "Shapes")!.Elements(V + "Shape").ToList();
        m.HasPageBitmap = shapes.Count == 1 && (string?)shapes[0].Attribute("Type") == "Foreign";

        // Identity: keep one valid AgentId; regenerate copies (Visio copy/paste duplicates User cells).
        var seen = new Dictionary<Guid, XElement>();
        var identities = new Dictionary<string, Guid>();
        foreach (var s in shapes.OrderBy(s => NativeRefMatches(s) ? 0 : 1).ThenBy(s => int.Parse((string)s.Attribute("ID")!)))
        {
            var nativeId = (string)s.Attribute("ID")!;
            var raw = UserValue(s, "AgentId");
            if (Guid.TryParse(raw, out var agentId) && seen.TryAdd(agentId, s))
            {
                identities[nativeId] = agentId;
                continue;
            }
            var regenerated = UuidV5(IdNamespace, $"page:0/shape:{nativeId}");
            identities[nativeId] = regenerated;
            m.Diagnostics.Add(new("warning", raw is null ? "missing_agent_id" : "duplicate_agent_id", "regenerated",
                $"shape {nativeId} received {regenerated}"));
        }
        m.AgentIds.AddRange(shapes.Select(s => identities[(string)s.Attribute("ID")!]));
        m.DrawableCount = shapes.Count;

        foreach (var s in shapes)
        {
            var nativeId = (string)s.Attribute("ID")!;
            var agentId = identities[nativeId];
            var nameU = (string?)s.Attribute("NameU");
            if (CellOrNull(s, "BeginX") is null)
            {
                double w = CellValue(s, "Width") * 72, h = CellValue(s, "Height") * 72;
                double x = (CellValue(s, "PinX") - CellValue(s, "LocPinX")) * 72;
                double top = (CellValue(s, "PinY") - CellValue(s, "LocPinY")) * 72 + h;
                m.Bounds[agentId] = new ProbeBounds(x, m.PageHeightPt - top, w, h);
            }
            if (nameU == "Rectangle" && NativeRefMatches(s))
            {
                m.RectangleId = nativeId;
                m.RectangleAgentId = agentId;
                m.RectangleText = (string?)s.Element(V + "Text") ?? "";
                m.RectangleFill = CellString(s, "FillForegnd");
                m.RectangleRotationDeg = -CellValue(s, "Angle") * 180 / Math.PI;
                foreach (var ix in (CellString(s, "LayerMember") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
                    if (layerNames.TryGetValue(ix, out var n)) m.RectangleLayers.Add(n);
            }
            if (nameU == "Ellipse") m.EllipseId = nativeId;
            if ((string?)s.Attribute("Type") == "Foreign")
            {
                var relId = (string)s.Element(V + "ForeignData")!.Element(V + "Rel")!.Attribute(R + "id")!;
                var bytes = ReadEntry(zip, Resolve("visio/pages/", rels[relId].Target));
                m.ImageHash = Sha256(bytes);
                var recorded = UserValue(s, "AssetSha256");
                var svgHash = UserValue(s, "SvgSourceSha256");
                if (recorded is not null && recorded != m.ImageHash)
                    m.Diagnostics.Add(new("warning", "stale_image_provenance", "dropped",
                        $"shape {nativeId} picture bytes changed since export; app SVG source and asset metadata ignored"));
                else if (svgHash is not null)
                {
                    var svgRel = rels.Values.FirstOrDefault(r => r.Type == SvgSourceRel);
                    var svg = svgRel.Target is null ? null : Encoding.UTF8.GetString(ReadEntry(zip, Resolve("visio/pages/", svgRel.Target)));
                    if (svg is not null && Sha256(Encoding.UTF8.GetBytes(svg)) == svgHash)
                    {
                        m.PreservedSvgSource = svg;
                        m.Diagnostics.Add(new("info", "svg_rasterised", "approximated",
                            $"shape {nativeId} is a PNG derivative; standalone SVG source preserved in package"));
                    }
                    else m.Diagnostics.Add(new("warning", "svg_source_missing", "dropped", $"shape {nativeId}"));
                }
            }
        }

        foreach (var c in page.Root!.Element(V + "Connects")?.Elements(V + "Connect") ?? [])
        {
            var toCell = (string)c.Attribute("ToCell")!;
            var toSheet = (string)c.Attribute("ToSheet")!;
            var target = shapes.Single(s => (string)s.Attribute("ID")! == toSheet);
            string? port = null;
            if (toCell.StartsWith("Connections.X"))
            {
                var ix = int.Parse(toCell["Connections.X".Length..]) - 1;
                port = target.Elements(V + "Section").Where(x => (string?)x.Attribute("N") == "Connection")
                    .Elements(V + "Row").Select(r => (string?)r.Attribute("N")).ElementAtOrDefault(ix);
            }
            if ((string)c.Attribute("FromCell")! == "BeginX") { m.ConnectorFromShapeId = toSheet; m.ConnectorFromPort = port; }
            else { m.ConnectorToShapeId = toSheet; m.ConnectorToPort = port; }
        }
        return m;
    }

    public static double ReadCell(string path, string shapeId, string cell)
    {
        using var zip = ZipFile.OpenRead(path);
        var shape = LoadXml(zip, "visio/pages/page1.xml").Root!.Element(V + "Shapes")!.Elements(V + "Shape")
            .Single(s => (string)s.Attribute("ID")! == shapeId);
        return CellValue(shape, cell);
    }

    /// <summary>Emulates Visio copy/paste: a new native ID with the User cells copied verbatim.</summary>
    public static void SimulateVisioCopyPaste(string path, Guid agentId)
    {
        using var zip = ZipFile.Open(path, ZipArchiveMode.Update);
        var doc = LoadXml(zip, "visio/pages/page1.xml");
        var shapes = doc.Root!.Element(V + "Shapes")!;
        var original = shapes.Elements(V + "Shape").Single(s => UserValue(s, "AgentId") == agentId.ToString());
        var copy = new XElement(original);
        var newId = shapes.Elements(V + "Shape").Max(s => int.Parse((string)s.Attribute("ID")!)) + 1;
        copy.SetAttributeValue("ID", newId);
        copy.SetAttributeValue("NameU", "Rectangle.copy");
        var pinX = copy.Elements(V + "Cell").Single(c => (string?)c.Attribute("N") == "PinX");
        pinX.SetAttributeValue("V", Fmt(double.Parse((string)pinX.Attribute("V")!, CultureInfo.InvariantCulture) + 0.5));
        shapes.AddFirst(copy); // a copy can precede the original in source order
        zip.GetEntry("visio/pages/page1.xml")!.Delete();
        WriteXml(zip, "visio/pages/page1.xml", doc);
    }

    /// <summary>Emulates Visio "Change Picture": new bytes, stale app User cells retained.</summary>
    public static void ReplacePictureBytes(string path, byte[] png)
    {
        using var zip = ZipFile.Open(path, ZipArchiveMode.Update);
        zip.GetEntry("visio/media/image1.png")!.Delete();
        WriteBytes(zip, "visio/media/image1.png", png);
    }

    private static bool NativeRefMatches(XElement s) => UserValue(s, "AgentNativeRef") == $"0:{(string)s.Attribute("ID")!}";

    private static XDocument PagesXml(ProbeSceneDto scene) => new(new XElement(V + "Pages",
        new XAttribute(XNamespace.Xmlns + "r", R),
        new XElement(V + "Page", new XAttribute("ID", 0), new XAttribute("NameU", "Page-1"), new XAttribute("Name", "Page-1"),
            new XElement(V + "PageSheet",
                new XAttribute("LineStyle", 0), new XAttribute("FillStyle", 0), new XAttribute("TextStyle", 0),
                Cell("PageWidth", scene.PageWidthPt / 72), Cell("PageHeight", scene.PageHeightPt / 72),
                Cell("PageScale", 1), Cell("DrawingScale", 1), Cell("DrawingSizeType", 0), Cell("DrawingScaleType", 0),
                new XElement(V + "Section", new XAttribute("N", "User"), UserRow("AgentPageId", "b0000000-0000-4000-8000-000000000001")),
                new XElement(V + "Section", new XAttribute("N", "Layer"),
                    new XElement(V + "Row", new XAttribute("IX", 0),
                        Cell("Name", scene.LayerName), Cell("Color", 255), Cell("Status", 0), Cell("Visible", 1),
                        Cell("Print", 1), Cell("Active", 0), Cell("Lock", 0), Cell("Snap", 1), Cell("Glue", 1)))),
            new XElement(V + "Rel", new XAttribute(R + "id", "rId1")))));

    private static XDocument DocumentXml() => new(new XElement(V + "VisioDocument",
        new XAttribute(XNamespace.Xmlns + "r", R), new XAttribute(XNamespace.Xml + "space", "preserve"),
        new XElement(V + "DocumentSettings", new XAttribute("TopPage", 0), new XAttribute("DefaultTextStyle", 0),
            new XAttribute("DefaultLineStyle", 0), new XAttribute("DefaultFillStyle", 0), new XAttribute("DefaultGuideStyle", 0),
            new XElement(V + "GlueSettings", 9), new XElement(V + "SnapSettings", 65847), new XElement(V + "SnapExtensions", 34),
            new XElement(V + "DynamicGridEnabled", 1), new XElement(V + "ProtectStyles", 0), new XElement(V + "ProtectShapes", 0),
            new XElement(V + "ProtectMasters", 0), new XElement(V + "ProtectBkgnds", 0)),
        new XElement(V + "Colors", new XElement(V + "ColorEntry", new XAttribute("IX", 0), new XAttribute("RGB", "#000000"))),
        new XElement(V + "FaceNames", new XElement(V + "FaceName", new XAttribute("NameU", "Calibri"), new XAttribute("UnicodeRanges", "-536859905 -1073732485 9 0"), new XAttribute("CharSets", "536871423 0"), new XAttribute("Panose", "2 15 5 2 2 2 4 3 2 4"), new XAttribute("Flags", 325))),
        new XElement(V + "StyleSheets", new XElement(V + "StyleSheet", new XAttribute("ID", 0), new XAttribute("NameU", "No Style"), new XAttribute("Name", "No Style"),
            Cell("EnableLineProps", 1), Cell("EnableFillProps", 1), Cell("EnableTextProps", 1), Cell("HideForApply", 0),
            Cell("LineWeight", 0.01041666666666667), Cell("LineColor", 0), Cell("LinePattern", 1), Cell("Rounding", 0),
            Cell("EndArrowSize", 2), Cell("BeginArrow", 0), Cell("EndArrow", 0), Cell("LineCap", 0), Cell("BeginArrowSize", 2),
            Cell("FillForegnd", 1), Cell("FillBkgnd", 0), Cell("FillPattern", 1), Cell("ShdwForegnd", 0), Cell("ShdwPattern", 0),
            Cell("LeftMargin", 0.05555555555555555), Cell("RightMargin", 0.05555555555555555), Cell("TopMargin", 0.05555555555555555),
            Cell("BottomMargin", 0.05555555555555555), Cell("VerticalAlign", 1), Cell("TextBkgnd", 0),
            new XElement(V + "Section", new XAttribute("N", "Character"), new XElement(V + "Row", new XAttribute("IX", 0),
                Cell("Font", 0), Cell("Color", 0), Cell("Style", 0), Cell("Size", 0.1666666666666667))),
            new XElement(V + "Section", new XAttribute("N", "Paragraph"), new XElement(V + "Row", new XAttribute("IX", 0),
                Cell("HorzAlign", 1)))))));

    private static XDocument ContentTypes() => new(new XElement(Ct + "Types",
        new XElement(Ct + "Default", new XAttribute("Extension", "rels"), new XAttribute("ContentType", "application/vnd.openxmlformats-package.relationships+xml")),
        new XElement(Ct + "Default", new XAttribute("Extension", "xml"), new XAttribute("ContentType", "application/xml")),
        new XElement(Ct + "Default", new XAttribute("Extension", "png"), new XAttribute("ContentType", "image/png")),
        new XElement(Ct + "Default", new XAttribute("Extension", "svg"), new XAttribute("ContentType", "image/svg+xml")),
        new XElement(Ct + "Override", new XAttribute("PartName", "/visio/document.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.drawing.main+xml")),
        new XElement(Ct + "Override", new XAttribute("PartName", "/visio/pages/pages.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.pages+xml")),
        new XElement(Ct + "Override", new XAttribute("PartName", "/visio/pages/page1.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.page+xml"))));

    private static XDocument Rels(params (string Id, string Type, string Target)[] rels) => new(new XElement(Pr + "Relationships",
        rels.Select(r => new XElement(Pr + "Relationship", new XAttribute("Id", r.Id), new XAttribute("Type", r.Type), new XAttribute("Target", r.Target)))));

    internal static XElement Cell(string n, object v, string? formula = null)
    {
        var e = new XElement(V + "Cell", new XAttribute("N", n), new XAttribute("V", v is double d ? Fmt(d) : Convert.ToString(v, CultureInfo.InvariantCulture)!));
        if (formula is not null) e.Add(new XAttribute("F", formula));
        return e;
    }

    private static XElement UserRow(string name, string value) => new(V + "Row", new XAttribute("N", name),
        new XElement(V + "Cell", new XAttribute("N", "Value"), new XAttribute("V", value), new XAttribute("U", "STR"),
            new XAttribute("F", "\"" + value.Replace("\"", "\"\"") + "\"")));

    private static string? UserValue(XElement shape, string name) => shape.Elements(V + "Section")
        .Where(s => (string?)s.Attribute("N") == "User").Elements(V + "Row")
        .FirstOrDefault(r => (string?)r.Attribute("N") == name)?.Elements(V + "Cell")
        .FirstOrDefault(c => (string?)c.Attribute("N") == "Value")?.Attribute("V")?.Value;

    private static XElement? CellOrNull(XElement parent, string n) => parent.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == n);
    private static string? CellString(XElement parent, string n) => (string?)CellOrNull(parent, n)?.Attribute("V");
    private static double CellValue(XElement parent, string n) => double.Parse(CellString(parent, n) ?? throw new InvalidDataException($"missing cell {n}"), CultureInfo.InvariantCulture);

    private static string Fmt(double d) => d.ToString("R", CultureInfo.InvariantCulture);
    private static string Resolve(string baseDir, string target) => Path.GetFullPath("/" + baseDir + target).TrimStart('/').Replace('\\', '/');
    public static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static XDocument LoadXml(ZipArchive zip, string name)
    {
        using var s = zip.GetEntry(name)!.Open();
        return XDocument.Load(s);
    }

    private static byte[] ReadEntry(ZipArchive zip, string name)
    {
        using var s = zip.GetEntry(name)!.Open();
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    private static void WriteXml(ZipArchive zip, string name, XDocument doc)
    {
        using var s = zip.CreateEntry(name, CompressionLevel.Optimal).Open();
        doc.Declaration = new XDeclaration("1.0", "utf-8", "yes");
        doc.Save(s, SaveOptions.DisableFormatting);
    }

    private static void WriteBytes(ZipArchive zip, string name, byte[] bytes)
    {
        using var s = zip.CreateEntry(name, CompressionLevel.Optimal).Open();
        s.Write(bytes);
    }

    internal static Guid UuidV5(Guid ns, string name)
    {
        var nsBytes = ns.ToByteArray(bigEndian: true);
        var hash = SHA1.HashData([.. nsBytes, .. Encoding.UTF8.GetBytes(name)]);
        var b = hash[..16];
        b[6] = (byte)((b[6] & 0x0F) | 0x50);
        b[8] = (byte)((b[8] & 0x3F) | 0x80);
        return new Guid(b, bigEndian: true);
    }
}
