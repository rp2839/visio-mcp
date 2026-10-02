using System.IO.Compression;
using System.Text;
using Diagram.Visio;
using Diagram.Visio.Abstractions;
using Xunit;

namespace Diagram.Visio.Tests;

public sealed class PackageGuardTests
{
    private static byte[] Zip(params (string Name, byte[] Data)[] entries)
    {
        using var ms = new MemoryStream();
        using (var z = new ZipArchive(ms, ZipArchiveMode.Create, true))
            foreach (var (n, d) in entries) { using var s = z.CreateEntry(n, CompressionLevel.SmallestSize).Open(); s.Write(d); }
        return ms.ToArray();
    }
    private static readonly (string, byte[]) Types = ("[Content_Types].xml", Encoding.UTF8.GetBytes("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>"));

    private static async Task<VsdxException> Rejects(byte[] pkg, PackageLimits? limits = null) =>
        await Assert.ThrowsAsync<VsdxException>(() => PackageGuard.ValidateAsync(new MemoryStream(pkg), limits));

    [Fact]
    public async Task ZipBombRejectsByActualDecompressedBytes()
    {
        var e = await Rejects(Zip(Types, ("visio/bomb.xml", new byte[70 * 1024 * 1024])));
        Assert.Equal("limit_exceeded", e.Code);
        var ratio = await Rejects(Zip(Types, ("visio/r.bin", new byte[3 * 1024 * 1024])), new PackageLimits(MaxRatio: 10));
        Assert.Equal("limit_exceeded", ratio.Code);
    }

    [Theory]
    [InlineData("../evil.xml")]
    [InlineData("/abs.xml")]
    [InlineData("visio/../../x.xml")]
    [InlineData("C:/x.xml")]
    public async Task TraversalAndAbsoluteNamesReject(string name)
    {
        Assert.Equal("invalid_request", (await Rejects(Zip(Types, (name, "<a/>"u8.ToArray())))).Code);
    }

    [Fact]
    public async Task XxeAndDtdReject()
    {
        var xxe = "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]><x>&e;</x>"u8.ToArray();
        Assert.Equal("invalid_request", (await Rejects(Zip(Types, ("visio/document.xml", xxe)))).Code);
        var billion = "<?xml version=\"1.0\"?><!DOCTYPE l [<!ENTITY a \"aaaaaaaaaa\"><!ENTITY b \"&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;\">]><l>&b;</l>"u8.ToArray();
        Assert.Equal("invalid_request", (await Rejects(Zip(Types, ("visio/x.xml", billion)))).Code);
    }

    [Fact]
    public async Task ExternalRelationshipRejects()
    {
        var rels = "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"r\" Type=\"t\" Target=\"https://evil.example/x.png\" TargetMode=\"External\"/></Relationships>"u8.ToArray();
        Assert.Equal("invalid_request", (await Rejects(Zip(Types, ("visio/pages/_rels/page1.xml.rels", rels)))).Code);
    }

    [Fact]
    public async Task DeepXmlRejects()
    {
        var deep = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("<a>", 300)) + string.Concat(Enumerable.Repeat("</a>", 300)));
        Assert.Equal("limit_exceeded", (await Rejects(Zip(Types, ("visio/deep.xml", deep)))).Code);
    }

    [Fact]
    public async Task TooManyEntriesReject()
    {
        Assert.Equal("limit_exceeded", (await Rejects(Zip([Types, .. Enumerable.Range(0, 20).Select(i => ($"visio/{i}.xml", "<a/>"u8.ToArray()))]), new PackageLimits(Entries: 10))).Code);
    }

    [Fact]
    public async Task MacrosAndOleAreInertDiagnostics()
    {
        var (doc, blobs) = Scene.Build();
        var (pkg, _) = await Scene.ExportAsync(doc, blobs);
        using var ms = new MemoryStream();
        ms.Write(pkg);
        using (var z = new ZipArchive(ms, ZipArchiveMode.Update, true))
        {
            using (var s = z.CreateEntry("visio/vbaProject.bin").Open()) s.Write([1, 2, 3]);
            using (var s = z.CreateEntry("visio/embeddings/oleObject1.bin").Open()) s.Write([1, 2, 3]);
        }
        var g = await PackageGuard.ValidateAsync(new MemoryStream(ms.ToArray()));
        Assert.Contains(g.Diagnostics, d => d.Code == "macro_inert");
        Assert.Contains(g.Diagnostics, d => d.Code == "ole_inert");
    }

    [Fact]
    public async Task NotAZipRejectsBeforeAnyBackendCall()
    {
        Assert.Equal("invalid_request", (await Rejects("hello"u8.ToArray())).Code);
        Assert.Equal("invalid_request", (await Rejects(Zip(("visio/document.xml", "<a/>"u8.ToArray())))).Code); // no content types
    }
}
