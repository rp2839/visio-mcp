using System.Diagnostics;
using Diagram.Core.Contracts;
using Diagram.Visio;
using Xunit;

namespace Diagram.Visio.Tests;

/// <summary>
/// §18 native save target (&lt; 3 s preferred) on the 10-page × 500-element benchmark, including
/// the exporter's self-check reimport. Reported; the assertion ceiling is generous.
/// </summary>
public sealed class PerformanceTests(ITestOutputHelper output)
{
    private static DiagramDocument Benchmark(int pages = 10, int perPage = 500)
    {
        var n = 0x10000;
        var list = new List<Page>();
        for (var p = 0; p < pages; p++)
        {
            var els = new List<Element>();
            var shapes = (int)(perPage * 0.9);
            for (var i = 0; i < shapes; i++)
                els.Add(new ShapeElement
                {
                    Id = Scene.Id(n++), Alias = $"s{i}", LayerIds = [], ZIndex = i, Metadata = new(),
                    Bounds = new Bounds { X = 20 + i % 25 * 92, Y = 20 + i / 25 * 80, Width = 80, Height = 50 },
                    Geometry = new ShapeGeometry { Preset = i % 3 == 0 ? "ellipse" : "roundedRect", CornerRadiusPt = 4 }, Style = Scene.Style(), Text = Scene.Text($"Node {i}"),
                });
            for (var i = 0; i < perPage - shapes; i++)
            {
                var a = (ShapeElement)els[i * 2];
                var b = (ShapeElement)els[i * 2 + 1];
                els.Add(new ConnectorElement
                {
                    Id = Scene.Id(n++), LayerIds = [], ZIndex = shapes + i, Metadata = new(), Bounds = new Bounds { X = a.Bounds.X, Y = a.Bounds.Y, Width = b.Bounds.X + b.Bounds.Width - a.Bounds.X, Height = 50 },
                    From = new Endpoint { ElementId = a.Id, Glue = "dynamic" }, To = new Endpoint { ElementId = b.Id, Glue = "dynamic" }, Route = "orthogonal", Waypoints = [], Style = new LineStyle { Stroke = "#333333", StrokeWidthPt = 1.5, Dash = "solid", StartArrow = "none", EndArrow = "triangle" },
                });
            }
            list.Add(new Page { Id = p == 0 ? Scene.Page1 : Scene.Id(0x100 + p), Name = $"Page-{p + 1}", WidthPt = 2400, HeightPt = 1700, Background = "#FFFFFF", Grid = new PageGrid { Visible = true, SpacingPt = 10, Snap = true }, Guides = [], Layers = [], Elements = els });
        }
        return new DiagramDocument { SchemaVersion = 1, Id = Scene.Doc, Title = "Benchmark", Revision = 1, Metadata = new(), Assets = [], Pages = list };
    }

    [Fact]
    public async Task NativeSave5000ElementsUnderTarget()
    {
        var doc = Benchmark();
        var blobs = new Blobs();
        await Scene.ExportAsync(doc, blobs); // warm-up (JIT)
        var samples = new List<double>();
        byte[] pkg = [];
        for (var i = 0; i < 3; i++)
        {
            var sw = Stopwatch.StartNew();
            (pkg, _) = await Scene.ExportAsync(doc, blobs);
            samples.Add(sw.Elapsed.TotalMilliseconds);
        }
        samples.Sort();
        var sw3 = Stopwatch.StartNew();
        await new DirectVsdxExporter().ExportAsync(Scene.Snapshot(doc), blobs, new Diagram.Visio.Abstractions.ExportOptions(SelfCheck: false), CancellationToken.None);
        var noCheckMs = sw3.Elapsed.TotalMilliseconds;
        var sw2 = Stopwatch.StartNew();
        var back = await Scene.ImportAsync(pkg);
        var importMs = sw2.Elapsed.TotalMilliseconds;
        output.WriteLine($"vsdx export (with self-check) median {samples[1]:F0} ms over 3 runs [{string.Join(", ", samples.Select(s => s.ToString("F0")))}]; package {pkg.Length / 1024} KiB; import {importMs:F0} ms; {Environment.ProcessorCount} cpus, {System.Runtime.InteropServices.RuntimeInformation.OSDescription}");
        Directory.CreateDirectory("perf");
        await File.WriteAllTextAsync("perf/vsdx-performance.txt", $"exportMedianMs={samples[1]:F0} exportWithoutSelfCheckMs={noCheckMs:F0} importMs={importMs:F0} packageKiB={pkg.Length / 1024}");
        Assert.Equal(5000, back.Document.Pages.Sum(p => p.Elements.Count));
        Assert.True(samples[1] < 15_000, $"export took {samples[1]} ms");
    }
}
