using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Xml.Linq;
using VsdxProbe;
using Xunit;

namespace VsdxProbe.Tests;

public sealed class RoundTripTests : IDisposable
{
    private static readonly Guid AgentId = Guid.Parse("6f1c2b9e-3a4d-4c5e-8f70-112233445566");
    private readonly string dir = Directory.CreateTempSubdirectory("vsdx-probe-").FullName;

    public void Dispose() => Directory.Delete(dir, recursive: true);

    private string NewPath() => Path.Combine(dir, $"{Guid.NewGuid():N}.vsdx");

    [Fact]
    public void GeneratedFileContainsIndependentShapesAndGlue()
    {
        var path = NewPath();
        var written = ProbeScene.Write(path, ProbeScene.Default(AgentId));
        var manifest = ProbeScene.Read(path);

        Assert.Equal(5, manifest.DrawableCount); // rect, ellipse, connector, text box, PNG picture
        Assert.Equal(AgentId, manifest.RectangleAgentId);
        Assert.Equal(manifest.RectangleId, manifest.ConnectorFromShapeId);
        Assert.Equal(manifest.EllipseId, manifest.ConnectorToShapeId);
        Assert.Equal("Probe", manifest.RectangleText);
        Assert.Equal(ProbeScene.SamplePngSha256, manifest.ImageHash);
        Assert.Equal(written.ImageHash, manifest.ImageHash);
        Assert.Equal(297 * 72 / 25.4, manifest.PageWidthPt, 6);
        Assert.Equal(210 * 72 / 25.4, manifest.PageHeightPt, 6);
        Assert.Equal("#1F77B4", manifest.RectangleFill);
        Assert.Contains("Agents", manifest.RectangleLayers);
        Assert.False(manifest.HasPageBitmap);
    }

    [Fact]
    public void GeometryRoundTripsWithinNativeTolerance()
    {
        var path = NewPath();
        var scene = ProbeScene.Default(AgentId);
        ProbeScene.Write(path, scene);
        var manifest = ProbeScene.Read(path);
        var rect = scene.Elements.Single(e => e.Kind == ProbeKind.Rectangle);
        var read = manifest.Bounds[rect.AgentId];
        Assert.InRange(Math.Abs(read.X - rect.X), 0, 0.01);
        Assert.InRange(Math.Abs(read.Y - rect.Y), 0, 0.01);
        Assert.InRange(Math.Abs(read.Width - rect.Width), 0, 0.01);
        Assert.InRange(Math.Abs(read.Height - rect.Height), 0, 0.01);
    }

    [Fact]
    public void Rotation33Degrees()
    {
        var path = NewPath();
        var scene = ProbeScene.Default(AgentId) with { RectangleRotationDeg = 33 };
        ProbeScene.Write(path, scene);
        var manifest = ProbeScene.Read(path);
        Assert.InRange(Math.Abs(manifest.RectangleRotationDeg - 33), 0, 0.01);
        // Visio Angle is counter-clockwise radians; canonical rotation is clockwise degrees.
        var angle = ProbeScene.ReadCell(path, manifest.RectangleId, "Angle");
        Assert.InRange(Math.Abs(angle + 33 * Math.PI / 180), 0, 1e-9);
    }

    [Fact]
    public void StaticPortSurvives()
    {
        var path = NewPath();
        var scene = ProbeScene.Default(AgentId) with { ConnectorToPort = "west" };
        ProbeScene.Write(path, scene);
        var manifest = ProbeScene.Read(path);
        Assert.Equal("west", manifest.ConnectorToPort);
        Assert.Null(manifest.ConnectorFromPort); // dynamic glue on the source
    }

    [Fact]
    public void DuplicateUserIdResolved()
    {
        var path = NewPath();
        ProbeScene.Write(path, ProbeScene.Default(AgentId));
        ProbeScene.SimulateVisioCopyPaste(path, AgentId);
        var manifest = ProbeScene.Read(path);
        Assert.Single(manifest.AgentIds, id => id == AgentId);
        Assert.Equal(manifest.AgentIds.Count, manifest.AgentIds.Distinct().Count());
        Assert.Contains(manifest.Diagnostics, d => d.Code == "duplicate_agent_id" && d.Action == "regenerated");
    }

    [Fact]
    public void SvgSourcePreservation()
    {
        var path = NewPath();
        var scene = ProbeScene.Default(AgentId) with { SvgSource = ProbeScene.SampleSvg };
        ProbeScene.Write(path, scene);
        var manifest = ProbeScene.Read(path);
        // Native SVG pictures are unproven without Visio: the probe writes a PNG
        // derivative plus an inert package-carried source and reports it.
        Assert.Equal(ProbeScene.SampleSvg, manifest.PreservedSvgSource);
        Assert.Contains(manifest.Diagnostics, d => d.Code == "svg_rasterised" && d.Action == "approximated");
    }

    [Fact]
    public void StaleImageProvenanceIsRejected()
    {
        var path = NewPath();
        ProbeScene.Write(path, ProbeScene.Default(AgentId) with { SvgSource = ProbeScene.SampleSvg });
        ProbeScene.ReplacePictureBytes(path, ProbeScene.AlternatePng);
        var manifest = ProbeScene.Read(path);
        Assert.Null(manifest.PreservedSvgSource);
        Assert.Contains(manifest.Diagnostics, d => d.Code == "stale_image_provenance");
        Assert.Equal(Convert.ToHexString(SHA256.HashData(ProbeScene.AlternatePng)).ToLowerInvariant(), manifest.ImageHash);
    }

    [Fact]
    public void PackageIsWellFormedOpc()
    {
        var path = NewPath();
        ProbeScene.Write(path, ProbeScene.Default(AgentId));
        using var zip = ZipFile.OpenRead(path);
        var names = zip.Entries.Select(e => e.FullName).ToHashSet();
        Assert.Contains("[Content_Types].xml", names);
        Assert.Contains("visio/document.xml", names);
        Assert.Contains("visio/pages/pages.xml", names);
        Assert.Contains("visio/pages/page1.xml", names);
        Assert.Contains(names, n => n.StartsWith("visio/media/") && n.EndsWith(".png"));
        foreach (var e in zip.Entries.Where(e => e.FullName.EndsWith(".xml") || e.FullName.EndsWith(".rels")))
        {
            using var s = e.Open();
            XDocument.Load(s); // throws if malformed
        }
    }

    [Fact]
    public void OfficeImoCapabilityIsRecorded()
    {
        // Evidence for the backend decision: OfficeIMO.Visio 3.4.4 exposes shapes,
        // connectors with Connect glue, layers and User cells, but no picture /
        // ForeignData API. An exporter without images cannot satisfy G1 alone.
        var report = OfficeImoCapabilities.Probe(NewPath());
        Assert.True(report.UserCells);
        Assert.True(report.ConnectorGlue);
        Assert.True(report.Layers);
        Assert.False(report.Pictures);
        var asm = typeof(OfficeIMO.Visio.VisioDocument).Assembly;
        Assert.DoesNotContain(asm.GetExportedTypes(), t => t.Name.Contains("Picture") || t.Name.Contains("ForeignData"));
    }
}
