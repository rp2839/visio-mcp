using System.IO.Compression;
using System.Text;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Host.Tests;

public sealed class VsdxLifecycleTests : IDisposable
{
    private readonly TempDir tmp = new();
    private readonly BlobStore blobs;
    private readonly AssetPreparer preparer;
    private readonly byte[] png = Png.Create(8, 4);

    public VsdxLifecycleTests()
    {
        blobs = new BlobStore(tmp.File("blobs"));
        preparer = new AssetPreparer(blobs);
    }

    public void Dispose() => tmp.Dispose();

    private async Task<(FakeEditor Editor, VsdxCoordinator Vsdx, AtomicFileWriter Writer)> SetupAsync()
    {
        var sha = await blobs.PutDurableAsync(png, CancellationToken.None);
        var editor = new FakeEditor(Docs.WithImage(sha));
        var writer = new AtomicFileWriter();
        return (editor, new VsdxCoordinator(editor, blobs, preparer, writer: writer), writer);
    }

    private static ExpectedState Expect(FakeEditor e) => new(e.Document.Id, e.SessionId, e.Revision);

    [Fact]
    public async Task ExportThenOpenPreservesIdentityAndMarksClean()
    {
        var (editor, vsdx, _) = await SetupAsync();
        var path = tmp.File("a.vsdx");
        var saved = await vsdx.ExportAsync(path, editor.Scope, markSaved: true, CancellationToken.None);
        Assert.True(saved.Ok, saved.Error?.Message);
        Assert.True(saved.Value!.MarkedClean);
        Assert.False(editor.IsDirty);
        var before = editor.Document.Pages[0].Elements.Select(e => e.Id()).ToList();
        editor.Edit();
        var opened = await vsdx.OpenAsync(path, Expect(editor), CancellationToken.None);
        Assert.True(opened.Ok, opened.Error?.Message);
        Assert.False(opened.Value!.SaveAsRequired);
        Assert.Equal(before, editor.Document.Pages[0].Elements.Select(e => e.Id()).ToList());
        Assert.Equal(Docs.DocId, editor.Document.Id);
        Assert.False(editor.IsDirty);
    }

    [Fact]
    public async Task ImportedNativeBlobsDurableBeforePublish()
    {
        var (editor, vsdx, _) = await SetupAsync();
        var path = tmp.File("a.vsdx");
        Assert.True((await vsdx.ExportAsync(path, editor.Scope, false, CancellationToken.None)).Ok);
        // Fresh profile: empty blob store; the published document must only reference durable blobs.
        var freshBlobs = new BlobStore(tmp.File("blobs2"));
        var fresh = new VsdxCoordinator(editor, freshBlobs, new AssetPreparer(freshBlobs));
        var checkedAssets = 0;
        editor.OnReplace = doc => { foreach (var a in doc.Assets) { Assert.True(freshBlobs.Contains(a.Sha256)); checkedAssets++; } };
        Assert.True((await fresh.OpenAsync(path, Expect(editor), CancellationToken.None)).Ok);
        Assert.Equal(1, checkedAssets);
    }

    [Fact]
    public async Task InvalidCandidateIsRejectedWholeAndExistingDocumentStays()
    {
        var (editor, vsdx, _) = await SetupAsync();
        var path = tmp.File("bad.vsdx");
        await File.WriteAllBytesAsync(path, Encoding.UTF8.GetBytes("not a package"));
        var title = editor.Document.Title;
        var r = await vsdx.OpenAsync(path, Expect(editor), CancellationToken.None);
        Assert.Equal("invalid_request", r.Error!.Code);
        Assert.DoesNotContain("doc.replace", editor.Calls);
        Assert.Equal(title, editor.Document.Title);
    }

    [Fact]
    public async Task LossyImportRequiresSaveAsAndStaysDirty()
    {
        var (editor, vsdx, _) = await SetupAsync();
        var path = tmp.File("a.vsdx");
        Assert.True((await vsdx.ExportAsync(path, editor.Scope, false, CancellationToken.None)).Ok);
        using (var zip = ZipFile.Open(path, ZipArchiveMode.Update))
            using (var s = zip.CreateEntry("visio/vbaProject.bin").Open()) s.Write([1, 2, 3]);
        var r = await vsdx.OpenAsync(path, Expect(editor), CancellationToken.None);
        Assert.True(r.Ok, r.Error?.Message);
        Assert.True(r.Value!.SaveAsRequired);
        Assert.Contains("macro_inert", r.Value.Report.ByCode.Keys);
        Assert.Null(editor.SavedRevision); // published dirty, no save path → Save As
    }

    [Fact]
    public async Task ExportOfRevisionRDoesNotCleanRPlus1()
    {
        var (editor, vsdx, writer) = await SetupAsync();
        var r = editor.Revision;
        writer.BeforeReplace = _ => editor.Edit();
        var saved = await vsdx.ExportAsync(tmp.File("a.vsdx"), editor.Scope, true, CancellationToken.None);
        Assert.Equal(r, saved.Value!.Revision);
        Assert.Equal(r, editor.SavedRevision);
        Assert.True(editor.IsDirty);
    }

    [Fact]
    public async Task LateNativeOpenCannotReplaceNewEditsOrSession()
    {
        var (editor, vsdx, _) = await SetupAsync();
        var path = tmp.File("a.vsdx");
        Assert.True((await vsdx.ExportAsync(path, editor.Scope, false, CancellationToken.None)).Ok);
        var expected = Expect(editor);
        editor.Edit();
        Assert.Equal("revision_conflict", (await vsdx.OpenAsync(path, expected, CancellationToken.None)).Error!.Code);
        var expected2 = Expect(editor);
        editor.NewSession();
        Assert.Equal("session_mismatch", (await vsdx.OpenAsync(path, expected2, CancellationToken.None)).Error!.Code);
    }

    [Fact]
    public async Task MissingBlobFailsExportWithoutWriting()
    {
        var editor = new FakeEditor(Docs.WithImage(new string('a', 64)));
        var vsdx = new VsdxCoordinator(editor, blobs, preparer);
        var path = tmp.File("missing.vsdx");
        var r = await vsdx.ExportAsync(path, editor.Scope, true, CancellationToken.None);
        Assert.Equal("not_found", r.Error!.Code);
        Assert.False(File.Exists(path));
        Assert.Null(editor.SavedRevision);
    }

    [Fact]
    public async Task SvgUsesFrontendRasterAndCarriesSourceElseNotClean()
    {
        var svg = Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\" fill=\"#f00\"/></svg>");
        var prep = await preparer.PrepareBytesAsync(svg, "image/svg+xml", new AssetPreparer.Options("Vec"), CancellationToken.None);
        var editor = new FakeEditor(Docs.WithImage(prep.Value!.Ref.Asset.Sha256, "image/svg+xml")) { RasterPng = png };
        var vsdx = new VsdxCoordinator(editor, blobs, preparer);
        var ok = await vsdx.ExportAsync(tmp.File("v.vsdx"), editor.Scope, true, CancellationToken.None);
        Assert.True(ok.Value!.MarkedClean);
        Assert.Contains("svg_rasterised", ok.Value.Report.ByCode.Keys);
        var reopened = await vsdx.OpenAsync(tmp.File("v.vsdx"), Expect(editor), CancellationToken.None);
        Assert.Equal("image/svg+xml", editor.Document.Assets.Single().MimeType);

        var noRaster = new FakeEditor(Docs.WithImage(prep.Value.Ref.Asset.Sha256, "image/svg+xml"));
        var lossy = await new VsdxCoordinator(noRaster, blobs, preparer).ExportAsync(tmp.File("w.vsdx"), noRaster.Scope, true, CancellationToken.None);
        Assert.False(lossy.Value!.MarkedClean);
        Assert.Contains("svg_no_fallback", lossy.Value.Report.ByCode.Keys);
    }
}
