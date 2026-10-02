using System.Buffers.Binary;
using System.IO.Compression;

namespace VsdxProbe;

/// <summary>Deterministic solid-colour RGB PNG encoder for probe fixtures (no image library).</summary>
public static class TinyPng
{
    public static byte[] Create(int width, int height, (byte R, byte G, byte B) colour)
    {
        var raw = new byte[height * (1 + width * 3)];
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                var o = y * (1 + width * 3) + 1 + x * 3;
                raw[o] = colour.R; raw[o + 1] = colour.G; raw[o + 2] = colour.B;
            }
        using var idat = new MemoryStream();
        using (var z = new ZLibStream(idat, CompressionLevel.SmallestSize, leaveOpen: true)) z.Write(raw);

        using var png = new MemoryStream();
        png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var ihdr = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(ihdr, width);
        BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(4), height);
        ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
        Chunk(png, "IHDR", ihdr);
        Chunk(png, "IDAT", idat.ToArray());
        Chunk(png, "IEND", []);
        return png.ToArray();
    }

    private static void Chunk(Stream s, string type, byte[] data)
    {
        Span<byte> len = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(len, data.Length);
        s.Write(len);
        var typed = new byte[4 + data.Length];
        for (var i = 0; i < 4; i++) typed[i] = (byte)type[i];
        data.CopyTo(typed, 4);
        s.Write(typed);
        BinaryPrimitives.WriteUInt32BigEndian(len, Crc32(typed));
        s.Write(len);
    }

    private static uint Crc32(byte[] data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in data)
        {
            crc ^= b;
            for (var k = 0; k < 8; k++) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
        }
        return ~crc;
    }
}
