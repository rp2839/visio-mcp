using System.Text.Json;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Host.Tests;

public sealed class ExportPathTests : IDisposable
{
    private readonly TempDir tmp = new();
    public void Dispose() => tmp.Dispose();

    private sealed class Consent(Func<string, string, CancellationToken, Task<bool>> answer) : IExportConsent
    {
        public List<string> Asked { get; } = [];
        public Task<bool> RequestAsync(string client, string path, string reason, CancellationToken ct) { Asked.Add(reason); return answer(path, reason, ct); }
    }

    private static Func<CancellationToken, Task<bool>> Current(bool v = true) => _ => Task.FromResult(v);
    private string Ws => tmp.File("exports");

    [Fact]
    public async Task OmittedPathGetsSafeUniqueNameInWorkspace()
    {
        var policy = new ExportPathPolicy(Ws);
        var a = await policy.ResolveAsync(null, "vsdx", null, "Architecture: Q3/plan", 7, "agent", Current(), CancellationToken.None);
        Assert.Equal(Path.Combine(Path.GetFullPath(Ws), "architecture-q3-plan-r7.vsdx"), a.Value!.Path);
        await File.WriteAllTextAsync(a.Value.Path, "x");
        var b = await policy.ResolveAsync(null, "vsdx", null, "Architecture: Q3/plan", 7, "agent", Current(), CancellationToken.None);
        Assert.EndsWith("architecture-q3-plan-r7-2.vsdx", b.Value!.Path);
        var reserved = await policy.ResolveAsync(null, "png", null, "CON", 1, "agent", Current(), CancellationToken.None);
        Assert.EndsWith("diagram-r1.png", reserved.Value!.Path);
    }

    [Fact]
    public async Task SavedDocumentDirectoryIsApprovedWithoutConsent()
    {
        var docDir = Directory.CreateDirectory(tmp.File("docs")).FullName;
        var consent = new Consent((_, _, _) => Task.FromResult(false));
        var policy = new ExportPathPolicy(Ws, consent);
        var r = await policy.ResolveAsync(Path.Combine(docDir, "out.vsdx"), "vsdx", Path.Combine(docDir, "a.diagram.json"), "t", 1, "agent", Current(), CancellationToken.None);
        Assert.True(r.Ok);
        Assert.Empty(consent.Asked);
        var omitted = await policy.ResolveAsync(null, "svg", Path.Combine(docDir, "a.diagram.json"), "t", 1, "agent", Current(), CancellationToken.None);
        Assert.StartsWith(docDir, omitted.Value!.Path);
    }

    [Fact]
    public async Task OutsideRootAndOverwriteNeedConsent()
    {
        var outside = Directory.CreateDirectory(tmp.File("elsewhere")).FullName;
        var target = Path.Combine(outside, "x.png");
        Assert.Equal("consent_denied", (await new ExportPathPolicy(Ws).ResolveAsync(target, "png", null, "t", 1, "agent", Current(), CancellationToken.None)).Error!.Code);
        var yes = new Consent((_, _, _) => Task.FromResult(true));
        var ok = await new ExportPathPolicy(Ws, yes).ResolveAsync(target, "png", null, "t", 1, "agent", Current(), CancellationToken.None);
        Assert.True(ok.Value!.ConsentGiven);
        Assert.Contains("outside the approved folders", yes.Asked.Single());
        Directory.CreateDirectory(Ws);
        var existing = Path.Combine(Ws, "e.png");
        await File.WriteAllTextAsync(existing, "old");
        var no = new Consent((_, _, _) => Task.FromResult(false));
        Assert.Equal("consent_denied", (await new ExportPathPolicy(Ws, no).ResolveAsync(existing, "png", null, "t", 1, "agent", Current(), CancellationToken.None)).Error!.Code);
        Assert.Contains("replaces an existing file", no.Asked.Single());
        Assert.Equal("old", await File.ReadAllTextAsync(existing));
    }

    [Theory]
    [InlineData(@"\\server\share\x.vsdx", "UNC")]
    [InlineData(@"\\?\C:\x.vsdx", "device")]
    [InlineData(@"\\.\PhysicalDrive0", "device")]
    [InlineData(@"C:\docs\x.vsdx:secret", "alternate data streams")]
    [InlineData(@"C:\docs\CON.vsdx", "reserved")]
    [InlineData(@"C:\docs\lpt1", "reserved")]
    [InlineData(@"C:\docs\..\x.vsdx", "relative segments")]
    [InlineData(@"C:\docs\name. \x.vsdx", "dot or space")]
    [InlineData(@"docs\x.vsdx", "absolute")]
    [InlineData("C:\\docs\\x?.vsdx", "invalid characters")]
    public void UnsafeSyntaxRejects(string path, string expected)
    {
        Assert.Contains(expected, ExportPathPolicy.CheckSyntax(path));
    }

    [Fact]
    public void SafeWindowsPathPassesSyntax() => Assert.Null(ExportPathPolicy.CheckSyntax(@"C:\Users\me\Documents\diagram.vsdx"));

    [Fact]
    public async Task ReparseTraversalRejects()
    {
        Directory.CreateDirectory(Ws);
        var outside = Directory.CreateDirectory(tmp.File("secret")).FullName;
        var link = Path.Combine(Ws, "link");
        Directory.CreateSymbolicLink(link, outside);
        var r = await new ExportPathPolicy(Ws, new Consent((_, _, _) => Task.FromResult(true))).ResolveAsync(Path.Combine(link, "x.vsdx"), "vsdx", null, "t", 1, "agent", Current(), CancellationToken.None);
        Assert.Equal("path_not_permitted", r.Error!.Code);
    }

    [Fact]
    public async Task ExtensionMismatchRejects()
    {
        var r = await new ExportPathPolicy(Ws).ResolveAsync(Path.Combine(Path.GetFullPath(Ws), "x.png"), "vsdx", null, "t", 1, "agent", Current(), CancellationToken.None);
        Assert.Equal("invalid_request", r.Error!.Code);
        Assert.True((await new ExportPathPolicy(Ws).ResolveAsync(Path.Combine(Path.GetFullPath(Ws), "x.jpeg"), "jpeg", null, "t", 1, "agent", Current(), CancellationToken.None)).Ok);
    }

    [Fact]
    public async Task LateConsentAfterSessionChangeRejects()
    {
        var target = Path.Combine(Directory.CreateDirectory(tmp.File("o")).FullName, "x.svg");
        var r = await new ExportPathPolicy(Ws, new Consent((_, _, _) => Task.FromResult(true))).ResolveAsync(target, "svg", null, "t", 1, "agent", Current(false), CancellationToken.None);
        Assert.Equal("session_mismatch", r.Error!.Code);
    }

    [Fact]
    public async Task ConsentTimeoutDenies()
    {
        var target = Path.Combine(Directory.CreateDirectory(tmp.File("o")).FullName, "x.svg");
        var slow = new Consent(async (_, _, ct) => { await Task.Delay(Timeout.Infinite, ct); return true; });
        var r = await new ExportPathPolicy(Ws, slow, TimeSpan.FromMilliseconds(50)).ResolveAsync(target, "svg", null, "t", 1, "agent", Current(), CancellationToken.None);
        Assert.Equal("consent_denied", r.Error!.Code);
    }

    [Fact]
    public async Task RevalidateBeforeWriteCatchesNewFileOrLink()
    {
        var policy = new ExportPathPolicy(Ws);
        var d = (await policy.ResolveAsync(null, "png", null, "t", 1, "agent", Current(), CancellationToken.None)).Value!;
        Assert.True(policy.Revalidate(d).Ok);
        await File.WriteAllTextAsync(d.Path, "appeared");
        Assert.Equal("consent_denied", policy.Revalidate(d).Error!.Code);
    }

    [Fact]
    public async Task ExportServiceWritesApprovedVsdxWithoutMarkingSaved()
    {
        var blobs = new BlobStore(tmp.File("blobs"));
        var preparer = new AssetPreparer(blobs);
        var sha = await blobs.PutDurableAsync(Png.Create(4, 4), CancellationToken.None);
        var editor = new FakeEditor(Docs.WithImage(sha));
        var svc = new ExportService(editor, new VsdxCoordinator(editor, blobs, preparer), new ExportPathPolicy(Ws), () => null);
        RequestEnvelope Req(object p) => new() { ProtocolVersion = 1, Kind = "request", RequestId = "x", Method = "doc.export", DocumentId = editor.Document.Id, SessionId = editor.SessionId, Params = JsonSerializer.SerializeToElement(p) };
        var r = await svc.HandleAsync(Req(new { format = "vsdx" }), CancellationToken.None);
        Assert.Null(r.Error);
        var path = r.Result.GetProperty("path").GetString()!;
        Assert.True(File.Exists(path));
        Assert.StartsWith(Path.GetFullPath(Ws), path);
        Assert.Null(editor.SavedRevision); // an export is a copy, never a save
        var svg = await svc.HandleAsync(Req(new { format = "svg" }), CancellationToken.None);
        Assert.StartsWith("<svg", await File.ReadAllTextAsync(svg.Result.GetProperty("path").GetString()!));
        var denied = await svc.HandleAsync(Req(new { format = "vsdx", path = "/etc/passwd.vsdx" }), CancellationToken.None);
        Assert.Equal(("consent_denied", "not_applied"), (denied.Error!.Code, denied.Error.Outcome));
    }
}
