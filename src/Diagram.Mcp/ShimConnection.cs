using System.Text.Json;
using Diagram.Core.Contracts;
using Diagram.Ipc;

namespace Diagram.Mcp;

/// <summary>
/// Lazy pipe connection. The shim never launches the app, never opens files itself, never
/// generates transaction IDs and never retries a request; it reconnects only for the next call.
/// </summary>
public sealed class ShimConnection(string pipeName) : IAsyncDisposable
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private PipeClient? client;
    private long next;
    public string PipeName { get; } = pipeName;

    public static TimeSpan Deadline(string method) => method switch
    {
        "doc.apply" or "doc.executeScript" => TimeSpan.FromSeconds(15 + 5),
        "doc.render" => TimeSpan.FromSeconds(30 + 5),
        "doc.export" => TimeSpan.FromSeconds(120 + 5),
        _ => TimeSpan.FromSeconds(10 + 5),
    };

    private async Task<PipeClient> ClientAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (client is { Connected: true }) return client;
            if (client is not null) await client.DisposeAsync();
            client = await PipeClient.ConnectAsync(PipeName, "mcp-shim", TimeSpan.FromMilliseconds(800), ct);
            return client;
        }
        finally { gate.Release(); }
    }

    public async Task<ResponseEnvelope> CallAsync(string method, string? documentId, string? sessionId, object parameters, CancellationToken ct)
    {
        var request = new RequestEnvelope
        {
            ProtocolVersion = 1, Kind = "request", RequestId = $"mcp-{Interlocked.Increment(ref next)}", Method = method,
            DocumentId = documentId, SessionId = sessionId,
            Params = JsonSerializer.SerializeToElement(parameters, ContractJson.Options),
        };
        PipeClient c;
        try { c = await ClientAsync(ct); }
        catch (FrameException e)
        {
            return new ResponseEnvelope { ProtocolVersion = 1, Kind = "response", RequestId = request.RequestId, Error = new AppError { Code = e.Code, Message = e.Message, Retryable = true, Outcome = "not_applied" } };
        }
        return await c.CallAsync(request, Deadline(method), ct);
    }

    public async ValueTask DisposeAsync()
    {
        if (client is not null) await client.DisposeAsync();
    }
}
