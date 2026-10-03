using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Xml.Linq;
using Diagram.Core.Contracts;
using Diagram.Visio.Abstractions;
using static Diagram.Visio.Vx;

namespace Diagram.Visio;

/// <summary>2-D affine map (local → page points, y down): page = (A·x + C·y + E, B·x + D·y + F).</summary>
internal readonly record struct Affine(double A, double B, double C, double D, double E, double F)
{
    public (double X, double Y) Map(double x, double y) => (A * x + C * y + E, B * x + D * y + F);
    public Affine Then(Affine inner) => new(  // this ∘ inner
        A * inner.A + C * inner.B, B * inner.A + D * inner.B,
        A * inner.C + C * inner.D, B * inner.C + D * inner.D,
        A * inner.E + C * inner.F + E, B * inner.E + D * inner.F + F);
    public double Det => A * D - B * C;
}

/// <summary>
/// Supported-subset importer producing one whole canonical candidate plus validated blobs.
/// Every approximation or drop is a diagnostic; the frontend validates the whole candidate
/// before anything is published, so a failed import leaves the open document intact.
/// </summary>
public sealed class DirectVsdxImporter : IVsdxImporter
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private readonly List<Diagnostic> diagnostics = [];
    private ZipArchive zip = null!;
    private Dictionary<string, (XElement Top, Dictionary<string, XElement> ById)> masters = new();
    private SheetInheritance inheritance = new(null);
    private ThemeColours theme = new(null);
    private int themedColours;
    private List<string> faceNames = [];
    private Dictionary<int, string> colorTable = new();

    private sealed class Parsed
    {
        public required XElement Shape { get; init; }
        public required XElement? Master { get; init; }
        public required int PageIndex { get; init; }
        public required string NativeId { get; init; }
        public required Affine Transform { get; init; } // local inches → page pt
        public required Affine ParentTransform { get; init; }
        public string? ParentNative { get; init; }
        public List<string> ChildNatives { get; } = [];
        public int Order { get; set; }
    }

    public Task<ImportResult> ImportAsync(Stream validatedPackage, ImportOptions options, CancellationToken ct)
    {
        diagnostics.Clear();
        var bytes = validatedPackage is MemoryStream m ? m.ToArray() : ReadAll(validatedPackage);
        using (zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read))
        {
            var docPart = RootTarget("_rels/.rels", RelDocument) ?? "visio/document.xml";
            var docXml = Load(zip, docPart);
            faceNames = docXml.Root!.Element(V + "FaceNames")?.Elements(V + "FaceName").OrderBy(f => (int?)f.Attribute("ID") ?? 0).Select(f => (string?)f.Attribute("NameU") ?? (string?)f.Attribute("Name") ?? "Calibri").ToList() ?? [];
            colorTable = docXml.Root!.Element(V + "Colors")?.Elements(V + "ColorEntry").ToDictionary(c => (int)c.Attribute("IX")!, c => (string)c.Attribute("RGB")!) ?? new();
            var docSheet = docXml.Root!.Element(V + "DocumentSheet");
            var docIdText = docSheet is null ? null : User(docSheet, "AgentDocumentId");
            var preserved = IdentityMap.IsUuid(docIdText);
            var seed = preserved ? Guid.Parse(docIdText!) : IdentityMap.UuidV5(IdentityMap.Namespace, Convert.ToHexString(SHA256.HashData(bytes)));
            if (!preserved) diagnostics.Add(new Diagnostic { Severity = "info", Code = "document_identity_generated", Action = "regenerated", Detail = "no AgentDocumentId; identity derived from package bytes" });
            var identity = new IdentityMap(seed);
            inheritance = new SheetInheritance(docXml.Root);
            var themeTarget = RelTarget(docPart, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme");
            theme = new ThemeColours(themeTarget is null ? null : Load(zip, Resolve(Path.GetDirectoryName(docPart)!.Replace('\\', '/'), themeTarget)));
            themedColours = 0;
            LoadMasters(docPart);

            var docDir = Path.GetDirectoryName(docPart)!.Replace('\\', '/');
            var pagesPart = Resolve(docDir, RelTarget(docPart, RelPages) ?? "pages/pages.xml");
            var pagesXml = Load(zip, pagesPart);
            var pagesRels = RelsOf(pagesPart);
            var pageParts = new List<(XElement Entry, byte[] Bytes, string Part)>();
            foreach (var p in pagesXml.Root!.Elements(V + "Page"))
            {
                if ((string?)p.Attribute("Background") == "1") { diagnostics.Add(new Diagnostic { Severity = "warning", Code = "background_page", Action = "dropped", Detail = $"background page '{(string?)p.Attribute("Name")}' is not imported" }); continue; }
                var rid = (string?)p.Element(V + "Rel")?.Attribute(R + "id");
                if (rid is null || !pagesRels.TryGetValue(rid, out var target)) continue;
                var part = Resolve(Path.GetDirectoryName(pagesPart)!.Replace('\\', '/'), target.Target);
                pageParts.Add((p, Vx.Bytes(zip, part), part)); // the archive is read sequentially
            }
            // Page XML is independent: parse in parallel (the dominant cost for large drawings).
            var parsedXml = new XDocument[pageParts.Count];
            Parallel.For(0, pageParts.Count, i => parsedXml[i] = Vx.Parse(pageParts[i].Bytes));
            var pages = pageParts.Select((p, i) => (p.Entry, Contents: parsedXml[i], p.Part)).ToList();
            if (pages.Count == 0) throw new VsdxException("invalid_request", "package has no foreground pages");

            // Pass 1: parse geometry/transforms; collect identity candidates in document order.
            var parsed = new List<Parsed>();
            var order = 0;
            for (var pi = 0; pi < pages.Count; pi++)
            {
                var sheet = pages[pi].Entry.Element(V + "PageSheet");
                var heightPt = (Num(sheet, "PageHeight") ?? 8.27) * 72;
                var root = new Affine(72, 0, 0, -72, 0, heightPt);
                foreach (var s in pages[pi].Contents.Root!.Element(V + "Shapes")?.Elements(V + "Shape") ?? [])
                    Walk(s, pi, root, null, parsed, ref order);
            }
            var assigned = identity.Assign(parsed.Select(p => new IdentityMap.Candidate(p.PageIndex, p.NativeId, User(p.Shape, "AgentId"), User(p.Shape, "AgentNativeRef"), p.Order)).ToList(), diagnostics);

            // Pass 2: build canonical pages/elements.
            var blobs = new Dictionary<string, byte[]>();
            var assets = new Dictionary<string, Asset>();
            var outPages = new List<Page>();
            for (var pi = 0; pi < pages.Count; pi++)
            {
                ct.ThrowIfCancellationRequested();
                outPages.Add(BuildPage(pi, pages[pi].Entry, pages[pi].Contents, pages[pi].Part, parsed.Where(p => p.PageIndex == pi).ToList(), assigned, identity, blobs, assets));
            }
            var title = docSheet is null ? null : User(docSheet, "AgentTitle");
            var meta = TryJson<Dictionary<string, string>>(docSheet is null ? null : User(docSheet, "AgentMetadata")) ?? new();
            var document = new DiagramDocument
            {
                SchemaVersion = 1, Id = seed.ToString(), Title = title ?? Path.GetFileNameWithoutExtension(options.SourcePath ?? "Imported"), Revision = 0,
                Pages = outPages, Assets = [.. assets.Values], Metadata = meta,
                Source = new DiagramDocumentSource { Format = "vsdx", Path = options.SourcePath },
            };
            if (themedColours > 0)
                diagnostics.Add(new Diagnostic { Severity = "info", Code = "theme_colour", Action = "approximated", Detail = $"{themedColours} colour(s) resolved from the theme by QuickStyle index; theme fill matrices (tints, gradients) are not applied" });
            return Task.FromResult(new ImportResult(document, blobs, [.. diagnostics], new IdentityReport(identity.Preserved, identity.Regenerated, identity.Generated, preserved)));
        }
    }

    private static byte[] ReadAll(Stream s) { using var ms = new MemoryStream(); s.CopyTo(ms); return ms.ToArray(); }

    // ---------------- package navigation ----------------
    private Dictionary<string, (string Type, string Target)> RelsOf(string part)
    {
        var dir = Path.GetDirectoryName(part)!.Replace('\\', '/');
        var relsPart = (dir.Length > 0 ? dir + "/" : "") + "_rels/" + Path.GetFileName(part) + ".rels";
        if (zip.GetEntry(relsPart) is null) return new();
        return Load(zip, relsPart).Root!.Elements(Pr + "Relationship").ToDictionary(r => (string)r.Attribute("Id")!, r => ((string)r.Attribute("Type")!, (string)r.Attribute("Target")!));
    }

    private string? RootTarget(string relsPart, string type) =>
        zip.GetEntry(relsPart) is null ? null : Load(zip, relsPart).Root!.Elements(Pr + "Relationship").FirstOrDefault(r => (string?)r.Attribute("Type") == type)?.Attribute("Target")?.Value.TrimStart('/');

    private string? RelTarget(string part, string type) => RelsOf(part).Values.FirstOrDefault(r => r.Type == type).Target;

    private void LoadMasters(string docPart)
    {
        masters = new();
        var mastersTarget = RelTarget(docPart, "http://schemas.microsoft.com/visio/2010/relationships/masters");
        if (mastersTarget is null) return;
        var mastersPart = Resolve(Path.GetDirectoryName(docPart)!.Replace('\\', '/'), mastersTarget);
        var rels = RelsOf(mastersPart);
        foreach (var m in Load(zip, mastersPart).Root!.Elements(V + "Master"))
        {
            var rid = (string?)m.Element(V + "Rel")?.Attribute(R + "id");
            if (rid is null || !rels.TryGetValue(rid, out var t)) continue;
            var contents = Load(zip, Resolve(Path.GetDirectoryName(mastersPart)!.Replace('\\', '/'), t.Target));
            var top = contents.Root!.Element(V + "Shapes")?.Elements(V + "Shape").FirstOrDefault();
            if (top is null) continue;
            // Sub-shapes of group masters are addressed by instance children through MasterShape.
            var byId = contents.Root!.Descendants(V + "Shape").Where(x => x.Attribute("ID") is not null)
                .GroupBy(x => (string)x.Attribute("ID")!).ToDictionary(g => g.Key, g => g.First());
            masters[(string)m.Attribute("ID")!] = (top, byId);
        }
        if (masters.Count > 0) diagnostics.Add(new Diagnostic { Severity = "info", Code = "masters_inherited", Action = "approximated", Detail = $"{masters.Count} master(s): instance cells inherit master geometry/style values; master links are not kept" });
    }

    // ---------------- cells with master inheritance ----------------
    private static double? CellNum(XElement shape, XElement? master, string n) => Num(shape, n) ?? (master is null ? null : Num(master, n));
    private static string? CellStr(XElement shape, XElement? master, string n) => CellV(shape, n) ?? (master is null ? null : CellV(master, n));

    private static Affine LocalTransform(XElement s, XElement? master, out bool flipped)
    {
        double pinX = CellNum(s, master, "PinX") ?? 0, pinY = CellNum(s, master, "PinY") ?? 0;
        double w = CellNum(s, master, "Width") ?? 0, h = CellNum(s, master, "Height") ?? 0;
        double lx = CellNum(s, master, "LocPinX") ?? w / 2, ly = CellNum(s, master, "LocPinY") ?? h / 2;
        double angle = CellNum(s, master, "Angle") ?? 0;
        double fx = CellNum(s, master, "FlipX") == 1 ? -1 : 1, fy = CellNum(s, master, "FlipY") == 1 ? -1 : 1;
        flipped = fx < 0 || fy < 0;
        double cos = Math.Cos(angle), sin = Math.Sin(angle);
        // parent = Pin + R(angle) · F · (l − LocPin), with the flip mirroring about the pin.
        double a = cos * fx, b = sin * fx, c = -sin * fy, d = cos * fy;
        return new Affine(a, b, c, d, pinX - (a * lx + c * ly), pinY - (b * lx + d * ly));
    }

    private void Walk(XElement raw, int pageIndex, Affine parent, string? parentNative, List<Parsed> outList, ref int order, string? inheritedMaster = null)
    {
        // Instance children of a group master name their master sub-shape with MasterShape.
        var masterId = (string?)raw.Attribute("Master") ?? inheritedMaster;
        XElement? master = null;
        if (masterId is not null && masters.TryGetValue(masterId, out var m))
            master = (string?)raw.Attribute("MasterShape") is { } ms ? m.ById.GetValueOrDefault(ms) : raw.Attribute("Master") is not null ? m.Top : null;
        // All later reads see one effective sheet: style sheets < master < local.
        var s = inheritance.Effective(raw, master);
        var local = LocalTransform(s, null, out var flipped);
        if (flipped) diagnostics.Add(new Diagnostic { Severity = "warning", Code = "flip", Action = "approximated", SourceShapeId = (string?)s.Attribute("ID"), Detail = "FlipX/FlipY is folded into geometry placement; canonical shapes have no flip" });
        var p = new Parsed { Shape = s, Master = null, PageIndex = pageIndex, NativeId = (string)s.Attribute("ID")!, Transform = parent.Then(local), ParentTransform = parent, ParentNative = parentNative };
        if ((string?)s.Attribute("Type") == "Group")
        {
            foreach (var c in raw.Element(V + "Shapes")?.Elements(V + "Shape") ?? [])
            {
                Walk(c, pageIndex, p.Transform, p.NativeId, outList, ref order, masterId);
                p.ChildNatives.Add((string)c.Attribute("ID")!);
            }
        }
        p.Order = order++; // children precede their group in canonical z-order
        outList.Add(p);
    }

    // ---------------- pages ----------------
    private Page BuildPage(int pi, XElement entry, XDocument contents, string pagePart, List<Parsed> shapes, Dictionary<string, string> ids, IdentityMap identity,
        Dictionary<string, byte[]> blobs, Dictionary<string, Asset> assets)
    {
        var sheet = entry.Element(V + "PageSheet");
        var widthPt = (Num(sheet, "PageWidth") ?? 11.69) * 72;
        var heightPt = (Num(sheet, "PageHeight") ?? 8.27) * 72;
        var pageIdText = sheet is null ? null : User(sheet, "AgentPageId");
        var pageId = IdentityMap.IsUuid(pageIdText) ? pageIdText! : identity.Derived("page", pi.ToString(Inv));
        var layerRows = sheet is null ? [] : Sections(sheet, "Layer").Elements(V + "Row").OrderBy(r => (int?)r.Attribute("IX") ?? 0).ToList();
        var layerIdJson = TryJson<List<string>>(sheet is null ? null : User(sheet, "AgentLayerIds"));
        var layers = layerRows.Select((r, i) => new Layer
        {
            Id = layerIdJson is { } l && l.Count == layerRows.Count && IdentityMap.IsUuid(l[i]) ? l[i] : identity.Derived("layer", $"{pi}:{(string?)r.Attribute("IX") ?? i.ToString(Inv)}"),
            Name = CellV(r, "Name") is { Length: > 0 } n ? n : $"Layer {i + 1}", Visible = Num(r, "Visible") != 0, Locked = Num(r, "Lock") == 1,
            Printable = Num(r, "Print") != 0, Snap = Num(r, "Snap") != 0, Glue = Num(r, "Glue") != 0,
        }).ToList();
        var layerByIx = layerRows.Select((r, i) => ((string?)r.Attribute("IX") ?? i.ToString(Inv), layers[i].Id)).ToDictionary(x => x.Item1, x => x.Item2);
        var grid = TryJson<PageGrid>(sheet is null ? null : User(sheet, "AgentGrid")) ?? new PageGrid { Visible = true, Snap = true, SpacingPt = (Num(sheet, "XGridSpacing") is double gs && gs > 0 ? gs * 72 : 72 / 25.4 * 5) };
        var guides = TryJson<List<Guide>>(sheet is null ? null : User(sheet, "AgentGuides")) ?? [];
        var background = sheet is null ? null : User(sheet, "AgentBackground");
        var page = new Page
        {
            Id = pageId, Name = (string?)entry.Attribute("NameU") ?? (string?)entry.Attribute("Name") ?? $"Page-{pi + 1}",
            WidthPt = widthPt, HeightPt = heightPt, Background = background is "none" || (background?.Length is 7 or 9 && background[0] == '#') ? background! : "#FFFFFF",
            Grid = grid, Guides = guides, Layers = layers, Elements = [],
        };
        var key = (Parsed p) => $"{p.PageIndex}:{p.NativeId}";
        (diagPage, diagIds) = (pageId, ids);
        var byNative = shapes.ToDictionary(p => p.NativeId);
        var rels = RelsOf(pagePart);
        var connects = contents.Root!.Element(V + "Connects")?.Elements(V + "Connect").ToList() ?? [];
        var elements = new List<Element>();
        var aliases = new HashSet<string>();
        var z = 0;
        foreach (var p in shapes.OrderBy(p => p.Order))
        {
            var id = ids[key(p)];
            var el = BuildElement(p, id, page, byNative, ids, connects, rels, pagePart, blobs, assets, layerByIx);
            if (el is null) continue;
            el = WithZ(el, z++);
            var alias = User(p.Shape, "AgentAlias");
            if (alias is not null && System.Text.RegularExpressions.Regex.IsMatch(alias, "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$"))
            {
                if (aliases.Add(alias)) el = WithAlias(el, alias);
                else diagnostics.Add(new Diagnostic { Severity = "warning", Code = "duplicate_alias", Action = "dropped", PageId = pageId, ElementId = id, SourceShapeId = p.NativeId, Detail = $"alias '{alias}' already used on this page" });
            }
            elements.Add(el);
        }
        // Groups: children must exist; canonical bounds are derived (R4).
        var present = elements.Select(e => e.Id()).ToHashSet();
        for (var i = 0; i < elements.Count; i++)
            if (elements[i] is GroupElement g)
            {
                var kids = g.ChildIds.Where(present.Contains).ToList();
                elements[i] = g with { ChildIds = kids };
            }
        elements.RemoveAll(e => e is GroupElement { ChildIds.Count: 0 });
        var map = elements.ToDictionary(e => e.Id());
        foreach (var g in elements.OfType<GroupElement>().ToList())
        {
            var derived = GroupBounds.Derive(map, g.Id);
            if (derived is not null) { var ng = g with { Bounds = derived }; map[g.Id] = ng; elements[elements.FindIndex(e => e.Id() == g.Id)] = ng; }
        }
        // Children-first ordering can still leave nested groups derived before parents; derive bottom-up again.
        foreach (var g in elements.OfType<GroupElement>().ToList())
        {
            var derived = GroupBounds.Derive(map, g.Id);
            if (derived is not null) { var ng = g with { Bounds = derived }; map[g.Id] = ng; elements[elements.FindIndex(e => e.Id() == g.Id)] = ng; }
        }
        return page with { Elements = elements };
    }

    private static Element WithZ(Element e, int z) => e switch
    {
        ShapeElement s => s with { ZIndex = z }, TextElement t => t with { ZIndex = z }, ImageElement i => i with { ZIndex = z },
        ConnectorElement c => c with { ZIndex = z }, GroupElement g => g with { ZIndex = z }, _ => e,
    };

    private static Element WithAlias(Element e, string a) => e switch
    {
        ShapeElement s => s with { Alias = a }, TextElement t => t with { Alias = a }, ImageElement i => i with { Alias = a },
        ConnectorElement c => c with { Alias = a }, GroupElement g => g with { Alias = a }, _ => e,
    };

    // ---------------- elements ----------------
    private Element? BuildElement(Parsed p, string id, Page page, Dictionary<string, Parsed> byNative, Dictionary<string, string> ids, List<XElement> connects,
        Dictionary<string, (string Type, string Target)> rels, string pagePart, Dictionary<string, byte[]> blobs, Dictionary<string, Asset> assets, Dictionary<string, string> layerByIx)
    {
        var s = p.Shape;
        var type = (string?)s.Attribute("Type") ?? "Shape";
        var layerIds = (CellV(s, "LayerMember") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries).Select(ix => layerByIx.GetValueOrDefault(ix)).OfType<string>().Distinct().ToList();
        var locked = User(s, "AgentLocked") == "1" || (Num(s, "LockMoveX") == 1 && Num(s, "LockMoveY") == 1);
        var hidden = User(s, "AgentHidden") == "1";
        var metadata = Metadata(s);
        var name = (string?)s.Attribute("Name");
        if (name is not null && System.Text.RegularExpressions.Regex.IsMatch(name, @"^(shape|text|image|connector|group|Dynamic connector)\.\d+$")) name = null;
        if (type == "Guide") { Diag("info", "guide_shape", "dropped", p, "Visio guide shapes are not canonical elements"); return null; }
        if (type == "Group")
        {
            if (Sections(s, "Geometry").Any(g => Num(g, "NoShow") != 1) || !string.IsNullOrEmpty(TextOf(s)))
                Diag("warning", "group_own_content", "dropped", p, "a group's own geometry/text is not kept; add it as a child to preserve it");
            return new GroupElement
            {
                Id = id, Name = name, LayerIds = layerIds, Locked = locked, Hidden = hidden, Metadata = metadata,
                ChildIds = p.ChildNatives.Select(n => ids[$"{p.PageIndex}:{n}"]).ToList(), Bounds = new Bounds(), RotationDeg = 0,
            };
        }
        if (CellV(s, "BeginX") is not null || CellNum(s, p.Master, "ObjType") == 2) return BuildConnector(p, id, page, byNative, ids, connects, layerIds, locked, hidden, metadata, name);
        double wIn = CellNum(s, p.Master, "Width") ?? 0, hIn = CellNum(s, p.Master, "Height") ?? 0;
        var (bounds, rotation) = BoxGeometry(p.Transform, wIn, hIn);
        if (type == "Foreign") return BuildImage(p, id, bounds, rotation, rels, pagePart, blobs, assets, layerIds, locked, hidden, metadata, name);
        var sections = Sections(s, "Geometry").ToList();
        if (sections.Count == 0 && p.Master is not null) sections = Sections(p.Master, "Geometry").ToList();
        var (subpaths, approx) = GeometryMap.FromSections(V, sections, wIn, hIn, hidden && sections.All(g => Num(g, "NoShow") == 1));
        foreach (var a in approx.Distinct()) Diag("info", "geometry_row", "approximated", p, $"{a} rows approximated with cubic/line segments");
        var style = ShapeStyleOf(s, p.Master, sections);
        var text = TextOf(s);
        var block = TextBlockOf(s, p.Master, text ?? "");
        var kindHint = User(s, "AgentKind");
        var preset = User(s, "AgentPreset");
        var hash = User(s, "AgentGeomHash");
        string? geometryPreset;
        string? svgPath = null;
        if (preset is not null && hash == GeometryMap.Hash(subpaths)) geometryPreset = preset == "text" ? null : preset;
        else
        {
            if (preset is not null) Diag("warning", "stale_preset", "approximated", p, $"geometry edited in Visio; '{preset}' metadata ignored and outline kept as a custom path");
            geometryPreset = GeometryMap.IsBox(subpaths) ? "rectangle" : subpaths.Count == 0 ? "rectangle" : "custom";
            if (geometryPreset == "custom") svgPath = GeometryMap.ToUnitPath(subpaths);
        }
        var isText = kindHint == "text" || (kindHint is null && text is not null && style.Fill == "none" && style.Stroke == "none");
        if (isText)
            return new TextElement { Id = id, Name = name, LayerIds = layerIds, Locked = locked, Hidden = hidden, Metadata = metadata, Bounds = bounds, RotationDeg = rotation, Style = style, Text = block };
        double? radius = double.TryParse(User(s, "AgentCornerRadius"), NumberStyles.Float, Inv, out var r) ? r : null;
        var ports = Sections(s, "Connection").Elements(V + "Row").Select(row => (Name: (string?)row.Attribute("N"), X: Num(row, "X"), Y: Num(row, "Y")))
            .Where(x => x.Name is not null && !DirectVsdxExporter.DefaultPorts.ContainsKey(x.Name) && System.Text.RegularExpressions.Regex.IsMatch(x.Name, "^[A-Za-z_][A-Za-z0-9_-]{0,63}$") && x.X is not null && x.Y is not null)
            .Select(x => new Port { Name = x.Name!, X = Math.Clamp(wIn == 0 ? 0 : x.X!.Value / wIn, 0, 1), Y = Math.Clamp(hIn == 0 ? 0 : 1 - x.Y!.Value / hIn, 0, 1) }).ToList();
        return new ShapeElement
        {
            Id = id, Name = name, LayerIds = layerIds, Locked = locked, Hidden = hidden, Metadata = metadata, Bounds = bounds, RotationDeg = rotation,
            Geometry = new ShapeGeometry { Preset = geometryPreset ?? "rectangle", SvgPath = svgPath, CornerRadiusPt = radius },
            Style = style, Text = text is null ? null : block, Ports = ports.Count > 0 ? ports : null,
        };
    }

    private static (Bounds, double) BoxGeometry(Affine t, double wIn, double hIn)
    {
        var (cx, cy) = t.Map(wIn / 2, hIn / 2);
        var (ox, oy) = t.Map(0, 0);
        var (xx, xy) = t.Map(1, 0);
        double w = Math.Sqrt(Math.Pow(t.Map(wIn, 0).X - ox, 2) + Math.Pow(t.Map(wIn, 0).Y - oy, 2));
        double h = Math.Sqrt(Math.Pow(t.Map(0, hIn).X - ox, 2) + Math.Pow(t.Map(0, hIn).Y - oy, 2));
        var deg = Math.Atan2(xy - oy, xx - ox) * 180 / Math.PI;
        deg = Math.Round(deg, 9);
        if (deg <= -360 || deg >= 360) deg %= 360;
        if (Math.Abs(deg) < 1e-9) deg = 0;
        return (new Bounds { X = cx - w / 2, Y = cy - h / 2, Width = w, Height = h }, deg);
    }

    private Dictionary<string, string> Metadata(XElement s)
    {
        var meta = new Dictionary<string, string>();
        foreach (var row in Sections(s, "Property").Elements(V + "Row"))
        {
            var label = CellV(row, "Label") ?? (string?)row.Attribute("N") ?? "";
            var value = CellV(row, "Value") ?? "";
            if (label.Length == 0 || label.Length > 256 || meta.Count >= 256) continue;
            meta[label] = value.Length > 4096 ? value[..4096] : value;
        }
        return meta;
    }

    private static string? TextOf(XElement s)
    {
        var t = s.Element(V + "Text");
        if (t is null) return null;
        var value = string.Concat(t.Nodes().OfType<XText>().Select(x => x.Value)).Replace("\r\n", "\n").Replace('\r', '\n').TrimEnd('\n');
        return value;
    }

    /// <summary>
    /// A colour cell of <paramref name="owner"/> (the shape, or a Character row). A themed cell
    /// (THEMEVAL formula or V="Themed") that was inherited from a style sheet or master is resolved
    /// from the theme through the shape's QuickStyle colour index, because its cached value belongs
    /// to another context. A themed value cached on the shape itself is trusted.
    /// </summary>
    private string CellColour(XElement owner, XElement shape, string cell, string quickStyleCell, string fallback)
    {
        var c = owner.Elements(V + "Cell").FirstOrDefault(x => (string?)x.Attribute("N") == cell);
        var v = (string?)c?.Attribute("V");
        var f = (string?)c?.Attribute("F");
        var themed = v == "Themed" || (f is not null && (f.Contains("THEMEVAL", StringComparison.OrdinalIgnoreCase) || f.Contains("THEME(", StringComparison.OrdinalIgnoreCase)));
        var inherited = c?.Attribute(SheetInheritance.OriginAttr) is not null;
        var cachedUsable = v is { Length: 7 } && v[0] == '#';
        if (themed && (inherited || !cachedUsable) && theme.Available && Num(shape, quickStyleCell) is double q)
        {
            var variation = Num(shape, "VariationColorIndex") is double vi && vi is >= 0 and < 100 ? (int)vi : 0;
            if (theme.ForQuickStyle((int)q, variation) is { } rgb) { themedColours++; return rgb; }
        }
        return Colour(v == "Themed" ? null : v, f, fallback);
    }

    /// <summary>
    /// ShapeRouteStyle 2 is straight; with ConLineRouteExt=1 (straight lines) the page-default (0)
    /// and centre-to-centre (16) styles are straight too; ConLineRouteExt=2 is curved.
    /// </summary>
    internal static string RouteOf(double shapeRouteStyle, double lineRouteExt) =>
        lineRouteExt == 2 ? "curved"
        : shapeRouteStyle == 2 || (lineRouteExt == 1 && shapeRouteStyle is 0 or 16) ? "straight"
        : "orthogonal";

    private string Colour(string? v, string? formula, string fallback)
    {
        if (v is { Length: 7 } && v[0] == '#') return v.ToUpperInvariant();
        if (int.TryParse(v, NumberStyles.Integer, Inv, out var ix) && colorTable.TryGetValue(ix, out var c)) return c.ToUpperInvariant();
        if (formula is not null && System.Text.RegularExpressions.Regex.Match(formula, @"RGB\((\d+),\s*(\d+),\s*(\d+)\)") is { Success: true } m)
            return $"#{int.Parse(m.Groups[1].Value):X2}{int.Parse(m.Groups[2].Value):X2}{int.Parse(m.Groups[3].Value):X2}";
        return fallback;
    }

    private static string WithAlpha(string rgb, double trans) => trans <= 1e-9 ? rgb : $"{rgb}{(int)Math.Round((1 - Math.Clamp(trans, 0, 1)) * 255):X2}";

    private ShapeStyle ShapeStyleOf(XElement s, XElement? master, List<XElement> geometry)
    {
        var noFill = geometry.Count > 0 && geometry.All(g => Num(g, "NoFill") == 1);
        var noLine = geometry.Count > 0 && geometry.All(g => Num(g, "NoLine") == 1);
        var fillPattern = CellNum(s, master, "FillPattern") ?? 1;
        var fill = noFill || fillPattern == 0 ? "none" : CellColour(s, s, "FillForegnd", "QuickStyleFillColor", "#FFFFFF");
        var fillTrans = CellNum(s, master, "FillForegndTrans") ?? 0;
        var linePattern = CellNum(s, master, "LinePattern") ?? 1;
        var stroke = noLine || linePattern == 0 ? "none" : WithAlpha(CellColour(s, s, "LineColor", "QuickStyleLineColor", "#000000"), CellNum(s, master, "LineColorTrans") ?? 0);
        var dash = linePattern switch { 2 => "dash", 3 => "dot", 4 => "dashDot", _ => "solid" };
        if (linePattern > 4) diagnostics.Add(new Diagnostic { Severity = "info", Code = "line_pattern", Action = "approximated", SourceShapeId = (string?)s.Attribute("ID"), Detail = $"line pattern {linePattern} mapped to dash" });
        var custom = (User(s, "AgentLineStyle") ?? "").Split(';');
        return new ShapeStyle
        {
            Fill = fill, FillOpacity = Math.Clamp(1 - fillTrans, 0, 1), Stroke = stroke, StrokeWidthPt = Math.Round((CellNum(s, master, "LineWeight") ?? 1.0 / 72) * 72, 9),
            Dash = linePattern > 4 ? "dash" : dash,
            LineCap = custom.Length == 2 ? custom[0] : (CellNum(s, master, "LineCap") ?? 2) switch { 0 => "round", 1 => "square", _ => "butt" },
            LineJoin = custom.Length == 2 ? custom[1] : "miter",
        };
    }

    private TextBlock TextBlockOf(XElement s, XElement? master, string value)
    {
        var ch = Sections(s, "Character").Elements(V + "Row").FirstOrDefault() ?? (master is null ? null : Sections(master, "Character").Elements(V + "Row").FirstOrDefault());
        var para = Sections(s, "Paragraph").Elements(V + "Row").FirstOrDefault() ?? (master is null ? null : Sections(master, "Paragraph").Elements(V + "Row").FirstOrDefault());
        var fontIx = (int)(Num(ch, "Font") ?? 0);
        var style = (int)(Num(ch, "Style") ?? 0);
        var colour = WithAlpha(ch is null ? "#000000" : CellColour(ch, s, "Color", "QuickStyleFontColor", "#000000"), Num(ch, "ColorTrans") ?? 0);
        return new TextBlock
        {
            Value = value, FontFamily = fontIx >= 0 && fontIx < faceNames.Count ? faceNames[fontIx] : "Calibri", FontSizePt = Math.Round((Num(ch, "Size") ?? 11.0 / 72) * 72, 6),
            Bold = (style & 1) != 0, Italic = (style & 2) != 0, Underline = (style & 4) != 0, Colour = colour,
            HorizontalAlign = (Num(para, "HorzAlign") ?? 1) switch { 0 => "left", 2 => "right", _ => "center" },
            VerticalAlign = (CellNum(s, master, "VerticalAlign") ?? 1) switch { 0 => "top", 2 => "bottom", _ => "middle" },
            Wrap = User(s, "AgentTextWrap") != "0", PaddingPt = Math.Round((CellNum(s, master, "LeftMargin") ?? 4.0 / 72) * 72, 6),
        };
    }

    private Element BuildConnector(Parsed p, string id, Page page, Dictionary<string, Parsed> byNative, Dictionary<string, string> ids, List<XElement> connects,
        List<string> layerIds, bool locked, bool hidden, Dictionary<string, string> metadata, string? name)
    {
        var s = p.Shape;
        var begin = p.ParentTransform.Map(CellNum(s, p.Master, "BeginX") ?? 0, CellNum(s, p.Master, "BeginY") ?? 0);
        var end = p.ParentTransform.Map(CellNum(s, p.Master, "EndX") ?? 0, CellNum(s, p.Master, "EndY") ?? 0);
        Endpoint EndOf(string cell, (double X, double Y) point)
        {
            var c = connects.FirstOrDefault(x => (string?)x.Attribute("FromSheet") == p.NativeId && (string?)x.Attribute("FromCell") == cell);
            if (c is null) return new Endpoint { Glue = "none", Point = new Point { X = point.X, Y = point.Y } };
            var toSheet = (string)c.Attribute("ToSheet")!;
            if (!byNative.TryGetValue(toSheet, out var target) || !ids.TryGetValue($"{p.PageIndex}:{toSheet}", out var targetId) || CellV(target.Shape, "BeginX") is not null)
            {
                Diag("warning", "glue_lost", "approximated", p, $"glue target shape {toSheet} is not imported; endpoint kept as a free point");
                return new Endpoint { Glue = "none", Point = new Point { X = point.X, Y = point.Y } };
            }
            var toCell = (string?)c.Attribute("ToCell") ?? "PinX";
            var m = System.Text.RegularExpressions.Regex.Match(toCell, @"^Connections\.(?:X(\d+)|([A-Za-z_][\w-]*)\.X)$");
            if (!m.Success) return new Endpoint { ElementId = targetId, Glue = "dynamic" };
            string? port;
            if (m.Groups[1].Success)
            {
                var ix = int.Parse(m.Groups[1].Value, Inv) - 1;
                var rows = Sections(target.Shape, "Connection").Elements(V + "Row").OrderBy(r => (int?)r.Attribute("IX") ?? 0).ToList();
                if (rows.Count == 0 && target.Master is not null) rows = Sections(target.Master, "Connection").Elements(V + "Row").ToList();
                port = ix >= 0 && ix < rows.Count ? (string?)rows[ix].Attribute("N") : null;
                port ??= ix >= 0 && ix < DirectVsdxExporter.PortOrder.Length && rows.Count == 0 ? DirectVsdxExporter.PortOrder[ix] : $"p{ix + 1}";
            }
            else port = m.Groups[2].Value;
            if (!DirectVsdxExporter.DefaultPorts.ContainsKey(port) && !Sections(target.Shape, "Connection").Elements(V + "Row").Any(r => (string?)r.Attribute("N") == port))
            {
                Diag("info", "port_normalised", "approximated", p, $"connection point {toCell} became dynamic glue");
                return new Endpoint { ElementId = targetId, Glue = "dynamic" };
            }
            return new Endpoint { ElementId = targetId, Glue = "static", Port = port };
        }
        var from = EndOf("BeginX", begin);
        var to = EndOf("EndX", end);
        var waypoints = TryJson<List<Point>>(User(s, "AgentWaypoints")) ?? [];
        var geoRows = Sections(s, "Geometry").Elements(V + "Row").Count();
        if (User(s, "AgentWaypoints") is null && geoRows > 2) Diag("info", "route_normalised", "approximated", p, "Visio route points are derived geometry; no canonical waypoints imported");
        var fallback = TryJson<Bounds>(User(s, "AgentFallbackBounds"))
            ?? new Bounds { X = Math.Min(begin.X, end.X), Y = Math.Min(begin.Y, end.Y), Width = Math.Abs(end.X - begin.X), Height = Math.Abs(end.Y - begin.Y) };
        var route = User(s, "AgentRoute") is { } rt && rt is "straight" or "orthogonal" or "curved" ? rt
            : RouteOf(CellNum(s, p.Master, "ShapeRouteStyle") ?? 0, CellNum(s, p.Master, "ConLineRouteExt") ?? 0);
        var linePattern = CellNum(s, p.Master, "LinePattern") ?? 1;
        string Arrow(double? code)
        {
            var c = (int)(code ?? 0);
            var hit = DirectVsdxExporter.ArrowCodes.FirstOrDefault(kv => kv.Value == c).Key;
            if (hit is null) { Diag("info", "arrow_head", "approximated", p, $"arrow head {c} mapped to triangle"); return "triangle"; }
            return hit;
        }
        var label = TextOf(s);
        return new ConnectorElement
        {
            Id = id, Name = name, LayerIds = layerIds, Locked = locked, Hidden = hidden, Metadata = metadata, Bounds = fallback, RotationDeg = 0,
            From = from, To = to, Route = route, Waypoints = waypoints,
            Style = new LineStyle
            {
                Stroke = CellColour(s, s, "LineColor", "QuickStyleLineColor", "#000000"), StrokeWidthPt = Math.Max(0.01, Math.Round((CellNum(s, p.Master, "LineWeight") ?? 1.0 / 72) * 72, 9)),
                Dash = linePattern switch { 2 => "dash", 3 => "dot", 4 => "dashDot", _ => "solid" },
                StartArrow = Arrow(CellNum(s, p.Master, "BeginArrow")), EndArrow = Arrow(CellNum(s, p.Master, "EndArrow")),
            },
            Label = label is { Length: > 0 } ? TextBlockOf(s, p.Master, label) : null,
        };
    }

    private Element? BuildImage(Parsed p, string id, Bounds bounds, double rotation, Dictionary<string, (string Type, string Target)> rels, string pagePart,
        Dictionary<string, byte[]> blobs, Dictionary<string, Asset> assets, List<string> layerIds, bool locked, bool hidden, Dictionary<string, string> metadata, string? name)
    {
        var s = p.Shape;
        var fd = s.Element(V + "ForeignData");
        var rid = (string?)fd?.Element(V + "Rel")?.Attribute(R + "id");
        if (fd is null || rid is null || !rels.TryGetValue(rid, out var rel) || (string?)fd.Attribute("ForeignType") is not ("Bitmap" or null))
        {
            Diag("warning", "foreign_object", "dropped", p, $"foreign object ({(string?)fd?.Attribute("ForeignType") ?? "unknown"}) is not a supported picture");
            return null;
        }
        var part = Resolve(Path.GetDirectoryName(pagePart)!.Replace('\\', '/'), rel.Target);
        var bytes = Bytes(zip, part);
        var mime = Sniff(bytes);
        if (mime is null) { Diag("warning", "picture_format", "dropped", p, $"picture format of '{part}' is not PNG/JPEG/BMP"); return null; }
        var dims = RasterSize(mime, bytes);
        if (dims is null || dims.Value.W <= 0 || dims.Value.H <= 0 || dims.Value.W > 16384 || dims.Value.H > 16384 || (long)dims.Value.W * dims.Value.H > 64L * 1024 * 1024)
        { Diag("warning", "picture_limits", "dropped", p, "picture header is malformed or exceeds the pixel budget"); return null; }
        var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var recordedSha = User(s, "AssetSha256");
        var recordedId = User(s, "AssetId");
        Asset asset;
        if (recordedSha == sha && recordedId is not null && System.Text.RegularExpressions.Regex.IsMatch(recordedId, @"^asset:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(~[0-9a-f]{64})?$"))
        {
            var svgSha = User(s, "SvgSourceSha256");
            var svgRel = rels.Values.FirstOrDefault(r => r.Type == RelSvgSource && r.Target.Contains(svgSha?[..Math.Min(16, svgSha.Length)] ?? "\0"));
            byte[]? svg = null;
            if (svgSha is not null && svgRel.Target is not null)
            {
                var src = Bytes(zip, Resolve(Path.GetDirectoryName(pagePart)!.Replace('\\', '/'), svgRel.Target));
                if (Convert.ToHexString(SHA256.HashData(src)).ToLowerInvariant() == svgSha) svg = src;
            }
            if (svgSha is not null && svg is null) Diag("warning", "svg_source_missing", "approximated", p, "SVG source not found in the package; the PNG derivative is imported");
            asset = svg is not null
                ? new Asset { Id = recordedId, Name = SlugName(recordedId), MimeType = "image/svg+xml", Sha256 = svgSha!, Tags = [], Provenance = "imported from VSDX (app-authored SVG source)", WidthPx = dims.Value.W, HeightPx = dims.Value.H }
                : new Asset { Id = recordedId, Name = SlugName(recordedId), MimeType = mime, Sha256 = sha, Tags = [], Provenance = "imported from VSDX (app-authored)", WidthPx = dims.Value.W, HeightPx = dims.Value.H };
            if (svg is not null) blobs[svgSha!] = svg; else blobs[sha] = bytes;
        }
        else
        {
            if (recordedSha is not null && recordedSha != sha)
                Diag("warning", "stale_image_provenance", "dropped", p, "picture bytes changed in Visio; recorded asset ID/SVG source ignored");
            asset = new Asset { Id = $"asset:image~{sha}", Name = $"image-{sha[..8]}", MimeType = mime, Sha256 = sha, Tags = [], Provenance = "imported from VSDX", WidthPx = dims.Value.W, HeightPx = dims.Value.H };
            blobs[sha] = bytes;
        }
        if (assets.TryGetValue(asset.Id, out var existing) && existing.Sha256 != asset.Sha256)
        {
            asset = asset with { Id = $"{asset.Id.Split('~')[0]}~{asset.Sha256}" };
            Diag("info", "asset_version", "regenerated", p, $"asset ID collision resolved as version {asset.Id}");
        }
        assets.TryAdd(asset.Id, asset);
        var fit = User(s, "AgentFit") is { } f && f is "contain" or "cover" or "stretch" ? f : "stretch";
        var transparency = Sections(s, "Image").Elements(V + "Row").Select(r => Num(r, "Transparency")).FirstOrDefault() ?? 0;
        return new ImageElement
        {
            Id = id, Name = name, LayerIds = layerIds, Locked = locked, Hidden = hidden, Metadata = metadata, Bounds = bounds, RotationDeg = rotation,
            AssetId = asset.Id, Fit = fit, Opacity = Math.Clamp(Math.Round(1 - transparency, 6), 0, 1), PreserveAspectRatio = User(s, "AgentAspect") != "0" && fit != "stretch",
        };
    }

    private static string SlugName(string assetId) => assetId["asset:".Length..].Split('~')[0];

    internal static string? Sniff(byte[] b)
    {
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 2 && b[0] == (byte)'B' && b[1] == (byte)'M') return "image/bmp";
        return null;
    }

    internal static (int W, int H)? RasterSize(string mime, byte[] b)
    {
        try
        {
            switch (mime)
            {
                case "image/png" when b.Length >= 24: return ((int)System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(16)), (int)System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(20)));
                case "image/bmp" when b.Length >= 26: return (BitConverter.ToInt32(b, 18), Math.Abs(BitConverter.ToInt32(b, 22)));
                case "image/jpeg":
                    for (var i = 2; i + 9 < b.Length;)
                    {
                        if (b[i] != 0xFF) return null;
                        var marker = b[i + 1];
                        if (marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
                        var len = (b[i + 2] << 8) | b[i + 3];
                        if (marker >= 0xC0 && marker <= 0xCF && marker is not 0xC4 and not 0xC8 and not 0xCC) return ((b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]);
                        i += 2 + len;
                    }
                    return null;
            }
        }
        catch (Exception) { return null; }
        return null;
    }

    private string? diagPage;
    private Dictionary<string, string>? diagIds;

    private void Diag(string severity, string code, string action, Parsed p, string detail) =>
        diagnostics.Add(new Diagnostic
        {
            Severity = severity, Code = code, Action = action, SourceShapeId = p.NativeId, Detail = detail,
            PageId = diagPage, ElementId = diagIds?.GetValueOrDefault($"{p.PageIndex}:{p.NativeId}"),
        });

    private static T? TryJson<T>(string? json) where T : class
    {
        if (json is null) return null;
        try { return JsonSerializer.Deserialize<T>(json, ContractJson.Options); } catch (Exception) { return null; }
    }
}

/// <summary>Canonical group bounds (R4), identical to the frontend's deriveGroupBounds.</summary>
public static class GroupBounds
{
    public static Bounds? Derive(IReadOnlyDictionary<string, Element> byId, string groupId, HashSet<string>? seen = null)
    {
        seen ??= [];
        if (!byId.TryGetValue(groupId, out var g) || g is not GroupElement ge || !seen.Add(groupId)) return null;
        Bounds? acc = null;
        foreach (var c in ge.ChildIds)
        {
            if (!byId.TryGetValue(c, out var child)) continue;
            var b = child switch
            {
                GroupElement => Derive(byId, c, seen),
                ConnectorElement ce => Authored(ce),
                ShapeElement s => Rotated(s.Bounds, s.RotationDeg),
                TextElement t => Rotated(t.Bounds, t.RotationDeg),
                ImageElement i => Rotated(i.Bounds, i.RotationDeg),
                _ => null,
            };
            if (b is not null) acc = acc is null ? b : Union(acc, b);
        }
        return acc;
    }

    public static Bounds Rotated(Bounds b, double deg)
    {
        if (deg % 360 == 0) return b with { };
        double cx = b.X + b.Width / 2, cy = b.Y + b.Height / 2, r = deg * Math.PI / 180, cos = Math.Cos(r), sin = Math.Sin(r);
        var pts = new[] { (b.X, b.Y), (b.X + b.Width, b.Y), (b.X + b.Width, b.Y + b.Height), (b.X, b.Y + b.Height) }
            .Select(p => (X: cx + (p.Item1 - cx) * cos - (p.Item2 - cy) * sin, Y: cy + (p.Item1 - cx) * sin + (p.Item2 - cy) * cos)).ToList();
        return Of(pts);
    }

    private static Bounds Authored(ConnectorElement c)
    {
        var pts = new List<(double X, double Y)> { (c.Bounds.X, c.Bounds.Y), (c.Bounds.X + c.Bounds.Width, c.Bounds.Y + c.Bounds.Height) };
        pts.AddRange(c.Waypoints.Select(p => (p.X, p.Y)));
        if (c.From.Point is { } f && c.From.ElementId is null) pts.Add((f.X, f.Y));
        if (c.To.Point is { } t && c.To.ElementId is null) pts.Add((t.X, t.Y));
        return Of(pts);
    }

    private static Bounds Of(List<(double X, double Y)> pts)
    {
        double minX = pts.Min(p => p.X), minY = pts.Min(p => p.Y), maxX = pts.Max(p => p.X), maxY = pts.Max(p => p.Y);
        return new Bounds { X = minX, Y = minY, Width = maxX - minX, Height = maxY - minY };
    }

    private static Bounds Union(Bounds a, Bounds b) => Of([(a.X, a.Y), (a.X + a.Width, a.Y + a.Height), (b.X, b.Y), (b.X + b.Width, b.Y + b.Height)]);
}
