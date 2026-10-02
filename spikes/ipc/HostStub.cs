using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace IpcProbe;

/// <summary>Test host: handshake-first, handles app.hello and doc.summary. No editable document.</summary>
public sealed class HostStub(string pipeName)
{
    public Guid DocumentId { get; } = Guid.Parse("d0000000-0000-4000-8000-000000000001");
    public Guid SessionId { get; } = Guid.NewGuid();
    public int Revision { get; set; } = 3;
    public bool DropDuringSummary { get; init; }
    public int MaxClients { get; init; } = 8;

    public async Task RunAsync(CancellationToken ct)
    {
        var connections = new List<Task>();
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, MaxClients, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                try
                {
                    await server.WaitForConnectionAsync(ct);
                }
                catch (OperationCanceledException)
                {
                    await server.DisposeAsync();
                    break;
                }
                connections.Add(ServeAsync(server, ct));
            }
        }
        finally
        {
            await Task.WhenAll(connections.Select(t => t.ContinueWith(_ => { }, TaskScheduler.Default)));
        }
    }

    private async Task ServeAsync(NamedPipeServerStream stream, CancellationToken ct)
    {
        await using var _ = stream;
        var first = true;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                JsonObject req;
                using (var doc = await FrameCodec.ReadAsync(stream, ct))
                    req = JsonNode.Parse(doc.RootElement.GetRawText())!.AsObject();
                var method = req["method"]?.GetValue<string>();
                var requestId = req["requestId"]?.GetValue<string>() ?? "";
                if (first && method != "app.hello")
                {
                    await ErrorAsync(stream, requestId, "invalid_request", "first frame must be the app.hello handshake", ct);
                    return; // close the connection
                }
                first = false;
                if (method == "app.hello")
                {
                    await ReplyAsync(stream, requestId, new JsonObject
                    {
                        ["protocolVersion"] = 1, ["connectionId"] = Guid.NewGuid().ToString(),
                        ["capabilities"] = new JsonArray("doc.summary"),
                    }, ct);
                    continue;
                }
                if (method == "doc.summary")
                {
                    if (req["documentId"]?.GetValue<string>() != DocumentId.ToString())
                    { await ErrorAsync(stream, requestId, "document_mismatch", "unknown document", ct); continue; }
                    if (req["sessionId"]?.GetValue<string>() != SessionId.ToString())
                    { await ErrorAsync(stream, requestId, "session_mismatch", "stale or unknown session", ct); continue; }
                    if (DropDuringSummary) return; // simulate host crash after dispatch
                    await ReplyAsync(stream, requestId, new JsonObject
                    {
                        ["documentId"] = DocumentId.ToString(), ["sessionId"] = SessionId.ToString(),
                        ["revision"] = Revision, ["pageCount"] = 1, ["elementCount"] = 5,
                    }, ct);
                    continue;
                }
                await ErrorAsync(stream, requestId, "method_not_found", $"unknown method", ct);
            }
        }
        catch (Exception e) when (e is FrameException or IOException or OperationCanceledException)
        {
            if (e is FrameException fe && fe.Code == "limit_exceeded")
                Console.Error.WriteLine("host stub: rejected oversized frame");
        }
    }

    private static Task ReplyAsync(Stream s, string requestId, JsonObject result, CancellationToken ct) =>
        SendAsync(s, new JsonObject { ["protocolVersion"] = 1, ["kind"] = "response", ["requestId"] = requestId, ["result"] = result }, ct);

    private static Task ErrorAsync(Stream s, string requestId, string code, string message, CancellationToken ct) =>
        SendAsync(s, new JsonObject
        {
            ["protocolVersion"] = 1, ["kind"] = "response", ["requestId"] = requestId,
            ["error"] = new JsonObject { ["code"] = code, ["message"] = message, ["retryable"] = false },
        }, ct);

    private static async Task SendAsync(Stream s, JsonObject o, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(o.ToJsonString());
        await FrameCodec.WriteAsync(s, doc, ct);
    }
}
