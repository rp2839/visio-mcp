using System.Text;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Host.Tests;

public sealed class AssetInputTests : IDisposable
{
    private readonly TempDir tmp = new();
    private readonly BlobStore blobs;
    private readonly AssetPreparer preparer;

    public AssetInputTests()
    {
        blobs = new BlobStore(tmp.File("blobs"));
        preparer = new AssetPreparer(blobs);
    }

    public void Dispose() => tmp.Dispose();

    private Task<Result<PreparedAsset>> Prepare(byte[] bytes, string mime, string name = "Logo") =>
        preparer.PrepareBytesAsync(bytes, mime, new AssetPreparer.Options(name), CancellationToken.None);

    [Fact]
    public async Task RasterHeaderOver64MpxRejectsBeforeDecode()
    {
        var tooLarge = await Prepare(Png.Create(9000, 9000, truncateAfterHeader: true), "image/png");
        Assert.Equal("limit_exceeded", tooLarge.Error!.Code);
        Assert.Equal(0, preparer.DecoderCalls);
        var side = await Prepare(Png.Create(17_000, 10, truncateAfterHeader: true), "image/png");
        Assert.Equal("limit_exceeded", side.Error!.Code);
    }

    [Fact]
    public async Task PngJpegBmpAccepted()
    {
        var png = await Prepare(Png.Create(40, 20), "image/png");
        Assert.True(png.Ok);
        Assert.Equal((40, 20), ((int)png.Value!.Ref.Asset.WidthPx!, (int)png.Value.Ref.Asset.HeightPx!));
        var bmp = new byte[54];
        bmp[0] = (byte)'B'; bmp[1] = (byte)'M';
        BitConverter.GetBytes(30).CopyTo(bmp, 18); BitConverter.GetBytes(-10).CopyTo(bmp, 22);
        var b = await Prepare(bmp, "image/bmp");
        Assert.Equal(10, b.Value!.Ref.Asset.HeightPx);
        byte[] jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x20, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00];
        var j = await Prepare(jpeg, "image/jpeg");
        Assert.True(j.Ok, j.Error?.Message);
        Assert.Equal((64, 32), ((int)j.Value!.Ref.Asset.WidthPx!, (int)j.Value.Ref.Asset.HeightPx!));
    }

    [Fact]
    public async Task MimeMismatchRejects()
    {
        var r = await Prepare(Png.Create(2, 2), "image/jpeg");
        Assert.Equal("invalid_request", r.Error!.Code);
    }

    [Theory]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"https://evil.example/x.png\"/></svg>")]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"><use xlink:href=\"file:///etc/passwd#x\"/></svg>")]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect style=\"fill:url(https://evil.example/a)\"/></svg>")]
    [InlineData("<?xml version=\"1.0\"?><!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><svg xmlns=\"http://www.w3.org/2000/svg\"><text>&x;</text></svg>")]
    public async Task SvgExternalResourceRejects(string svg)
    {
        var r = await Prepare(Encoding.UTF8.GetBytes(svg), "image/svg+xml");
        Assert.False(r.Ok);
        Assert.Equal("invalid_request", r.Error!.Code);
    }

    [Fact]
    public async Task SanitiseThenHash()
    {
        var dirty = Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"10\"><script>x()</script><foreignObject><div/></foreignObject><rect onclick=\"x()\" width=\"20\" height=\"10\" fill=\"#123456\"/></svg>");
        var prepared = await Prepare(dirty, "image/svg+xml");
        Assert.True(prepared.Ok, prepared.Error?.Message);
        Assert.True(prepared.Value!.Sanitised);
        var stored = (await blobs.ReadAsync(prepared.Value.Ref.Asset.Sha256, CancellationToken.None)).ToArray();
        var expectedSanitisedHash = BlobStore.Sha256(stored);
        Assert.Equal(expectedSanitisedHash, prepared.Value.Ref.Asset.Sha256);
        Assert.NotEqual(BlobStore.Sha256(dirty), prepared.Value.Ref.Asset.Sha256);
        var text = Encoding.UTF8.GetString(stored);
        Assert.DoesNotContain("script", text);
        Assert.DoesNotContain("foreignObject", text);
        Assert.DoesNotContain("onclick", text);
        Assert.Contains("#123456", text);
        Assert.Equal(20, prepared.Value.Ref.Asset.WidthPx);
    }

    [Fact]
    public async Task SourcePathNeverAutomaticallyReread()
    {
        var path = tmp.File("logo.png");
        var original = Png.Create(4, 4);
        await File.WriteAllBytesAsync(path, original);
        await using var stream = File.OpenRead(path);
        var prepared = await preparer.PrepareAsync(stream, "image/png", new AssetPreparer.Options("Logo", SourcePath: path), CancellationToken.None);
        stream.Close();
        await File.WriteAllBytesAsync(path, Png.Create(5, 5)); // source changes on disk afterwards
        var sha = prepared.Value!.Ref.Asset.Sha256;
        Assert.Equal(original, (await blobs.ReadAsync(sha, CancellationToken.None)).ToArray());
        Assert.Equal(path, prepared.Value.Ref.Asset.SourcePath); // informational only
    }

    [Fact]
    public async Task PreparationRefsVerifyOwnershipExpiryAndHash()
    {
        var clock = new ManualClock(DateTimeOffset.Parse("2026-10-02T12:00:00Z"));
        var p = new AssetPreparer(blobs, clock);
        var prepared = (await p.PrepareBytesAsync(Png.Create(2, 2), "image/png", new AssetPreparer.Options("A"), CancellationToken.None)).Value!;
        Assert.True(p.Verify(prepared.Ref).Ok);
        Assert.False(p.Verify(prepared.Ref, owner: "other-client").Ok);
        Assert.False(p.Verify(prepared.Ref with { Asset = prepared.Ref.Asset with { Sha256 = new string('0', 64) } }).Ok);
        clock.Advance(TimeSpan.FromHours(1));
        Assert.False(p.Verify(prepared.Ref).Ok);
    }

    private sealed class ManualClock(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset now = now;
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan t) => now += t;
    }
}
