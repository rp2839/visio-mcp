namespace Diagram.Host.Core;

/// <summary>
/// Writes a temp file in the target directory, flushes it to disk and atomically replaces
/// the destination (keeping a .bak of an overwritten file). Any failure before the replace
/// leaves the original bytes untouched.
/// </summary>
public sealed class AtomicFileWriter
{
    /// <summary>Test seam: invoked after the temp file is durable, immediately before replace.</summary>
    internal Action<string>? BeforeReplace { get; set; }
    public bool KeepBackup { get; init; } = true;

    public async Task WriteAsync(string path, ReadOnlyMemory<byte> bytes, CancellationToken ct)
    {
        var full = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(full) ?? throw new IOException($"no directory for {path}");
        Directory.CreateDirectory(dir);
        var temp = Path.Combine(dir, $".{Path.GetFileName(full)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var fs = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await fs.WriteAsync(bytes, ct);
                await fs.FlushAsync(ct);
                fs.Flush(flushToDisk: true);
            }
            BeforeReplace?.Invoke(temp);
            ct.ThrowIfCancellationRequested();
            if (File.Exists(full))
                File.Replace(temp, full, KeepBackup ? full + ".bak" : null, ignoreMetadataErrors: true);
            else
                File.Move(temp, full);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }
}
