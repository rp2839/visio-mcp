using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Diagram.Core.Contracts;

namespace Diagram.Ipc;

public sealed record ConnectionInfo(string ConnectionId, string ClientLabel);

public delegate Task<ResponseEnvelope> RequestHandler(RequestEnvelope request, ConnectionInfo connection, CancellationToken ct);

/// <summary>
/// Per-user named-pipe server: handshake-first, at most 8 clients and 16 outstanding requests
/// per connection, one writer per connection behind a bounded 64-response queue. The host
/// stamps origin (caller-supplied origin is discarded) and never trusts the client label.
/// </summary>
public sealed class PipeServer(string pipeName)
{
    public int MaxClients { get; init; } = 8;
    public int MaxPendingPerConnection { get; init; } = 16;
    public int WriterQueue { get; init; } = 64;
    private int connections;

    public async Task StartAsync(RequestHandler handler, CancellationToken ct)
    {
        var tasks = new List<Task>();
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream server;
            try
            {
                server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            }
            catch (IOException) when (!ct.IsCancellationRequested)
            {
                await Task.Delay(50, ct).ConfigureAwait(false);
                continue;
            }
            try { await server.WaitForConnectionAsync(ct); }
            catch (OperationCanceledException) { await server.DisposeAsync(); break; }
            if (Interlocked.Increment(ref connections) > MaxClients)
            {
                Interlocked.Decrement(ref connections);
                _ = RejectAsync(server, "busy", "too many clients");
                continue;
            }
            tasks.Add(Task.Run(async () =>
            {
                try { await ServeAsync(server, handler, ct); }
                finally { Interlocked.Decrement(ref connections); }
            }, CancellationToken.None));
        }
        await Task.WhenAll(tasks.Select(t => t.ContinueWith(_ => { }, TaskScheduler.Default)));
    }

    private static async Task RejectAsync(Stream s, string code, string message)
    {
        await using var _ = s;
        try { await WriteAsync(s, Error("", code, message), CancellationToken.None); } catch { /* peer gone */ }
    }

    internal static ResponseEnvelope Error(string requestId, string code, string message, bool retryable = false, string? outcome = null) => new()
    {
        ProtocolVersion = 1, Kind = "response", RequestId = requestId,
        Error = new AppError { Code = code, Message = message, Retryable = retryable, Outcome = outcome },
    };

    private static Task WriteAsync(Stream s, ResponseEnvelope r, CancellationToken ct) =>
        FrameCodec.WriteAsync(s, System.Text.Encoding.UTF8.GetBytes(ContractJson.Serialize(r)), ct);

    private async Task ServeAsync(NamedPipeServerStream stream, RequestHandler handler, CancellationToken ct)
    {
        await using var _ = stream;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var writer = Channel.CreateBounded<ResponseEnvelope>(new BoundedChannelOptions(WriterQueue) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
        var writing = Task.Run(async () =>
        {
            await foreach (var r in writer.Reader.ReadAllAsync(cts.Token)) await WriteAsync(stream, r, cts.Token);
        }, CancellationToken.None);
        var pending = new SemaphoreSlim(MaxPendingPerConnection, MaxPendingPerConnection);
        ConnectionInfo? connection = null;
        var inflight = new List<Task>();
        try
        {
            while (!cts.IsCancellationRequested)
            {
                var payload = await FrameCodec.ReadAsync(stream, cts.Token);
                RequestEnvelope req;
                try { req = ContractJson.Deserialize<RequestEnvelope>(System.Text.Encoding.UTF8.GetString(payload)); }
                catch (JsonException e)
                {
                    await writer.Writer.WriteAsync(Error(TryRequestId(payload), "invalid_request", $"malformed request: {e.Message}"), cts.Token);
                    if (connection is null) break;
                    continue;
                }
                if (req.ProtocolVersion != Handshake.ProtocolVersion)
                {
                    await writer.Writer.WriteAsync(Error(req.RequestId, "unsupported_version", "protocol version 1 required"), cts.Token);
                    break;
                }
                if (connection is null)
                {
                    if (req.Method != Handshake.Method)
                    {
                        await writer.Writer.WriteAsync(Error(req.RequestId, "invalid_request", "first frame must be the app.hello handshake"), cts.Token);
                        break;
                    }
                    var label = req.Params.ValueKind == JsonValueKind.Object && req.Params.TryGetProperty("clientLabel", out var l) && l.ValueKind == JsonValueKind.String ? l.GetString()! : "unknown";
                    connection = new ConnectionInfo($"c-{Guid.NewGuid():N}", label.Length > 64 ? label[..64] : label);
                    await writer.Writer.WriteAsync(new ResponseEnvelope
                    {
                        ProtocolVersion = 1, Kind = "response", RequestId = req.RequestId,
                        Result = JsonSerializer.SerializeToElement(new { protocolVersion = 1, connectionId = connection.ConnectionId, capabilities = Handshake.Capabilities }),
                    }, cts.Token);
                    continue;
                }
                if (!pending.Wait(0))
                {
                    await writer.Writer.WriteAsync(Error(req.RequestId, "busy", "too many outstanding requests on this connection", retryable: true, outcome: "not_applied"), cts.Token);
                    continue;
                }
                // Host-stamped origin; never an idempotency key.
                var stamped = req with { Origin = new Origin { Source = "mcp", ClientLabel = connection.ClientLabel, ConnectionId = connection.ConnectionId } };
                var conn = connection;
                inflight.Add(Task.Run(async () =>
                {
                    try
                    {
                        ResponseEnvelope r;
                        try { r = await handler(stamped, conn, cts.Token); }
                        catch (Exception) { r = Error(req.RequestId, "internal_error", "request handler failed", outcome: "unknown"); }
                        await writer.Writer.WriteAsync(r with { RequestId = req.RequestId }, cts.Token);
                    }
                    finally { pending.Release(); }
                }, CancellationToken.None));
            }
        }
        catch (Exception e) when (e is FrameException or IOException or OperationCanceledException or ChannelClosedException)
        {
            if (e is FrameException { Code: "limit_exceeded" })
                try { await WriteAsync(stream, Error("", "limit_exceeded", e.Message), CancellationToken.None); } catch { /* peer gone */ }
        }
        finally
        {
            // Let in-flight replies and queued errors flush before closing the connection.
            try { await Task.WhenAll(inflight).WaitAsync(TimeSpan.FromSeconds(1)); } catch { /* disconnected */ }
            writer.Writer.TryComplete();
            try { await writing.WaitAsync(TimeSpan.FromSeconds(1)); } catch { /* peer gone */ }
            cts.Cancel();
            try { await writing; } catch { /* closing */ }
        }
    }

    private static string TryRequestId(byte[] payload)
    {
        try { return JsonNode.Parse(payload)?["requestId"]?.GetValue<string>() ?? ""; } catch { return ""; }
    }
}
