using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace WebViewProbe.Bridge;

public sealed record WebMessage(string Source, bool IsTopLevel, string Json);

/// <summary>Seam over CoreWebView2 so bridge rules are testable without Windows.</summary>
public interface IWebMessageChannel
{
    void PostJson(string json);
    event Action<WebMessage>? MessageReceived;
    event Action? ProcessFailed;
}

public sealed record AppError(string Code, string Message, bool Retryable, string? Outcome = null);

public sealed record RequestEnvelope(string RequestId, string Method, Guid? DocumentId, Guid? SessionId, JsonObject Params);

public sealed record ResponseEnvelope(string RequestId, JsonObject? Result, AppError? Error)
{
    public bool Ok => Error is null;
    public int? Revision => Result?["revision"]?.GetValue<int>();
}

/// <summary>
/// Host side of the message-only bridge: fixed exact origin, top-level frame only,
/// readiness handshake, host-generated correlations, renderer failure settles pending
/// calls with an unknown outcome. The frontend (bridge.ts) owns state, dedup and revisions.
/// </summary>
public sealed class ProbeBridge
{
    public static readonly Uri Origin = new("https://app.agentic-diagram.invalid/");
    private readonly IWebMessageChannel channel;
    private readonly TimeSpan timeout;
    private readonly ConcurrentDictionary<string, (string RequestId, TaskCompletionSource<ResponseEnvelope> Tcs)> pending = new();
    private long next;

    public bool IsReady { get; private set; }
    public Guid? DocumentId { get; private set; }
    public Guid? SessionId { get; private set; }
    public int RejectedMessages { get; private set; }

    public ProbeBridge(IWebMessageChannel channel, TimeSpan? timeout = null)
    {
        this.channel = channel;
        this.timeout = timeout ?? TimeSpan.FromSeconds(15);
        channel.MessageReceived += OnMessage;
        channel.ProcessFailed += OnProcessFailed;
    }

    public static bool IsTrustedSource(string source, bool isTopLevel)
    {
        if (!isTopLevel) return false;
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri)) return false;
        // Exact parsed origin comparison, never a string prefix.
        return uri.Scheme == Origin.Scheme && uri.IdnHost == Origin.IdnHost && uri.Port == Origin.Port && string.IsNullOrEmpty(uri.UserInfo);
    }

    public async Task<ResponseEnvelope> SendAsync(RequestEnvelope request, CancellationToken ct)
    {
        if (!IsReady)
            return new(request.RequestId, null, new("not_ready", "editor has not completed the ready handshake", true, "not_applied"));
        var correlation = $"h{Interlocked.Increment(ref next)}";
        var tcs = new TaskCompletionSource<ResponseEnvelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[correlation] = (request.RequestId, tcs);
        var msg = new JsonObject
        {
            ["protocolVersion"] = 1, ["kind"] = "request", ["requestId"] = correlation, ["method"] = request.Method,
            ["params"] = request.Params.DeepClone(),
        };
        if (request.DocumentId is { } d) msg["documentId"] = d.ToString();
        if (request.SessionId is { } s) msg["sessionId"] = s.ToString();
        channel.PostJson(msg.ToJsonString());
        using var timer = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timer.CancelAfter(timeout);
        await using (timer.Token.Register(() => Settle(correlation, new AppError("timeout_unknown", "no reply before deadline", true, "unknown"))))
            return await tcs.Task;
    }

    private void Settle(string correlation, AppError error)
    {
        if (pending.TryRemove(correlation, out var p))
            p.Tcs.TrySetResult(new ResponseEnvelope(p.RequestId, null, error));
    }

    private void OnProcessFailed()
    {
        IsReady = false;
        foreach (var key in pending.Keys)
            Settle(key, new AppError("timeout_unknown", "renderer failed while the request was pending", true, "unknown"));
    }

    private void OnMessage(WebMessage message)
    {
        if (!IsTrustedSource(message.Source, message.IsTopLevel)) { RejectedMessages++; return; }
        JsonObject o;
        try { o = JsonNode.Parse(message.Json)!.AsObject(); }
        catch { RejectedMessages++; return; }
        var kind = o["kind"]?.GetValue<string>();
        if (kind == "event" && o["method"]?.GetValue<string>() == "editor.ready")
        {
            DocumentId = Guid.Parse(o["documentId"]!.GetValue<string>());
            SessionId = Guid.Parse(o["sessionId"]!.GetValue<string>());
            IsReady = true;
            return;
        }
        if (kind != "response") return;
        var correlation = o["requestId"]?.GetValue<string>();
        if (correlation is null || !pending.TryRemove(correlation, out var p)) return; // late or unknown reply
        AppError? error = null;
        if (o["error"] is JsonObject e)
            error = new(e["code"]!.GetValue<string>(), e["message"]?.GetValue<string>() ?? "", e["retryable"]?.GetValue<bool>() ?? false, e["outcome"]?.GetValue<string>());
        p.Tcs.TrySetResult(new ResponseEnvelope(p.RequestId, o["result"] as JsonObject, error));
    }
}
