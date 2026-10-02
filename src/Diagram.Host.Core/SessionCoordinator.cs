using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

/// <summary>Host → frontend lifecycle calls. The frontend engine owns the only editable document.</summary>
public interface IEditorChannel
{
    Task<Result<JsonElement>> CallAsync(string method, Scope? scope, JsonObject parameters, CancellationToken ct);
}

public sealed record ExpectedState(string DocumentId, string SessionId, long BaseRevision);
public sealed record SavedFile(string Path, string DocumentId, string SessionId, long Revision, bool MarkedClean);
public sealed record OpenedDocument(Snapshot Snapshot, IReadOnlyList<Diagnostic> Diagnostics);

/// <summary>
/// Save/open lifecycle. Save captures revision R through a queued snapshot barrier, does IO
/// outside the queue and marks only R saved in its original session. Open prepares the whole
/// candidate (limits, blobs, sanitising, durable storage) before publishing it through the
/// engine's expected-session/revision barrier, which issues a fresh session.
/// </summary>
public sealed class SessionCoordinator(IEditorChannel editor, BlobStore blobs, AssetPreparer preparer, AtomicFileWriter? writer = null)
{
    public const string Format = "agentic-diagram";
    public const int FormatVersion = 1;
    private readonly AtomicFileWriter writer = writer ?? new AtomicFileWriter();

    public async Task<Result<SavedFile>> SaveJsonAsync(string path, Scope scope, CancellationToken ct)
    {
        var snap = await editor.CallAsync("doc.snapshot", scope, new JsonObject(), ct);
        if (!snap.Ok) return Result<SavedFile>.From(snap.Error!);
        var snapshot = snap.Value.Deserialize<Snapshot>(ContractJson.Options)!;
        byte[] bytes;
        try
        {
            bytes = await SerializeAsync(snapshot.Document, ct);
        }
        catch (HostException e)
        {
            return Result<SavedFile>.From(e.Error);
        }
        try
        {
            await writer.WriteAsync(path, bytes, ct);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Original file untouched; document stays dirty.
            return Result<SavedFile>.Fail("io_error", $"save failed: {e.Message}", retryable: true);
        }
        var marked = await editor.CallAsync("doc.markSaved", new Scope { DocumentId = snapshot.DocumentId, SessionId = snapshot.SessionId },
            new JsonObject { ["revision"] = snapshot.Revision, ["path"] = path }, ct);
        // If the session changed meanwhile, the file is written but nothing is marked clean.
        return Result<SavedFile>.Success(new SavedFile(path, snapshot.DocumentId, snapshot.SessionId, snapshot.Revision, marked.Ok));
    }

    public async Task<byte[]> SerializeAsync(DiagramDocument document, CancellationToken ct)
    {
        var assets = new JsonObject();
        var liveAssets = new List<Asset>();
        foreach (var a in document.Assets)
        {
            var blob = await blobs.ReadAsync(a.Sha256, ct);
            assets[a.Sha256] = Convert.ToBase64String(blob.Span);
            liveAssets.Add(a with { EmbeddedData = null });
        }
        var doc = document with { Assets = liveAssets };
        var root = new JsonObject
        {
            ["format"] = Format,
            ["formatVersion"] = FormatVersion,
            ["document"] = JsonNode.Parse(ContractJson.Serialize(doc)),
            ["assetBlobs"] = assets,
        };
        return Encoding.UTF8.GetBytes(root.ToJsonString());
    }

    public async Task<Result<OpenedDocument>> OpenJsonAsync(string path, ExpectedState expected, CancellationToken ct)
    {
        var info = new FileInfo(path);
        if (!info.Exists) return Result<OpenedDocument>.Fail("not_found", "file not found");
        if (info.Length > InputLimits.NativeJsonBytes) return Result<OpenedDocument>.Fail("limit_exceeded", "native JSON exceeds 64 MiB");
        var bytes = await File.ReadAllBytesAsync(path, ct);
        var prepared = await PrepareCandidateAsync(bytes, ct);
        if (!prepared.Ok) return Result<OpenedDocument>.From(prepared.Error!);
        var (document, diagnostics) = prepared.Value!;
        var replaced = await editor.CallAsync("doc.replace", new Scope { DocumentId = expected.DocumentId, SessionId = expected.SessionId }, new JsonObject
        {
            ["baseRevision"] = expected.BaseRevision,
            ["document"] = JsonNode.Parse(ContractJson.Serialize(document)),
            ["savedRevision"] = document.Revision,
            ["path"] = path,
        }, ct);
        if (!replaced.Ok) return Result<OpenedDocument>.From(replaced.Error!);
        return Result<OpenedDocument>.Success(new OpenedDocument(replaced.Value.Deserialize<Snapshot>(ContractJson.Options)!, diagnostics));
    }

    /// <summary>Bounded parse, blob verification, sanitising and durable storage; never publishes.</summary>
    public async Task<Result<(DiagramDocument Document, List<Diagnostic> Diagnostics)>> PrepareCandidateAsync(byte[] bytes, CancellationToken ct)
    {
        if (bytes.LongLength > InputLimits.NativeJsonBytes) return Fail("limit_exceeded", "native JSON exceeds 64 MiB");
        var scan = ScanBudgets(bytes);
        if (scan is not null) return Fail(scan.Value.Code, scan.Value.Message);
        JsonObject root;
        DiagramDocument document;
        try
        {
            root = JsonNode.Parse(bytes, documentOptions: new JsonDocumentOptions { MaxDepth = InputLimits.NativeJsonDepth })!.AsObject();
            if (root["format"]?.GetValue<string>() != Format || root["formatVersion"]?.GetValue<int>() != FormatVersion)
                return Fail("unsupported_version", "not an agentic-diagram v1 JSON file");
            document = ContractJson.Deserialize<DiagramDocument>(root["document"]!.ToJsonString());
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or NullReferenceException or FormatException)
        {
            return Fail("invalid_request", $"malformed native JSON: {e.Message}");
        }
        var blobsNode = root["assetBlobs"] as JsonObject ?? new JsonObject();
        var diagnostics = new List<Diagnostic>();
        var assets = new List<Asset>();
        foreach (var asset in document.Assets)
        {
            var b64 = blobsNode[asset.Sha256]?.GetValue<string>() ?? asset.EmbeddedData;
            if (b64 is null) return Fail("not_found", $"asset {asset.Id} has no embedded bytes (sourcePath is never reread)");
            byte[] data;
            try { data = Convert.FromBase64String(b64); }
            catch (FormatException) { return Fail("invalid_request", $"asset {asset.Id} bytes are not base64"); }
            if (BlobStore.Sha256(data) != asset.Sha256) return Fail("invalid_request", $"asset {asset.Id} bytes do not match its sha256");
            var p = await preparer.PrepareBytesAsync(data, asset.MimeType, new AssetPreparer.Options(asset.Name, asset.Id["asset:".Length..].Split('~')[0], asset.Tags, asset.Provenance, asset.SourcePath), ct);
            if (!p.Ok) return Fail(p.Error!.Code, $"asset {asset.Id}: {p.Error.Message}");
            var sha = p.Value!.Ref.Asset.Sha256;
            if (sha != asset.Sha256)
                diagnostics.Add(new Diagnostic { Severity = "warning", Code = "svg_sanitised", Action = "approximated", Detail = $"asset {asset.Id} was sanitised; hash {asset.Sha256[..12]}… → {sha[..12]}…" });
            assets.Add(asset with { Sha256 = sha, EmbeddedData = null, WidthPx = asset.WidthPx ?? p.Value.Ref.Asset.WidthPx, HeightPx = asset.HeightPx ?? p.Value.Ref.Asset.HeightPx });
        }
        foreach (var (sha, _) in blobsNode)
            if (!document.Assets.Any(a => a.Sha256 == sha))
                diagnostics.Add(new Diagnostic { Severity = "info", Code = "unreferenced_blob", Action = "dropped", Detail = $"blob {sha[..Math.Min(12, sha.Length)]}… is not referenced" });
        return Result<(DiagramDocument, List<Diagnostic>)>.Success((document with { Assets = assets }, diagnostics));

        static Result<(DiagramDocument, List<Diagnostic>)> Fail(string code, string message) => Result<(DiagramDocument, List<Diagnostic>)>.Fail(code, message);
    }

    /// <summary>Streaming pre-scan: nesting depth and ordinary string length are bounded before any tree is built.</summary>
    internal static (string Code, string Message)? ScanBudgets(ReadOnlySpan<byte> json)
    {
        var reader = new Utf8JsonReader(json, new JsonReaderOptions { MaxDepth = InputLimits.NativeJsonDepth + 1, CommentHandling = JsonCommentHandling.Disallow });
        var inBlobs = false;
        var blobsDepth = -1;
        try
        {
            while (reader.Read())
            {
                if (reader.CurrentDepth > InputLimits.NativeJsonDepth) return ("limit_exceeded", $"JSON nesting exceeds {InputLimits.NativeJsonDepth}");
                switch (reader.TokenType)
                {
                    case JsonTokenType.PropertyName when reader.CurrentDepth == 1 && reader.ValueTextEquals("assetBlobs"u8):
                        inBlobs = true;
                        blobsDepth = 1;
                        break;
                    case JsonTokenType.EndObject when inBlobs && reader.CurrentDepth == blobsDepth:
                        inBlobs = false;
                        break;
                    case JsonTokenType.String:
                        var len = reader.HasValueSequence ? reader.ValueSequence.Length : reader.ValueSpan.Length;
                        if (inBlobs)
                        {
                            if (len > InputLimits.RasterBytes * 4 / 3 + 4) return ("limit_exceeded", "embedded asset exceeds the raster budget");
                        }
                        else if (len > InputLimits.NativeJsonStringChars && (len > InputLimits.NativeJsonStringChars * 6L || reader.GetString()!.Length > InputLimits.NativeJsonStringChars))
                            return ("limit_exceeded", "string exceeds 1 MiB");
                        break;
                }
            }
        }
        catch (JsonException e)
        {
            return (e.Message.Contains("depth", StringComparison.OrdinalIgnoreCase) ? "limit_exceeded" : "invalid_request", $"malformed JSON: {e.Message}");
        }
        return null;
    }
}
