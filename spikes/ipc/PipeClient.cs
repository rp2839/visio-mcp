using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace IpcProbe;

public sealed record PipeResponse(bool Ok, JsonObject? Result, string? ErrorCode, string? Message, string? Outcome);

/// <summary>Probe pipe client: one writer, sequential calls, explicit request correlation.</summary>
public sealed class PipeClient : IAsyncDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly SemaphoreSlim gate = new(1, 1);
    private int next;

    private PipeClient(NamedPipeClientStream pipe) => this.pipe = pipe;

    public static async Task<PipeClient> ConnectAsync(string pipeName, TimeSpan timeout, CancellationToken ct, bool handshake = true, string clientLabel = "probe")
    {
        var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            await pipe.ConnectAsync((int)timeout.TotalMilliseconds, ct);
        }
        catch (Exception e) when (e is TimeoutException or IOException)
        {
            await pipe.DisposeAsync();
            throw new FrameException("not_running", "diagram application pipe is not available");
        }
        var client = new PipeClient(pipe);
        if (handshake)
        {
            var hello = await client.CallAsync("app.hello", new JsonObject { ["clientLabel"] = clientLabel }, ct);
            if (!hello.Ok) throw new FrameException(hello.ErrorCode ?? "unsupported_version", hello.Message ?? "handshake rejected");
        }
        return client;
    }

    public async Task<PipeResponse> CallAsync(string method, JsonObject @params, CancellationToken ct, Guid? documentId = null, Guid? sessionId = null)
    {
        await gate.WaitAsync(ct);
        var dispatched = false;
        try
        {
            var requestId = $"c{Interlocked.Increment(ref next)}";
            var envelope = new JsonObject
            {
                ["protocolVersion"] = 1, ["kind"] = "request", ["requestId"] = requestId, ["method"] = method,
            };
            if (documentId is { } d) envelope["documentId"] = d.ToString();
            if (sessionId is { } s) envelope["sessionId"] = s.ToString();
            envelope["params"] = @params.DeepClone();
            using var doc = JsonDocument.Parse(envelope.ToJsonString());
            await FrameCodec.WriteAsync(pipe, doc, ct);
            dispatched = true;
            using var reply = await FrameCodec.ReadAsync(pipe, ct);
            var node = JsonNode.Parse(reply.RootElement.GetRawText())!.AsObject();
            if (node["requestId"]?.GetValue<string>() != requestId)
                return new PipeResponse(false, null, "internal_error", "response correlation mismatch", "unknown");
            if (node["error"] is JsonObject err)
                return new PipeResponse(false, null, err["code"]?.GetValue<string>(), err["message"]?.GetValue<string>(), err["outcome"]?.GetValue<string>());
            return new PipeResponse(true, node["result"]?.AsObject(), null, null, null);
        }
        catch (Exception e) when (e is FrameException or IOException or ObjectDisposedException)
        {
            // After dispatch the request may have been applied: never claim a rollback.
            return new PipeResponse(false, null, "disconnected", e.Message, dispatched ? "unknown" : "not_applied");
        }
        finally
        {
            gate.Release();
        }
    }

    public ValueTask DisposeAsync()
    {
        pipe.Dispose();
        return ValueTask.CompletedTask;
    }
}
