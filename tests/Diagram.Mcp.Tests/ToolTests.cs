using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Ipc;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Xunit;

namespace Diagram.Mcp.Tests;

public sealed class ToolTests
{
    private static readonly string ShimDll = Path.Combine(AppContext.BaseDirectory, "Diagram.Mcp.dll");
    private const string Doc = "00000000-0000-4000-8000-000000000001";
    private const string Session = "00000000-0000-4000-8000-000000000002";
    public static readonly string[] SourceToolNames =
        ["get_document_summary", "get_objects", "apply_operations", "execute_script", "render_page", "render_region", "inspect_layout", "list_assets", "get_changes", "export_document"];

    /// <summary>Fake app behind the real pipe server: records every request it receives.</summary>
    private sealed class FakeApp
    {
        public List<RequestEnvelope> Received { get; } = [];
        public Func<RequestEnvelope, ResponseEnvelope?>? Override { get; set; }
        public Task<ResponseEnvelope> Handle(RequestEnvelope r, ConnectionInfo c, CancellationToken ct)
        {
            lock (Received) Received.Add(r);
            if (Override?.Invoke(r) is { } o) return Task.FromResult(o);
            object result = r.Method switch
            {
                "app.current" => new { documentId = Doc, sessionId = Session, revision = 7 },
                "doc.summary" => new { documentId = r.DocumentId, sessionId = r.SessionId, revision = 7, elements = Array.Empty<object>() },
                "doc.apply" => new { transactionId = r.Params.GetProperty("transactionId").GetString(), previousRevision = 7, revision = 8, changed = new[] { "x" } },
                "doc.render" => new { mimeType = "image/png", data = Convert.ToBase64String([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), revision = 7, widthPx = 1, heightPx = 1 },
                _ => new { ok = true },
            };
            return Task.FromResult(new ResponseEnvelope { ProtocolVersion = 1, Kind = "response", RequestId = r.RequestId, Result = JsonSerializer.SerializeToElement(result) });
        }
    }

    private static async Task<(McpClient Client, FakeApp App, CancellationTokenSource Cts, Task Run)> StartAsync()
    {
        var pipe = $"mcp-{Guid.NewGuid():N}";
        var app = new FakeApp();
        var cts = new CancellationTokenSource();
        var run = new PipeServer(pipe).StartAsync(app.Handle, cts.Token);
        var client = await McpClient.CreateAsync(new StdioClientTransport(new StdioClientTransportOptions
        {
            Name = "shim", Command = "dotnet", Arguments = [ShimDll],
            EnvironmentVariables = new Dictionary<string, string?> { ["AGENTIC_DIAGRAM_PIPE"] = pipe },
        }));
        return (client, app, cts, run);
    }

    [Fact]
    public async Task AllToolNamesMatchSource()
    {
        var (client, _, cts, run) = await StartAsync();
        var tools = await client.ListToolsAsync();
        Assert.Equal(SourceToolNames.Order(), tools.Select(t => t.Name).Order());
        await client.DisposeAsync(); cts.Cancel(); await run;
    }

    [Fact]
    public async Task ToolSchemasRequireIdentity()
    {
        var (client, _, cts, run) = await StartAsync();
        var tools = (await client.ListToolsAsync()).ToDictionary(t => t.Name);
        foreach (var name in new[] { "apply_operations", "execute_script" })
        {
            var required = tools[name].JsonSchema.GetProperty("required").EnumerateArray().Select(e => e.GetString()).ToHashSet();
            Assert.Superset(new HashSet<string?> { "documentId", "sessionId", "transactionId", "baseRevision" }, required);
        }
        var changes = tools["get_changes"].JsonSchema.GetProperty("required").EnumerateArray().Select(e => e.GetString()).ToHashSet();
        Assert.Contains("sessionId", changes);
        await client.DisposeAsync(); cts.Cancel(); await run;
    }

    [Fact]
    public async Task MutationsForwardCallerIdentityAndNeverRetry()
    {
        var (client, app, cts, run) = await StartAsync();
        var tx = Guid.NewGuid().ToString();
        var ok = await client.CallToolAsync("apply_operations", new Dictionary<string, object?>
        {
            ["documentId"] = Doc, ["sessionId"] = Session, ["transactionId"] = tx, ["baseRevision"] = 7,
            ["operations"] = JsonDocument.Parse("""[{"op":"move","target":"x","delta":{"xPt":1,"yPt":0}}]""").RootElement,
        });
        Assert.NotEqual(true, ok.IsError);
        var sent = app.Received.Single(r => r.Method == "doc.apply");
        Assert.Equal(tx, sent.Params.GetProperty("transactionId").GetString());
        Assert.Equal(Session, sent.SessionId);

        // Host failure after dispatch: one request, unknown outcome, no automatic retry.
        app.Override = r => r.Method == "doc.apply" ? throw new IOException("boom") : null;
        var unknown = await client.CallToolAsync("apply_operations", new Dictionary<string, object?>
        {
            ["documentId"] = Doc, ["sessionId"] = Session, ["transactionId"] = Guid.NewGuid().ToString(), ["baseRevision"] = 8,
            ["operations"] = JsonDocument.Parse("[]").RootElement,
        });
        Assert.True(unknown.IsError);
        Assert.Equal("unknown", unknown.StructuredContent!.Value.GetProperty("outcome").GetString());
        Assert.Equal(2, app.Received.Count(r => r.Method == "doc.apply"));

        var noTx = await client.CallToolAsync("apply_operations", new Dictionary<string, object?>
        {
            ["documentId"] = Doc, ["sessionId"] = Session, ["transactionId"] = "not-a-uuid", ["baseRevision"] = 8, ["operations"] = JsonDocument.Parse("[]").RootElement,
        });
        Assert.Equal("invalid_request", noTx.StructuredContent!.Value.GetProperty("code").GetString());
        await client.DisposeAsync(); cts.Cancel(); await run;
    }

    [Fact]
    public async Task ReadsWithoutScopeUseTheCurrentDocument()
    {
        var (client, app, cts, run) = await StartAsync();
        var r = await client.CallToolAsync("get_document_summary", new Dictionary<string, object?>());
        Assert.Equal(Session, r.StructuredContent!.Value.GetProperty("sessionId").GetString());
        Assert.Equal(["app.current", "doc.summary"], app.Received.Select(x => x.Method));
        await client.DisposeAsync(); cts.Cancel(); await run;
    }

    [Fact]
    public async Task RenderReturnsImageBlockAndMetadata()
    {
        var (client, _, cts, run) = await StartAsync();
        var r = await client.CallToolAsync("render_page", new Dictionary<string, object?> { ["pageId"] = "p" });
        var image = Assert.IsType<ImageContentBlock>(r.Content[0]);
        Assert.Equal("image/png", image.MimeType);
        var meta = JsonNode.Parse(((TextContentBlock)r.Content[1]).Text)!;
        Assert.Null(meta["data"]); // bytes only in the image block
        Assert.Equal(7, meta["revision"]!.GetValue<int>());
        await client.DisposeAsync(); cts.Cancel(); await run;
    }

    [Fact]
    public async Task MissingHostIsNotRunning()
    {
        await using var client = await McpClient.CreateAsync(new StdioClientTransport(new StdioClientTransportOptions
        {
            Name = "shim", Command = "dotnet", Arguments = [ShimDll],
            EnvironmentVariables = new Dictionary<string, string?> { ["AGENTIC_DIAGRAM_PIPE"] = $"absent-{Guid.NewGuid():N}" },
        }));
        var r = await client.CallToolAsync("get_document_summary", new Dictionary<string, object?>());
        Assert.True(r.IsError);
        Assert.Equal("not_running", r.StructuredContent!.Value.GetProperty("code").GetString());
    }

    [Fact]
    public async Task StdioHasNoLogs()
    {
        var psi = new ProcessStartInfo("dotnet", [ShimDll]) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        psi.Environment["AGENTIC_DIAGRAM_PIPE"] = $"absent-{Guid.NewGuid():N}";
        using var p = Process.Start(psi)!;
        var err = p.StandardError.ReadToEndAsync();
        await p.StandardInput.WriteLineAsync("""{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}""");
        await p.StandardInput.WriteLineAsync("""{"jsonrpc":"2.0","method":"notifications/initialized"}""");
        await p.StandardInput.WriteLineAsync("""{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_document_summary","arguments":{}}}""");
        var lines = new List<string>();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (lines.Count < 2 && await p.StandardOutput.ReadLineAsync(cts.Token) is { } line) lines.Add(line);
        p.StandardInput.Close();
        await p.WaitForExitAsync(cts.Token);
        Assert.All(lines, l => Assert.Equal("2.0", JsonNode.Parse(l)!["jsonrpc"]!.GetValue<string>()));
        Assert.Contains("stdout carries protocol only", await err);
    }
}
