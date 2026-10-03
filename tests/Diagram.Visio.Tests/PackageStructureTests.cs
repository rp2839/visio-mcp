using System.IO.Compression;
using System.Xml.Linq;
using Xunit;

namespace Diagram.Visio.Tests;

/// <summary>
/// Package-level requirements Visio enforces on open (Windows finding: error 271 without a
/// windows part), and validity of the fixture images Visio decodes.
/// </summary>
public sealed class PackageStructureTests
{
    private static readonly XNamespace Ct = "http://schemas.openxmlformats.org/package/2006/content-types";
    private static readonly XNamespace Pr = "http://schemas.openxmlformats.org/package/2006/relationships";

    [Fact]
    public async Task ExportHasWindowsPartRelationshipAndContentType()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        using var zip = new ZipArchive(new MemoryStream(pkg));
        Assert.NotNull(zip.GetEntry("visio/windows.xml"));
        var rels = XDocument.Load(zip.GetEntry("visio/_rels/document.xml.rels")!.Open());
        Assert.Contains(rels.Root!.Elements(Pr + "Relationship"), r => (string?)r.Attribute("Type") == "http://schemas.microsoft.com/visio/2010/relationships/windows" && (string?)r.Attribute("Target") == "windows.xml");
        var types = XDocument.Load(zip.GetEntry("[Content_Types].xml")!.Open());
        Assert.Contains(types.Root!.Elements(Ct + "Override"), o => (string?)o.Attribute("PartName") == "/visio/windows.xml" && (string?)o.Attribute("ContentType") == "application/vnd.ms-visio.windows+xml");
    }

    [Fact]
    public async Task EveryPartHasAContentTypeAndEveryRelationshipTargetExists()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        using var zip = new ZipArchive(new MemoryStream(pkg));
        var types = XDocument.Load(zip.GetEntry("[Content_Types].xml")!.Open()).Root!;
        var overrides = types.Elements(Ct + "Override").Select(o => ((string)o.Attribute("PartName")!).TrimStart('/')).ToHashSet();
        var defaults = types.Elements(Ct + "Default").Select(d => (string)d.Attribute("Extension")!).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var e in zip.Entries.Where(e => e.FullName != "[Content_Types].xml"))
            Assert.True(overrides.Contains(e.FullName) || defaults.Contains(Path.GetExtension(e.FullName).TrimStart('.')), $"{e.FullName} has no content type");
        foreach (var relsEntry in zip.Entries.Where(e => e.FullName.EndsWith(".rels")))
        {
            var dir = Path.GetDirectoryName(Path.GetDirectoryName(relsEntry.FullName))!.Replace('\\', '/');
            foreach (var r in XDocument.Load(relsEntry.Open()).Root!.Elements(Pr + "Relationship"))
            {
                var target = Vx.Resolve(dir, (string)r.Attribute("Target")!);
                Assert.True(zip.GetEntry(target) is not null, $"{relsEntry.FullName} → {target} missing");
            }
        }
    }

    [Fact]
    public void FixtureJpegIsAFullyEncodedBaselineJpeg()
    {
        var j = Bytes.Jpeg();
        Assert.Equal([0xFF, 0xD8], j[..2]);
        Assert.Equal([0xFF, 0xD9], j[^2..]);
        var markers = new HashSet<byte>();
        (int W, int H) size = default;
        for (var i = 2; i + 3 < j.Length && j[i] == 0xFF;)
        {
            markers.Add(j[i + 1]);
            if (j[i + 1] == 0xC0) size = (j[i + 7] << 8 | j[i + 8], j[i + 5] << 8 | j[i + 6]);
            if (j[i + 1] == 0xDA) break; // scan data follows
            i += 2 + (j[i + 2] << 8 | j[i + 3]);
        }
        Assert.Superset(new HashSet<byte> { 0xDB, 0xC4, 0xC0, 0xDA }, markers); // quantisation, Huffman, SOF0, scan
        Assert.Equal((64, 32), size);
        Assert.True(j.Length > 200, "real entropy-coded data, not a header stub");
    }
}
