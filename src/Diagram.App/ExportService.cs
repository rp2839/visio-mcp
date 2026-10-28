using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Diagram.Visio;

namespace Diagram.App;

/// <summary>
/// export_document: writes vsdx, svg, png or jpeg for an outside client. A client never names a place on the disk freely: files go to the
/// folder of the open document or to the application's export folder, anywhere else needs the person's choice (see <see cref="ExportPathPolicy"/>),
/// and the destination is checked again right before the write.
/// </summary>
public sealed partial class ExportService
{
    readonly MainWindow window;
    readonly IExportConsent? consent;

    public ExportService(MainWindow window, string exportRoot, IExportConsent? consent = null)
    {
        this.window = window;
        this.consent = consent;
        Policy = new ExportPathPolicy(exportRoot,
            () => window.Services?.CurrentPath is { } p && Path.GetDirectoryName(p) is { Length: > 0 } dir ? [Path.GetFullPath(dir)] : [],
            () => window.Router.CurrentScope, consent);
        PhysicalPrintDispatcher = (job, ct) => PdfExport.PrintAsync(window, job, ct);
        PrintOutputHandler = HandlePreparedPrintOutputAsync;
    }

    public ExportPathPolicy Policy { get; }
    public string ExportRoot => Policy.ExportRoot;

    /// <summary>The folders a client may export into without being asked: the export folder, and the folder the open document came from.</summary>
    public IReadOnlyList<string> ApprovedRoots() => Policy.ApprovedRoots();

    public async Task<ResponseEnvelope> HandleAsync(RequestEnvelope request, CancellationToken ct)
    {
        ResponseEnvelope Err(string code, string message, JsonObject? details = null, bool retryable = false) =>
            new() { RequestId = request.RequestId, Error = new AppError { Code = code, Message = message, Retryable = retryable, Details = details } };
        ResponseEnvelope Err2(AppError e) => new() { RequestId = request.RequestId, Error = e };

        // Any open document can be exported, not just the active tab: the request names the document and session, and the router knows whether that pair is still open.
        if (window.Router.Documents.Count == 0) return Err("not_ready", "the editor has not signalled ready", retryable: true);
        if (request.DocumentId is not { } documentId || window.Router.ScopeOf(documentId) is not { } scope) return Err("document_mismatch", "the document is not the open one");
        if (request.SessionId != scope.SessionId) return Err("session_mismatch", "the session is not the current one");
        var format = request.Params["format"]?.GetValue<string>() ?? "";
        var requested = request.Params["path"]?.GetValue<string>();
        var pageId = request.Params["pageId"]?.GetValue<string>();

        // the snapshot barrier gives the title and revision this export will be labelled with
        var snap = await window.Router.SnapshotAsync(scope, ct);
        if (!snap.IsOk) return Err2(snap.Error!);
        // the document's own folder is approved, and the destination is rechecked against this document staying open (it need not be the active tab)
        var policy = new ExportPathPolicy(ExportRoot,
            () => window.Services?.PathOf(documentId) is { } p && Path.GetDirectoryName(p) is { Length: > 0 } dir ? [Path.GetFullPath(dir)] : [],
            () => window.Router.ScopeOf(documentId), consent);
        var dest = await policy.ResolveAsync(requested, format, snap.Value.Document.Title, scope, snap.Value.Revision, "MCP client", ct);
        if (!dest.IsOk) return Err2(dest.Error!);
        var path = Result<string>.Ok(dest.Value.Path);
        Directory.CreateDirectory(Path.GetDirectoryName(path.Value)!);
        Result<Unit> Revalidate() { var again = policy.Revalidate(dest.Value, scope); return again.IsOk ? Result<Unit>.Ok(default) : Result<Unit>.Fail(again.Error!); }

        if (format == "vsdx")
        {
            var r = await window.Native.ExportAsync(path.Value, scope, acceptLoss: true, ct, Revalidate);
            if (!r.IsOk) return Err2(r.Error!);
            return Ok(request, new JsonObject
            {
                ["path"] = r.Value.Path, ["format"] = "vsdx", ["revision"] = r.Value.Revision, ["bytes"] = r.Value.Bytes, ["lossy"] = r.Value.Report.IsLossy,
                ["summary"] = r.Value.Report.Summary, ["diagnostics"] = r.Value.Report.ToJson(),
            });
        }

        var p = new JsonObject { ["scope"] = "page", ["format"] = format, ["maxWidth"] = format == "svg" ? 4096 : 3200, ["maxHeight"] = format == "svg" ? 4096 : 2400 };
        if (pageId is not null) p["pageId"] = pageId;
        var rendered = await window.Router.RenderAsync(scope, p, ct);
        if (!rendered.IsOk) return Err2(rendered.Error!);
        byte[] bytes;
        try { bytes = Convert.FromBase64String(rendered.Value.GetProperty("base64").GetString()!); }
        catch (Exception e) when (e is FormatException or KeyNotFoundException or InvalidOperationException) { return Err("internal_error", "the editor returned an unreadable picture"); }
        if (Revalidate() is { IsOk: false } stale) return Err2(stale.Error!);
        try { await window.Writer.WriteAsync(path.Value, bytes, ct); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return Err("io_error", "the file could not be written: " + e.Message, retryable: true); }
        return Ok(request, new JsonObject
        {
            ["path"] = path.Value, ["format"] = format, ["revision"] = rendered.Value.GetProperty("revision").GetInt32(), ["bytes"] = bytes.Length, ["lossy"] = false,
            ["widthPx"] = rendered.Value.GetProperty("widthPx").GetInt32(), ["heightPx"] = rendered.Value.GetProperty("heightPx").GetInt32(),
        });
    }

    static ResponseEnvelope Ok(RequestEnvelope r, JsonNode result) => new() { RequestId = r.RequestId, Result = JsonSerializer.SerializeToElement(result) };
}
