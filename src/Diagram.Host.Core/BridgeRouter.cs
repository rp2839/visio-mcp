using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

public sealed record WebMessage(string Source, bool IsTopLevel, string Json);

/// <summary>Seam over CoreWebView2 (implemented by Diagram.App on the UI dispatcher).</summary>
public interface IWebMessageChannel
{
    void PostJson(string json);
    event Action<WebMessage>? MessageReceived;
    event Action? ProcessFailed;
}

/// <summary>
/// Host side of the message-only WebView2 bridge. Accepts messages only from the exact
/// packaged top-level origin; requires the editor.ready handshake; generates unique
/// host correlations; settles pending calls with an unknown outcome on renderer failure
/// or deadline. The frontend owns scope checks, deduplication and revisions.
/// </summary>
public sealed class BridgeRouter : IEditorChannel
{
    public static readonly Uri Origin = new("https://app.agentic-diagram.invalid/");
    private readonly IWebMessageChannel channel;
    private readonly ConcurrentDictionary<string, Pending> pending = new();
    private readonly ConcurrentDictionary<string, Func<JsonObject, CancellationToken, Task<Result<JsonNode?>>>> hostHandlers = new();
    private long next;
    private long lastEventSequence;

    private sealed record Pending(string RequestId, string Method, TaskCompletionSource<ResponseEnvelope> Tcs);

    public bool IsReady { get; private set; }
    public string? DocumentId { get; private set; }
    public string? SessionId { get; private set; }
    public int RejectedMessages { get; private set; }
    public event Action<JsonObject>? EventReceived;
    /// <summary>Raised when a sequenced event arrives out of order (journal must checkpoint).</summary>
    public event Action<long, long>? SequenceGap;
    public event Action? RendererFailed;

    public BridgeRouter(IWebMessageChannel channel)
    {
        this.channel = channel;
        channel.MessageReceived += OnMessage;
        channel.ProcessFailed += OnProcessFailed;
    }

    public static TimeSpan DefaultDeadline(string method) => method switch
    {
        "doc.apply" or "doc.executeScript" or "doc.undo" or "doc.redo" => TimeSpan.FromSeconds(15),
        "doc.render" => TimeSpan.FromSeconds(30),
        "doc.exportSnapshot" or "doc.replace" or "doc.export" => TimeSpan.FromSeconds(120),
        _ => TimeSpan.FromSeconds(10),
    };

    public static bool IsMutation(string method) => method is "doc.apply" or "doc.executeScript" or "doc.undo" or "doc.redo" or "doc.replace" or "doc.new" or "doc.markSaved";

    public static bool IsTrustedSource(string source, bool isTopLevel)
    {
        if (!isTopLevel || !Uri.TryCreate(source, UriKind.Absolute, out var uri)) return false;
        return uri.Scheme == Origin.Scheme && uri.IdnHost == Origin.IdnHost && uri.Port == Origin.Port && string.IsNullOrEmpty(uri.UserInfo);
    }

    /// <summary>Frontend → host service (e.g. host.prepareAsset). Handlers never receive document state ownership.</summary>
    public void RegisterHostHandler(string method, Func<JsonObject, CancellationToken, Task<Result<JsonNode?>>> handler) => hostHandlers[method] = handler;

    public async Task<ResponseEnvelope> SendAsync(RequestEnvelope request, CancellationToken ct, TimeSpan? deadline = null)
    {
        if (!IsReady)
            return Error(request.RequestId, "not_ready", "editor has not completed the ready handshake", retryable: true, outcome: "not_applied");
        var correlation = $"h{Interlocked.Increment(ref next)}";
        var tcs = new TaskCompletionSource<ResponseEnvelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[correlation] = new Pending(request.RequestId, request.Method, tcs);
        // Host-generated correlation replaces the caller's requestId on this hop.
        var wire = JsonNode.Parse(ContractJson.Serialize(request with { RequestId = correlation }))!.AsObject();
        channel.PostJson(wire.ToJsonString());
        using var timer = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timer.CancelAfter(deadline ?? DefaultDeadline(request.Method));
        await using (timer.Token.Register(() => Settle(correlation, "timeout_unknown", "no reply before the deadline")))
            return await tcs.Task;
    }

    public async Task<Result<JsonElement>> CallAsync(string method, Scope? scope, JsonObject parameters, CancellationToken ct)
    {
        var req = new RequestEnvelope
        {
            ProtocolVersion = 1, Kind = "request", RequestId = $"host-{Guid.NewGuid():N}", Method = method,
            DocumentId = scope?.DocumentId, SessionId = scope?.SessionId,
            Params = JsonSerializer.SerializeToElement(parameters),
        };
        var r = await SendAsync(req, ct);
        return r.Error is { } e ? Result<JsonElement>.From(e) : Result<JsonElement>.Success(r.Result);
    }

    private static ResponseEnvelope Error(string requestId, string code, string message, bool retryable, string? outcome) => new()
    {
        ProtocolVersion = 1, Kind = "response", RequestId = requestId,
        Error = new AppError { Code = code, Message = message, Retryable = retryable, Outcome = outcome },
    };

    private void Settle(string correlation, string code, string message)
    {
        if (!pending.TryRemove(correlation, out var p)) return;
        // After dispatch a mutation may have committed: never claim a rollback.
        var outcome = IsMutation(p.Method) ? "unknown" : "not_applied";
        p.Tcs.TrySetResult(Error(p.RequestId, code, message, retryable: true, outcome));
    }

    private void OnProcessFailed()
    {
        IsReady = false;
        foreach (var key in pending.Keys) Settle(key, "timeout_unknown", "renderer failed while the request was pending");
        RendererFailed?.Invoke();
    }

    private void OnMessage(WebMessage message)
    {
        if (!IsTrustedSource(message.Source, message.IsTopLevel)) { RejectedMessages++; return; }
        JsonObject o;
        try { o = JsonNode.Parse(message.Json, documentOptions: new JsonDocumentOptions { MaxDepth = 256 })!.AsObject(); }
        catch (Exception) { RejectedMessages++; return; }
        if (o["protocolVersion"]?.GetValue<int>() != 1) { RejectedMessages++; return; }
        switch (o["kind"]?.GetValue<string>())
        {
            case "event": OnEvent(o); break;
            case "response": OnResponse(o); break;
            case "request": _ = OnHostRequestAsync(o); break;
            default: RejectedMessages++; break;
        }
    }

    private void OnEvent(JsonObject o)
    {
        var method = o["method"]?.GetValue<string>();
        if (method == "editor.ready" || method == "doc.opened")
        {
            DocumentId = o["documentId"]?.GetValue<string>();
            SessionId = o["sessionId"]?.GetValue<string>();
            if (method == "editor.ready") { IsReady = true; lastEventSequence = 0; }
        }
        if (o["sequence"]?.GetValue<long>() is { } seq)
        {
            if (lastEventSequence != 0 && seq != lastEventSequence + 1) SequenceGap?.Invoke(lastEventSequence, seq);
            lastEventSequence = seq;
        }
        EventReceived?.Invoke(o);
    }

    private void OnResponse(JsonObject o)
    {
        var correlation = o["requestId"]?.GetValue<string>();
        if (correlation is null || !pending.TryRemove(correlation, out var p)) return; // late or unknown reply
        ResponseEnvelope env;
        try { env = ContractJson.Deserialize<ResponseEnvelope>(o.ToJsonString()); }
        catch (JsonException e) { env = Error(p.RequestId, "internal_error", $"malformed editor response: {e.Message}", false, IsMutation(p.Method) ? "unknown" : "not_applied"); }
        p.Tcs.TrySetResult(env with { RequestId = p.RequestId });
    }

    private async Task OnHostRequestAsync(JsonObject o)
    {
        var requestId = o["requestId"]?.GetValue<string>() ?? "";
        var method = o["method"]?.GetValue<string>() ?? "";
        JsonObject reply;
        if (!hostHandlers.TryGetValue(method, out var handler))
            reply = new JsonObject { ["protocolVersion"] = 1, ["kind"] = "response", ["requestId"] = requestId, ["error"] = new JsonObject { ["code"] = "method_not_found", ["message"] = method, ["retryable"] = false } };
        else
        {
            Result<JsonNode?> r;
            try { r = await handler(o["params"] as JsonObject ?? new JsonObject(), CancellationToken.None); }
            catch (HostException e) { r = Result<JsonNode?>.From(e.Error); }
            catch (Exception) { r = Result<JsonNode?>.Fail("internal_error", "host service failed"); }
            reply = new JsonObject { ["protocolVersion"] = 1, ["kind"] = "response", ["requestId"] = requestId };
            if (r.Ok) reply["result"] = r.Value?.DeepClone();
            else reply["error"] = JsonNode.Parse(ContractJson.Serialize(r.Error!));
        }
        channel.PostJson(reply.ToJsonString());
    }
}
