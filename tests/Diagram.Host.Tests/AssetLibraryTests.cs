using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Host.Tests;

public sealed class AssetLibraryTests : IDisposable
{
    private readonly TempDir tmp = new();
    private readonly BlobStore blobs;
    private readonly AssetPreparer preparer;
    private readonly AssetLibrary library;
    private readonly byte[] v1 = Png.Create(8, 4), v2 = Png.Create(16, 8);

    public AssetLibraryTests()
    {
        blobs = new BlobStore(tmp.File("blobs"));
        preparer = new AssetPreparer(blobs);
        library = new AssetLibrary(tmp.File("library"), blobs, preparer);
    }

    public void Dispose() => tmp.Dispose();

    private static RequestEnvelope Req(string method, FakeEditor e, object p) => new()
    {
        ProtocolVersion = 1, Kind = "request", RequestId = "r1", Method = method, DocumentId = e.Document.Id, SessionId = e.SessionId,
        Params = JsonSerializer.SerializeToElement(p),
    };

    [Fact]
    public async Task SourceReplaceDoesNotModifyOpenDocument()
    {
        var added = await library.AddAsync(v1, "image/png", new AssetPreparer.Options("Logo", "logo", ["brand"]), CancellationToken.None);
        var editor = new FakeEditor(Docs.WithImage(added.Value!.Sha256));
        var before = ContractJson.Serialize(editor.Document);
        var replaced = await library.ReplaceSourceAsync("asset:logo", v2, "image/png", CancellationToken.None);
        Assert.Equal(2, replaced.Value!.Version);
        Assert.Equal([added.Value.Sha256], replaced.Value.PreviousSha256);
        Assert.Equal(before, ContractJson.Serialize(editor.Document));
        Assert.Empty(editor.Calls); // the library never talks to the open document
        Assert.True(blobs.Contains(added.Value.Sha256)); // old version still resolvable
        Assert.Contains(added.Value.Sha256, await library.ReferencedBlobsAsync(CancellationToken.None));
    }

    [Fact]
    public async Task SanitisedHashStable()
    {
        var svg = Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"4\" height=\"4\"><script>alert(1)</script><rect width=\"4\" height=\"4\" onclick=\"x()\"/></svg>");
        var a = await library.AddAsync(svg, "image/svg+xml", new AssetPreparer.Options("Vec", "vec"), CancellationToken.None);
        var b = await library.AddAsync(svg, "image/svg+xml", new AssetPreparer.Options("Vec", "vec"), CancellationToken.None);
        Assert.Equal(a.Value!.Sha256, b.Value!.Sha256);
        Assert.NotEqual(BlobStore.Sha256(svg), a.Value.Sha256); // hash of sanitised bytes
        var stored = Encoding.UTF8.GetString((await blobs.ReadAsync(a.Value.Sha256, CancellationToken.None)).Span);
        Assert.DoesNotContain("script", stored);
        Assert.DoesNotContain("onclick", stored);
    }

    [Fact]
    public async Task ListReturnsScopeAndVersion()
    {
        await library.AddAsync(v1, "image/png", new AssetPreparer.Options("ESG Global Primary", "esg-global", ["logo", "esg"]), CancellationToken.None);
        await library.ReplaceSourceAsync("asset:esg-global", v2, "image/png", CancellationToken.None);
        await library.AddAsync(Png.Create(3, 3), "image/png", new AssetPreparer.Options("Other", "other", ["icon"]), CancellationToken.None);
        var docSha = await blobs.PutDurableAsync(v1, CancellationToken.None);
        var editor = new FakeEditor(Docs.WithImage(docSha));
        var service = new AssetsListService(library, new AssetResolver(library, preparer, editor), editor);
        var r = await service.HandleAsync(Req("assets.list", editor, new { query = "esg" }), CancellationToken.None);
        Assert.Null(r.Error);
        var assets = JsonNode.Parse(r.Result.GetRawText())!["assets"]!.AsArray();
        var lib = Assert.Single(assets, a => a!["scope"]!.GetValue<string>() == "library")!;
        Assert.Equal("asset:esg-global", lib["id"]!.GetValue<string>());
        Assert.Equal(2, lib["version"]!.GetValue<int>());
        var pref = lib["preparedRef"]!.Deserialize<PreparedAssetRef>(ContractJson.Options)!;
        Assert.True(preparer.Verify(pref).Ok);
        // tag filter + the document's pinned asset
        var all = JsonNode.Parse((await service.HandleAsync(Req("assets.list", editor, new { tags = new[] { "logo" } }), CancellationToken.None)).Result.GetRawText())!["assets"]!.AsArray();
        Assert.Contains(all, a => a!["scope"]!.GetValue<string>() == "document" && a["version"]!.GetValue<string>() == "pinned" && a["usedBy"]!.GetValue<int>() == 1);
        Assert.DoesNotContain(all, a => a!["id"]!.GetValue<string>() == "asset:other");
        Assert.DoesNotContain(all, a => a!["sourcePath"] is not null); // never leak paths
    }

    [Fact]
    public async Task LibraryHashCollisionWithPinnedSlugResolvesToVersionId()
    {
        var docSha = await blobs.PutDurableAsync(v1, CancellationToken.None);
        var editor = new FakeEditor(Docs.WithImage(docSha)); // pins asset:logo = v1
        await library.AddAsync(v2, "image/png", new AssetPreparer.Options("Logo", "logo"), CancellationToken.None);
        var resolver = new AssetResolver(library, preparer, editor);
        var r = await resolver.ResolveAsync("asset:logo", editor.Scope, BlobStore.Sha256(v2), CancellationToken.None);
        Assert.True(r.Value!.Versioned);
        Assert.Equal($"asset:logo~{BlobStore.Sha256(v2)}", r.Value.Prepared.Ref.Asset.Id);
        var pinned = await resolver.ResolveAsync("asset:logo", editor.Scope, null, CancellationToken.None);
        Assert.Equal(("document", docSha), (pinned.Value!.Scope, pinned.Value.Prepared.Ref.Asset.Sha256));
    }

    [Fact]
    public async Task DurableBlobBeforeCatalogue()
    {
        string? seen = null;
        library.BeforeCatalogue = sha => { Assert.True(blobs.Contains(sha)); seen = sha; };
        var r = await library.AddAsync(v1, "image/png", new AssetPreparer.Options("Logo"), CancellationToken.None);
        Assert.Equal(r.Value!.Sha256, seen);
        // Catalogue publication failure leaves the previous catalogue intact.
        library.BeforeCatalogue = _ => throw new IOException("disk full");
        await Assert.ThrowsAsync<IOException>(() => library.ReplaceSourceAsync("asset:logo", v2, "image/png", CancellationToken.None));
        library.BeforeCatalogue = null;
        Assert.Equal(1, (await library.GetAsync("asset:logo", CancellationToken.None))!.Version);
    }

    [Fact]
    public async Task InvalidBytesNeverReachTheCatalogue()
    {
        var r = await library.AddAsync(Png.Create(4, 4, truncateAfterHeader: true)[..20], "image/png", new AssetPreparer.Options("Broken"), CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Empty(await library.ListAsync(null, null, CancellationToken.None));
    }
}
