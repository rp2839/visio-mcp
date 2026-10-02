using System.Buffers.Binary;

namespace Diagram.Ipc;

public sealed class FrameException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>4-byte little-endian unsigned length + UTF-8 JSON payload; exact partial reads.</summary>
public static class FrameCodec
{
    public const uint MaxFrameBytes = 32u * 1024 * 1024;
    private static long payloadAllocations;
    internal static long PayloadAllocations => Interlocked.Read(ref payloadAllocations);

    public static async Task<byte[]> ReadAsync(Stream stream, CancellationToken ct, uint maxBytes = MaxFrameBytes)
    {
        var header = new byte[4];
        await ReadExactlyAsync(stream, header, ct);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        // Validate the declared size before allocating the payload.
        if (length > maxBytes) throw new FrameException("limit_exceeded", $"frame of {length} bytes exceeds the {maxBytes} byte cap");
        Interlocked.Increment(ref payloadAllocations);
        var payload = new byte[length];
        await ReadExactlyAsync(stream, payload, ct);
        return payload;
    }

    public static async Task WriteAsync(Stream stream, ReadOnlyMemory<byte> payload, CancellationToken ct)
    {
        if ((uint)payload.Length > MaxFrameBytes) throw new FrameException("limit_exceeded", "frame exceeds the 32 MiB cap");
        var frame = new byte[4 + payload.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame.AsMemory(4));
        await stream.WriteAsync(frame, ct);
        await stream.FlushAsync(ct);
    }

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> buffer, CancellationToken ct)
    {
        var read = 0;
        while (read < buffer.Length)
        {
            var n = await stream.ReadAsync(buffer[read..], ct);
            if (n == 0) throw new FrameException("disconnected", "peer closed the connection");
            read += n;
        }
    }
}
