using System.Text.Json;
using Diagram.Core.Contracts;
using Diagram.Visio;
using Xunit;

namespace Diagram.Visio.Tests;

/// <summary>
/// §23 demo steps 10 and 14 at library level: the final demo document produced by
/// src/web/tests/browser/demo.spec.ts is exported to VSDX and re-imported, and every agent ID and
/// glue reference must resolve. Steps 11–13 (Visio/Word) are I41 and NOT RUN here.
/// </summary>
public sealed class DemoRoundTripTests
{
    private static readonly string Out = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/demo/out"));

    [Fact]
    public async Task DemoDocumentSurvivesVsdxRoundTrip()
    {
        var finalPath = Path.Combine(Out, "demo-final.json");
        if (!File.Exists(finalPath)) Assert.Skip("NOT RUN: run the browser demo (tests/browser/demo.spec.ts) first to produce tools/demo/out/demo-final.json");
        var snapshot = JsonSerializer.Deserialize<Snapshot>(await File.ReadAllBytesAsync(finalPath), ContractJson.Options)!;
        var raw = JsonSerializer.Deserialize<Dictionary<string, string>>(await File.ReadAllTextAsync(Path.Combine(Out, "demo-assets.json")))!;
        var blobs = new Blobs();
        foreach (var (sha, b64) in raw) blobs.Map[sha] = Convert.FromBase64String(b64);
        foreach (var a in snapshot.Document.Assets.Where(a => a.MimeType == "image/svg+xml")) blobs.Raster[a.Sha256] = Bytes.Png(60, 30, 44, 160, 44); // frontend derivative stand-in

        var (pkg, export) = await Scene.ExportAsync(snapshot.Document, blobs);
        await File.WriteAllBytesAsync(Path.Combine(Out, "demo.vsdx"), pkg);
        var back = await Scene.ImportAsync(pkg);

        var before = snapshot.Document.Pages.SelectMany(p => p.Elements).ToDictionary(e => e.Id());
        var after = back.Document.Pages.SelectMany(p => p.Elements).ToDictionary(e => e.Id());
        var glue = before.Values.OfType<ConnectorElement>().Select(c => new
        {
            c.Id, from = c.From.ElementId, to = c.To.ElementId,
            fromAfter = (after[c.Id] as ConnectorElement)!.From.ElementId, toAfter = (after[c.Id] as ConnectorElement)!.To.ElementId,
        }).ToList();
        var report = new
        {
            exportedIds = before.Keys.Order().ToList(), reimportedIds = after.Keys.Order().ToList(), glue,
            images = before.Values.OfType<ImageElement>().Select(i => new { i.Id, before = i.AssetId, after = (after[i.Id] as ImageElement)!.AssetId }).ToList(),
            exportDiagnostics = export.Diagnostics.Select(d => d.Code).ToList(), importDiagnostics = back.Diagnostics.Select(d => d.Code).ToList(),
            identity = back.Identity, packageBytes = pkg.Length,
        };
        await File.WriteAllTextAsync(Path.Combine(Out, "demo-roundtrip.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));

        Assert.Equal(report.exportedIds, report.reimportedIds);
        Assert.All(glue, g => Assert.Equal((g.from, g.to), (g.fromAfter, g.toAfter)));
        Assert.All(report.images, i => Assert.Equal(i.before, i.after));
        Assert.Equal(snapshot.Document.Id, back.Document.Id);
    }
}
