using System.Text.Json;
using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

/// <summary>A host-owned method (asset library, export) served without a second editable document.</summary>
public interface IHostRequestService
{
    bool Handles(string method);
    Task<ResponseEnvelope> HandleAsync(RequestEnvelope request, CancellationToken ct);
}

/// <summary>
/// Entry point for pipe requests: host services handle host-owned methods; everything else is
/// forwarded to the frontend engine through the bridge (which applies admission and the queue).
/// With an asset guard, MCP mutations may only reference approved bytes: every prepared ref
/// must be host-issued, unexpired and unmodified, and every registered asset hash must already
/// be durable in the blob store.
/// </summary>
public sealed class HostRequestHandler(BridgeRouter bridge, IEnumerable<IHostRequestService>? services = null, AssetPreparer? preparer = null, BlobStore? blobs = null)
{
    private readonly List<IHostRequestService> services = [.. services ?? []];

    public void Add(IHostRequestService service) => services.Add(service);

    public async Task<ResponseEnvelope> HandleAsync(RequestEnvelope request, CancellationToken ct)
    {
        var service = services.FirstOrDefault(s => s.Handles(request.Method));
        if (service is not null) return await service.HandleAsync(request, ct);
        // Host lifecycle methods are GUI-only; never forward them from the pipe.
        if (request.Method is "doc.snapshot" or "doc.exportSnapshot" or "doc.markSaved" or "doc.replace" or "asset.rasterize")
            return Error(request.RequestId, "method_not_found", $"{request.Method} is not available to MCP clients");
        if (CheckAssetReferences(request) is { } refused) return refused;
        return await bridge.SendAsync(request, ct);
    }

    internal ResponseEnvelope? CheckAssetReferences(RequestEnvelope request)
    {
        if (preparer is null || blobs is null || request.Params.ValueKind != JsonValueKind.Object) return null;
        if (request.Method == "doc.executeScript" && request.Params.TryGetProperty("preparedAssetRefs", out var refs) && refs.ValueKind == JsonValueKind.Object)
        {
            foreach (var r in refs.EnumerateObject())
            {
                PreparedAssetRef? pref;
                try { pref = r.Value.Deserialize<PreparedAssetRef>(ContractJson.Options); }
                catch (JsonException) { return Error(request.RequestId, "invalid_request", $"prepared asset {r.Name} is malformed"); }
                var v = pref is null ? Result<bool>.Fail("invalid_request", "null prepared asset") : preparer.Verify(pref);
                if (!v.Ok) return Error(request.RequestId, v.Error!.Code, $"prepared asset {r.Name}: {v.Error.Message}", v.Error.Retryable);
            }
        }
        if (request.Method == "doc.apply" && request.Params.TryGetProperty("operations", out var ops) && ops.ValueKind == JsonValueKind.Array)
        {
            foreach (var op in ops.EnumerateArray())
            {
                if (op.ValueKind != JsonValueKind.Object || !op.TryGetProperty("op", out var kind) || kind.GetString() != "registerAsset") continue;
                var sha = op.TryGetProperty("asset", out var a) && a.ValueKind == JsonValueKind.Object && a.TryGetProperty("sha256", out var s) ? s.GetString() : null;
                bool known;
                try { known = sha is not null && blobs.Contains(sha); }
                catch (HostException) { known = false; }
                if (!known) return Error(request.RequestId, "not_found", "registerAsset references bytes the host has not approved; use list_assets preparedRef descriptors");
            }
        }
        return null;
    }

    public static ResponseEnvelope Error(string requestId, string code, string message, bool retryable = false, string? outcome = "not_applied") => new()
    {
        ProtocolVersion = 1, Kind = "response", RequestId = requestId,
        Error = new AppError { Code = code, Message = message, Retryable = retryable, Outcome = outcome },
    };
}
