using Xunit;

namespace Diagram.Windows.Tests;

/// <summary>
/// Windows-only: a real stdio MCP client → Diagram.Mcp shim → per-user pipe → Diagram.App →
/// WebView2 frontend. NOT RUN on Linux; the same paths are covered portably by
/// tests/Diagram.Mcp.Tests (shim ↔ pipe), tests/Diagram.Ipc.Tests and src/web admission tests.
/// </summary>
public sealed class LiveControlTests
{
    private static bool OnWindows => OperatingSystem.IsWindows();

    [Fact] public void ReconnectAfterLostCommittedReplyReturnsIdenticalResult() => Assert.SkipUnless(OnWindows, "Windows live control only");
    [Fact] public void StaleHumanRevisionRemainsUntouched() => Assert.SkipUnless(OnWindows, "Windows live control only");
    [Fact] public void ChangedPayloadConflicts() => Assert.SkipUnless(OnWindows, "Windows live control only");
    [Fact] public void ScriptCreateDuplicatesOnce() => Assert.SkipUnless(OnWindows, "Windows live control only");
    [Fact] public void ReadsShowCurrentCanonicalStore() => Assert.SkipUnless(OnWindows, "Windows live control only");
    [Fact] public void SecondUserIsRefused() => Assert.SkipUnless(OnWindows, "Windows pipe ACLs only");
}
