using System.Text;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Host.Tests;

public sealed class AppResourceServerTests : IDisposable
{
    private readonly TempDir tmp = new();
    private readonly BlobStore blobs;
    private readonly AppResourceServer server;
    private const string O = "https://app.agentic-diagram.invalid/";

    public AppResourceServerTests()
    {
        var fe = Directory.CreateDirectory(tmp.File("frontend")).FullName;
        File.WriteAllText(Path.Combine(fe, "index.html"), "<!doctype html>");
        Directory.CreateDirectory(Path.Combine(fe, "assets"));
        File.WriteAllText(Path.Combine(fe, "assets", "index-abc.js"), "console.log(1)");
        File.WriteAllText(tmp.File("secret.txt"), "secret");
        blobs = new BlobStore(tmp.File("blobs"));
        server = new AppResourceServer(fe, blobs);
    }

    public void Dispose() => tmp.Dispose();

    private Task<AppResource> Get(string url) => server.ResolveAsync(url, CancellationToken.None);

    [Fact]
    public async Task ServesImportedImageBytesByHashOnTheAppOrigin()
    {
        var png = Png.Create(4, 2);
        var sha = await blobs.PutDurableAsync(png, CancellationToken.None);
        var r = await Get(O + "blobs/" + sha);
        Assert.Equal(200, r.Status);
        Assert.Equal(png, r.Body);
        Assert.Contains("Content-Type: image/png", r.Headers);
        var svg = Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
        Assert.Contains("Content-Type: image/svg+xml", (await Get(O + "blobs/" + await blobs.PutDurableAsync(svg, CancellationToken.None))).Headers);
    }

    [Fact]
    public async Task ServesFrontendFilesAlongsideBlobs()
    {
        var index = await Get(O);
        Assert.Equal((200, "<!doctype html>"), (index.Status, Encoding.UTF8.GetString(index.Body!)));
        Assert.Contains("text/html", index.Headers);
        var js = await Get(O + "assets/index-abc.js");
        Assert.Equal(200, js.Status);
        Assert.Contains("text/javascript", js.Headers);
        Assert.Equal(200, (await Get(O + "index.html?x=1")).Status);
    }

    [Theory]
    [InlineData("blobs/" + "0000000000000000000000000000000000000000000000000000000000000000")] // unknown hash
    [InlineData("blobs/../secret.txt")]
    [InlineData("blobs/ABC")]
    [InlineData("..%2Fsecret.txt")]
    [InlineData("assets/..%2F..%2Fsecret.txt")]
    [InlineData("missing.js")]
    [InlineData("C:%5Cwindows%5Cwin.ini")]
    public async Task UnknownOrEscapingPathsAre404(string path) => Assert.Equal(404, (await Get(O + path)).Status);

    [Theory]
    [InlineData("https://evil.example/index.html")]
    [InlineData("http://app.agentic-diagram.invalid/index.html")]
    public async Task OtherOriginsAreForbidden(string url) => Assert.Equal(403, (await Get(url)).Status);
}
