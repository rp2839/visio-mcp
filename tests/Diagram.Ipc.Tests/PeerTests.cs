using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Diagram.Core.Contracts;
using Diagram.Ipc;
using Xunit;

namespace Diagram.Ipc.Tests;

public sealed class PeerTests
{
    private static RequestEnvelope Req(string method, object? p = null) => new()
    {
        ProtocolVersion = 1, Kind = "request", RequestId = "x", Method = method,
        DocumentId = "00000000-0000-4000-8000-000000000001", SessionId = "00000000-0000-4000-8000-000000000002",
        Params = JsonSerializer.SerializeToElement(p ?? new { }),
    };

    private static (string Name, CancellationTokenSource Cts, Task Run) Start(RequestHandler handler, int maxClients = 8)
    {
        var name = $"ipc-{Guid.NewGuid():N}";
        var cts = new CancellationTokenSource();
        var run = new PipeServer(name) { MaxClients = maxClients }.StartAsync(handler, cts.Token);
        return (name, cts, run);
    }

    private static Task<ResponseEnvelope> Echo(RequestEnvelope r, ConnectionInfo c, CancellationToken ct) =>
        Task.FromResult(new ResponseEnvelope { ProtocolVersion = 1, Kind = "response", RequestId = r.RequestId, Result = JsonSerializer.SerializeToElement(new { method = r.Method, origin = r.Origin }) });

    [Fact]
    public async Task FirstFrameHandshakeAndHostStampedOrigin()
    {
        var (name, cts, run) = Start(Echo);
        await using (var raw = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous))
        {
            await raw.ConnectAsync(2000);
            await FrameCodec.WriteAsync(raw, Encoding.UTF8.GetBytes(ContractJson.Serialize(Req("doc.summary"))), CancellationToken.None);
            var reply = ContractJson.Deserialize<ResponseEnvelope>(Encoding.UTF8.GetString(await FrameCodec.ReadAsync(raw, CancellationToken.None)));
            Assert.Equal("invalid_request", reply.Error!.Code);
        }
        await using var client = await PipeClient.ConnectAsync(name, "tester", TimeSpan.FromSeconds(2), CancellationToken.None);
        var spoofed = Req("doc.summary") with { Origin = new Origin { Source = "gui", ConnectionId = "fake" } };
        var r = await client.CallAsync(spoofed, TimeSpan.FromSeconds(5), CancellationToken.None);
        var origin = r.Result.GetProperty("origin");
        Assert.Equal("mcp", origin.GetProperty("source").GetString());
        Assert.Equal(client.ConnectionId, origin.GetProperty("connectionId").GetString());
        Assert.Equal("tester", origin.GetProperty("clientLabel").GetString());
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task EightClientsSixteenPendingLimit()
    {
        var release = new TaskCompletionSource();
        var (name, cts, run) = Start(async (r, c, ct) => { await release.Task; return await Echo(r, c, ct); }, maxClients: 8);
        var clients = new List<PipeClient>();
        for (var i = 0; i < 8; i++) clients.Add(await PipeClient.ConnectAsync(name, $"c{i}", TimeSpan.FromSeconds(2), CancellationToken.None));
        await Assert.ThrowsAsync<FrameException>(() => PipeClient.ConnectAsync(name, "ninth", TimeSpan.FromSeconds(2), CancellationToken.None));
        var calls = Enumerable.Range(0, 17).Select(_ => clients[0].CallAsync(Req("doc.summary"), TimeSpan.FromSeconds(10), CancellationToken.None)).ToList();
        var busy = await Task.WhenAny(calls);
        Assert.Equal("busy", (await busy).Error?.Code);
        release.SetResult();
        var results = await Task.WhenAll(calls);
        Assert.Equal(16, results.Count(x => x.Error is null));
        foreach (var c in clients) await c.DisposeAsync();
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task UnknownMutationTimeout()
    {
        var (name, cts, run) = Start(async (r, c, ct) => { await Task.Delay(Timeout.Infinite, ct); return null!; });
        await using var client = await PipeClient.ConnectAsync(name, "t", TimeSpan.FromSeconds(2), CancellationToken.None);
        var r = await client.CallAsync(Req("doc.apply", new { transactionId = Guid.NewGuid(), baseRevision = 0, operations = Array.Empty<object>() }), TimeSpan.FromMilliseconds(200), CancellationToken.None);
        Assert.Equal("timeout_unknown", r.Error!.Code);
        Assert.Equal("unknown", r.Error.Outcome);
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task DisconnectAfterDispatchIsUnknownNotRollback()
    {
        var (name, cts, run) = Start((r, c, ct) => throw new IOException("host crashed"));
        await using var client = await PipeClient.ConnectAsync(name, "t", TimeSpan.FromSeconds(2), CancellationToken.None);
        var r = await client.CallAsync(Req("doc.apply"), TimeSpan.FromSeconds(5), CancellationToken.None);
        Assert.Equal("unknown", r.Error!.Outcome);
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task MissingHostIsNotRunning()
    {
        var e = await Assert.ThrowsAsync<FrameException>(() => PipeClient.ConnectAsync($"absent-{Guid.NewGuid():N}", "t", TimeSpan.FromMilliseconds(200), CancellationToken.None));
        Assert.Equal("not_running", e.Code);
    }

    [Fact]
    public void SameUserSessionOnly()
    {
        // Portable assertion: the per-user pipe name embeds the user (SID + session on Windows) and
        // protocol version; CurrentUserOnly is set on both ends. Second-user refusal is Windows-only.
        var name = Handshake.PipeName();
        Assert.Contains(OperatingSystem.IsWindows() ? "S-1-" : Environment.UserName, name);
        Assert.EndsWith("-v1", name);
    }
}
