using IpcProbe;

// Usage: dotnet run --project spikes/ipc -- <pipe-name>
var name = args.FirstOrDefault() ?? "agentic-diagram-probe";
var host = new HostStub(name);
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
Console.Error.WriteLine($"host stub listening on pipe '{name}', document {host.DocumentId}, session {host.SessionId}");
await host.RunAsync(cts.Token);
