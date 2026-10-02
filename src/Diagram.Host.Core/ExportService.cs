using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

/// <summary>
/// doc.export for MCP clients: vsdx/svg/png/jpeg of one revision-labelled snapshot, written
/// atomically to a destination approved by ExportPathPolicy. Exports never change the save
/// path or clean state of the open document.
/// </summary>
public sealed class ExportService(IEditorChannel editor, VsdxCoordinator vsdx, ExportPathPolicy policy, Func<string?> documentPath, AtomicFileWriter? writer = null) : IHostRequestService
{
    private readonly AtomicFileWriter writer = writer ?? new AtomicFileWriter();

    public bool Handles(string method) => method == "doc.export";

    public async Task<ResponseEnvelope> HandleAsync(RequestEnvelope request, CancellationToken ct)
    {
        if (request.DocumentId is null || request.SessionId is null) return HostRequestHandler.Error(request.RequestId, "invalid_request", "documentId and sessionId are required");
        var scope = new Scope { DocumentId = request.DocumentId, SessionId = request.SessionId };
        var p = request.Params.ValueKind == JsonValueKind.Object ? request.Params : default;
        var format = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("format", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString()! : "";
        var path = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("path", out var pa) && pa.ValueKind == JsonValueKind.String ? pa.GetString() : null;
        var pageId = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("pageId", out var pg) && pg.ValueKind == JsonValueKind.String ? pg.GetString() : null;

        var snap = await editor.CallAsync("doc.snapshot", scope, new JsonObject(), ct);
        if (!snap.Ok) return Err(request, snap.Error!);
        var snapshot = snap.Value.Deserialize<Snapshot>(ContractJson.Options)!;
        var origin = request.Origin?.ClientLabel ?? request.Origin?.ConnectionId ?? "MCP client";
        var dest = await policy.ResolveAsync(path, format, documentPath(), snapshot.Document.Title, snapshot.Revision, origin,
            async c => (await editor.CallAsync("doc.snapshot", scope, new JsonObject(), c)).Ok, ct);
        if (!dest.Ok) return Err(request, dest.Error!);
        var reval = policy.Revalidate(dest.Value!);
        if (!reval.Ok) return Err(request, reval.Error!);

        long revision;
        var diagnostics = new JsonArray();
        if (format == "vsdx")
        {
            var r = await vsdx.ExportAsync(dest.Value!.Path, scope, markSaved: false, ct);
            if (!r.Ok) return Err(request, r.Error!);
            revision = r.Value!.Revision;
            foreach (var d in r.Value.Report.Diagnostics) diagnostics.Add(JsonNode.Parse(ContractJson.Serialize(d)));
        }
        else
        {
            byte[] bytes;
            if (format == "svg")
            {
                var r = await editor.CallAsync("doc.renderSvg", scope, new JsonObject { ["pageId"] = pageId }, ct);
                if (!r.Ok) return Err(request, r.Error!);
                bytes = Encoding.UTF8.GetBytes(r.Value.GetProperty("svg").GetString()!);
                revision = r.Value.GetProperty("revision").GetInt64();
            }
            else
            {
                var page = pageId ?? snapshot.Document.Pages[0].Id;
                var r = await editor.CallAsync("doc.render", scope, new JsonObject { ["pageId"] = page, ["format"] = format, ["maxWidth"] = 3200, ["maxHeight"] = 3200 }, ct);
                if (!r.Ok) return Err(request, r.Error!);
                bytes = Convert.FromBase64String(r.Value.GetProperty("data").GetString()!);
                revision = r.Value.GetProperty("revision").GetInt64();
            }
            var again = policy.Revalidate(dest.Value!);
            if (!again.Ok) return Err(request, again.Error!);
            try { await writer.WriteAsync(dest.Value!.Path, bytes, ct); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return HostRequestHandler.Error(request.RequestId, "io_error", $"export failed: {e.Message}", true); }
        }
        var result = new JsonObject
        {
            ["documentId"] = snapshot.DocumentId, ["sessionId"] = snapshot.SessionId, ["revision"] = revision, ["format"] = format,
            ["path"] = dest.Value!.Path, ["overwrote"] = dest.Value.Overwrite, ["userApproved"] = dest.Value.ConsentGiven, ["diagnostics"] = diagnostics,
        };
        return new ResponseEnvelope
        {
            ProtocolVersion = 1, Kind = "response", RequestId = request.RequestId, DocumentId = snapshot.DocumentId, SessionId = snapshot.SessionId,
            Result = JsonSerializer.SerializeToElement(result),
        };
    }

    private static ResponseEnvelope Err(RequestEnvelope r, AppError e) => HostRequestHandler.Error(r.RequestId, e.Code, e.Message, e.Retryable, e.Outcome ?? "not_applied");
}
