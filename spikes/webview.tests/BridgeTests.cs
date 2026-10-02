using System.Text.Json.Nodes;
using WebViewProbe.Bridge;
using Xunit;

namespace WebViewProbe.Tests;

/// <summary>
/// Host-side bridge rules against a fake CoreWebView2 channel. The fake frontend mirrors
/// bridge.ts's queue-head order (scope → cache → revision); the real bridge.ts is exercised
/// by spikes/canvas/tests/bridge.spec.ts. Real WebView2 behaviour is a Windows-only check.
/// </summary>
public sealed class BridgeTests
{
    private const string Origin = "https://app.agentic-diagram.invalid/index.html";

    private sealed class FakeWebView : IWebMessageChannel
    {
        public event Action<WebMessage>? MessageReceived;
        public event Action? ProcessFailed;
        public readonly Guid DocumentId = Guid.NewGuid();
        public readonly Guid SessionId = Guid.NewGuid();
        public int Revision;
        public bool Unresponsive;
        private readonly Dictionary<string, (string Hash, JsonObject Result)> cache = new();

        public void Ready(string source = Origin, bool topLevel = true) => Deliver(new JsonObject
        {
            ["protocolVersion"] = 1, ["kind"] = "event", ["method"] = "editor.ready",
            ["documentId"] = DocumentId.ToString(), ["sessionId"] = SessionId.ToString(), ["revision"] = Revision,
        }, source, topLevel);

        public void Deliver(JsonObject o, string source = Origin, bool topLevel = true) =>
            MessageReceived?.Invoke(new WebMessage(source, topLevel, o.ToJsonString()));

        public void Crash() => ProcessFailed?.Invoke();

        public void PostJson(string json)
        {
            if (Unresponsive) return;
            var m = JsonNode.Parse(json)!.AsObject();
            var id = m["requestId"]!.GetValue<string>();
            JsonObject Reply(JsonObject body) { body["protocolVersion"] = 1; body["kind"] = "response"; body["requestId"] = id; return body; }
            JsonObject Error(string code) => Reply(new JsonObject { ["error"] = new JsonObject { ["code"] = code, ["message"] = code } });
            if (m["sessionId"]?.GetValue<string>() != SessionId.ToString()) { Deliver(Error("session_mismatch")); return; }
            var p = m["params"]!.AsObject();
            var tx = p["transactionId"]!.GetValue<string>();
            var hash = p.ToJsonString();
            if (cache.TryGetValue(tx, out var c)) { Deliver(c.Hash == hash ? Reply(new JsonObject { ["result"] = c.Result.DeepClone() }) : Error("transaction_id_conflict")); return; }
            if (p["baseRevision"]!.GetValue<int>() != Revision) { Deliver(Error("revision_conflict")); return; }
            var result = new JsonObject { ["revision"] = ++Revision, ["changed"] = new JsonArray("rect") };
            cache[tx] = (hash, result);
            Deliver(Reply(new JsonObject { ["result"] = result.DeepClone() }));
        }
    }

    private static RequestEnvelope Apply(FakeWebView v, Guid? session = null, string? tx = null, int baseRevision = 0) =>
        new(Guid.NewGuid().ToString(), "doc.apply", v.DocumentId, session ?? v.SessionId, new JsonObject
        {
            ["transactionId"] = tx ?? Guid.NewGuid().ToString(), ["baseRevision"] = baseRevision, ["atomic"] = true,
            ["operations"] = new JsonArray(new JsonObject { ["op"] = "move", ["target"] = "rect", ["dx"] = 40, ["dy"] = 0 }),
        });

    [Fact]
    public async Task ReadyBeforeApply()
    {
        var view = new FakeWebView();
        var bridge = new ProbeBridge(view);
        var early = await bridge.SendAsync(Apply(view), CancellationToken.None);
        Assert.Equal("not_ready", early.Error!.Code);
        Assert.Equal(0, view.Revision); // never dispatched
        view.Ready();
        var response = await bridge.SendAsync(Apply(view), CancellationToken.None);
        Assert.Equal(1, response.Revision);
        Assert.Equal(view.SessionId, bridge.SessionId);
    }

    [Fact]
    public async Task MismatchedSessionRejected()
    {
        var view = new FakeWebView();
        var bridge = new ProbeBridge(view);
        view.Ready();
        var stale = await bridge.SendAsync(Apply(view, session: Guid.NewGuid()), CancellationToken.None);
        Assert.Equal("session_mismatch", stale.Error!.Code);
        Assert.Equal(0, view.Revision);
    }

    [Fact]
    public async Task DuplicateTransactionChangesOnce()
    {
        var view = new FakeWebView();
        var bridge = new ProbeBridge(view);
        view.Ready();
        var tx = Guid.NewGuid().ToString();
        var response = await bridge.SendAsync(Apply(view, tx: tx), CancellationToken.None);
        var duplicate = await bridge.SendAsync(Apply(view, tx: tx), CancellationToken.None);
        Assert.Equal(1, response.Revision);
        Assert.Equal(1, duplicate.Revision);
        Assert.Equal(1, view.Revision);
    }

    [Theory]
    [InlineData("https://app.agentic-diagram.invalid.evil.example/index.html", true)]
    [InlineData("https://evil.example/?https://app.agentic-diagram.invalid/", true)]
    [InlineData("http://app.agentic-diagram.invalid/index.html", true)]
    [InlineData("https://app.agentic-diagram.invalid:8443/index.html", true)]
    [InlineData("https://user@app.agentic-diagram.invalid/index.html", true)]
    [InlineData(Origin, false)] // child frame from the right origin
    public void WrongOriginAndChildFrameRejected(string source, bool topLevel)
    {
        var view = new FakeWebView();
        var bridge = new ProbeBridge(view);
        view.Ready(source, topLevel);
        Assert.False(bridge.IsReady);
        Assert.Equal(1, bridge.RejectedMessages);
    }

    [Fact]
    public async Task RendererCrashSettlesPendingUnknown()
    {
        var view = new FakeWebView();
        var bridge = new ProbeBridge(view);
        view.Ready();
        view.Unresponsive = true;
        var pending = bridge.SendAsync(Apply(view), CancellationToken.None);
        Assert.False(pending.IsCompleted);
        view.Crash();
        var result = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("timeout_unknown", result.Error!.Code);
        Assert.Equal("unknown", result.Error.Outcome);
        Assert.False(bridge.IsReady);
        var afterCrash = await bridge.SendAsync(Apply(view), CancellationToken.None);
        Assert.Equal("not_ready", afterCrash.Error!.Code);
    }

    [Fact]
    public async Task CorrelationsDoNotCollideAndTimeoutIsUnknown()
    {
        var view = new FakeWebView { Unresponsive = true };
        var bridge = new ProbeBridge(view, TimeSpan.FromMilliseconds(100));
        view.Ready();
        var a = bridge.SendAsync(Apply(view), CancellationToken.None);
        var b = bridge.SendAsync(Apply(view), CancellationToken.None);
        var results = await Task.WhenAll(a, b);
        Assert.All(results, r => Assert.Equal("unknown", r.Error!.Outcome));
        Assert.NotEqual(results[0].RequestId, results[1].RequestId);
    }
}
