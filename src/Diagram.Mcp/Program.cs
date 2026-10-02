using Diagram.Mcp;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = Host.CreateApplicationBuilder(args);
// Stdout is reserved for MCP protocol frames; every diagnostic goes to stderr and omits document content.
builder.Logging.ClearProviders();
builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.Services.AddSingleton(new ShimConnection(Environment.GetEnvironmentVariable("AGENTIC_DIAGRAM_PIPE") ?? Diagram.Ipc.Handshake.PipeName()));
builder.Services.AddMcpServer(o => o.ServerInfo = new() { Name = "agentic-diagram", Version = "0.1.0" })
    .WithStdioServerTransport()
    .WithTools<DiagramTools>();
Console.Error.WriteLine("agentic-diagram MCP shim: stdio server starting (stdout carries protocol only)");
await builder.Build().RunAsync();
