using Xunit;

namespace Diagram.Windows.Tests;

/// <summary>
/// Windows-only crash recovery with a real renderer and host process. Portable coverage of the same
/// rules: tests/Diagram.Host.Tests/RecoveryTests (journal, checkpoints, torn tail, blob GC) and
/// src/web/tests/recovery.test.ts (forwarding, validated replay).
/// </summary>
public sealed class CrashRecoveryTests
{
    private const string NotRun = "NOT RUN: needs an interactive Windows desktop with WebView2; no automated harness yet";

    [Fact] public void KillRendererMidSessionRestoresLastDurableRevision() => Assert.Skip(NotRun);
    [Fact] public void KillHostMidSessionRestoresAndReportsLoss() => Assert.Skip(NotRun);
    [Fact] public void OldAgentSessionIsRejectedAfterRecovery() => Assert.Skip(NotRun);
    [Fact] public void AgentRereadsAndContinuesAfterRecovery() => Assert.Skip(NotRun);
}
