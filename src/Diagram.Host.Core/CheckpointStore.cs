using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

public sealed record RecoveryCandidate(
    Snapshot Base, IReadOnlyList<CommittedEvent> Tail, IReadOnlyList<Diagnostic> Report)
{
    /// <summary>Last durable revision: the checkpoint plus the contiguous journal tail.</summary>
    public long Revision => Tail.Count > 0 ? Tail[^1].Revision : Base.Revision;
    public IReadOnlyList<long> ReplayedRevisions => Tail.Select(t => t.Revision).ToList();
    public bool Lossy => Report.Any(d => d.Action == "dropped");
}

/// <summary>
/// Immutable checkpoint generations published through an atomic manifest. The current and
/// previous generations are retained; the journal tail newer than the checkpoint (R+1…) is
/// kept. Blobs referenced by a checkpoint must be durable before it is published.
/// </summary>
public sealed class CheckpointStore(string root, BlobStore blobs, RecoveryJournal journal)
{
    private readonly string dir = Path.GetFullPath(root);
    private readonly AtomicFileWriter writer = new() { KeepBackup = false };
    private readonly SemaphoreSlim gate = new(1, 1);
    private string ManifestPath => Path.Combine(dir, "manifest.json");

    /// <summary>Crash-injection seam: "after-generation" or "after-manifest".</summary>
    internal Action<string>? FaultPoint { get; set; }

    public async Task<Result<DurableRevision>> PublishAsync(Snapshot snapshot, long sequence, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            foreach (var a in snapshot.Document.Assets)
            {
                bool ok;
                try { ok = blobs.Contains(a.Sha256); } catch (HostException) { ok = false; }
                if (!ok) return Result<DurableRevision>.Fail("io_error", $"asset {a.Id} blob is not durable; checkpoint not published", retryable: true);
            }
            var current = ReadManifest();
            var generation = (current?.Generation ?? 0) + 1;
            var file = $"gen-{generation:D8}.json";
            var bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot, ContractJson.Options);
            await writer.WriteAsync(Path.Combine(dir, file), bytes, ct);
            FaultPoint?.Invoke("after-generation");
            var manifest = new Manifest
            {
                Generation = generation, File = file, Sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                DocumentId = snapshot.DocumentId, SessionId = snapshot.SessionId, Revision = snapshot.Revision, Sequence = sequence,
                Previous = current is null ? null : current with { Previous = null },
            };
            await writer.WriteAsync(ManifestPath, JsonSerializer.SerializeToUtf8Bytes(manifest), ct);
            FaultPoint?.Invoke("after-manifest");
            journal.SetBase(snapshot.SessionId, snapshot.Revision, sequence);
            await journal.CompactAsync(snapshot.SessionId, snapshot.Revision, ct);
            var keepFiles = new HashSet<string> { file };
            if (manifest.Previous is { } p) keepFiles.Add(p.File);
            foreach (var f in Directory.EnumerateFiles(dir, "gen-*.json"))
                if (!keepFiles.Contains(Path.GetFileName(f))) File.Delete(f);
            journal.DeleteOtherSessions(new HashSet<string>(new[] { snapshot.SessionId, manifest.Previous?.SessionId }.OfType<string>()));
            return Result<DurableRevision>.Success(new DurableRevision(snapshot.SessionId, snapshot.Revision, sequence));
        }
        finally { gate.Release(); }
    }

    /// <summary>The newest readable checkpoint plus its session's contiguous journal tail, or null.</summary>
    public Task<RecoveryCandidate?> ReadRecoveryAsync(CancellationToken ct)
    {
        var report = new List<Diagnostic>();
        var manifest = ReadManifest();
        if (manifest is null) return Task.FromResult<RecoveryCandidate?>(null);
        var (snap, used) = (Load(manifest), manifest);
        if (snap is null && manifest.Previous is { } prev)
        {
            report.Add(new Diagnostic { Severity = "warning", Code = "checkpoint_fallback", Action = "approximated", Detail = $"checkpoint generation {manifest.Generation} unreadable; using generation {prev.Generation}" });
            (snap, used) = (Load(prev), prev);
        }
        if (snap is null) return Task.FromResult<RecoveryCandidate?>(null);
        var read = journal.Read(snap.SessionId);
        var tail = new List<CommittedEvent>();
        var head = snap.Revision;
        foreach (var r in read.Records.Where(r => r.Revision > snap.Revision && r.DocumentId == snap.DocumentId))
        {
            if (r.ResolvedDiff.PreviousRevision != head) { report.Add(Gap(head, r)); break; }
            tail.Add(r);
            head = r.Revision;
        }
        if (read.TornTail) report.Add(new Diagnostic { Severity = "info", Code = "torn_tail", Action = "dropped", Detail = $"incomplete final journal record ({read.DiscardedBytes} bytes) ignored" });
        if (read.CorruptAtOffset is { } off) report.Add(new Diagnostic { Severity = "error", Code = "journal_corrupt", Action = "dropped", Detail = $"journal corrupt at byte {off}; {read.DiscardedBytes} bytes after the last good record discarded" });
        journal.SetBase(snap.SessionId, head, tail.Count > 0 ? tail[^1].Sequence : used.Sequence);
        return Task.FromResult<RecoveryCandidate?>(new RecoveryCandidate(snap, tail, report));
    }

    /// <summary>Hashes referenced by retained checkpoints and journals (blob GC must keep them).</summary>
    public IReadOnlySet<string> ReferencedBlobs()
    {
        var set = new HashSet<string>(journal.ReferencedHashes());
        var m = ReadManifest();
        foreach (var g in new[] { m, m?.Previous }.OfType<Manifest>())
            if (Load(g) is { } s) foreach (var a in s.Document.Assets) set.Add(a.Sha256);
        return set;
    }

    private static Diagnostic Gap(long head, CommittedEvent r) => new()
    {
        Severity = "error", Code = "journal_gap", Action = "dropped", Detail = $"journal jumps from revision {head} to {r.ResolvedDiff.PreviousRevision}→{r.Revision}; later records discarded",
    };

    private Snapshot? Load(Manifest m)
    {
        var path = Path.Combine(dir, m.File);
        if (!File.Exists(path)) return null;
        var bytes = File.ReadAllBytes(path);
        if (Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != m.Sha256) return null;
        try { return JsonSerializer.Deserialize<Snapshot>(bytes, ContractJson.Options); }
        catch (JsonException) { return null; }
    }

    private Manifest? ReadManifest()
    {
        if (!File.Exists(ManifestPath)) return null;
        try { return JsonSerializer.Deserialize<Manifest>(File.ReadAllBytes(ManifestPath)); }
        catch (JsonException) { return null; }
    }

    private sealed record Manifest
    {
        [JsonPropertyName("formatVersion")] public int FormatVersion { get; init; } = 1;
        [JsonPropertyName("generation")] public long Generation { get; init; }
        [JsonPropertyName("file")] public string File { get; init; } = "";
        [JsonPropertyName("sha256")] public string Sha256 { get; init; } = "";
        [JsonPropertyName("documentId")] public string DocumentId { get; init; } = "";
        [JsonPropertyName("sessionId")] public string SessionId { get; init; } = "";
        [JsonPropertyName("revision")] public long Revision { get; init; }
        [JsonPropertyName("sequence")] public long Sequence { get; init; }
        [JsonPropertyName("previous")] public Manifest? Previous { get; init; }
    }
}
