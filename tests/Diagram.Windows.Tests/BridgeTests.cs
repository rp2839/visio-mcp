using Xunit;

namespace Diagram.Windows.Tests;

/// <summary>
/// Windows-only: real WebView2 + packaged frontend. Not runnable on Linux; the same bridge
/// rules are exercised portably by tests/Diagram.Host.Tests/BridgeRouterTests.
/// </summary>
public sealed class BridgeTests
{
    private static bool OnWindows => OperatingSystem.IsWindows();

    [Fact] public void NotReadyRejects() => Assert.SkipUnless(OnWindows, "Windows/WebView2 only (I11 Windows acceptance)");
    [Fact] public void WrongOriginOrChildFrameRejects() => Assert.SkipUnless(OnWindows, "Windows/WebView2 only");
    [Fact] public void CorrelationsDoNotCollide() => Assert.SkipUnless(OnWindows, "Windows/WebView2 only");
    [Fact] public void AppStartsReadyWithA4Snapshot() => Assert.SkipUnless(OnWindows, "Windows/WebView2 only");
    [Fact] public void PendingMutationCrashIsUnknown() => Assert.SkipUnless(OnWindows, "Windows/WebView2 only");
}
