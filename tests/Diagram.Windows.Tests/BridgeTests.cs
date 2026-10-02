using Xunit;

namespace Diagram.Windows.Tests;

/// <summary>
/// Windows-only: real WebView2 + packaged frontend. Not runnable on Linux; the same bridge
/// rules are exercised portably by tests/Diagram.Host.Tests/BridgeRouterTests.
/// </summary>
public sealed class BridgeTests
{
    // Always skipped: no automated Windows/WebView2 harness exists yet, so an empty body must never
    // report a pass. Each case is a manual acceptance item until it is implemented.
    private const string NotRun = "NOT RUN: needs an interactive Windows desktop with WebView2; no automated harness yet";

    [Fact] public void NotReadyRejects() => Assert.Skip(NotRun);
    [Fact] public void WrongOriginOrChildFrameRejects() => Assert.Skip(NotRun);
    [Fact] public void CorrelationsDoNotCollide() => Assert.Skip(NotRun);
    [Fact] public void AppStartsReadyWithA4Snapshot() => Assert.Skip(NotRun);
    [Fact] public void PendingMutationCrashIsUnknown() => Assert.Skip(NotRun);
}
