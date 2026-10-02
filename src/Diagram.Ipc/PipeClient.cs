using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Diagram.Core.Contracts;

namespace Diagram.Ipc;

/// <summary>
/// Pipe client used by the MCP shim: lazy connect, handshake, one writer, concurrent calls
/// correlated by requestId. Never retries; a failure after dispatch is reported with an
/// unknown outcome, never as a rollback.
/// </summary>
public sealed class PipeClient : IAsyncDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly SemaphoreSlim writeLock = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<ResponseEnvelope>> pending = new();
    private readonly CancellationTokenSource readerCts = new();
    private Task? reader;
    private long next;
    public string? ConnectionId { get; private set; }
    public bool Connected => pipe.IsConnected && reader is { IsCompleted: false };

    private PipeClient(NamedPipeClientStream pipe) => this.pipe = pipe;

    public static async Task<PipeClient> ConnectAsync(string pipeName, string clientLabel, TimeSpan timeout, CancellationToken ct)
    {
        var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try
        {
            await pipe.ConnectAsync((int)timeout.TotalMilliseconds, ct);
        }
        catch (Exception e) when (e is TimeoutException or IOException or UnauthorizedAccessException)
        {
            await pipe.DisposeAsync();
            throw new FrameException("not_running", "the diagram application is not running for this user");
        }
        var client = new PipeClient(pipe);
        client.reader = Task.Run(client.ReadLoopAsync);
        var hello = await client.CallAsync(new RequestEnvelope
        {
            ProtocolVersion = 1, Kind = "request", RequestId = "hello", Method = Handshake.Method,
            Params = JsonSerializer.SerializeToElement(new { clientLabel }),
        }, TimeSpan.FromSeconds(5), ct);
        if (hello.Error is { } e2) { await client.DisposeAsync(); throw new FrameException(e2.Code, e2.Message); }
        client.ConnectionId = hello.Result.GetProperty("connectionId").GetString();
        return client;
    }

    public async Task<ResponseEnvelope> CallAsync(RequestEnvelope request, TimeSpan deadline, CancellationToken ct)
    {
        var id = $"{request.RequestId}#{Interlocked.Increment(ref next)}";
        var tcs = new TaskCompletionSource<ResponseEnvelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = tcs;
        var dispatched = false;
        try
        {
            var payload = Encoding.UTF8.GetBytes(ContractJson.Serialize(request with { RequestId = id }));
            await writeLock.WaitAsync(ct);
            try { await FrameCodec.WriteAsync(pipe, payload, ct); dispatched = true; }
            finally { writeLock.Release(); }
            using var timer = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timer.CancelAfter(deadline);
            var r = await tcs.Task.WaitAsync(timer.Token);
            return r with { RequestId = request.RequestId };
        }
        catch (Exception e) when (e is FrameException or IOException or OperationCanceledException or ObjectDisposedException)
        {
            pending.TryRemove(id, out _);
            var code = e is OperationCanceledException && !ct.IsCancellationRequested ? "timeout_unknown" : "timeout_unknown";
            return PipeServer.Error(request.RequestId, code, dispatched ? "no reply; the request may have been applied" : "request was not sent", retryable: true,
                outcome: dispatched ? "unknown" : "not_applied");
        }
    }

    private async Task ReadLoopAsync()
    {
        try
        {
            while (!readerCts.IsCancellationRequested)
            {
                var payload = await FrameCodec.ReadAsync(pipe, readerCts.Token);
                var r = ContractJson.Deserialize<ResponseEnvelope>(Encoding.UTF8.GetString(payload));
                if (pending.TryRemove(r.RequestId, out var tcs)) tcs.TrySetResult(r);
            }
        }
        catch (Exception)
        {
            // Disconnect: settle everything in flight as unknown (never a rollback claim).
            foreach (var (key, tcs) in pending)
                if (pending.TryRemove(key, out _))
                    tcs.TrySetException(new FrameException("disconnected", "pipe closed"));
        }
    }

    public async ValueTask DisposeAsync()
    {
        readerCts.Cancel();
        await pipe.DisposeAsync();
        if (reader is not null) try { await reader; } catch { /* closing */ }
    }
}
