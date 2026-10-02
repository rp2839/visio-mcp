using System.Buffers.Binary;
using System.Text;
using Diagram.Ipc;
using Xunit;

namespace Diagram.Ipc.Tests;

public sealed class FrameTests
{
    private sealed class Trickle(byte[] data) : MemoryStream(data)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) => base.ReadAsync(buffer[..Math.Min(1, buffer.Length)], ct);
    }

    [Fact]
    public async Task PartialFrames()
    {
        var ms = new MemoryStream();
        await FrameCodec.WriteAsync(ms, Encoding.UTF8.GetBytes("{\"a\":1}"), CancellationToken.None);
        await FrameCodec.WriteAsync(ms, Encoding.UTF8.GetBytes("{\"b\":\"é\"}"), CancellationToken.None);
        var t = new Trickle(ms.ToArray());
        Assert.Equal("{\"a\":1}", Encoding.UTF8.GetString(await FrameCodec.ReadAsync(t, CancellationToken.None)));
        Assert.Equal("{\"b\":\"é\"}", Encoding.UTF8.GetString(await FrameCodec.ReadAsync(t, CancellationToken.None)));
    }

    [Fact]
    public async Task ThirtyTwoMiBCap()
    {
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, FrameCodec.MaxFrameBytes + 1);
        var before = FrameCodec.PayloadAllocations;
        var e = await Assert.ThrowsAsync<FrameException>(() => FrameCodec.ReadAsync(new MemoryStream(header), CancellationToken.None));
        Assert.Equal("limit_exceeded", e.Code);
        Assert.Equal(before, FrameCodec.PayloadAllocations);
        await Assert.ThrowsAsync<FrameException>(() => FrameCodec.WriteAsync(new MemoryStream(), new byte[FrameCodec.MaxFrameBytes + 1], CancellationToken.None));
    }

    [Fact]
    public async Task TruncationIsDisconnected()
    {
        var bytes = new byte[8];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, 100);
        var e = await Assert.ThrowsAsync<FrameException>(() => FrameCodec.ReadAsync(new MemoryStream(bytes), CancellationToken.None));
        Assert.Equal("disconnected", e.Code);
    }
}
