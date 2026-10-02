using System.Buffers.Binary;
using System.Text.Json;

namespace IpcProbe;

public sealed class FrameException(string code, string message, string? outcome = null) : Exception(message)
{
    public string Code { get; } = code;
    /// <summary>"unknown" when a request may have been dispatched before the failure.</summary>
    public string? Outcome { get; } = outcome;
}

/// <summary>4-byte little-endian unsigned length + UTF-8 JSON. Exact partial reads.</summary>
public static class FrameCodec
{
    public const uint MaxFrameBytes = 32u * 1024 * 1024;
    private static long payloadAllocations;
    public static long PayloadAllocations => Interlocked.Read(ref payloadAllocations);

    public static async Task<JsonDocument> ReadAsync(Stream stream, CancellationToken ct)
    {
        var header = new byte[4];
        await ReadExactlyAsync(stream, header, ct);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        // Validate the declared size before allocating any payload buffer.
        if (length > MaxFrameBytes) throw new FrameException("limit_exceeded", $"frame of {length} bytes exceeds the 32 MiB cap");
        Interlocked.Increment(ref payloadAllocations);
        var payload = new byte[length];
        await ReadExactlyAsync(stream, payload, ct);
        try
        {
            return JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = 64 });
        }
        catch (JsonException e)
        {
            throw new FrameException("invalid_request", "malformed JSON frame: " + e.Message);
        }
    }

    public static async Task WriteAsync(Stream stream, JsonDocument doc, CancellationToken ct)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(doc.RootElement);
        if ((uint)payload.Length > MaxFrameBytes) throw new FrameException("limit_exceeded", "frame exceeds 32 MiB");
        var frame = new byte[4 + payload.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame, 4);
        await stream.WriteAsync(frame, ct);
        await stream.FlushAsync(ct);
    }

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> buffer, CancellationToken ct)
    {
        var read = 0;
        while (read < buffer.Length)
        {
            var n = await stream.ReadAsync(buffer[read..], ct);
            if (n == 0) throw new FrameException("disconnected", "peer closed the connection mid-frame");
            read += n;
        }
    }
}
