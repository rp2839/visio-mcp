using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Host.Tests;

public sealed class BridgeRouterTests
{
    private const string Origin = "https://app.agentic-diagram.invalid/index.html";

    private sealed class FakeView : IWebMessageChannel
    {
        public event Action<WebMessage>? MessageReceived;
        public event Action? ProcessFailed;
        public List<JsonObject> Posted { get; } = [];
        public bool AutoReply { get; set; } = true;
        public void PostJson(string json)
        {
            var m = JsonNode.Parse(json)!.AsObject();
            Posted.Add(m);
            if (AutoReply && m["kind"]!.GetValue<string>() == "request")
                Deliver(new JsonObject { ["protocolVersion"] = 1, ["kind"] = "response", ["requestId"] = m["requestId"]!.GetValue<string>(), ["result"] = new JsonObject { ["revision"] = 1 } });
        }
        public void Deliver(JsonObject o, string source = Origin, bool top = true) => MessageReceived?.Invoke(new WebMessage(source, top, o.ToJsonString()));
        public void Ready(string source = Origin, bool top = true) => Deliver(new JsonObject { ["protocolVersion"] = 1, ["kind"] = "event", ["method"] = "editor.ready", ["sequence"] = 1, ["documentId"] = Docs.DocId, ["sessionId"] = "00000000-0000-4000-8000-000000000009", ["payload"] = new JsonObject() }, source, top);
        public void Crash() => ProcessFailed?.Invoke();
    }

    private static RequestEnvelope Apply(string id = "r1") => new()
    {
        ProtocolVersion = 1, Kind = "request", RequestId = id, Method = "doc.apply", DocumentId = Docs.DocId, SessionId = "00000000-0000-4000-8000-000000000009",
        Params = JsonSerializer.SerializeToElement(new { transactionId = "00000000-0000-4000-8000-000000000077", baseRevision = 0, atomic = true, operations = Array.Empty<object>() }),
    };

    [Fact]
    public async Task NotReadyRejects()
    {
        var view = new FakeView();
        var bridge = new BridgeRouter(view);
        var r = await bridge.SendAsync(Apply(), CancellationToken.None);
        Assert.Equal("not_ready", r.Error!.Code);
        Assert.Empty(view.Posted);
    }

    [Theory]
    [InlineData("https://app.agentic-diagram.invalid.evil.example/", true)]
    [InlineData("http://app.agentic-diagram.invalid/", true)]
    [InlineData("https://app.agentic-diagram.invalid:444/", true)]
    [InlineData(Origin, false)]
    public void WrongOriginOrChildFrameRejects(string source, bool top)
    {
        var view = new FakeView();
        var bridge = new BridgeRouter(view);
        view.Ready(source, top);
        Assert.False(bridge.IsReady);
        Assert.Equal(1, bridge.RejectedMessages);
    }

    [Fact]
    public async Task CorrelationsDoNotCollideAndCallerIdIsRestored()
    {
        var view = new FakeView();
        var bridge = new BridgeRouter(view);
        view.Ready();
        var a = bridge.SendAsync(Apply("same"), CancellationToken.None);
        var b = bridge.SendAsync(Apply("same"), CancellationToken.None);
        await Task.WhenAll(a, b);
        Assert.Equal("same", (await a).RequestId);
        Assert.NotEqual(view.Posted[0]["requestId"]!.GetValue<string>(), view.Posted[1]["requestId"]!.GetValue<string>());
    }

    [Fact]
    public async Task PendingMutationCrashIsUnknownAndReadIsNotApplied()
    {
        var view = new FakeView { AutoReply = false };
        var bridge = new BridgeRouter(view);
        view.Ready();
        var mutation = bridge.SendAsync(Apply(), CancellationToken.None);
        var read = bridge.SendAsync(Apply() with { Method = "doc.summary", Params = JsonSerializer.SerializeToElement(new { }) }, CancellationToken.None);
        view.Crash();
        Assert.Equal("unknown", (await mutation).Error!.Outcome);
        Assert.Equal("not_applied", (await read).Error!.Outcome);
        Assert.False(bridge.IsReady);
    }

    [Fact]
    public async Task DeadlineGivesTimeoutUnknown()
    {
        var view = new FakeView { AutoReply = false };
        var bridge = new BridgeRouter(view);
        view.Ready();
        var r = await bridge.SendAsync(Apply(), CancellationToken.None, TimeSpan.FromMilliseconds(50));
        Assert.Equal("timeout_unknown", r.Error!.Code);
        Assert.Equal("unknown", r.Error.Outcome);
    }

    [Fact]
    public void SequenceGapIsReported()
    {
        var view = new FakeView();
        var bridge = new BridgeRouter(view);
        (long, long)? gap = null;
        bridge.SequenceGap += (a, b) => gap = (a, b);
        view.Ready();
        view.Deliver(new JsonObject { ["protocolVersion"] = 1, ["kind"] = "event", ["method"] = "doc.committed", ["sequence"] = 2, ["payload"] = new JsonObject() });
        view.Deliver(new JsonObject { ["protocolVersion"] = 1, ["kind"] = "event", ["method"] = "doc.committed", ["sequence"] = 4, ["payload"] = new JsonObject() });
        Assert.Equal((2L, 4L), gap);
    }

    [Fact]
    public async Task HostHandlersAnswerFrontendRequests()
    {
        var view = new FakeView();
        var bridge = new BridgeRouter(view);
        bridge.RegisterHostHandler("host.echo", (p, _) => Task.FromResult(Result<JsonNode?>.Success(p["x"]!.DeepClone())));
        view.Deliver(new JsonObject { ["protocolVersion"] = 1, ["kind"] = "request", ["requestId"] = "f1", ["method"] = "host.echo", ["params"] = new JsonObject { ["x"] = 5 } });
        view.Deliver(new JsonObject { ["protocolVersion"] = 1, ["kind"] = "request", ["requestId"] = "f2", ["method"] = "host.shell", ["params"] = new JsonObject() });
        await Task.Delay(50);
        Assert.Equal(5, view.Posted.Single(p => p["requestId"]!.GetValue<string>() == "f1")["result"]!.GetValue<int>());
        Assert.Equal("method_not_found", view.Posted.Single(p => p["requestId"]!.GetValue<string>() == "f2")["error"]!["code"]!.GetValue<string>());
    }
}
