using System.IO.Compression;
using System.Xml.Linq;
using Diagram.Core.Contracts;
using Diagram.Visio;
using Xunit;

namespace Diagram.Visio.Tests;

public sealed class MappingTests
{
    private const double Pt = 0.01, Deg = 0.01;
    private static Element El(DiagramDocument d, string id) => d.Pages.SelectMany(p => p.Elements).Single(e => e.Id() == id);
    private static void Near(Bounds a, Bounds b)
    {
        Assert.InRange(Math.Abs(a.X - b.X), 0, Pt); Assert.InRange(Math.Abs(a.Y - b.Y), 0, Pt);
        Assert.InRange(Math.Abs(a.Width - b.Width), 0, Pt); Assert.InRange(Math.Abs(a.Height - b.Height), 0, Pt);
    }

    private static (string, double) Effective(string paint, double opacity) =>
        paint.Length == 9 ? (paint[..7].ToUpperInvariant(), opacity * Convert.ToInt32(paint[7..], 16) / 255.0) : (paint.ToUpperInvariant(), opacity);

    [Fact]
    public async Task BasicObjects_PagesPresetsTextStylesRotation()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, export) = await Scene.ExportAsync(doc, blobs);
        var back = (await Scene.ImportAsync(pkg)).Document;
        Assert.Equal(doc.Id, back.Id);
        Assert.Equal(["Architecture", "Letter portrait"], back.Pages.Select(p => p.Name));
        Assert.Equal([Scene.Page1, Scene.Page2], back.Pages.Select(p => p.Id));
        Assert.InRange(Math.Abs(back.Pages[1].WidthPt - 612), 0, Pt);
        for (var i = 0; i < Scene.Presets.Length; i++)
        {
            var a = (ShapeElement)El(doc, Scene.Id(100 + i));
            var b = (ShapeElement)El(back, Scene.Id(100 + i));
            Assert.Equal(a.Geometry.Preset, b.Geometry.Preset);
            Near(a.Bounds, b.Bounds);
            Assert.InRange(Math.Abs(a.RotationDeg - b.RotationDeg), 0, Deg);
            Assert.Equal(a.Text!.Value, b.Text!.Value);
            Assert.Equal(a.Text.Bold, b.Text.Bold);
            Assert.Equal(a.Style.Dash, b.Style.Dash);
            // Visio has one fill transparency: #RRGGBBAA alpha folds into fillOpacity (documented normalisation).
            var (ca, oa) = Effective(a.Style.Fill, a.Style.FillOpacity);
            var (cb, ob) = Effective(b.Style.Fill, b.Style.FillOpacity);
            Assert.Equal(ca, cb);
            Assert.InRange(Math.Abs(oa - ob), 0, 0.005);
            Assert.Equal(a.Alias, b.Alias);
        }
        Assert.Equal(8, ((ShapeElement)El(back, Scene.Id(101))).Geometry.CornerRadiusPt);
        Assert.Equal(new Dictionary<string, string> { ["owner"] = "Ops", ["cost centre"] = "42" }, El(back, Scene.Id(100)) switch { ShapeElement s => s.Metadata, _ => null });
        var text = (TextElement)El(back, Scene.Id(200));
        Assert.Equal(("left", "top", false, 9.0), (text.Text.HorizontalAlign, text.Text.VerticalAlign, text.Text.Wrap, text.Text.FontSizePt));
        Assert.Equal("none", text.Style.Fill);
        Assert.Equal(Scene.Presets.Length + 1, back.Pages[0].Elements.OfType<ShapeElement>().Count(s => s.Text is not null) + back.Pages[0].Elements.OfType<TextElement>().Count());
    }

    [Fact]
    public async Task ExportWritesNativeEditableGeometryNotABitmap()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        using var zip = new ZipArchive(new MemoryStream(pkg));
        var page = XDocument.Load(zip.GetEntry("visio/pages/page1.xml")!.Open());
        XNamespace v = "http://schemas.microsoft.com/office/visio/2012/main";
        var shapes = page.Descendants(v + "Shape").ToList();
        Assert.Equal(doc.Pages[0].Elements.Count, shapes.Count);
        Assert.All(shapes.Where(s => (string?)s.Attribute("Type") == "Shape" && s.Elements(v + "Cell").All(c => (string?)c.Attribute("N") != "BeginX")),
            s => Assert.Contains(s.Descendants(v + "Row"), r => ((string?)r.Attribute("T"))?.StartsWith("Rel") == true));
        Assert.Equal(4, shapes.Count(s => (string?)s.Attribute("Type") == "Foreign")); // independent pictures, not a page image
        Assert.Contains(zip.Entries, e => e.FullName.EndsWith(".svg")); // SVG source carried
        Assert.Contains(page.Descendants(v + "Cell"), c => (string?)c.Attribute("F") == "_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)");
        Assert.Contains(page.Descendants(v + "Connect"), c => ((string)c.Attribute("ToCell")!).StartsWith("Connections.X"));
    }

    [Fact]
    public async Task Structural_GlueWaypointsGroupsLayersLocksHidden()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        var back = (await Scene.ImportAsync(pkg)).Document;
        var dyn = (ConnectorElement)El(back, Scene.Id(400));
        Assert.Equal((Scene.Id(100), "dynamic"), (dyn.From.ElementId, dyn.From.Glue));
        Assert.Equal((Scene.Id(101), "dynamic"), (dyn.To.ElementId, dyn.To.Glue));
        var stat = (ConnectorElement)El(back, Scene.Id(401));
        Assert.Equal(("static", "south"), (stat.From.Glue, stat.From.Port));
        Assert.Equal(("static", "tap"), (stat.To.Glue, stat.To.Port));
        Assert.Equal(("circle", "open", "straight"), (stat.Style.StartArrow, stat.Style.EndArrow, stat.Route));
        Assert.Equal("flows", stat.Label!.Value);
        var free = (ConnectorElement)El(back, Scene.Id(402));
        Assert.Equal("none", free.To.Glue);
        Assert.InRange(Math.Abs(free.To.Point!.X - 500), 0, Pt);
        Assert.Single(free.Waypoints);
        Assert.Equal("diamond", free.Style.EndArrow);
        var grp = (GroupElement)El(back, Scene.Id(503));
        Assert.Equal([Scene.Id(500), Scene.Id(501), Scene.Id(502)], grp.ChildIds.Order());
        Assert.Equal(0, grp.RotationDeg);
        Near(((GroupElement)El(doc, Scene.Id(503))).Bounds, grp.Bounds);
        var rotated = (ShapeElement)El(back, Scene.Id(500));
        Assert.InRange(Math.Abs(rotated.RotationDeg - 30), 0, Deg);
        Near(((ShapeElement)El(doc, Scene.Id(500))).Bounds, rotated.Bounds);
        var inner = (ConnectorElement)El(back, Scene.Id(502));
        Assert.Equal((Scene.Id(500), Scene.Id(501)), (inner.From.ElementId, inner.To.ElementId));
        Assert.Equal([Scene.LayerA, Scene.LayerB], back.Pages[0].Layers.Select(l => l.Id));
        Assert.Equal((false, true), (back.Pages[0].Layers[0].Printable, back.Pages[0].Layers[1].Locked));
        Assert.Equal([Scene.LayerA, Scene.LayerB], El(back, Scene.Id(200)) switch { TextElement t => t.LayerIds, _ => null });
        Assert.True(((ShapeElement)El(back, Scene.Id(201))).Locked);
        Assert.True(((ShapeElement)El(back, Scene.Id(202))).Hidden);
        // z-order ranks survive (groups after their children)
        var ranks = back.Pages[0].Elements.Select(e => e.Id()).ToList();
        Assert.True(ranks.IndexOf(Scene.Id(503)) > ranks.IndexOf(Scene.Id(502)));
        Assert.True(ranks.IndexOf(Scene.Id(100)) < ranks.IndexOf(Scene.Id(114)));
        Assert.Equal(back.Pages[0].Elements.Select(e => e.ZIndex()).Order(), back.Pages[0].Elements.Select(e => e.ZIndex()));
        Assert.Equal(new PageGrid { Visible = true, SpacingPt = 14.173228346456693, Snap = true }, back.Pages[0].Grid);
    }

    [Fact]
    public async Task Images_PngJpegBmpSvgFitOpacityAndBlobs()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, export) = await Scene.ExportAsync(doc, blobs);
        var r = await Scene.ImportAsync(pkg);
        var back = r.Document;
        foreach (var (id, asset) in new[] { (300, "asset:logo"), (301, "asset:photo"), (302, "asset:bitmap"), (303, "asset:vector") })
        {
            var img = (ImageElement)El(back, Scene.Id(id));
            Assert.Equal(asset, img.AssetId);
            var a = back.Assets.Single(x => x.Id == asset);
            Assert.Equal(doc.Assets.Single(x => x.Id == asset).Sha256, a.Sha256);
            Assert.Equal(a.Sha256, Bytes.Sha(r.Blobs[a.Sha256]));
        }
        Assert.Equal("image/svg+xml", back.Assets.Single(a => a.Id == "asset:vector").MimeType); // original SVG restored, not the PNG derivative
        Assert.Contains(export.Diagnostics, d => d.Code == "svg_rasterised" && d.Action == "approximated");
        var photo = (ImageElement)El(back, Scene.Id(301));
        Assert.Equal(("cover", 0.75), (photo.Fit, photo.Opacity));
        Assert.InRange(Math.Abs(photo.RotationDeg - 15), 0, Deg);
        Assert.Equal(("stretch", false), (((ImageElement)El(back, Scene.Id(302))).Fit, ((ImageElement)El(back, Scene.Id(302))).PreserveAspectRatio));
    }

    [Fact]
    public async Task EditedForeignDataIsStaleProvenance()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        // Emulate Visio "Change Picture" on the SVG-derived picture: new bytes, stale User cells kept.
        using var ms = new MemoryStream();
        ms.Write(pkg);
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Update, true))
        {
            var pngs = zip.Entries.Where(e => e.FullName.StartsWith("visio/media/image") && e.FullName.EndsWith(".png")).ToList();
            foreach (var e in pngs.Skip(1)) { var name = e.FullName; e.Delete(); using var s = zip.CreateEntry(name).Open(); s.Write(Bytes.Png(5, 5, 255, 0, 0)); }
        }
        var r = await Scene.ImportAsync(ms.ToArray());
        var vector = (ImageElement)El(r.Document, Scene.Id(303));
        Assert.StartsWith("asset:image~", vector.AssetId);
        Assert.Contains(r.Diagnostics, d => d.Code == "stale_image_provenance");
        Assert.Equal("image/png", r.Document.Assets.Single(a => a.Id == vector.AssetId).MimeType);
    }

    [Fact]
    public async Task ProjectionMismatchFailsExport()
    {
        var (doc, blobs) = Scene.Build();
        var snap = Scene.Snapshot(doc);
        var stale = snap with { Projection = snap.Projection with { Revision = snap.Revision - 1 } };
        var e = await Assert.ThrowsAsync<Diagram.Visio.Abstractions.VsdxException>(() => new DirectVsdxExporter().ExportAsync(stale, blobs, new(), CancellationToken.None));
        Assert.Equal("projection_failed", e.Code);
    }

    [Fact]
    public async Task IndependentOracleOfficeImoLoadsExport()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        var path = Path.Combine(Path.GetTempPath(), $"oracle-{Guid.NewGuid():N}.vsdx");
        await File.WriteAllBytesAsync(path, pkg);
        try
        {
            var loaded = OfficeIMO.Visio.VisioDocument.Load(path);
            Assert.Equal(2, loaded.Pages.Count);
            Assert.Contains(loaded.Pages[0].Shapes, s => s.GetUserCellValue("AgentId") == Scene.Id(100));
            // OfficeIMO 3.4.4 only classifies its own master-based connectors as Connectors; our glued 1-D
            // shapes load as plain shapes, so the oracle check is that every exported identity is readable.
            var ids = loaded.Pages[0].Shapes.Select(s => s.GetUserCellValue("AgentId")).ToHashSet();
            Assert.Contains(Scene.Id(400), ids);
            Assert.Contains(Scene.Id(401), ids);
            Assert.Contains(Scene.Id(303), ids);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public async Task UnknownEffectsAndMastersReportDiagnostics()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        using var ms = new MemoryStream();
        ms.Write(pkg);
        XNamespace v = "http://schemas.microsoft.com/office/visio/2012/main";
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Update, true))
        {
            var e = zip.GetEntry("visio/pages/page2.xml")!;
            XDocument x;
            using (var s = e.Open()) x = XDocument.Load(s);
            var shape = x.Descendants(v + "Shape").First();
            shape.Elements(v + "Cell").Single(c => (string?)c.Attribute("N") == "FlipX").SetAttributeValue("V", "1");
            foreach (var g in shape.Elements(v + "Section").Where(s => (string?)s.Attribute("N") == "Geometry"))
                g.Add(new XElement(v + "Row", new XAttribute("T", "NURBSTo"), new XAttribute("IX", 99), new XElement(v + "Cell", new XAttribute("N", "X"), new XAttribute("V", "0.5")), new XElement(v + "Cell", new XAttribute("N", "Y"), new XAttribute("V", "0.2"))));
            e.Delete();
            using var w = zip.CreateEntry("visio/pages/page2.xml").Open();
            x.Save(w);
        }
        var r = await Scene.ImportAsync(ms.ToArray());
        Assert.Contains(r.Diagnostics, d => d.Code == "flip");
        Assert.Contains(r.Diagnostics, d => d.Code == "stale_preset");
        Assert.Equal("custom", ((ShapeElement)r.Document.Pages[1].Elements[0]).Geometry.Preset);
        Assert.True(r.Lossy);
    }
}

public sealed class FixtureTests
{
    /// <summary>
    /// Regenerates tests/fixtures/vsdx/app-authored/scene.vsdx (input for I41 Visio/Word checks)
    /// when UPDATE_VSDX_FIXTURES=1; otherwise verifies the committed fixture still imports with its IDs.
    /// </summary>
    [Fact]
    public async Task AppAuthoredFixtureImportsWithStableIds()
    {
        var dir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../fixtures/vsdx/app-authored"));
        var path = Path.Combine(dir, "scene.vsdx");
        var (doc, blobs) = Scene.Build();
        if (Environment.GetEnvironmentVariable("UPDATE_VSDX_FIXTURES") == "1")
        {
            Directory.CreateDirectory(dir);
            var (pkg, _) = await Scene.ExportAsync(doc, blobs);
            await File.WriteAllBytesAsync(path, pkg);
            await File.WriteAllLinesAsync(Path.Combine(dir, "scene.ids.txt"), doc.Pages.SelectMany(p => p.Elements).Select(e => $"{e.Id()} {e.Kind()}").Order());
        }
        Assert.True(File.Exists(path), "run with UPDATE_VSDX_FIXTURES=1 to create the fixture");
        var r = await Scene.ImportAsync(await File.ReadAllBytesAsync(path));
        var expected = await File.ReadAllLinesAsync(Path.Combine(dir, "scene.ids.txt"));
        Assert.Equal(expected, r.Document.Pages.SelectMany(p => p.Elements).Select(e => $"{e.Id()} {e.Kind()}").Order());
    }
}
