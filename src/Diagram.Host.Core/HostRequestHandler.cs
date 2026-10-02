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
/// </summary>
public sealed class HostRequestHandler(BridgeRouter bridge, IEnumerable<IHostRequestService>? services = null)
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
        return await bridge.SendAsync(request, ct);
    }

    public static ResponseEnvelope Error(string requestId, string code, string message, bool retryable = false, string? outcome = "not_applied") => new()
    {
        ProtocolVersion = 1, Kind = "response", RequestId = requestId,
        Error = new AppError { Code = code, Message = message, Retryable = retryable, Outcome = outcome },
    };
}
