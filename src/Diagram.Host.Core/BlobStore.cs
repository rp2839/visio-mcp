using System.Security.Cryptography;

namespace Diagram.Host.Core;

/// <summary>
/// Per-user content-addressed immutable blob store. Bytes are durable (fsync'd, atomically
/// published) before PutDurableAsync returns, so journal records may reference the hash.
/// </summary>
public sealed class BlobStore(string root)
{
    private readonly AtomicFileWriter writer = new() { KeepBackup = false };
    public string Root { get; } = Path.GetFullPath(root);

    public static string Sha256(ReadOnlySpan<byte> bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private string PathFor(string sha)
    {
        if (sha.Length != 64 || !sha.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
            throw HostException.Of("invalid_request", "blob hash must be 64 lowercase hex characters");
        return Path.Combine(Root, sha[..2], sha);
    }

    public bool Contains(string sha) => File.Exists(PathFor(sha));

    public async Task<string> PutDurableAsync(ReadOnlyMemory<byte> bytes, CancellationToken ct)
    {
        var sha = Sha256(bytes.Span);
        var path = PathFor(sha);
        if (!File.Exists(path)) await writer.WriteAsync(path, bytes, ct);
        return sha;
    }

    public async Task<ReadOnlyMemory<byte>> ReadAsync(string sha, CancellationToken ct)
    {
        var path = PathFor(sha);
        if (!File.Exists(path)) throw HostException.Of("not_found", $"blob {sha} is not in the store");
        var bytes = await File.ReadAllBytesAsync(path, ct);
        if (Sha256(bytes) != sha) throw HostException.Of("io_error", $"blob {sha} failed its integrity check");
        return bytes;
    }

    /// <summary>Removes blobs not in <paramref name="referenced"/> (documents, library, undo and recovery generations).</summary>
    public int CollectGarbage(IReadOnlySet<string> referenced)
    {
        var removed = 0;
        if (!Directory.Exists(Root)) return 0;
        foreach (var file in Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories))
        {
            var name = Path.GetFileName(file);
            if (name.Length == 64 && !referenced.Contains(name)) { File.Delete(file); removed++; }
        }
        return removed;
    }
}
