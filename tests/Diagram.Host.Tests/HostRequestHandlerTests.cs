using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Host.Tests;

public sealed class HostRequestHandlerTests
{
    private sealed class View : IWebMessageChannel
    {
        public event Action<WebMessage>? MessageReceived;
        public event Action? ProcessFailed { add { } remove { } }
        public List<string> Methods { get; } = [];
        public void PostJson(string json)
        {
            var m = JsonNode.Parse(json)!.AsObject();
            Methods.Add(m["method"]!.GetValue<string>());
            MessageReceived?.Invoke(new WebMessage("https://app.agentic-diagram.invalid/", true, new JsonObject { ["protocolVersion"] = 1, ["kind"] = "response", ["requestId"] = m["requestId"]!.GetValue<string>(), ["result"] = new JsonObject() }.ToJsonString()));
        }
        public void Ready() => MessageReceived?.Invoke(new WebMessage("https://app.agentic-diagram.invalid/", true, """{"protocolVersion":1,"kind":"event","method":"editor.ready","sequence":1,"documentId":"d","sessionId":"s","payload":{}}"""));
    }

    private sealed class Library : IHostRequestService
    {
        public bool Handles(string method) => method == "assets.list";
        public Task<ResponseEnvelope> HandleAsync(RequestEnvelope r, CancellationToken ct) =>
            Task.FromResult(new ResponseEnvelope { ProtocolVersion = 1, Kind = "response", RequestId = r.RequestId, Result = JsonSerializer.SerializeToElement(new { assets = Array.Empty<object>() }) });
    }

    private static RequestEnvelope Req(string m) => new() { ProtocolVersion = 1, Kind = "request", RequestId = "r", Method = m, DocumentId = "d", SessionId = "s", Params = JsonSerializer.SerializeToElement(new { }) };

    [Fact]
    public async Task RoutesHostMethodsLocallyAndForwardsTheRest()
    {
        var view = new View();
        var bridge = new BridgeRouter(view);
        view.Ready();
        var h = new HostRequestHandler(bridge, [new Library()]);
        Assert.True((await h.HandleAsync(Req("assets.list"), CancellationToken.None)).Error is null);
        Assert.True((await h.HandleAsync(Req("doc.summary"), CancellationToken.None)).Error is null);
        Assert.Equal(["doc.summary"], view.Methods);
        Assert.Equal("method_not_found", (await h.HandleAsync(Req("doc.replace"), CancellationToken.None)).Error!.Code);
        Assert.Equal(["doc.summary"], view.Methods);
    }
}
