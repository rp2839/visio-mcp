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
        // File → Close methods are GUI-only too: an agent must not be able to discard the document.
        Assert.Equal("method_not_found", (await h.HandleAsync(Req("doc.status"), CancellationToken.None)).Error!.Code);
        Assert.Equal("method_not_found", (await h.HandleAsync(Req("doc.new"), CancellationToken.None)).Error!.Code);
        Assert.Equal(["doc.summary"], view.Methods);
    }
}

public sealed class AssetGuardTests : IDisposable
{
    private readonly TempDir tmp = new();
    public void Dispose() => tmp.Dispose();

    private static RequestEnvelope Req(string method, object p) => new() { ProtocolVersion = 1, Kind = "request", RequestId = "r", Method = method, DocumentId = "d", SessionId = "s", Params = JsonSerializer.SerializeToElement(p, ContractJson.Options) };

    [Fact]
    public async Task McpMutationsOnlyReferenceApprovedBytes()
    {
        var blobs = new BlobStore(tmp.File("b"));
        var preparer = new AssetPreparer(blobs);
        var h = new HostRequestHandler(new BridgeRouter(new NullView()), null, preparer, blobs);
        var prepared = (await preparer.PrepareBytesAsync(Png.Create(2, 2), "image/png", new AssetPreparer.Options("x"), CancellationToken.None)).Value!;
        Assert.Null(h.CheckAssetReferences(Req("doc.executeScript", new { script = "", preparedAssetRefs = new Dictionary<string, PreparedAssetRef> { ["logo"] = prepared.Ref } })));
        var forged = prepared.Ref with { PreparationId = "prep-forged" };
        Assert.Equal("not_found", h.CheckAssetReferences(Req("doc.executeScript", new { preparedAssetRefs = new Dictionary<string, PreparedAssetRef> { ["logo"] = forged } }))!.Error!.Code);
        var tampered = prepared.Ref with { Asset = prepared.Ref.Asset with { Sha256 = new string('e', 64) } };
        Assert.Equal("invalid_request", h.CheckAssetReferences(Req("doc.executeScript", new { preparedAssetRefs = new Dictionary<string, PreparedAssetRef> { ["logo"] = tampered } }))!.Error!.Code);
        Assert.Null(h.CheckAssetReferences(Req("doc.apply", new { operations = new object[] { new { op = "registerAsset", asset = prepared.Ref.Asset } } })));
        var unknown = h.CheckAssetReferences(Req("doc.apply", new { operations = new object[] { new { op = "registerAsset", asset = prepared.Ref.Asset with { Sha256 = new string('f', 64) } } } }));
        Assert.Equal(("not_found", "not_applied"), (unknown!.Error!.Code, unknown.Error.Outcome));
        Assert.Equal("not_found", h.CheckAssetReferences(Req("doc.apply", new { operations = new object[] { new { op = "registerAsset", asset = new { sha256 = "../../etc" } } } }))!.Error!.Code);
    }

    private sealed class NullView : IWebMessageChannel
    {
        public event Action<WebMessage>? MessageReceived { add { } remove { } }
        public event Action? ProcessFailed { add { } remove { } }
        public void PostJson(string json) { }
    }
}
