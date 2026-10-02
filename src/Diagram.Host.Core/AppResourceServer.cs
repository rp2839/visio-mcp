namespace Diagram.Host.Core;

public sealed record AppResource(int Status, string Reason, byte[]? Body, string Headers);

/// <summary>
/// Serves everything on the app origin (https://app.agentic-diagram.invalid/): the packaged
/// frontend files and, under <c>/blobs/&lt;sha256&gt;</c>, approved asset bytes from the blob store.
/// One handler owns the whole origin. WebView2's folder mapping would otherwise answer every
/// request on the mapped host, so blob URLs never reached the blob store. Paths are confined to
/// the frontend folder, blob names must be hashes, and other hosts are refused.
/// </summary>
public sealed class AppResourceServer(string frontendRoot, BlobStore blobs)
{
    public const string BlobPath = "blobs/";
    private readonly string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(frontendRoot));

    private static readonly Dictionary<string, string> Types = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8", [".js"] = "text/javascript; charset=utf-8", [".mjs"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8", [".json"] = "application/json", [".map"] = "application/json", [".svg"] = "image/svg+xml",
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".ico"] = "image/x-icon",
        [".woff"] = "font/woff", [".woff2"] = "font/woff2", [".ttf"] = "font/ttf", [".txt"] = "text/plain; charset=utf-8",
    };

    public async Task<AppResource> ResolveAsync(string uri, CancellationToken ct)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var u) || u.Scheme != Uri.UriSchemeHttps || !string.Equals(u.Host, BridgeRouter.Origin.Host, StringComparison.OrdinalIgnoreCase))
            return Status(403, "Forbidden");
        var path = Uri.UnescapeDataString(u.AbsolutePath).TrimStart('/');
        if (path.Length == 0) path = "index.html";

        if (path.StartsWith(BlobPath, StringComparison.Ordinal))
        {
            var sha = path[BlobPath.Length..];
            if (sha.Length != 64 || !sha.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')) return Status(404, "Not Found");
            try
            {
                var bytes = await blobs.ReadAsync(sha, ct);
                var mime = AssetPreparer.Sniff(bytes.Span) ?? "application/octet-stream";
                return new AppResource(200, "OK", bytes.ToArray(), $"Content-Type: {mime}\r\nCache-Control: max-age=31536000, immutable\r\nX-Content-Type-Options: nosniff");
            }
            catch (Exception e) when (e is HostException or IOException or UnauthorizedAccessException)
            {
                return Status(404, "Not Found");
            }
        }

        if (path.Contains('\\') || path.Contains(':') || path.Split('/').Any(s => s is "" or "." or "..")) return Status(404, "Not Found");
        var full = Path.GetFullPath(Path.Combine(root, path));
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal) || !File.Exists(full)) return Status(404, "Not Found");
        var type = Types.TryGetValue(Path.GetExtension(full), out var t) ? t : "application/octet-stream";
        var cache = path == "index.html" ? "no-cache" : "max-age=31536000, immutable";
        return new AppResource(200, "OK", await File.ReadAllBytesAsync(full, ct), $"Content-Type: {type}\r\nCache-Control: {cache}\r\nX-Content-Type-Options: nosniff");
    }

    private static AppResource Status(int code, string reason) => new(code, reason, null, "");
}
