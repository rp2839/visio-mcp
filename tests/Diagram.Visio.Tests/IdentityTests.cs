using System.IO.Compression;
using System.Xml.Linq;
using Diagram.Core.Contracts;
using Diagram.Visio;
using Xunit;

namespace Diagram.Visio.Tests;

public sealed class IdentityTests
{
    private static readonly XNamespace V = "http://schemas.microsoft.com/office/visio/2012/main";

    private static byte[] EditPage(byte[] pkg, string part, Action<XDocument> edit)
    {
        using var ms = new MemoryStream();
        ms.Write(pkg);
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Update, true))
        {
            var e = zip.GetEntry(part)!;
            XDocument x;
            using (var s = e.Open()) x = XDocument.Load(s);
            edit(x);
            e.Delete();
            using var w = zip.CreateEntry(part).Open();
            x.Save(w);
        }
        return ms.ToArray();
    }

    private static string? UserVal(XElement s, string n) => s.Elements(V + "Section").Where(x => (string?)x.Attribute("N") == "User").Elements(V + "Row")
        .FirstOrDefault(r => (string?)r.Attribute("N") == n)?.Elements(V + "Cell").First().Attribute("V")?.Value;

    [Fact]
    public async Task ValidIdsSurviveUnchangedIncludingPagesLayersGroups()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        var r = await Scene.ImportAsync(pkg);
        Assert.Equal(doc.Pages.SelectMany(p => p.Elements).Select(e => e.Id()).Order(), r.Document.Pages.SelectMany(p => p.Elements).Select(e => e.Id()).Order());
        Assert.Equal(doc.Pages.SelectMany(p => p.Layers).Select(l => l.Id), r.Document.Pages.SelectMany(p => p.Layers).Select(l => l.Id));
        Assert.True(r.Identity.DocumentIdentityPreserved);
        Assert.Equal(0, r.Identity.Regenerated);
    }

    [Fact]
    public async Task CopiedDuplicatesRegenerateAndReferencesFollowTheCopy()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        // Visio copy/paste of shape p1 plus a new connector glued to the copy.
        var edited = EditPage(pkg, "visio/pages/page1.xml", x =>
        {
            var shapes = x.Root!.Element(V + "Shapes")!;
            var original = shapes.Elements(V + "Shape").Single(s => UserVal(s, "AgentId") == Scene.Id(101));
            var copy = new XElement(original);
            copy.SetAttributeValue("ID", 900);
            shapes.AddFirst(copy); // copies can precede originals in document order
            var conn = new XElement(shapes.Elements(V + "Shape").Single(s => UserVal(s, "AgentId") == Scene.Id(400)));
            conn.SetAttributeValue("ID", 901);
            conn.Elements(V + "Section").Where(s => (string?)s.Attribute("N") == "User").Remove(); // a Visio-drawn connector has no app cells
            shapes.Add(conn);
            x.Root!.Element(V + "Connects")!.Add(
                new XElement(V + "Connect", new XAttribute("FromSheet", 901), new XAttribute("FromCell", "BeginX"), new XAttribute("ToSheet", 900), new XAttribute("ToCell", "PinX"), new XAttribute("ToPart", 3)),
                new XElement(V + "Connect", new XAttribute("FromSheet", 901), new XAttribute("FromCell", "EndX"), new XAttribute("ToSheet", 1), new XAttribute("ToCell", "PinX"), new XAttribute("ToPart", 3)));
        });
        var r = await Scene.ImportAsync(edited);
        var all = r.Document.Pages.SelectMany(p => p.Elements).ToList();
        Assert.Equal(all.Count, all.Select(e => e.Id()).Distinct().Count());
        Assert.Contains(all, e => e.Id() == Scene.Id(101)); // original keeps its UUID (matching native ref)
        Assert.Contains(r.Diagnostics, d => d.Code == "duplicate_agent_id" && d.Action == "regenerated");
        var copyId = r.Diagnostics.First(d => d.Code == "duplicate_agent_id").ElementId!;
        var newConn = all.OfType<ConnectorElement>().Single(c => c.Id != Scene.Id(400) && c.From.ElementId == copyId);
        Assert.Equal(Scene.Id(100), newConn.To.ElementId);
        Assert.Equal(1, r.Identity.Regenerated);
        Assert.Equal(1, r.Identity.Generated);
        // Duplicate alias resolution: the copy cannot keep alias p1
        Assert.Single(all, e => e is ShapeElement { Alias: "p1" });
        Assert.Contains(r.Diagnostics, d => d.Code == "duplicate_alias");
    }

    [Fact]
    public async Task MissingIdsAreDeterministicForUnchangedBytes()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        var stripped = EditPage(pkg, "visio/pages/page2.xml", x =>
        {
            foreach (var s in x.Descendants(V + "Shape")) s.Elements(V + "Section").Where(sec => (string?)sec.Attribute("N") == "User").Remove();
        });
        var a = await Scene.ImportAsync(stripped);
        var b = await Scene.ImportAsync(stripped);
        Assert.Equal(a.Document.Pages[1].Elements[0].Id(), b.Document.Pages[1].Elements[0].Id());
        Assert.NotEqual(Scene.Id(600), a.Document.Pages[1].Elements[0].Id());
        Assert.Equal(1, a.Identity.Generated);
    }

    [Fact]
    public async Task InvalidIdsRegenerateWithDiagnostics()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        var bad = EditPage(pkg, "visio/pages/page2.xml", x =>
        {
            var cell = x.Descendants(V + "Row").First(r => (string?)r.Attribute("N") == "AgentId").Elements(V + "Cell").First();
            cell.SetAttributeValue("V", "not-a-uuid");
        });
        var r = await Scene.ImportAsync(bad);
        Assert.Contains(r.Diagnostics, d => d.Code == "invalid_agent_id");
    }
}
