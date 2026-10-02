using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Visio;
using Diagram.Visio.Abstractions;

namespace Diagram.Host.Core;

public sealed record OpenedVsdx(Snapshot Snapshot, CompatibilityReport Report, IdentityReport Identity, bool SaveAsRequired);
public sealed record ExportedVsdx(string Path, string DocumentId, string SessionId, long Revision, bool MarkedClean, CompatibilityReport Report);

/// <summary>
/// Native VSDX open/export. Import and IO run outside the engine queue; publication goes
/// through the same expected-session/revision barrier as JSON open. Every imported blob is
/// sanitised and durable before the candidate is published; a failure leaves the current
/// document untouched. Export reads one revision-matched snapshot + projection barrier.
/// </summary>
public sealed class VsdxCoordinator(IEditorChannel editor, BlobStore blobs, AssetPreparer preparer,
    IVsdxImporter? importer = null, IVsdxExporter? exporter = null, AtomicFileWriter? writer = null)
{
    private readonly IVsdxImporter importer = importer ?? new DirectVsdxImporter();
    private readonly IVsdxExporter exporter = exporter ?? new DirectVsdxExporter();
    private readonly AtomicFileWriter writer = writer ?? new AtomicFileWriter();
    private static readonly PackageLimits Limits = new(InputLimits.VsdxCompressedBytes, InputLimits.VsdxEntries, InputLimits.VsdxExpandedBytes,
        InputLimits.VsdxEntryExpandedBytes, InputLimits.VsdxMaxCompressionRatio, InputLimits.XmlMaxDepth, InputLimits.XmlMaxCharacters);

    public async Task<Result<OpenedVsdx>> OpenAsync(string path, ExpectedState expected, CancellationToken ct)
    {
        var info = new FileInfo(path);
        if (!info.Exists) return Result<OpenedVsdx>.Fail("not_found", "file not found");
        if (info.Length > InputLimits.VsdxCompressedBytes) return Result<OpenedVsdx>.Fail("limit_exceeded", "VSDX exceeds 100 MiB");
        var prepared = await PrepareAsync(await File.ReadAllBytesAsync(path, ct), path, ct);
        if (!prepared.Ok) return Result<OpenedVsdx>.From(prepared.Error!);
        var (document, report, identity) = prepared.Value!;
        // A lossy import is published dirty with no save path: Ctrl+S becomes Save As.
        var replaced = await editor.CallAsync("doc.replace", new Scope { DocumentId = expected.DocumentId, SessionId = expected.SessionId }, new JsonObject
        {
            ["baseRevision"] = expected.BaseRevision,
            ["document"] = JsonNode.Parse(ContractJson.Serialize(document)),
            ["savedRevision"] = report.RequiresSaveAs ? null : document.Revision,
            ["path"] = report.RequiresSaveAs ? null : path,
        }, ct);
        if (!replaced.Ok) return Result<OpenedVsdx>.From(replaced.Error!);
        return Result<OpenedVsdx>.Success(new OpenedVsdx(replaced.Value.Deserialize<Snapshot>(ContractJson.Options)!, report, identity, report.RequiresSaveAs));
    }

    /// <summary>Guard → import → sanitise + durable blobs. Never publishes.</summary>
    public async Task<Result<(DiagramDocument Document, CompatibilityReport Report, IdentityReport Identity)>> PrepareAsync(byte[] package, string? sourcePath, CancellationToken ct)
    {
        ImportResult imported;
        GuardedPackage guarded;
        try
        {
            guarded = await PackageGuard.ValidateAsync(new MemoryStream(package), Limits, ct);
            imported = await importer.ImportAsync(new MemoryStream(guarded.Bytes), new ImportOptions(sourcePath), ct);
        }
        catch (VsdxException e)
        {
            return Fail(e.Code, e.Message);
        }
        var diagnostics = new List<Diagnostic>(guarded.Diagnostics);
        diagnostics.AddRange(imported.Diagnostics);
        var assets = new List<Asset>();
        var remap = new Dictionary<string, string>();
        foreach (var asset in imported.Document.Assets)
        {
            if (!imported.Blobs.TryGetValue(asset.Sha256, out var bytes)) return Fail("invalid_request", $"asset {asset.Id} has no package bytes");
            var p = await preparer.PrepareBytesAsync(bytes, asset.MimeType, new AssetPreparer.Options(asset.Name, asset.Id["asset:".Length..].Split('~')[0], asset.Tags, asset.Provenance), ct);
            if (!p.Ok) return Fail(p.Error!.Code, $"asset {asset.Id}: {p.Error.Message}");
            var sha = p.Value!.Ref.Asset.Sha256; // durable in the blob store before publication
            if (sha != asset.Sha256)
                diagnostics.Add(new Diagnostic { Severity = "warning", Code = "svg_sanitised", Action = "approximated", Detail = $"asset {asset.Id} was sanitised on import" });
            assets.Add(asset with { Sha256 = sha, EmbeddedData = null, SourcePath = null, WidthPx = asset.WidthPx ?? p.Value.Ref.Asset.WidthPx, HeightPx = asset.HeightPx ?? p.Value.Ref.Asset.HeightPx });
        }
        return Result<(DiagramDocument, CompatibilityReport, IdentityReport)>.Success((imported.Document with { Assets = assets }, CompatibilityReport.From(diagnostics), imported.Identity));

        static Result<(DiagramDocument, CompatibilityReport, IdentityReport)> Fail(string code, string message) =>
            Result<(DiagramDocument, CompatibilityReport, IdentityReport)>.Fail(code, message);
    }

    /// <param name="markSaved">GUI save to .vsdx: mark revision R clean only when nothing was dropped.</param>
    public async Task<Result<ExportedVsdx>> ExportAsync(string path, Scope scope, bool markSaved, CancellationToken ct)
    {
        var snap = await editor.CallAsync("doc.exportSnapshot", scope, new JsonObject(), ct);
        if (!snap.Ok) return Result<ExportedVsdx>.From(snap.Error!);
        var snapshot = snap.Value.Deserialize<ExportSnapshot>(ContractJson.Options)!;
        ExportResult result;
        try
        {
            result = await exporter.ExportAsync(snapshot, new HostBlobSource(blobs, editor, scope), new ExportOptions(), ct);
        }
        catch (VsdxException e)
        {
            return Result<ExportedVsdx>.Fail(e.Code, e.Message);
        }
        catch (HostException e)
        {
            return Result<ExportedVsdx>.From(e.Error);
        }
        try
        {
            await writer.WriteAsync(path, result.Package, ct);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Result<ExportedVsdx>.Fail("io_error", $"export failed: {e.Message}", retryable: true);
        }
        var report = CompatibilityReport.From(result.Diagnostics);
        var marked = false;
        if (markSaved && report.Dropped == 0)
        {
            var m = await editor.CallAsync("doc.markSaved", new Scope { DocumentId = snapshot.DocumentId, SessionId = snapshot.SessionId },
                new JsonObject { ["revision"] = snapshot.Revision, ["path"] = path }, ct);
            marked = m.Ok;
        }
        return Result<ExportedVsdx>.Success(new ExportedVsdx(path, snapshot.DocumentId, snapshot.SessionId, snapshot.Revision, marked, report));
    }

    /// <summary>Approved blobs by hash; SVG raster derivatives come from the frontend renderer and are cached durably.</summary>
    private sealed class HostBlobSource(BlobStore blobs, IEditorChannel editor, Scope scope) : IAssetBlobSource
    {
        public Task<ReadOnlyMemory<byte>> ReadAsync(string sha256, CancellationToken ct) => blobs.ReadAsync(sha256, ct);

        public async Task<ReadOnlyMemory<byte>?> ReadRasterFallbackAsync(string sha256, CancellationToken ct)
        {
            var r = await editor.CallAsync("asset.rasterize", scope, new JsonObject { ["sha256"] = sha256 }, ct);
            if (!r.Ok || r.Value.ValueKind != JsonValueKind.Object || !r.Value.TryGetProperty("data", out var data)) return null;
            byte[] png;
            try { png = Convert.FromBase64String(data.GetString() ?? ""); }
            catch (FormatException) { return null; }
            if (AssetPreparer.Sniff(png) != "image/png" || RasterHeader.Read("image/png", png) is null) return null;
            await blobs.PutDurableAsync(png, ct);
            return png;
        }
    }
}
