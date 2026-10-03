using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Diagram.Core.Contracts;
using Diagram.Visio;
using Diagram.Visio.Abstractions;

namespace Diagram.Visio.Tests;

public static class Bytes
{
    public static byte[] Png(int w, int h, byte r = 30, byte g = 120, byte b = 200)
    {
        var raw = new byte[h * (1 + w * 3)];
        for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) { var o = y * (1 + w * 3) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
        using var idat = new MemoryStream();
        using (var z = new ZLibStream(idat, CompressionLevel.Fastest, true)) z.Write(raw);
        using var png = new MemoryStream();
        png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var ihdr = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(ihdr, w); BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(4), h); ihdr[8] = 8; ihdr[9] = 2;
        Chunk(png, "IHDR", ihdr); Chunk(png, "IDAT", idat.ToArray()); Chunk(png, "IEND", []);
        return png.ToArray();
    }
    private static void Chunk(Stream s, string type, byte[] data)
    {
        var len = new byte[4]; BinaryPrimitives.WriteInt32BigEndian(len, data.Length); s.Write(len);
        var typed = Encoding.ASCII.GetBytes(type).Concat(data).ToArray(); s.Write(typed);
        uint crc = 0xFFFFFFFF; foreach (var x in typed) { crc ^= x; for (var k = 0; k < 8; k++) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320 : crc >> 1; }
        BinaryPrimitives.WriteUInt32BigEndian(len, ~crc); s.Write(len);
    }
    /// <summary>A real baseline JPEG (64×32 gradient, encoded by ImageMagick). The earlier header-only stub crashed Visio.</summary>
    public static byte[] Jpeg() => Convert.FromBase64String(JpegBase64);
    private const string JpegBase64 = "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAgAEADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAUG/8QAFhAAAwAAAAAAAAAAAAAAAAAAABRh/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAUH/8QAFhEAAwAAAAAAAAAAAAAAAAAAABVh/9oADAMBAAIRAxEAPwDNrwLwrLwLwsvaQEUJK8C8Ky8C8D2hFCSvAvCsvAvA9oRQkrwLwrLwLwPaEUKy8C8Kq8C8MZe02VFCUvAvCqvAvA9oRQlLwLwqrwLwPaEUJS8C8Kq8C8D2hFD/2Q==";
    public static byte[] Bmp(int w, int h)
    {
        var b = new byte[54 + w * h * 4];
        b[0] = (byte)'B'; b[1] = (byte)'M'; BitConverter.GetBytes(b.Length).CopyTo(b, 2); BitConverter.GetBytes(54).CopyTo(b, 10); BitConverter.GetBytes(40).CopyTo(b, 14);
        BitConverter.GetBytes(w).CopyTo(b, 18); BitConverter.GetBytes(h).CopyTo(b, 22); b[26] = 1; b[28] = 32;
        return b;
    }
    public static readonly byte[] Svg = Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 20 10\"><rect width=\"20\" height=\"10\" fill=\"#2CA02C\"/></svg>");
    public static string Sha(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();
}

public sealed class Blobs : IAssetBlobSource
{
    public Dictionary<string, byte[]> Map { get; } = new();
    public Dictionary<string, byte[]> Raster { get; } = new();
    public string Add(byte[] b) { var s = Bytes.Sha(b); Map[s] = b; return s; }
    public Task<ReadOnlyMemory<byte>> ReadAsync(string sha, CancellationToken ct) => Task.FromResult<ReadOnlyMemory<byte>>(Map[sha]);
    public Task<ReadOnlyMemory<byte>?> ReadRasterFallbackAsync(string sha, CancellationToken ct) => Task.FromResult(Raster.TryGetValue(sha, out var r) ? (ReadOnlyMemory<byte>?)r : null);
}

/// <summary>Canonical scene covering the supported matrix; ids are fixed so tests can address them.</summary>
public static class Scene
{
    public static string Id(int n) => $"00000000-0000-4000-8000-{n:x12}";
    public static readonly string Doc = Id(1), Page1 = Id(2), Page2 = Id(3), LayerA = Id(4), LayerB = Id(5);
    public static readonly string[] Presets = ["rectangle", "roundedRect", "ellipse", "diamond", "triangle", "hexagon", "parallelogram", "cylinder", "cloud", "callout", "server", "database", "application", "user", "document"];

    public static ShapeStyle Style(string fill = "#FFFFFF", string stroke = "#333333", double w = 1, string dash = "solid", double fillOpacity = 1) =>
        new() { Fill = fill, FillOpacity = fillOpacity, Stroke = stroke, StrokeWidthPt = w, Dash = dash, LineCap = "butt", LineJoin = "miter" };
    public static TextBlock Text(string v, string h = "center", string va = "middle", bool bold = false, double size = 11, bool wrap = true, double pad = 4) =>
        new() { Value = v, FontFamily = "Calibri", FontSizePt = size, Bold = bold, Italic = false, Underline = false, Colour = "#000000", HorizontalAlign = h, VerticalAlign = va, Wrap = wrap, PaddingPt = pad };

    public static (DiagramDocument Doc, Blobs Blobs) Build()
    {
        var blobs = new Blobs();
        var png = blobs.Add(Bytes.Png(40, 20));
        var jpg = blobs.Add(Bytes.Jpeg());
        var bmp = blobs.Add(Bytes.Bmp(8, 8));
        var svg = blobs.Add(Bytes.Svg);
        blobs.Raster[svg] = Bytes.Png(20, 10, 44, 160, 44);
        var assets = new List<Asset>
        {
            new() { Id = "asset:logo", Name = "Logo", MimeType = "image/png", Sha256 = png, WidthPx = 40, HeightPx = 20, Tags = ["logo"] },
            new() { Id = "asset:photo", Name = "Photo", MimeType = "image/jpeg", Sha256 = jpg, WidthPx = 64, HeightPx = 32, Tags = [] },
            new() { Id = "asset:bitmap", Name = "Bitmap", MimeType = "image/bmp", Sha256 = bmp, WidthPx = 8, HeightPx = 8, Tags = [] },
            new() { Id = "asset:vector", Name = "Vector", MimeType = "image/svg+xml", Sha256 = svg, WidthPx = 20, HeightPx = 10, Tags = [] },
        };
        var els = new List<Element>();
        var z = 0;
        for (var i = 0; i < Presets.Length; i++)
            els.Add(new ShapeElement
            {
                Id = Id(100 + i), Alias = $"p{i}", LayerIds = [], ZIndex = z++, Bounds = new Bounds { X = 20 + (i % 5) * 110, Y = 20 + i / 5 * 80, Width = 90, Height = 60 },
                Metadata = i == 0 ? new() { ["owner"] = "Ops", ["cost centre"] = "42" } : new(), Geometry = new ShapeGeometry { Preset = Presets[i], CornerRadiusPt = Presets[i] == "roundedRect" ? 8 : null },
                Style = Style(fill: i == 1 ? "#1F77B480" : "#FFFFFF", dash: i == 2 ? "dash" : "solid", fillOpacity: i == 3 ? 0.5 : 1), Text = Text($"P{i}", bold: i == 0),
                RotationDeg = i == 4 ? 33 : 0, Ports = i == 5 ? [new Port { Name = "tap", X = 0.25, Y = 0 }] : null,
            });
        // text box, locked + hidden + layers
        els.Add(new TextElement { Id = Id(200), Alias = "note", LayerIds = [LayerA, LayerB], ZIndex = z++, Bounds = new Bounds { X = 20, Y = 280, Width = 200, Height = 30 }, Metadata = new(), Style = Style("none", "none"), Text = Text("Independent text", h: "left", va: "top", wrap: false, size: 9) });
        els.Add(new ShapeElement { Id = Id(201), LayerIds = [LayerA], ZIndex = z++, Locked = true, Bounds = new Bounds { X = 240, Y = 280, Width = 60, Height = 30 }, Metadata = new(), Geometry = new ShapeGeometry { Preset = "rectangle" }, Style = Style() });
        els.Add(new ShapeElement { Id = Id(202), ZIndex = z++, Hidden = true, LayerIds = [], Bounds = new Bounds { X = 320, Y = 280, Width = 60, Height = 30 }, Metadata = new(), Geometry = new ShapeGeometry { Preset = "rectangle" }, Style = Style() });
        // images
        els.Add(new ImageElement { Id = Id(300), Alias = "logo", LayerIds = [], ZIndex = z++, Bounds = new Bounds { X = 20, Y = 330, Width = 100, Height = 40 }, Metadata = new(), AssetId = "asset:logo", Fit = "contain", Opacity = 1, PreserveAspectRatio = true });
        els.Add(new ImageElement { Id = Id(301), LayerIds = [], ZIndex = z++, Bounds = new Bounds { X = 140, Y = 330, Width = 60, Height = 60 }, Metadata = new(), AssetId = "asset:photo", Fit = "cover", Opacity = 0.75, PreserveAspectRatio = true, RotationDeg = 15 });
        els.Add(new ImageElement { Id = Id(302), LayerIds = [], ZIndex = z++, Bounds = new Bounds { X = 220, Y = 330, Width = 40, Height = 30 }, Metadata = new(), AssetId = "asset:bitmap", Fit = "stretch", Opacity = 1, PreserveAspectRatio = false });
        els.Add(new ImageElement { Id = Id(303), LayerIds = [], ZIndex = z++, Bounds = new Bounds { X = 280, Y = 330, Width = 80, Height = 40 }, Metadata = new(), AssetId = "asset:vector", Fit = "contain", Opacity = 1, PreserveAspectRatio = true });
        // connectors: dynamic, static, free endpoint with waypoints, labelled
        LineStyle Line(string start = "none", string end = "triangle") => new() { Stroke = "#333333", StrokeWidthPt = 1.5, Dash = "solid", StartArrow = start, EndArrow = end };
        els.Add(new ConnectorElement { Id = Id(400), Alias = "dyn", LayerIds = [], ZIndex = z++, Metadata = new(), Bounds = new Bounds { X = 110, Y = 50, Width = 20, Height = 0 }, From = new Endpoint { ElementId = Id(100), Glue = "dynamic" }, To = new Endpoint { ElementId = Id(101), Glue = "dynamic" }, Route = "orthogonal", Waypoints = [], Style = Line() });
        els.Add(new ConnectorElement { Id = Id(401), LayerIds = [], ZIndex = z++, Metadata = new(), Bounds = new Bounds { X = 65, Y = 80, Width = 0, Height = 20 }, From = new Endpoint { ElementId = Id(100), Glue = "static", Port = "south" }, To = new Endpoint { ElementId = Id(105), Glue = "static", Port = "tap" }, Route = "straight", Waypoints = [], Style = Line("circle", "open"), Label = Text("flows") });
        els.Add(new ConnectorElement { Id = Id(402), LayerIds = [], ZIndex = z++, Metadata = new(), Bounds = new Bounds { X = 400, Y = 300, Width = 100, Height = 50 }, From = new Endpoint { ElementId = Id(102), Glue = "dynamic" }, To = new Endpoint { Point = new Point { X = 500, Y = 350 }, Glue = "none" }, Route = "orthogonal", Waypoints = [new Point { X = 450, Y = 300 }], Style = Line(end: "diamond") });
        // group with a rotated child and an internal connector
        els.Add(new ShapeElement { Id = Id(500), Alias = "g1", LayerIds = [], ZIndex = z++, Bounds = new Bounds { X = 600, Y = 300, Width = 60, Height = 40 }, Metadata = new(), Geometry = new ShapeGeometry { Preset = "rectangle" }, Style = Style(), RotationDeg = 30 });
        els.Add(new ShapeElement { Id = Id(501), Alias = "g2", LayerIds = [], ZIndex = z++, Bounds = new Bounds { X = 700, Y = 360, Width = 50, Height = 50 }, Metadata = new(), Geometry = new ShapeGeometry { Preset = "ellipse" }, Style = Style() });
        els.Add(new ConnectorElement { Id = Id(502), LayerIds = [], ZIndex = z++, Metadata = new(), Bounds = new Bounds { X = 630, Y = 320, Width = 95, Height = 65 }, From = new Endpoint { ElementId = Id(500), Glue = "dynamic" }, To = new Endpoint { ElementId = Id(501), Glue = "dynamic" }, Route = "straight", Waypoints = [], Style = Line() });
        var groupChildren = new List<string> { Id(500), Id(501), Id(502) };
        els.Add(new GroupElement { Id = Id(503), Alias = "grp", LayerIds = [], ZIndex = z++, Metadata = new(), ChildIds = groupChildren, Bounds = new Bounds(), RotationDeg = 0 });
        var map = els.ToDictionary(e => e.Id());
        var gb = GroupBounds.Derive(map, Id(503))!;
        els[^1] = ((GroupElement)els[^1]) with { Bounds = gb };
        var page1 = new Page
        {
            Id = Page1, Name = "Architecture", WidthPt = 841.8897637795275, HeightPt = 595.2755905511812, Background = "#FFFFFF",
            Grid = new PageGrid { Visible = true, SpacingPt = 14.173228346456693, Snap = true }, Guides = [],
            Layers = [new Layer { Id = LayerA, Name = "Notes", Visible = true, Locked = false, Printable = false, Snap = true, Glue = true }, new Layer { Id = LayerB, Name = "Review", Visible = false, Locked = true, Printable = true, Snap = true, Glue = true }],
            Elements = els,
        };
        var page2 = new Page
        {
            Id = Page2, Name = "Letter portrait", WidthPt = 612, HeightPt = 792, Background = "#FFFFFF", Grid = new PageGrid { Visible = false, SpacingPt = 18, Snap = false }, Guides = [], Layers = [],
            Elements = [new ShapeElement { Id = Id(600), Alias = "p0", LayerIds = [], ZIndex = 0, Bounds = new Bounds { X = 100, Y = 100, Width = 100, Height = 50 }, Metadata = new(), Geometry = new ShapeGeometry { Preset = "hexagon" }, Style = Style(), Text = Text("second page") }],
        };
        return (new DiagramDocument { SchemaVersion = 1, Id = Doc, Title = "Scene", Revision = 12, Pages = [page1, page2], Assets = assets, Metadata = new() { ["project"] = "POC" } }, blobs);
    }

    /// <summary>Test projection: straight routes between port/centre points, group frames = canonical bounds.</summary>
    public static ExportSnapshot Snapshot(DiagramDocument doc)
    {
        var connectors = new Dictionary<string, ConnectorProjection>();
        var frames = new Dictionary<string, Bounds>();
        foreach (var page in doc.Pages)
        {
            var map = page.Elements.ToDictionary(e => e.Id());
            Point Pt(Endpoint e)
            {
                if (e.ElementId is null) return e.Point!;
                var t = map[e.ElementId].Bounds();
                if (e.Glue == "static" && e.Port is not null)
                {
                    var (u, v) = DirectVsdxExporter.DefaultPorts.TryGetValue(e.Port, out var d) ? d : ((map[e.ElementId] as ShapeElement)!.Ports!.First(p => p.Name == e.Port) is var p ? (p.X, p.Y) : (0.5, 0.5));
                    return new Point { X = t.X + u * t.Width, Y = t.Y + v * t.Height };
                }
                return new Point { X = t.X + t.Width / 2, Y = t.Y + t.Height / 2 };
            }
            foreach (var c in page.Elements.OfType<ConnectorElement>())
            {
                var pts = new List<Point> { Pt(c.From) };
                pts.AddRange(c.Waypoints);
                pts.Add(Pt(c.To));
                var b = new Bounds { X = pts.Min(p => p.X), Y = pts.Min(p => p.Y), Width = pts.Max(p => p.X) - pts.Min(p => p.X), Height = pts.Max(p => p.Y) - pts.Min(p => p.Y) };
                connectors[c.Id] = new ConnectorProjection { RoutePoints = pts, VisualBounds = b };
            }
            foreach (var g in page.Elements.OfType<GroupElement>()) frames[g.Id] = g.Bounds;
        }
        var sid = Id(9);
        return new ExportSnapshot { DocumentId = doc.Id, SessionId = sid, Revision = doc.Revision, Document = doc, Projection = new Projection { DocumentId = doc.Id, SessionId = sid, Revision = doc.Revision, Connectors = connectors, GroupVisualBounds = frames } };
    }

    public static async Task<(byte[] Package, ExportResult Export)> ExportAsync(DiagramDocument doc, Blobs blobs)
    {
        var r = await new DirectVsdxExporter().ExportAsync(Snapshot(doc), blobs, new ExportOptions(), CancellationToken.None);
        return (r.Package, r);
    }

    public static async Task<ImportResult> ImportAsync(byte[] package)
    {
        var guarded = await PackageGuard.ValidateAsync(new MemoryStream(package));
        return await new DirectVsdxImporter().ImportAsync(new MemoryStream(guarded.Bytes), new ImportOptions("scene.vsdx"), CancellationToken.None);
    }
}
