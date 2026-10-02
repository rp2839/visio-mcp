using System.Text;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Host.Tests;

public sealed class LifecycleTests : IDisposable
{
    private readonly TempDir tmp = new();
    private readonly BlobStore blobs;
    private readonly AssetPreparer preparer;
    private readonly byte[] png = Png.Create(8, 4);

    public LifecycleTests()
    {
        blobs = new BlobStore(tmp.File("blobs"));
        preparer = new AssetPreparer(blobs);
    }

    public void Dispose() => tmp.Dispose();

    private async Task<FakeEditor> EditorWithImageAsync()
    {
        var sha = await blobs.PutDurableAsync(png, CancellationToken.None);
        return new FakeEditor(Docs.WithImage(sha));
    }

    [Fact]
    public async Task SaveRevisionRDoesNotCleanRPlus1()
    {
        var editor = await EditorWithImageAsync();
        var writer = new AtomicFileWriter();
        var coordinator = new SessionCoordinator(editor, blobs, preparer, writer);
        var r = editor.Revision;
        writer.BeforeReplace = _ => editor.Edit(); // human edit while IO runs outside the queue
        var saved = await coordinator.SaveJsonAsync(tmp.File("a.diagram.json"), editor.Scope, CancellationToken.None);
        Assert.True(saved.Ok);
        Assert.Equal(r, saved.Value!.Revision);
        Assert.Equal(r, editor.SavedRevision);
        Assert.True(editor.IsDirty); // R+1 remains dirty
    }

    [Fact]
    public async Task SaveCannotCleanAnotherSession()
    {
        var editor = await EditorWithImageAsync();
        var writer = new AtomicFileWriter();
        var coordinator = new SessionCoordinator(editor, blobs, preparer, writer);
        writer.BeforeReplace = _ => editor.NewSession(); // document switched during save
        var saved = await coordinator.SaveJsonAsync(tmp.File("a.diagram.json"), editor.Scope, CancellationToken.None);
        Assert.True(saved.Ok);
        Assert.False(saved.Value!.MarkedClean);
        Assert.Null(editor.SavedRevision);
    }

    [Fact]
    public async Task LateOpenCannotReplaceNewSessionOrNewEdits()
    {
        var editor = await EditorWithImageAsync();
        var coordinator = new SessionCoordinator(editor, blobs, preparer);
        var path = tmp.File("b.diagram.json");
        Assert.True((await coordinator.SaveJsonAsync(path, editor.Scope, CancellationToken.None)).Ok);

        var expected = new ExpectedState(editor.Document.Id, editor.SessionId, editor.Revision);
        editor.Edit(); // new edit while the file was being read
        var late = await coordinator.OpenJsonAsync(path, expected, CancellationToken.None);
        Assert.Equal("revision_conflict", late.Error!.Code);

        var expected2 = new ExpectedState(editor.Document.Id, editor.SessionId, editor.Revision);
        editor.NewSession();
        var stale = await coordinator.OpenJsonAsync(path, expected2, CancellationToken.None);
        Assert.Equal("session_mismatch", stale.Error!.Code);
        Assert.EndsWith("*", editor.Document.Title); // existing document intact
    }

    [Fact]
    public async Task WriteFailurePreservesOriginal()
    {
        var editor = await EditorWithImageAsync();
        var path = tmp.File("c.diagram.json");
        var original = Encoding.UTF8.GetBytes("previous contents");
        await File.WriteAllBytesAsync(path, original);
        var writer = new AtomicFileWriter { BeforeReplace = _ => throw new IOException("disk full") };
        var coordinator = new SessionCoordinator(editor, blobs, preparer, writer);
        var saved = await coordinator.SaveJsonAsync(path, editor.Scope, CancellationToken.None);
        Assert.Equal("io_error", saved.Error!.Code);
        Assert.Equal(original, await File.ReadAllBytesAsync(path));
        Assert.Null(editor.SavedRevision);
        Assert.Empty(Directory.GetFiles(tmp.Path, "*.tmp"));
    }

    [Fact]
    public async Task OverwriteKeepsBackup()
    {
        var editor = await EditorWithImageAsync();
        var path = tmp.File("d.diagram.json");
        await File.WriteAllTextAsync(path, "old");
        var saved = await new SessionCoordinator(editor, blobs, preparer).SaveJsonAsync(path, editor.Scope, CancellationToken.None);
        Assert.True(saved.Ok);
        Assert.Equal("old", await File.ReadAllTextAsync(path + ".bak"));
    }

    [Fact]
    public async Task JsonLoadPreservesImagesAndIds()
    {
        var editor = await EditorWithImageAsync();
        var path = tmp.File("e.diagram.json");
        Assert.True((await new SessionCoordinator(editor, blobs, preparer).SaveJsonAsync(path, editor.Scope, CancellationToken.None)).Ok);

        // Fresh host (different blob store) opening the file into a different editor session.
        using var other = new TempDir();
        var blobs2 = new BlobStore(other.File("blobs"));
        var target = new FakeEditor(Docs.WithImage(BlobStore.Sha256(png)) with { Id = Docs.DocId });
        var oldSession = target.SessionId;
        var opened = await new SessionCoordinator(target, blobs2, new AssetPreparer(blobs2))
            .OpenJsonAsync(path, new ExpectedState(target.Document.Id, target.SessionId, target.Revision), CancellationToken.None);
        Assert.True(opened.Ok, opened.Error?.Message);
        var snap = opened.Value!.Snapshot;
        Assert.NotEqual(oldSession, snap.SessionId);
        Assert.Equal(new[] { Docs.ImageId, Docs.ShapeId }, snap.Document.Pages[0].Elements.Select(e => e.Id()));
        Assert.Equal(BlobStore.Sha256(png), snap.Document.Assets[0].Sha256);
        Assert.Null(snap.Document.Assets[0].EmbeddedData);
        Assert.Equal(png, (await blobs2.ReadAsync(BlobStore.Sha256(png), CancellationToken.None)).ToArray());
    }

    [Fact]
    public async Task OversizeOrDeepJsonRejectsBeforePublish()
    {
        var editor = await EditorWithImageAsync();
        var coordinator = new SessionCoordinator(editor, blobs, preparer);
        var expected = new ExpectedState(editor.Document.Id, editor.SessionId, editor.Revision);

        var deep = tmp.File("deep.json");
        await File.WriteAllTextAsync(deep, "{\"format\":\"agentic-diagram\",\"x\":" + new string('[', 200) + new string(']', 200) + "}");
        Assert.Equal("limit_exceeded", (await coordinator.OpenJsonAsync(deep, expected, CancellationToken.None)).Error!.Code);

        var longString = tmp.File("long.json");
        await File.WriteAllTextAsync(longString, "{\"format\":\"agentic-diagram\",\"formatVersion\":1,\"title\":\"" + new string('x', 1024 * 1024 + 1) + "\"}");
        Assert.Equal("limit_exceeded", (await coordinator.OpenJsonAsync(longString, expected, CancellationToken.None)).Error!.Code);

        var huge = tmp.File("huge.json");
        await using (var fs = File.Create(huge)) fs.SetLength(InputLimits.NativeJsonBytes + 1);
        Assert.Equal("limit_exceeded", (await coordinator.OpenJsonAsync(huge, expected, CancellationToken.None)).Error!.Code);

        Assert.DoesNotContain("doc.replace", editor.Calls);
    }

    private async Task<string> WriteNativeAsync(DiagramDocument doc, Dictionary<string, byte[]> blobsBySha)
    {
        var root = new JsonObject
        {
            ["format"] = "agentic-diagram", ["formatVersion"] = 1,
            ["document"] = JsonNode.Parse(ContractJson.Serialize(doc)),
            ["assetBlobs"] = new JsonObject(blobsBySha.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)JsonValue.Create(Convert.ToBase64String(kv.Value))))),
        };
        var path = tmp.File($"{Guid.NewGuid():N}.diagram.json");
        await File.WriteAllTextAsync(path, root.ToJsonString());
        return path;
    }

    [Fact]
    public async Task JsonEmbeddedSvgIsSanitisedBeforePublish()
    {
        var svg = Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\" onload=\"alert(1)\"><script>alert(2)</script><rect width=\"10\" height=\"10\"/></svg>");
        var sha = BlobStore.Sha256(svg);
        var path = await WriteNativeAsync(Docs.WithImage(sha, "image/svg+xml"), new() { [sha] = svg });
        var editor = await EditorWithImageAsync();
        DiagramDocument? published = null;
        editor.OnReplace = d => published = d;
        var opened = await new SessionCoordinator(editor, blobs, preparer).OpenJsonAsync(path, new ExpectedState(editor.Document.Id, editor.SessionId, editor.Revision), CancellationToken.None);
        Assert.True(opened.Ok, opened.Error?.Message);
        var newSha = published!.Assets[0].Sha256;
        Assert.NotEqual(sha, newSha); // descriptor updated to the sanitised hash
        var stored = Encoding.UTF8.GetString((await blobs.ReadAsync(newSha, CancellationToken.None)).Span);
        Assert.DoesNotContain("script", stored);
        Assert.DoesNotContain("onload", stored);
        Assert.Contains(opened.Value!.Diagnostics, d => d.Code == "svg_sanitised");
    }

    [Fact]
    public async Task JsonEmbeddedRasterDecodeBudget()
    {
        var bomb = Png.Create(20_000, 20_000, truncateAfterHeader: true); // header claims 400 Mpx
        var sha = BlobStore.Sha256(bomb);
        var path = await WriteNativeAsync(Docs.WithImage(sha), new() { [sha] = bomb });
        var editor = await EditorWithImageAsync();
        var opened = await new SessionCoordinator(editor, blobs, preparer).OpenJsonAsync(path, new ExpectedState(editor.Document.Id, editor.SessionId, editor.Revision), CancellationToken.None);
        Assert.Equal("limit_exceeded", opened.Error!.Code);
        Assert.Equal(0, preparer.DecoderCalls);
        Assert.DoesNotContain("doc.replace", editor.Calls);
    }

    [Fact]
    public async Task ImportedBlobsDurableBeforePublish()
    {
        var fresh = Png.Create(3, 3);
        var sha = BlobStore.Sha256(fresh);
        var path = await WriteNativeAsync(Docs.WithImage(sha), new() { [sha] = fresh });
        var editor = await EditorWithImageAsync();
        var durableAtPublish = false;
        editor.OnReplace = _ => durableAtPublish = blobs.Contains(sha);
        var opened = await new SessionCoordinator(editor, blobs, preparer).OpenJsonAsync(path, new ExpectedState(editor.Document.Id, editor.SessionId, editor.Revision), CancellationToken.None);
        Assert.True(opened.Ok);
        Assert.True(durableAtPublish);
    }

    [Fact]
    public async Task ReferenceAndHashConsistencyIsChecked()
    {
        var editor = await EditorWithImageAsync();
        var missing = await WriteNativeAsync(Docs.WithImage(new string('e', 64)), new());
        var r1 = await new SessionCoordinator(editor, blobs, preparer).OpenJsonAsync(missing, new ExpectedState(editor.Document.Id, editor.SessionId, editor.Revision), CancellationToken.None);
        Assert.Equal("not_found", r1.Error!.Code);
        var wrong = await WriteNativeAsync(Docs.WithImage(new string('e', 64)), new() { [new string('e', 64)] = png });
        var r2 = await new SessionCoordinator(editor, blobs, preparer).OpenJsonAsync(wrong, new ExpectedState(editor.Document.Id, editor.SessionId, editor.Revision), CancellationToken.None);
        Assert.Equal("invalid_request", r2.Error!.Code);
        Assert.DoesNotContain("doc.replace", editor.Calls);
    }
}
