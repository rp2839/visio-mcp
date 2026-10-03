using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Xml.Linq;
using Diagram.Core.Contracts;
using Diagram.Visio.Abstractions;
using static Diagram.Visio.Vx;

namespace Diagram.Visio;

/// <summary>
/// Stateless exporter: one revision-matched ExportSnapshot → editable VSDX. Native geometry rows,
/// independent foreign-data pictures, 1-D connectors with glue formulas and Connects, User-cell
/// identity, layers and locks. Never rasterises the page. Self-reopens the package to verify
/// counts, identities and references before returning it.
/// </summary>
public sealed class DirectVsdxExporter : IVsdxExporter
{
    public static readonly string[] PortOrder = ["north", "east", "south", "west"];
    public static readonly Dictionary<string, (double U, double V)> DefaultPorts = new()
    {
        ["north"] = (0.5, 0), ["east"] = (1, 0.5), ["south"] = (0.5, 1), ["west"] = (0, 0.5),
    };
    internal static readonly Dictionary<string, int> ArrowCodes = new() { ["none"] = 0, ["open"] = 1, ["triangle"] = 4, ["circle"] = 20, ["diamond"] = 22 };
    internal static readonly Dictionary<string, int> DashCodes = new() { ["solid"] = 1, ["dash"] = 2, ["dot"] = 3, ["dashDot"] = 4 };

    private sealed class PageCtx
    {
        public required Page Page { get; init; }
        public required Projection Projection { get; init; }
        public Dictionary<string, Element> ById { get; } = new();
        public Dictionary<string, string> ParentOf { get; } = new();
        public Dictionary<string, int> NativeId { get; } = new();
        public List<(string Id, string Type, string Target)> Rels { get; } = [];
        public List<XElement> Connects { get; } = [];
        public required int PageIndex { get; init; }
    }

    private readonly List<Diagnostic> diagnostics = [];
    private readonly Dictionary<string, string> nativeIds = new();
    private readonly Dictionary<string, (string Part, string Ext)> media = new(); // sha → part
    private readonly HashSet<string> written = new(StringComparer.Ordinal);
    private readonly List<string> fonts = ["Calibri"];
    private ZipArchive zip = null!;

    public async Task<ExportResult> ExportAsync(ExportSnapshot snapshot, IAssetBlobSource blobs, ExportOptions options, CancellationToken ct)
    {
        if (snapshot.Projection.Revision != snapshot.Revision || snapshot.Projection.SessionId != snapshot.SessionId || snapshot.Projection.DocumentId != snapshot.DocumentId)
            throw new VsdxException("projection_failed", "projection sidecar does not match the snapshot revision/scope");
        diagnostics.Clear(); nativeIds.Clear(); media.Clear();
        var doc = snapshot.Document;
        using var ms = new MemoryStream();
        using (zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            var pageEntries = new List<XElement>();
            var pageRels = new List<(string, string, string)>();
            for (var i = 0; i < doc.Pages.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var page = doc.Pages[i];
                var ctx = new PageCtx { Page = page, Projection = snapshot.Projection, PageIndex = i };
                foreach (var e in page.Elements) ctx.ById[e.Id()] = e;
                foreach (var g in page.Elements.OfType<GroupElement>()) foreach (var c in g.ChildIds) ctx.ParentOf[c] = g.Id;
                var shapes = await PageShapesAsync(ctx, doc, blobs, ct);
                var pageDoc = new XDocument(new XElement(V + "PageContents", new XAttribute(XNamespace.Xmlns + "r", R), new XAttribute(XNamespace.Xml + "space", "preserve"),
                    new XElement(V + "Shapes", shapes), ctx.Connects.Count > 0 ? new XElement(V + "Connects", ctx.Connects) : null));
                Write(zip, $"visio/pages/page{i + 1}.xml", pageDoc);
                Write(zip, $"visio/pages/_rels/page{i + 1}.xml.rels", Rels(ctx.Rels));
                pageEntries.Add(PageEntry(page, i));
                pageRels.Add(($"rId{i + 1}", RelPage, $"page{i + 1}.xml"));
            }
            Write(zip, "visio/pages/pages.xml", new XDocument(new XElement(V + "Pages", new XAttribute(XNamespace.Xmlns + "r", R), pageEntries)));
            Write(zip, "visio/pages/_rels/pages.xml.rels", Rels(pageRels));
            Write(zip, "visio/document.xml", DocumentXml(doc));
            // Visio 16 refuses a package without a windows part (error 271), even an empty one.
            Write(zip, "visio/windows.xml", new XDocument(new XElement(V + "Windows", new XAttribute(XNamespace.Xmlns + "r", R))));
            Write(zip, "visio/_rels/document.xml.rels", Rels([("rId1", RelPages, "pages/pages.xml"), ("rId2", RelWindows, "windows.xml")]));
            Write(zip, "docProps/core.xml", CoreXml(doc));
            Write(zip, "docProps/app.xml", new XDocument(new XElement(XNamespace.Get("http://schemas.openxmlformats.org/officeDocument/2006/extended-properties") + "Properties",
                new XElement(XNamespace.Get("http://schemas.openxmlformats.org/officeDocument/2006/extended-properties") + "Application", "Agentic Diagram"))));
            Write(zip, "_rels/.rels", Rels([("rId1", RelDocument, "visio/document.xml"), ("rId2", RelCore, "docProps/core.xml"), ("rId3", RelApp, "docProps/app.xml")]));
            Write(zip, "[Content_Types].xml", ContentTypes(doc.Pages.Count));
        }
        var bytes = ms.ToArray();
        if (options.SelfCheck) await SelfCheckAsync(snapshot, bytes, ct);
        return new ExportResult(bytes, [.. diagnostics], new Dictionary<string, string>(nativeIds));
    }

    private void Diag(string severity, string code, string action, string detail, string? elementId = null, string? pageId = null) =>
        diagnostics.Add(new Diagnostic { Severity = severity, Code = code, Action = action, Detail = detail, ElementId = elementId, PageId = pageId });

    // ---------------- pages ----------------
    private XElement PageEntry(Page page, int index)
    {
        var layerIds = JsonSerializer.Serialize(page.Layers.Select(l => l.Id));
        var sheet = new XElement(V + "PageSheet", new XAttribute("LineStyle", 0), new XAttribute("FillStyle", 0), new XAttribute("TextStyle", 0),
            Cell("PageWidth", In(page.WidthPt)), Cell("PageHeight", In(page.HeightPt)), Cell("PageScale", 1.0), Cell("DrawingScale", 1.0),
            Cell("DrawingSizeType", 0), Cell("DrawingScaleType", 0), Cell("XGridSpacing", In(page.Grid.SpacingPt)), Cell("YGridSpacing", In(page.Grid.SpacingPt)),
            Section("User", UserRow("AgentPageId", page.Id), UserRow("AgentLayerIds", layerIds),
                UserRow("AgentGrid", JsonSerializer.Serialize(page.Grid, ContractJson.Options)), UserRow("AgentBackground", page.Background),
                UserRow("AgentGuides", JsonSerializer.Serialize(page.Guides, ContractJson.Options))));
        if (page.Layers.Count > 0)
            sheet.Add(Section("Layer", page.Layers.Select((l, ix) => new XElement(V + "Row", new XAttribute("IX", ix),
                Cell("Name", l.Name), Cell("Color", 255), Cell("Status", 0), Cell("Visible", l.Visible), Cell("Print", l.Printable),
                Cell("Active", 0), Cell("Lock", l.Locked), Cell("Snap", l.Snap), Cell("Glue", l.Glue), Cell("ColorTrans", 0.0)))));
        if (page.Guides.Count > 0) Diag("info", "guides_metadata", "approximated", $"{page.Guides.Count} guide(s) kept as app metadata, not Visio guide shapes", pageId: page.Id);
        if (page.Background is not "#FFFFFF" and not "none") Diag("info", "page_background", "approximated", "page background colour kept as app metadata", pageId: page.Id);
        return new XElement(V + "Page", new XAttribute("ID", index), new XAttribute("NameU", page.Name), new XAttribute("Name", page.Name), sheet,
            new XElement(V + "Rel", new XAttribute(R + "id", $"rId{index + 1}")));
    }

    private async Task<List<XElement>> PageShapesAsync(PageCtx ctx, DiagramDocument doc, IAssetBlobSource blobs, CancellationToken ct)
    {
        // Deterministic native IDs in canonical z-order, allocated before emission so
        // connectors can reference later shapes.
        var next = 1;
        foreach (var e in ctx.Page.Elements.OrderBy(e => e.ZIndex())) ctx.NativeId[e.Id()] = next++;
        foreach (var (id, n) in ctx.NativeId) nativeIds[id] = $"{ctx.PageIndex}:{n}";
        var top = ctx.Page.Elements.Where(e => !ctx.ParentOf.ContainsKey(e.Id())).OrderBy(e => e.ZIndex()).ToList();
        var frame = new Frame(0, 0, ctx.Page.HeightPt);
        var result = new List<XElement>();
        foreach (var e in top) result.Add(await ShapeAsync(ctx, e, frame, doc, blobs, ct));
        // Visio cannot interleave other shapes between a group's children.
        foreach (var g in ctx.Page.Elements.OfType<GroupElement>())
        {
            var zs = g.ChildIds.Select(c => ctx.ById[c].ZIndex()).Order().ToList();
            var between = ctx.Page.Elements.Count(e => !g.ChildIds.Contains(e.Id()) && e.Id() != g.Id && e.ZIndex() > zs[0] && e.ZIndex() < zs[^1]);
            if (between > 0) Diag("warning", "group_z_order", "approximated", $"group {g.Id}: {between} non-member shape(s) interleaved with members are stacked outside the group", g.Id, ctx.Page.Id);
        }
        return result;
    }

    /// <summary>Parent coordinate frame: origin (page pt) of the parent's local bottom-left, and its height.</summary>
    private readonly record struct Frame(double OriginX, double OriginTopY, double HeightPt)
    {
        public double LocalX(double pageX) => In(pageX - OriginX);
        public double LocalY(double pageY) => In(OriginTopY + HeightPt - pageY);
    }

    private static string PresetOf(Element e) => e switch { ShapeElement s => s.Geometry.Preset ?? "rectangle", _ => "rectangle" };

    private XElement BaseShape(PageCtx ctx, Element e, Bounds b, double rotationDeg, Frame frame, string type)
    {
        double w = In(b.Width), h = In(b.Height);
        var shape = new XElement(V + "Shape", new XAttribute("ID", ctx.NativeId[e.Id()]), new XAttribute("Type", type),
            new XAttribute("NameU", $"{e.Kind()}.{ctx.NativeId[e.Id()]}"), new XAttribute("Name", NameOf(e) ?? $"{e.Kind()}.{ctx.NativeId[e.Id()]}"),
            new XAttribute("LineStyle", 0), new XAttribute("FillStyle", 0), new XAttribute("TextStyle", 0),
            Cell("PinX", frame.LocalX(b.X + b.Width / 2)), Cell("PinY", frame.LocalY(b.Y + b.Height / 2)),
            Cell("Width", w), Cell("Height", h), Cell("LocPinX", w / 2), Cell("LocPinY", h / 2),
            Cell("Angle", -rotationDeg * Math.PI / 180), Cell("FlipX", 0), Cell("FlipY", 0), Cell("ObjType", type == "Group" ? 8 : 1));
        if (LayerMember(ctx, e) is { } lm) shape.Add(Cell("LayerMember", lm));
        if (Locked(e)) shape.Add(Cell("LockMoveX", 1), Cell("LockMoveY", 1), Cell("LockWidth", 1), Cell("LockHeight", 1), Cell("LockRotate", 1), Cell("LockDelete", 1), Cell("LockTextEdit", 1), Cell("LockFormat", 1));
        if (Hidden(e)) shape.Add(Cell("HideText", 1));
        return shape;
    }

    private static string? NameOf(Element e) => e switch { ShapeElement s => s.Name, TextElement t => t.Name, ImageElement i => i.Name, ConnectorElement c => c.Name, GroupElement g => g.Name, _ => null };
    private static string? AliasOf(Element e) => e switch { ShapeElement s => s.Alias, TextElement t => t.Alias, ImageElement i => i.Alias, ConnectorElement c => c.Alias, GroupElement g => g.Alias, _ => null };
    private static bool Locked(Element e) => e switch { ShapeElement s => s.Locked, TextElement t => t.Locked, ImageElement i => i.Locked, ConnectorElement c => c.Locked, GroupElement g => g.Locked, _ => false };
    private static bool Hidden(Element e) => e switch { ShapeElement s => s.Hidden, TextElement t => t.Hidden, ImageElement i => i.Hidden, ConnectorElement c => c.Hidden, GroupElement g => g.Hidden, _ => false };
    private static List<string> LayerIds(Element e) => e switch { ShapeElement s => s.LayerIds, TextElement t => t.LayerIds, ImageElement i => i.LayerIds, ConnectorElement c => c.LayerIds, GroupElement g => g.LayerIds, _ => [] };
    private static Dictionary<string, string> Meta(Element e) => e switch { ShapeElement s => s.Metadata, TextElement t => t.Metadata, ImageElement i => i.Metadata, ConnectorElement c => c.Metadata, GroupElement g => g.Metadata, _ => [] };
    private static double Rotation(Element e) => e switch { ShapeElement s => s.RotationDeg, TextElement t => t.RotationDeg, ImageElement i => i.RotationDeg, _ => 0 };

    private static string? LayerMember(PageCtx ctx, Element e)
    {
        var ids = LayerIds(e);
        if (ids.Count == 0) return null;
        return string.Join(';', ids.Select(id => ctx.Page.Layers.FindIndex(l => l.Id == id)).Where(i => i >= 0));
    }

    private XElement IdentitySection(PageCtx ctx, Element e, params (string, string)[] extra)
    {
        var rows = new List<XElement>
        {
            UserRow("AgentId", e.Id()), UserRow("AgentKind", e.Kind()), UserRow("AgentNativeRef", $"{ctx.PageIndex}:{ctx.NativeId[e.Id()]}"),
            UserRow("AgentZ", e.ZIndex().ToString(System.Globalization.CultureInfo.InvariantCulture)),
        };
        if (AliasOf(e) is { } a) rows.Add(UserRow("AgentAlias", a));
        if (Locked(e)) rows.Add(UserRow("AgentLocked", "1"));
        if (Hidden(e)) rows.Add(UserRow("AgentHidden", "1"));
        foreach (var (k, v) in extra) rows.Add(UserRow(k, v));
        return Section("User", rows);
    }

    private static XElement? MetadataSection(Element e)
    {
        var meta = Meta(e);
        if (meta.Count == 0) return null;
        return Section("Property", meta.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select((kv, i) => new XElement(V + "Row", new XAttribute("N", $"AgentMeta{i}"),
            Cell("Label", kv.Key), Cell("Value", kv.Value, unit: "STR"), Cell("Type", 0), Cell("Invisible", 0))));
    }

    private int FontIndex(string family)
    {
        var i = fonts.FindIndex(f => string.Equals(f, family, StringComparison.OrdinalIgnoreCase));
        if (i >= 0) return i;
        fonts.Add(family);
        return fonts.Count - 1;
    }

    private IEnumerable<XElement> TextCells(TextBlock t)
    {
        yield return Cell("LeftMargin", In(t.PaddingPt));
        yield return Cell("RightMargin", In(t.PaddingPt));
        yield return Cell("TopMargin", In(t.PaddingPt));
        yield return Cell("BottomMargin", In(t.PaddingPt));
        yield return Cell("VerticalAlign", t.VerticalAlign switch { "top" => 0, "bottom" => 2, _ => 1 });
        yield return Section("Character", new XElement(V + "Row", new XAttribute("IX", 0),
            Cell("Font", FontIndex(t.FontFamily)), Cell("Color", t.Colour[..7]), Cell("ColorTrans", t.Colour.Length == 9 ? 1 - Convert.ToInt32(t.Colour[7..], 16) / 255.0 : 0.0),
            Cell("Style", (t.Bold ? 1 : 0) | (t.Italic ? 2 : 0) | (t.Underline ? 4 : 0)), Cell("Size", In(t.FontSizePt))));
        yield return Section("Paragraph", new XElement(V + "Row", new XAttribute("IX", 0), Cell("HorzAlign", t.HorizontalAlign switch { "left" => 0, "right" => 2, _ => 1 })));
    }

    private static (string Colour, double Trans) Colour(string paint, double extraOpacity = 1)
    {
        var a = paint.Length == 9 ? Convert.ToInt32(paint[7..], 16) / 255.0 : 1;
        return (paint[..7], Math.Round(1 - a * extraOpacity, 6));
    }

    private IEnumerable<XElement> StyleCells(ShapeStyle st)
    {
        if (st.Fill == "none") yield return Cell("FillPattern", 0);
        else
        {
            var (c, t) = Colour(st.Fill, st.FillOpacity);
            yield return Cell("FillForegnd", c);
            yield return Cell("FillForegndTrans", t);
            yield return Cell("FillPattern", 1);
        }
        if (st.Stroke == "none" || st.StrokeWidthPt == 0) yield return Cell("LinePattern", 0);
        else
        {
            var (c, t) = Colour(st.Stroke);
            yield return Cell("LineColor", c);
            yield return Cell("LineColorTrans", t);
            yield return Cell("LinePattern", DashCodes[st.Dash]);
            yield return Cell("LineWeight", In(st.StrokeWidthPt));
            yield return Cell("LineCap", st.LineCap switch { "round" => 0, "square" => 1, _ => 2 });
        }
    }

    private XElement ConnectionSection(Element e, Bounds b)
    {
        var custom = e is ShapeElement s ? s.Ports ?? [] : [];
        var rows = new List<XElement>();
        var ix = 0;
        foreach (var name in PortOrder)
        {
            var (u, v) = DefaultPorts[name];
            rows.Add(new XElement(V + "Row", new XAttribute("T", "Connection"), new XAttribute("IX", ix++), new XAttribute("N", name),
                Cell("X", In(b.Width) * u), Cell("Y", In(b.Height) * (1 - v)), Cell("DirX", 0.0), Cell("DirY", 0.0), Cell("Type", 0)));
        }
        foreach (var p in custom.Where(p => !DefaultPorts.ContainsKey(p.Name)))
            rows.Add(new XElement(V + "Row", new XAttribute("T", "Connection"), new XAttribute("IX", ix++), new XAttribute("N", p.Name),
                Cell("X", In(b.Width) * p.X), Cell("Y", In(b.Height) * (1 - p.Y)), Cell("DirX", 0.0), Cell("DirY", 0.0), Cell("Type", 0)));
        return Section("Connection", rows);
    }

    private static int PortIndex(Element target, string port)
    {
        var i = Array.IndexOf(PortOrder, port);
        if (i >= 0) return i;
        var custom = (target as ShapeElement)?.Ports?.Where(p => !DefaultPorts.ContainsKey(p.Name)).Select(p => p.Name).ToList() ?? [];
        var j = custom.IndexOf(port);
        return j < 0 ? -1 : PortOrder.Length + j;
    }

    private async Task<XElement> ShapeAsync(PageCtx ctx, Element e, Frame frame, DiagramDocument doc, IAssetBlobSource blobs, CancellationToken ct)
    {
        switch (e)
        {
            case GroupElement g:
            {
                // Native group-local coordinates come from the revision-matched visual frame sidecar.
                var gb = ctx.Projection.GroupVisualBounds.TryGetValue(g.Id, out var vf) ? vf : g.Bounds;
                var shape = BaseShape(ctx, g, gb, 0, frame, "Group");
                shape.Add(IdentitySection(ctx, g, ("AgentCanonicalBounds", JsonSerializer.Serialize(g.Bounds, ContractJson.Options))));
                if (MetadataSection(g) is { } m) shape.Add(m);
                var inner = new Frame(gb.X, gb.Y, gb.Height);
                var children = new XElement(V + "Shapes");
                foreach (var c in g.ChildIds.Select(id => ctx.ById[id]).OrderBy(c => c.ZIndex())) children.Add(await ShapeAsync(ctx, c, inner, doc, blobs, ct));
                shape.Add(children);
                return shape;
            }
            case ConnectorElement c: return Connector(ctx, c, frame);
            case ImageElement i: return await PictureAsync(ctx, i, frame, doc, blobs, ct);
            default:
            {
                var b = e.Bounds();
                var shape = BaseShape(ctx, e, b, Rotation(e), frame, "Shape");
                var preset = PresetOf(e);
                var (style, text) = e switch { ShapeElement s => (s.Style, s.Text), TextElement t => (t.Style, (TextBlock?)t.Text), _ => throw new InvalidOperationException() };
                shape.Add(StyleCells(style));
                if (text is not null) shape.Add(TextCells(text));
                var sub = GeometryMap.Preset(e is ShapeElement se ? se.Geometry.Preset : "rectangle", b.Width, b.Height, (e as ShapeElement)?.Geometry.CornerRadiusPt, (e as ShapeElement)?.Geometry.SvgPath);
                var noLine = style.Stroke == "none" || style.StrokeWidthPt == 0;
                var noFill = style.Fill == "none";
                var extras = new List<(string, string)> { ("AgentPreset", e is TextElement ? "text" : preset), ("AgentGeomHash", GeometryMap.ExportHash(sub)) };
                if (e is ShapeElement { Geometry.CornerRadiusPt: { } r }) extras.Add(("AgentCornerRadius", r.ToString("R", System.Globalization.CultureInfo.InvariantCulture)));
                if (text is { Wrap: false }) extras.Add(("AgentTextWrap", "0"));
                if (style.LineJoin != "miter" || style.LineCap != "butt") extras.Add(("AgentLineStyle", $"{style.LineCap};{style.LineJoin}"));
                shape.Add(IdentitySection(ctx, e, [.. extras]));
                if (MetadataSection(e) is { } m) shape.Add(m);
                if (e is ShapeElement) shape.Add(ConnectionSection(e, b));
                shape.Add(GeometryMap.ToSections(V, sub, noFill, noLine, Hidden(e)));
                if (text is not null && text.Value.Length > 0) shape.Add(new XElement(V + "Text", text.Value));
                return shape;
            }
        }
    }

    private XElement Connector(PageCtx ctx, ConnectorElement c, Frame frame)
    {
        var route = ctx.Projection.Connectors.TryGetValue(c.Id, out var proj) && proj.RoutePoints.Count >= 2 ? proj.RoutePoints : null;
        if (route is null)
        {
            Diag("warning", "connector_route_missing", "approximated", "no projected route; using authored fallback bounds", c.Id, ctx.Page.Id);
            route = [new Point { X = c.Bounds.X, Y = c.Bounds.Y }, new Point { X = c.Bounds.X + c.Bounds.Width, Y = c.Bounds.Y + c.Bounds.Height }];
        }
        // Visio local coordinates (inches, y up) in the parent frame.
        var pts = route.Select(p => (X: frame.LocalX(p.X), Y: frame.LocalY(p.Y))).ToList();
        var (bx, by) = pts[0];
        var (ex, ey) = pts[^1];
        var theta = Math.Atan2(ey - by, ex - bx);
        var len = Math.Sqrt((ex - bx) * (ex - bx) + (ey - by) * (ey - by));
        var id = ctx.NativeId[c.Id];
        var shape = new XElement(V + "Shape", new XAttribute("ID", id), new XAttribute("Type", "Shape"), new XAttribute("NameU", $"Dynamic connector.{id}"),
            new XAttribute("Name", c.Name ?? $"Dynamic connector.{id}"), new XAttribute("LineStyle", 0), new XAttribute("FillStyle", 0), new XAttribute("TextStyle", 0),
            Cell("PinX", (bx + ex) / 2), Cell("PinY", (by + ey) / 2), Cell("Width", len), Cell("Height", 0.0), Cell("LocPinX", len / 2), Cell("LocPinY", 0.0),
            Cell("Angle", theta),
            Cell("BeginX", bx, Glue(ctx, c.From, true)), Cell("BeginY", by, Glue(ctx, c.From, true, y: true)),
            Cell("EndX", ex, Glue(ctx, c.To, false)), Cell("EndY", ey, Glue(ctx, c.To, false, y: true)),
            Cell("ObjType", 2), Cell("ShapeRouteStyle", c.Route == "straight" ? 2 : 1), Cell("ConLineRouteExt", c.Route == "curved" ? 2 : 1),
            Cell("ConFixedCode", c.Waypoints.Count > 0 ? 3 : 0), Cell("FillPattern", 0),
            Cell("LineColor", Colour(c.Style.Stroke).Colour), Cell("LineWeight", In(c.Style.StrokeWidthPt)), Cell("LinePattern", DashCodes[c.Style.Dash]),
            Cell("BeginArrow", ArrowCodes[c.Style.StartArrow]), Cell("EndArrow", ArrowCodes[c.Style.EndArrow]), Cell("BeginArrowSize", 2), Cell("EndArrowSize", 2));
        if (c.From.ElementId is { } f && ctx.NativeId.TryGetValue(f, out var fn)) shape.Add(Cell("BegTrigger", 2, $"_XFTRIGGER(Sheet.{fn}!EventXFMod)"));
        if (c.To.ElementId is { } t && ctx.NativeId.TryGetValue(t, out var tn)) shape.Add(Cell("EndTrigger", 2, $"_XFTRIGGER(Sheet.{tn}!EventXFMod)"));
        if (LayerMember(ctx, c) is { } lm) shape.Add(Cell("LayerMember", lm));
        if (c.Locked) shape.Add(Cell("LockMoveX", 1), Cell("LockMoveY", 1), Cell("LockBegin", 1), Cell("LockEnd", 1), Cell("LockDelete", 1));
        if (c.Label is not null) shape.Add(TextCells(c.Label));
        shape.Add(IdentitySection(ctx, c,
            ("AgentFrom", JsonSerializer.Serialize(c.From, ContractJson.Options)), ("AgentTo", JsonSerializer.Serialize(c.To, ContractJson.Options)),
            ("AgentWaypoints", JsonSerializer.Serialize(c.Waypoints, ContractJson.Options)), ("AgentRoute", c.Route),
            ("AgentFallbackBounds", JsonSerializer.Serialize(c.Bounds, ContractJson.Options))));
        if (MetadataSection(c) is { } m) shape.Add(m);
        var geo = new XElement(V + "Section", new XAttribute("N", "Geometry"), new XAttribute("IX", 0), Cell("NoFill", 1), Cell("NoLine", 0), Cell("NoShow", c.Hidden ? 1 : 0), Cell("NoSnap", 0));
        var row = 1;
        foreach (var (px, py) in pts)
        {
            double dx = px - bx, dy = py - by;
            double lx = dx * Math.Cos(theta) + dy * Math.Sin(theta) + 0, ly = -dx * Math.Sin(theta) + dy * Math.Cos(theta);
            geo.Add(new XElement(V + "Row", new XAttribute("T", row == 1 ? "MoveTo" : "LineTo"), new XAttribute("IX", row++), Cell("X", lx), Cell("Y", ly)));
        }
        shape.Add(geo);
        if (c.Label is { Value.Length: > 0 }) shape.Add(new XElement(V + "Text", c.Label.Value));
        foreach (var (end, cell) in new[] { (c.From, "BeginX"), (c.To, "EndX") })
        {
            if (end.ElementId is null) continue;
            if (!ctx.NativeId.TryGetValue(end.ElementId, out var target)) continue;
            var targetEl = ctx.ById[end.ElementId];
            var portIx = end.Glue == "static" && end.Port is not null ? PortIndex(targetEl, end.Port) : -1;
            ctx.Connects.Add(new XElement(V + "Connect", new XAttribute("FromSheet", id), new XAttribute("FromCell", cell), new XAttribute("FromPart", cell == "BeginX" ? 9 : 12),
                new XAttribute("ToSheet", target), new XAttribute("ToCell", portIx < 0 ? "PinX" : $"Connections.X{portIx + 1}"), new XAttribute("ToPart", portIx < 0 ? 3 : 100 + portIx)));
        }
        return shape;
    }

    private static string? Glue(PageCtx ctx, Endpoint end, bool begin, bool y = false)
    {
        if (end.ElementId is null || !ctx.NativeId.TryGetValue(end.ElementId, out var target)) return null;
        if (end.Glue == "static" && end.Port is not null)
        {
            var ix = PortIndex(ctx.ById[end.ElementId], end.Port);
            if (ix >= 0) return $"PAR(PNT(Sheet.{target}!Connections.X{ix + 1},Sheet.{target}!Connections.Y{ix + 1}))";
        }
        return "_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)";
    }

    private async Task<XElement> PictureAsync(PageCtx ctx, ImageElement i, Frame frame, DiagramDocument doc, IAssetBlobSource blobs, CancellationToken ct)
    {
        var asset = doc.Assets.FirstOrDefault(a => a.Id == i.AssetId) ?? throw new VsdxException("not_found", $"asset {i.AssetId} missing from the document catalogue");
        var shape = BaseShape(ctx, i, i.Bounds, i.RotationDeg, frame, "Foreign");
        byte[] bytes;
        string ext, compression;
        var extras = new List<(string, string)> { ("AssetId", asset.Id) };
        if (asset.MimeType == "image/svg+xml")
        {
            var raster = await blobs.ReadRasterFallbackAsync(asset.Sha256, ct);
            if (raster is null)
            {
                Diag("error", "svg_no_fallback", "dropped", $"SVG asset {asset.Id} has no PNG derivative; picture omitted", i.Id, ctx.Page.Id);
                shape.Add(IdentitySection(ctx, i, [.. extras]));
                return shape;
            }
            bytes = raster.Value.ToArray();
            (ext, compression) = ("png", "PNG");
            var source = (await blobs.ReadAsync(asset.Sha256, ct)).ToArray();
            var srcPart = $"visio/media/source-{asset.Sha256[..16]}.svg";
            if (written.Add(srcPart)) Write(zip, srcPart, source);
            var relId = $"rIdS{ctx.Rels.Count + 1}";
            if (!ctx.Rels.Any(r => r.Target == $"../media/source-{asset.Sha256[..16]}.svg")) ctx.Rels.Add((relId, RelSvgSource, $"../media/source-{asset.Sha256[..16]}.svg"));
            extras.Add(("SvgSourceSha256", asset.Sha256));
            Diag("info", "svg_rasterised", "approximated", $"SVG asset {asset.Id} exported as a PNG picture; standalone SVG source carried in the package", i.Id, ctx.Page.Id);
        }
        else
        {
            bytes = (await blobs.ReadAsync(asset.Sha256, ct)).ToArray();
            (ext, compression) = asset.MimeType switch { "image/jpeg" => ("jpeg", "JPEG"), "image/bmp" => ("bmp", "BMP"), _ => ("png", "PNG") };
        }
        var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        extras.Add(("AssetSha256", sha));
        if (!media.TryGetValue(sha, out var part))
        {
            part = ($"visio/media/image{media.Count + 1}.{ext}", ext);
            media[sha] = part;
            Write(zip, part.Part, bytes);
        }
        var target = "../media/" + Path.GetFileName(part.Part);
        var rel = ctx.Rels.FirstOrDefault(r => r.Target == target && r.Type == RelImage);
        if (rel.Id is null) { rel = ($"rId{ctx.Rels.Count + 1}", RelImage, target); ctx.Rels.Add(rel); }
        // Fit: Visio crops/positions the picture inside the shape with Img* cells.
        double w = In(i.Bounds.Width), h = In(i.Bounds.Height), iw = w, ih = h, ox = 0, oy = 0;
        if (i.Fit != "stretch" && i.PreserveAspectRatio && asset.WidthPx is > 0 && asset.HeightPx is > 0)
        {
            var aspect = (double)asset.WidthPx.Value / asset.HeightPx.Value;
            var scale = i.Fit == "cover" ? Math.Max(w / aspect, h) : Math.Min(w / aspect, h);
            (iw, ih) = (scale * aspect, scale);
            (ox, oy) = ((w - iw) / 2, (h - ih) / 2);
        }
        else if (i.Fit != "stretch") Diag("info", "image_fit_unknown_size", "approximated", "asset pixel size unknown; picture stretched to its box", i.Id, ctx.Page.Id);
        shape.Add(Cell("ImgOffsetX", ox), Cell("ImgOffsetY", oy), Cell("ImgWidth", iw), Cell("ImgHeight", ih), Cell("ClippingPath", ""), Cell("LinePattern", 0), Cell("FillPattern", 0));
        shape.Add(Section("Image", new XElement(V + "Row", new XAttribute("IX", 0), Cell("Transparency", Math.Round(1 - i.Opacity, 6)), Cell("Blur", 0.0), Cell("Sharpen", 0.0), Cell("Denoise", 0.0))));
        extras.Add(("AgentFit", i.Fit));
        extras.Add(("AgentAspect", i.PreserveAspectRatio ? "1" : "0"));
        shape.Add(IdentitySection(ctx, i, [.. extras]));
        if (MetadataSection(i) is { } m) shape.Add(m);
        shape.Add(new XElement(V + "ForeignData", new XAttribute("ForeignType", "Bitmap"), new XAttribute("CompressionType", compression),
            new XElement(V + "Rel", new XAttribute(R + "id", rel.Id))));
        return shape;
    }

    private XDocument DocumentXml(DiagramDocument doc) => new(new XElement(V + "VisioDocument", new XAttribute(XNamespace.Xmlns + "r", R), new XAttribute(XNamespace.Xml + "space", "preserve"),
        new XElement(V + "DocumentSettings", new XAttribute("TopPage", 0), new XAttribute("DefaultTextStyle", 0), new XAttribute("DefaultLineStyle", 0),
            new XAttribute("DefaultFillStyle", 0), new XAttribute("DefaultGuideStyle", 0),
            new XElement(V + "GlueSettings", 9), new XElement(V + "SnapSettings", 65847), new XElement(V + "SnapExtensions", 34), new XElement(V + "DynamicGridEnabled", 1)),
        new XElement(V + "Colors", new XElement(V + "ColorEntry", new XAttribute("IX", 0), new XAttribute("RGB", "#000000")), new XElement(V + "ColorEntry", new XAttribute("IX", 1), new XAttribute("RGB", "#FFFFFF"))),
        new XElement(V + "FaceNames", fonts.Select((f, i) => new XElement(V + "FaceName", new XAttribute("ID", i), new XAttribute("NameU", f), new XAttribute("Name", f)))),
        new XElement(V + "StyleSheets", new XElement(V + "StyleSheet", new XAttribute("ID", 0), new XAttribute("NameU", "No Style"), new XAttribute("Name", "No Style"),
            Cell("EnableLineProps", 1), Cell("EnableFillProps", 1), Cell("EnableTextProps", 1), Cell("HideForApply", 0),
            Cell("LineWeight", 1.0 / 72), Cell("LineColor", "#333333"), Cell("LinePattern", 1), Cell("Rounding", 0.0), Cell("EndArrowSize", 2), Cell("BeginArrow", 0), Cell("EndArrow", 0),
            Cell("LineCap", 0), Cell("BeginArrowSize", 2), Cell("FillForegnd", "#FFFFFF"), Cell("FillBkgnd", "#FFFFFF"), Cell("FillPattern", 1), Cell("ShdwPattern", 0),
            Cell("LeftMargin", 4.0 / 72), Cell("RightMargin", 4.0 / 72), Cell("TopMargin", 4.0 / 72), Cell("BottomMargin", 4.0 / 72), Cell("VerticalAlign", 1), Cell("TextBkgnd", 0),
            Section("Character", new XElement(V + "Row", new XAttribute("IX", 0), Cell("Font", 0), Cell("Color", "#000000"), Cell("Style", 0), Cell("Size", 11.0 / 72))),
            Section("Paragraph", new XElement(V + "Row", new XAttribute("IX", 0), Cell("HorzAlign", 1))))),
        new XElement(V + "DocumentSheet", new XAttribute("NameU", "TheDoc"), new XAttribute("LineStyle", 0), new XAttribute("FillStyle", 0), new XAttribute("TextStyle", 0),
            Section("User", UserRow("AgentDocumentId", doc.Id), UserRow("AgentSchemaVersion", "1"), UserRow("AgentTitle", doc.Title),
                UserRow("AgentMetadata", JsonSerializer.Serialize(doc.Metadata, ContractJson.Options))))));

    private static XDocument CoreXml(DiagramDocument doc)
    {
        XNamespace cp = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties", dc = "http://purl.org/dc/elements/1.1/";
        return new XDocument(new XElement(cp + "coreProperties", new XAttribute(XNamespace.Xmlns + "dc", dc), new XElement(dc + "title", doc.Title)));
    }

    private XDocument ContentTypes(int pages)
    {
        var types = new XElement(Ct + "Types",
            new XElement(Ct + "Default", new XAttribute("Extension", "rels"), new XAttribute("ContentType", "application/vnd.openxmlformats-package.relationships+xml")),
            new XElement(Ct + "Default", new XAttribute("Extension", "xml"), new XAttribute("ContentType", "application/xml")),
            new XElement(Ct + "Default", new XAttribute("Extension", "png"), new XAttribute("ContentType", "image/png")),
            new XElement(Ct + "Default", new XAttribute("Extension", "jpeg"), new XAttribute("ContentType", "image/jpeg")),
            new XElement(Ct + "Default", new XAttribute("Extension", "bmp"), new XAttribute("ContentType", "image/bmp")),
            new XElement(Ct + "Default", new XAttribute("Extension", "svg"), new XAttribute("ContentType", "image/svg+xml")),
            new XElement(Ct + "Override", new XAttribute("PartName", "/visio/document.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.drawing.main+xml")),
            new XElement(Ct + "Override", new XAttribute("PartName", "/visio/pages/pages.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.pages+xml")),
            new XElement(Ct + "Override", new XAttribute("PartName", "/visio/windows.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.windows+xml")),
            new XElement(Ct + "Override", new XAttribute("PartName", "/docProps/core.xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-package.core-properties+xml")),
            new XElement(Ct + "Override", new XAttribute("PartName", "/docProps/app.xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.extended-properties+xml")));
        for (var i = 1; i <= pages; i++)
            types.Add(new XElement(Ct + "Override", new XAttribute("PartName", $"/visio/pages/page{i}.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.page+xml")));
        return new XDocument(types);
    }

    /// <summary>Self-reopen: counts, identities, glue references and picture bytes must survive.</summary>
    private async Task SelfCheckAsync(ExportSnapshot snapshot, byte[] bytes, CancellationToken ct)
    {
        var guarded = await PackageGuard.ValidateAsync(new MemoryStream(bytes), ct: ct);
        var imported = await new DirectVsdxImporter().ImportAsync(new MemoryStream(guarded.Bytes), new ImportOptions(), ct);
        var expected = snapshot.Document.Pages.SelectMany(p => p.Elements).Where(e => !(e is ImageElement im && diagnostics.Any(d => d.Code == "svg_no_fallback" && d.ElementId == im.Id)))
            .Select(e => e.Id()).Order().ToList();
        var actual = imported.Document.Pages.SelectMany(p => p.Elements).Select(e => e.Id()).Order().ToList();
        if (!expected.SequenceEqual(actual)) throw new VsdxException("internal_error", $"self-check failed: {expected.Except(actual).Count()} element(s) missing, {actual.Except(expected).Count()} unexpected");
        var conns = imported.Document.Pages.SelectMany(p => p.Elements).OfType<ConnectorElement>().ToDictionary(c => c.Id);
        foreach (var c in snapshot.Document.Pages.SelectMany(p => p.Elements).OfType<ConnectorElement>())
            if (conns[c.Id].From.ElementId != c.From.ElementId || conns[c.Id].To.ElementId != c.To.ElementId)
                throw new VsdxException("internal_error", $"self-check failed: connector {c.Id} glue changed");
    }
}
