using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using IpcProbe;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

var builder = Host.CreateApplicationBuilder(args);
// Stdout carries MCP protocol only; every log line goes to stderr.
builder.Logging.ClearProviders();
builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
builder.Services.AddMcpServer().WithStdioServerTransport().WithTools<ProbeTools>();
Console.Error.WriteLine("probe shim starting (stdout reserved for MCP)");
await builder.Build().RunAsync();

[McpServerToolType]
public sealed class ProbeTools
{
    private static string PipeName => Environment.GetEnvironmentVariable("PROBE_PIPE") ?? "agentic-diagram-probe";

    [McpServerTool(Name = "get_document_summary"), Description("Summary of the open diagram document.")]
    public static async Task<CallToolResult> GetDocumentSummary(
        [Description("Document UUID from a previous read")] string documentId,
        [Description("Session UUID from a previous read")] string sessionId,
        CancellationToken ct)
    {
        if (!Guid.TryParse(documentId, out var doc) || !Guid.TryParse(sessionId, out var session))
            return Error("invalid_request", "documentId and sessionId must be UUIDs", null);
        PipeClient client;
        try
        {
            // Lazy connect; the shim never launches the app.
            client = await PipeClient.ConnectAsync(PipeName, TimeSpan.FromMilliseconds(500), ct, clientLabel: "mcp-probe");
        }
        catch (Exception e) when (e is FrameException or TimeoutException or IOException)
        {
            return Error(e is FrameException fe ? fe.Code : "not_running", "diagram application is not running", "not_applied");
        }
        await using (client)
        {
            var r = await client.CallAsync("doc.summary", new JsonObject(), ct, doc, session);
            if (!r.Ok) return Error(r.ErrorCode ?? "internal_error", r.Message ?? "", r.Outcome);
            var json = r.Result!.ToJsonString();
            return new CallToolResult
            {
                Content = [new TextContentBlock { Text = json }],
                StructuredContent = JsonDocument.Parse(json).RootElement.Clone(),
            };
        }
    }

    private static CallToolResult Error(string code, string message, string? outcome)
    {
        var o = new JsonObject { ["code"] = code, ["message"] = message, ["retryable"] = code is "not_running" or "disconnected" or "busy" };
        if (outcome is not null) o["outcome"] = outcome;
        var json = o.ToJsonString();
        return new CallToolResult
        {
            IsError = true,
            Content = [new TextContentBlock { Text = json }],
            StructuredContent = JsonDocument.Parse(json).RootElement.Clone(),
        };
    }
}
