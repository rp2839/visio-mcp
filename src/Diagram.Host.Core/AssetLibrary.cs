using System.Text.Json;
using System.Text.Json.Serialization;
using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

/// <summary>A per-user approved asset. Versions increase on source replacement; old hashes stay resolvable.</summary>
public sealed record LibraryAsset
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("mimeType")] public string MimeType { get; init; } = "";
    [JsonPropertyName("sha256")] public string Sha256 { get; init; } = "";
    [JsonPropertyName("widthPx")] public long? WidthPx { get; init; }
    [JsonPropertyName("heightPx")] public long? HeightPx { get; init; }
    [JsonPropertyName("byteLength")] public long ByteLength { get; init; }
    [JsonPropertyName("tags")] public List<string> Tags { get; init; } = [];
    [JsonPropertyName("provenance")] public string? Provenance { get; init; }
    [JsonPropertyName("version")] public int Version { get; init; } = 1;
    [JsonPropertyName("previousSha256")] public List<string> PreviousSha256 { get; init; } = [];
    [JsonPropertyName("updatedAt")] public string UpdatedAt { get; init; } = "";

    public Asset ToAsset(string? id = null) => new()
    {
        Id = id ?? Id, Name = Name, MimeType = MimeType, Sha256 = Sha256, WidthPx = WidthPx, HeightPx = HeightPx, Tags = [.. Tags], Provenance = Provenance,
    };
}

/// <summary>
/// Per-user catalogue of approved assets (catalogue.json next to the blob store). Bytes are
/// prepared (sniffed, sanitised) and durable before the catalogue references them; the
/// catalogue itself is published atomically. Open documents pin their own descriptors, so
/// library changes never modify a document.
/// </summary>
public sealed class AssetLibrary(string root, BlobStore blobs, AssetPreparer preparer, TimeProvider? clock = null)
{
    private readonly string catalogue = Path.Combine(Path.GetFullPath(root), "catalogue.json");
    private readonly AtomicFileWriter writer = new() { KeepBackup = true };
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly TimeProvider clock = clock ?? TimeProvider.System;
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    /// <summary>Test hook: runs after blob preparation and before the catalogue is published.</summary>
    internal Action<string>? BeforeCatalogue { get; set; }

    public async Task<IReadOnlyList<LibraryAsset>> ListAsync(string? query, IReadOnlyList<string>? tags, CancellationToken ct)
    {
        var all = await LoadAsync(ct);
        return all.Where(a => Matches(a, query) && (tags is null || tags.All(t => a.Tags.Contains(t, StringComparer.OrdinalIgnoreCase))))
            .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ThenBy(a => a.Id, StringComparer.Ordinal).ToList();
    }

    public async Task<LibraryAsset?> GetAsync(string id, CancellationToken ct) => (await LoadAsync(ct)).FirstOrDefault(a => a.Id == id);

    /// <summary>Adds approved bytes. Same id + same hash is idempotent; a new hash for an existing id must use ReplaceSourceAsync.</summary>
    public async Task<Result<LibraryAsset>> AddAsync(byte[] bytes, string declaredMime, AssetPreparer.Options options, CancellationToken ct)
    {
        var prepared = await preparer.PrepareBytesAsync(bytes, declaredMime, options, ct);
        if (!prepared.Ok) return Result<LibraryAsset>.From(prepared.Error!);
        var asset = prepared.Value!.Ref.Asset;
        await gate.WaitAsync(ct);
        try
        {
            var all = await LoadAsync(ct);
            var existing = all.FirstOrDefault(a => a.Id == asset.Id);
            if (existing is not null)
                return existing.Sha256 == asset.Sha256 ? Result<LibraryAsset>.Success(existing)
                    : Result<LibraryAsset>.Fail("invalid_request", $"{asset.Id} already exists; replace its source to publish a new version");
            var entry = new LibraryAsset
            {
                Id = asset.Id, Name = asset.Name, MimeType = asset.MimeType, Sha256 = asset.Sha256, WidthPx = asset.WidthPx, HeightPx = asset.HeightPx,
                ByteLength = prepared.Value.ByteLength, Tags = [.. asset.Tags], Provenance = asset.Provenance, UpdatedAt = Now(),
            };
            await PublishAsync([.. all, entry], entry.Sha256, ct);
            return Result<LibraryAsset>.Success(entry);
        }
        finally { gate.Release(); }
    }

    /// <summary>New bytes for an existing library asset: version + 1. Open documents keep their pinned descriptor.</summary>
    public async Task<Result<LibraryAsset>> ReplaceSourceAsync(string id, byte[] bytes, string declaredMime, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var all = await LoadAsync(ct);
            var existing = all.FirstOrDefault(a => a.Id == id);
            if (existing is null) return Result<LibraryAsset>.Fail("not_found", $"library asset {id} not found");
            var prepared = await preparer.PrepareBytesAsync(bytes, declaredMime, new AssetPreparer.Options(existing.Name, id["asset:".Length..], existing.Tags, existing.Provenance), ct);
            if (!prepared.Ok) return Result<LibraryAsset>.From(prepared.Error!);
            var a = prepared.Value!.Ref.Asset;
            if (a.Sha256 == existing.Sha256) return Result<LibraryAsset>.Success(existing);
            var next = existing with
            {
                MimeType = a.MimeType, Sha256 = a.Sha256, WidthPx = a.WidthPx, HeightPx = a.HeightPx, ByteLength = prepared.Value.ByteLength,
                Version = existing.Version + 1, PreviousSha256 = [.. existing.PreviousSha256, existing.Sha256], UpdatedAt = Now(),
            };
            await PublishAsync(all.Select(x => x.Id == id ? next : x).ToList(), next.Sha256, ct);
            return Result<LibraryAsset>.Success(next);
        }
        finally { gate.Release(); }
    }

    /// <summary>Every hash the catalogue references (current and previous versions), for blob GC.</summary>
    public async Task<IReadOnlySet<string>> ReferencedBlobsAsync(CancellationToken ct) =>
        (await LoadAsync(ct)).SelectMany(a => a.PreviousSha256.Append(a.Sha256)).ToHashSet();

    private async Task PublishAsync(List<LibraryAsset> all, string newSha, CancellationToken ct)
    {
        if (!blobs.Contains(newSha)) throw HostException.Of("io_error", "blob is not durable; catalogue not updated");
        BeforeCatalogue?.Invoke(newSha);
        await writer.WriteAsync(catalogue, JsonSerializer.SerializeToUtf8Bytes(new Catalogue { Assets = all }, Json), ct);
    }

    private async Task<List<LibraryAsset>> LoadAsync(CancellationToken ct)
    {
        if (!File.Exists(catalogue)) return [];
        await using var s = File.OpenRead(catalogue);
        var c = await JsonSerializer.DeserializeAsync<Catalogue>(s, Json, ct);
        return c?.Assets ?? [];
    }

    private static bool Matches(LibraryAsset a, string? q) => string.IsNullOrWhiteSpace(q)
        || a.Name.Contains(q, StringComparison.OrdinalIgnoreCase) || a.Id.Contains(q, StringComparison.OrdinalIgnoreCase)
        || a.Tags.Any(t => t.Contains(q, StringComparison.OrdinalIgnoreCase));

    private string Now() => clock.GetUtcNow().ToString("O");

    private sealed class Catalogue
    {
        [JsonPropertyName("formatVersion")] public int FormatVersion { get; init; } = 1;
        [JsonPropertyName("assets")] public List<LibraryAsset> Assets { get; init; } = [];
    }
}
