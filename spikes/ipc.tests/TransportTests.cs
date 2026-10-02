using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using IpcProbe;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Xunit;

namespace IpcProbe.Tests;

public sealed class TransportTests
{
    private static readonly string ShimDll = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "mcp", "bin", "Debug", "net10.0", "McpProbe.dll");

    /// <summary>Delivers bytes in tiny chunks to exercise exact partial reads.</summary>
    private sealed class TrickleStream(byte[] data, int chunk) : MemoryStream(data)
    {
        public override int Read(byte[] buffer, int offset, int count) => base.Read(buffer, offset, Math.Min(count, chunk));
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) => base.ReadAsync(buffer[..Math.Min(buffer.Length, chunk)], ct);
    }

    [Fact]
    public async Task PartialReadRoundTrips()
    {
        var ms = new MemoryStream();
        using var original = JsonDocument.Parse("""{"protocolVersion":1,"kind":"request","requestId":"r1","method":"doc.summary","params":{"text":"héllo"}}""");
        await FrameCodec.WriteAsync(ms, original, CancellationToken.None);
        await FrameCodec.WriteAsync(ms, original, CancellationToken.None);
        var trickle = new TrickleStream(ms.ToArray(), chunk: 3);
        using var a = await FrameCodec.ReadAsync(trickle, CancellationToken.None);
        using var b = await FrameCodec.ReadAsync(trickle, CancellationToken.None);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(original.RootElement.GetRawText()), JsonNode.Parse(a.RootElement.GetRawText())));
        Assert.Equal("héllo", b.RootElement.GetProperty("params").GetProperty("text").GetString());
    }

    [Fact]
    public async Task TruncatedFrameIsRejected()
    {
        var bytes = new byte[4 + 10];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, 20);
        var ex = await Assert.ThrowsAsync<FrameException>(() => FrameCodec.ReadAsync(new MemoryStream(bytes), CancellationToken.None));
        Assert.Equal("disconnected", ex.Code);
    }

    [Fact]
    public async Task FrameLengthAbove32MiBRejectedBeforeAllocation()
    {
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, FrameCodec.MaxFrameBytes + 1u);
        var before = FrameCodec.PayloadAllocations;
        var ex = await Assert.ThrowsAsync<FrameException>(() => FrameCodec.ReadAsync(new MemoryStream(header), CancellationToken.None));
        var oversizedFramePayloadAllocations = FrameCodec.PayloadAllocations - before;
        Assert.Equal("limit_exceeded", ex.Code);
        Assert.Equal(0, oversizedFramePayloadAllocations);
    }

    [Fact]
    public async Task EightMiBFrameRoundTrips()
    {
        var big = new string('x', 8 * 1024 * 1024);
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { blob = big }));
        var ms = new MemoryStream();
        await FrameCodec.WriteAsync(ms, doc, CancellationToken.None);
        ms.Position = 0;
        using var back = await FrameCodec.ReadAsync(ms, CancellationToken.None);
        Assert.Equal(big.Length, back.RootElement.GetProperty("blob").GetString()!.Length);
    }

    [Fact]
    public async Task NonHandshakeFirstFrameRejected()
    {
        var pipe = $"probe-{Guid.NewGuid():N}";
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var host = new HostStub(pipe);
        var run = host.RunAsync(cts.Token);
        await using var client = await PipeClient.ConnectAsync(pipe, TimeSpan.FromSeconds(2), cts.Token, handshake: false);
        var response = await client.CallAsync("doc.summary", new JsonObject(), cts.Token);
        Assert.False(response.Ok);
        Assert.Equal("invalid_request", response.ErrorCode);
        // The host closes the connection after a rejected first frame.
        var after = await client.CallAsync("app.hello", new JsonObject { ["clientLabel"] = "late" }, cts.Token);
        Assert.Equal("disconnected", after.ErrorCode);
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task HandshakeThenSummary()
    {
        var pipe = $"probe-{Guid.NewGuid():N}";
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var host = new HostStub(pipe);
        var run = host.RunAsync(cts.Token);
        await using var client = await PipeClient.ConnectAsync(pipe, TimeSpan.FromSeconds(2), cts.Token);
        var r = await client.CallAsync("doc.summary", new JsonObject(), cts.Token, host.DocumentId, host.SessionId);
        Assert.True(r.Ok);
        Assert.Equal(3, r.Result!["revision"]!.GetValue<int>());
        var mismatch = await client.CallAsync("doc.summary", new JsonObject(), cts.Token, host.DocumentId, Guid.NewGuid());
        Assert.Equal("session_mismatch", mismatch.ErrorCode);
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task MissingHostIsNotRunning()
    {
        var ex = await Assert.ThrowsAsync<FrameException>(() => PipeClient.ConnectAsync($"absent-{Guid.NewGuid():N}", TimeSpan.FromMilliseconds(300), CancellationToken.None));
        var error = ex;
        Assert.Equal("not_running", error.Code);
    }

    private static StdioClientTransport Shim(string pipe) => new(new StdioClientTransportOptions
    {
        Name = "probe-shim",
        Command = "dotnet",
        Arguments = [ShimDll],
        EnvironmentVariables = new Dictionary<string, string?> { ["PROBE_PIPE"] = pipe },
    });

    [Fact]
    public async Task RealSdkToolRoutesThroughPipe()
    {
        Assert.True(File.Exists(ShimDll), ShimDll);
        var pipe = $"probe-{Guid.NewGuid():N}";
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var host = new HostStub(pipe);
        var run = host.RunAsync(cts.Token);
        await using var client = await McpClient.CreateAsync(Shim(pipe), cancellationToken: cts.Token);
        var tools = await client.ListToolsAsync(cancellationToken: cts.Token);
        Assert.Contains(tools, t => t.Name == "get_document_summary");
        var result = await client.CallToolAsync("get_document_summary", new Dictionary<string, object?>
        {
            ["documentId"] = host.DocumentId.ToString(), ["sessionId"] = host.SessionId.ToString(),
        }, cancellationToken: cts.Token);
        Assert.NotEqual(true, result.IsError);
        var structured = result.StructuredContent!.Value;
        Assert.Equal(3, structured.GetProperty("revision").GetInt32());
        Assert.Equal(host.SessionId.ToString(), structured.GetProperty("sessionId").GetString());
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task SdkToolReportsNotRunningWhenHostAbsent()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        await using var client = await McpClient.CreateAsync(Shim($"absent-{Guid.NewGuid():N}"), cancellationToken: cts.Token);
        var result = await client.CallToolAsync("get_document_summary", new Dictionary<string, object?>
        {
            ["documentId"] = Guid.NewGuid().ToString(), ["sessionId"] = Guid.NewGuid().ToString(),
        }, cancellationToken: cts.Token);
        Assert.True(result.IsError);
        Assert.Equal("not_running", result.StructuredContent!.Value.GetProperty("code").GetString());
    }

    [Fact]
    public async Task DisconnectMidCallReportsUnknownOutcome()
    {
        var pipe = $"probe-{Guid.NewGuid():N}";
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var host = new HostStub(pipe) { DropDuringSummary = true };
        var run = host.RunAsync(cts.Token);
        await using var client = await McpClient.CreateAsync(Shim(pipe), cancellationToken: cts.Token);
        var result = await client.CallToolAsync("get_document_summary", new Dictionary<string, object?>
        {
            ["documentId"] = host.DocumentId.ToString(), ["sessionId"] = host.SessionId.ToString(),
        }, cancellationToken: cts.Token);
        Assert.True(result.IsError);
        var err = result.StructuredContent!.Value;
        Assert.Equal("disconnected", err.GetProperty("code").GetString());
        Assert.Equal("unknown", err.GetProperty("outcome").GetString());
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task StdoutContainsOnlyMcp()
    {
        var psi = new ProcessStartInfo("dotnet", [ShimDll])
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            Environment = { ["PROBE_PIPE"] = $"absent-{Guid.NewGuid():N}" },
        };
        using var p = Process.Start(psi)!;
        var stderr = p.StandardError.ReadToEndAsync();
        string[] requests =
        [
            """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}""",
            """{"jsonrpc":"2.0","method":"notifications/initialized"}""",
            """{"jsonrpc":"2.0","id":2,"method":"tools/list"}""",
            """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_document_summary","arguments":{"documentId":"00000000-0000-4000-8000-000000000001","sessionId":"00000000-0000-4000-8000-000000000002"}}}""",
        ];
        foreach (var r in requests) await p.StandardInput.WriteLineAsync(r);
        var lines = new List<string>();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (lines.Count < 3)
        {
            var line = await p.StandardOutput.ReadLineAsync(cts.Token);
            if (line is null) break;
            lines.Add(line);
        }
        p.StandardInput.Close();
        await p.WaitForExitAsync(cts.Token);
        var protocolOnlyStdout = lines.Count == 3 && lines.All(l => JsonNode.Parse(l)!["jsonrpc"]!.GetValue<string>() == "2.0");
        Assert.True(protocolOnlyStdout, string.Join('\n', lines));
        Assert.Contains("probe shim", await stderr); // diagnostics went to stderr
    }
}
