using System.Text.Json;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Host.Tests;

public sealed class RecoveryTests : IDisposable
{
    private readonly TempDir tmp = new();
    private readonly BlobStore blobs;
    private readonly RecoveryJournal journal;
    private readonly CheckpointStore checkpoints;
    private readonly string session = Guid.NewGuid().ToString();
    private string pngSha = "";

    public RecoveryTests()
    {
        blobs = new BlobStore(tmp.File("blobs"));
        journal = new RecoveryJournal(tmp.File("recovery"), blobs);
        checkpoints = new CheckpointStore(tmp.File("recovery"), blobs, journal);
    }

    public void Dispose() => tmp.Dispose();

    private async Task<Snapshot> BaseAsync(long revision = 3, string? sessionId = null)
    {
        pngSha = await blobs.PutDurableAsync(Png.Create(4, 4), CancellationToken.None);
        var doc = Docs.WithImage(pngSha) with { Revision = revision };
        return new Snapshot { DocumentId = doc.Id, SessionId = sessionId ?? session, Revision = revision, Document = doc };
    }

    private static JsonElement J(object? o) => JsonSerializer.SerializeToElement(o, ContractJson.Options);

    private CommittedEvent Ev(long seq, long rev, params EntityChange[] changes) => Ev(session, seq, rev, changes);

    private static CommittedEvent Ev(string sessionId, long seq, long rev, params EntityChange[] changes) => new()
    {
        Sequence = seq, DocumentId = Docs.DocId, SessionId = sessionId, Revision = rev,
        ResolvedDiff = new ResolvedDiff { Source = "mcp", TransactionId = Guid.NewGuid().ToString(), PreviousRevision = rev - 1, Revision = rev, Changes = [.. changes] },
    };

    private static EntityChange Move(double fromX, double toX) => new()
    {
        Entity = "element", Id = Docs.ShapeId, PageId = Docs.PageId,
        Before = J(new { id = Docs.ShapeId, kind = "shape", bounds = new { x = fromX } }), After = J(new { id = Docs.ShapeId, kind = "shape", bounds = new { x = toX } }),
    };

    private static EntityChange Created(string id) => new() { Entity = "element", Id = id, PageId = Docs.PageId, Before = J(null), After = J(new { id, kind = "shape" }) };

    private static EntityChange AssetChange(string? before, string? after) => new()
    {
        Entity = "asset", Id = "asset:logo",
        Before = J(before is null ? null : new { id = "asset:logo", sha256 = before }), After = J(after is null ? null : new { id = "asset:logo", sha256 = after }),
    };

    private async Task<RecoveryCandidate> RecoverAsync()
    {
        // A fresh process: new journal/checkpoint objects over the same directory.
        var j = new RecoveryJournal(tmp.File("recovery"), blobs);
        return (await new CheckpointStore(tmp.File("recovery"), blobs, j).ReadRecoveryAsync(CancellationToken.None))!;
    }

    [Fact]
    public async Task UndoReplayExact()
    {
        Assert.True((await checkpoints.PublishAsync(await BaseAsync(), 0, CancellationToken.None)).Ok);
        var events = new[] { Ev(1, 4, Move(200, 260)), Ev(2, 5, Move(260, 300)), Ev(3, 6, Move(300, 260)) }; // last = undo as a new revision
        DurableRevision? last = null;
        foreach (var e in events) last = (await journal.AppendDurableAsync(e, CancellationToken.None)).Value;
        var lastDurableRevision = last!.Revision;
        var recovery = await RecoverAsync();
        Assert.Equal(lastDurableRevision, recovery.Revision);
        Assert.Equal(events.Select(e => JsonSerializer.Serialize(e, ContractJson.Options)), recovery.Tail.Select(e => JsonSerializer.Serialize(e, ContractJson.Options)));
        Assert.Empty(recovery.Report);
    }

    [Fact]
    public async Task GeneratedIdReplayExact()
    {
        await checkpoints.PublishAsync(await BaseAsync(), 0, CancellationToken.None);
        var originalCreatedUuid = Guid.NewGuid().ToString();
        await journal.AppendDurableAsync(Ev(1, 4, Created(originalCreatedUuid)), CancellationToken.None);
        var recovery = await RecoverAsync();
        var createdId = recovery.Tail.Single().ResolvedDiff.Changes.Single(c => c.Before.ValueKind == JsonValueKind.Null).Id;
        Assert.Equal(originalCreatedUuid, createdId);
        Assert.Equal(originalCreatedUuid, recovery.Tail.Single().ResolvedDiff.Changes[0].After.GetProperty("id").GetString());
    }

    [Fact]
    public async Task BlobBeforeRecord()
    {
        await checkpoints.PublishAsync(await BaseAsync(), 0, CancellationToken.None);
        var bytes = Png.Create(9, 9);
        var sha = BlobStore.Sha256(bytes);
        var r = await journal.AppendDurableAsync(Ev(1, 4, AssetChange(null, sha)), CancellationToken.None);
        Assert.Equal("io_error", r.Error!.Code);
        Assert.False(File.Exists(journal.PathFor(session)));
        await blobs.PutDurableAsync(bytes, CancellationToken.None);
        Assert.True((await journal.AppendDurableAsync(Ev(1, 4, AssetChange(null, sha)), CancellationToken.None)).Ok);
    }

    [Theory]
    [InlineData("after-generation", 3L)]
    [InlineData("after-manifest", 5L)]
    public async Task CrashBeforeAfterManifest(string fault, long expectedBase)
    {
        await checkpoints.PublishAsync(await BaseAsync(), 0, CancellationToken.None);
        await journal.AppendDurableAsync(Ev(1, 4, Move(200, 210)), CancellationToken.None);
        await journal.AppendDurableAsync(Ev(2, 5, Move(210, 220)), CancellationToken.None);
        await journal.AppendDurableAsync(Ev(3, 6, Move(220, 230)), CancellationToken.None);
        checkpoints.FaultPoint = p => { if (p == fault) throw new IOException("power loss"); };
        var at5 = await BaseAsync(5);
        await Assert.ThrowsAsync<IOException>(() => checkpoints.PublishAsync(at5, 2, CancellationToken.None));
        var recovery = await RecoverAsync();
        Assert.Equal(expectedBase, recovery.Base.Revision);
        Assert.Equal(6, recovery.Revision); // nothing durable is lost either way
        Assert.Contains(6L, recovery.ReplayedRevisions);
    }

    [Fact]
    public async Task CheckpointDoesNotLoseTailRPlus1()
    {
        await checkpoints.PublishAsync(await BaseAsync(), 0, CancellationToken.None);
        await journal.AppendDurableAsync(Ev(1, 4, Move(200, 210)), CancellationToken.None);
        var snapshotAtR = await BaseAsync(4);
        var revisionRPlus1 = 5L;
        await journal.AppendDurableAsync(Ev(2, revisionRPlus1, Move(210, 220)), CancellationToken.None); // committed while the checkpoint is being written
        Assert.True((await checkpoints.PublishAsync(snapshotAtR, 1, CancellationToken.None)).Ok);
        Assert.True((await journal.AppendDurableAsync(Ev(3, 6, Move(220, 230)), CancellationToken.None)).Ok); // head not regressed
        var recovery = await RecoverAsync();
        Assert.Equal(4, recovery.Base.Revision);
        Assert.Contains(revisionRPlus1, recovery.ReplayedRevisions);
        Assert.Equal(6, recovery.Revision);
    }

    [Fact]
    public async Task TornTailVsMiddleCorruption()
    {
        await checkpoints.PublishAsync(await BaseAsync(), 0, CancellationToken.None);
        for (var i = 1; i <= 3; i++) await journal.AppendDurableAsync(Ev(i, 3 + i, Move(200 + i, 201 + i)), CancellationToken.None);
        var path = journal.PathFor(session);
        var good = await File.ReadAllBytesAsync(path);

        await File.WriteAllBytesAsync(path, good[..^7]); // crash mid-append
        var torn = await RecoverAsync();
        Assert.Equal(5, torn.Revision);
        Assert.Contains(torn.Report, d => d.Code == "torn_tail" && d.Severity == "info");
        Assert.DoesNotContain(torn.Report, d => d.Severity == "error");

        var corrupt = (byte[])good.Clone();
        var second = JsonSerializer.SerializeToUtf8Bytes(Ev(1, 4, Move(201, 202)), ContractJson.Options).Length + 36 + 40; // inside record 2
        corrupt[second] ^= 0xFF;
        await File.WriteAllBytesAsync(path, corrupt);
        var mid = await RecoverAsync();
        Assert.Equal(4, mid.Revision);
        Assert.Contains(mid.Report, d => d.Code == "journal_corrupt" && d.Severity == "error");
        Assert.True(mid.Lossy);
    }

    [Fact]
    public async Task NewSessionStartsOwnCheckpoint()
    {
        await checkpoints.PublishAsync(await BaseAsync(), 0, CancellationToken.None);
        await journal.AppendDurableAsync(Ev(1, 4, Move(200, 210)), CancellationToken.None);
        var newSession = Guid.NewGuid().ToString();
        var refused = await journal.AppendDurableAsync(Ev(newSession, 2, 1, Move(1, 2)), CancellationToken.None);
        Assert.Equal("checkpoint_required", refused.Error!.Code);
        Assert.True((await checkpoints.PublishAsync(await BaseAsync(0, newSession), 2, CancellationToken.None)).Ok);
        Assert.True((await journal.AppendDurableAsync(Ev(newSession, 3, 1, Move(1, 2)), CancellationToken.None)).Ok);
        var recovery = await RecoverAsync();
        Assert.Equal((newSession, 1L), (recovery.Base.SessionId, recovery.Revision));
        Assert.True(File.Exists(journal.PathFor(session))); // previous generation's session journal retained
        // A gap within the session also requires a checkpoint.
        Assert.Equal("checkpoint_required", (await journal.AppendDurableAsync(Ev(newSession, 4, 5, Move(2, 3)), CancellationToken.None)).Error!.Code);
    }

    [Fact]
    public async Task UndoAndRecoveryPreventBlobGc()
    {
        await checkpoints.PublishAsync(await BaseAsync(), 0, CancellationToken.None);
        var b = await blobs.PutDurableAsync(Png.Create(5, 5), CancellationToken.None);
        var orphan = await blobs.PutDurableAsync(Png.Create(6, 6), CancellationToken.None);
        await journal.AppendDurableAsync(Ev(1, 4, AssetChange(pngSha, b)), CancellationToken.None); // logo replaced; undo needs the old bytes
        var removed = blobs.CollectGarbage(checkpoints.ReferencedBlobs());
        Assert.Equal(1, removed);
        Assert.True(blobs.Contains(pngSha));
        Assert.True(blobs.Contains(b));
        Assert.False(blobs.Contains(orphan));
    }
}
