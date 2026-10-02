using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;
using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

public sealed record DurableRevision(string SessionId, long Revision, long Sequence);

/// <summary>
/// Append-only per-session journal of resolved diffs (CommittedEvent) forwarded by the frontend
/// engine. Records are framed as [u32 length][sha256(payload)][payload] and flushed to disk
/// before acknowledgement. The host never replays commands: records carry resolved before/after
/// values, including created UUIDs, so replay is deterministic. A record is accepted only when
/// it extends the session's durable chain (checkpoint revision or previous record) and every
/// asset hash it introduces is already durable in the blob store.
/// </summary>
public sealed class RecoveryJournal(string root, BlobStore blobs)
{
    private const int HeaderBytes = 4 + 32;
    public const int MaxRecordBytes = 64 * 1024 * 1024;
    private readonly string dir = Path.GetFullPath(root);
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<string, (long Revision, long Sequence)> heads = new();

    public string PathFor(string sessionId)
    {
        if (!Guid.TryParse(sessionId, out var g) || g.ToString() != sessionId) throw HostException.Of("invalid_request", "session id must be a lowercase UUID");
        return Path.Combine(dir, $"journal-{sessionId}.log");
    }

    /// <summary>
    /// Sets the durable chain head for a session (after its checkpoint is published). Monotonic: a
    /// checkpoint of R published after R+1 was journalled never moves the head back.
    /// </summary>
    public void SetBase(string sessionId, long revision, long sequence)
    {
        gate.Wait();
        try { if (!heads.TryGetValue(sessionId, out var h) || h.Revision < revision) heads[sessionId] = (revision, sequence); }
        finally { gate.Release(); }
    }

    public long? LastDurableRevision(string sessionId)
    {
        gate.Wait();
        try { return heads.TryGetValue(sessionId, out var h) ? h.Revision : null; }
        finally { gate.Release(); }
    }

    public async Task<Result<DurableRevision>> AppendDurableAsync(CommittedEvent ev, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (!heads.TryGetValue(ev.SessionId, out var head))
                return Result<DurableRevision>.Fail("checkpoint_required", $"session {ev.SessionId} has no durable checkpoint");
            if (ev.ResolvedDiff.PreviousRevision != head.Revision || ev.Revision != ev.ResolvedDiff.Revision || ev.Sequence <= head.Sequence)
                return Result<DurableRevision>.Fail("checkpoint_required", $"journal gap: durable revision {head.Revision}, event {ev.ResolvedDiff.PreviousRevision}→{ev.Revision}");
            foreach (var sha in IntroducedHashes(ev))
                if (!SafeContains(sha)) return Result<DurableRevision>.Fail("io_error", $"blob {sha[..Math.Min(12, sha.Length)]}… is not durable; record not written", retryable: true);
            var payload = JsonSerializer.SerializeToUtf8Bytes(ev, ContractJson.Options);
            if (payload.Length > MaxRecordBytes) return Result<DurableRevision>.Fail("limit_exceeded", "journal record exceeds 64 MiB; checkpoint instead");
            var frame = new byte[HeaderBytes + payload.Length];
            BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
            SHA256.HashData(payload, frame.AsSpan(4, 32));
            payload.CopyTo(frame, HeaderBytes);
            Directory.CreateDirectory(dir);
            await using (var fs = new FileStream(PathFor(ev.SessionId), FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough))
            {
                await fs.WriteAsync(frame, ct);
                fs.Flush(flushToDisk: true);
            }
            heads[ev.SessionId] = (ev.Revision, ev.Sequence);
            return Result<DurableRevision>.Success(new DurableRevision(ev.SessionId, ev.Revision, ev.Sequence));
        }
        finally { gate.Release(); }
    }

    public sealed record ReadResult(List<CommittedEvent> Records, bool TornTail, long? CorruptAtOffset, long DiscardedBytes);

    /// <summary>
    /// Reads contiguous valid records. An incomplete or mismatching final record is a torn tail
    /// (a crash during append) and is ignored; a bad record followed by more bytes is middle
    /// corruption: reading stops there and the rest is reported as discarded.
    /// </summary>
    public ReadResult Read(string sessionId)
    {
        var path = PathFor(sessionId);
        var records = new List<CommittedEvent>();
        if (!File.Exists(path)) return new ReadResult(records, false, null, 0);
        var bytes = File.ReadAllBytes(path);
        var pos = 0;
        while (pos < bytes.Length)
        {
            var remaining = bytes.Length - pos;
            if (remaining < HeaderBytes) return new ReadResult(records, true, null, remaining);
            var len = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(pos));
            if (len > MaxRecordBytes) return Bad(records, pos, bytes.Length);
            if (remaining < HeaderBytes + len) return new ReadResult(records, true, null, remaining);
            var payload = bytes.AsSpan(pos + HeaderBytes, (int)len);
            if (!SHA256.HashData(payload).AsSpan().SequenceEqual(bytes.AsSpan(pos + 4, 32))) return Bad(records, pos, bytes.Length, pos + HeaderBytes + (int)len);
            CommittedEvent? ev;
            try { ev = JsonSerializer.Deserialize<CommittedEvent>(payload, ContractJson.Options); }
            catch (JsonException) { ev = null; }
            if (ev is null) return Bad(records, pos, bytes.Length, pos + HeaderBytes + (int)len);
            records.Add(ev);
            pos += HeaderBytes + (int)len;
        }
        return new ReadResult(records, false, null, 0);

        static ReadResult Bad(List<CommittedEvent> records, int at, int total, int recordEnd = -1) =>
            recordEnd == total ? new ReadResult(records, true, null, total - at) : new ReadResult(records, false, at, total - at);
    }

    /// <summary>Rewrites a session's journal keeping only records after <paramref name="revision"/> (the tail &gt; R).</summary>
    public async Task CompactAsync(string sessionId, long revision, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var path = PathFor(sessionId);
            if (!File.Exists(path)) return;
            var keep = Read(sessionId).Records.Where(r => r.Revision > revision).ToList();
            using var ms = new MemoryStream();
            var header = new byte[HeaderBytes];
            foreach (var r in keep)
            {
                var payload = JsonSerializer.SerializeToUtf8Bytes(r, ContractJson.Options);
                BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)payload.Length);
                SHA256.HashData(payload, header.AsSpan(4));
                ms.Write(header);
                ms.Write(payload);
            }
            await new AtomicFileWriter { KeepBackup = false }.WriteAsync(path, ms.ToArray(), ct);
        }
        finally { gate.Release(); }
    }

    /// <summary>Deletes journals for sessions not in <paramref name="keep"/>.</summary>
    public void DeleteOtherSessions(IReadOnlySet<string> keep)
    {
        if (!Directory.Exists(dir)) return;
        foreach (var f in Directory.EnumerateFiles(dir, "journal-*.log"))
        {
            var s = Path.GetFileNameWithoutExtension(f)["journal-".Length..];
            if (!keep.Contains(s)) File.Delete(f);
        }
    }

    /// <summary>Every hash a journal record references (before and after values), so undo/recovery keep blobs alive.</summary>
    public IEnumerable<string> ReferencedHashes()
    {
        if (!Directory.Exists(dir)) yield break;
        foreach (var f in Directory.EnumerateFiles(dir, "journal-*.log"))
            foreach (var r in Read(Path.GetFileNameWithoutExtension(f)["journal-".Length..]).Records)
                foreach (var c in r.ResolvedDiff.Changes.Where(c => c.Entity == "asset"))
                {
                    if (Sha(c.Before) is { } b) yield return b;
                    if (Sha(c.After) is { } a) yield return a;
                }
    }

    internal static IEnumerable<string> IntroducedHashes(CommittedEvent ev) =>
        ev.ResolvedDiff.Changes.Where(c => c.Entity == "asset").Select(c => Sha(c.After)).OfType<string>().Distinct();

    private static string? Sha(JsonElement e) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty("sha256", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;

    private bool SafeContains(string sha)
    {
        try { return blobs.Contains(sha); }
        catch (HostException) { return false; }
    }
}
