using Xunit;

namespace Diagram.Windows.Tests;

/// <summary>
/// Windows-only: a real stdio MCP client → Diagram.Mcp shim → per-user pipe → Diagram.App →
/// WebView2 frontend. NOT RUN on Linux; the same paths are covered portably by
/// tests/Diagram.Mcp.Tests (shim ↔ pipe), tests/Diagram.Ipc.Tests and src/web admission tests.
/// </summary>
public sealed class LiveControlTests
{
    // Always skipped: no automated Windows/WebView2 harness exists yet, so an empty body must never
    // report a pass. Each case is a manual acceptance item until it is implemented.
    private const string NotRun = "NOT RUN: needs an interactive Windows desktop with WebView2; no automated harness yet";

    [Fact] public void ReconnectAfterLostCommittedReplyReturnsIdenticalResult() => Assert.Skip(NotRun);
    [Fact] public void StaleHumanRevisionRemainsUntouched() => Assert.Skip(NotRun);
    [Fact] public void ChangedPayloadConflicts() => Assert.Skip(NotRun);
    [Fact] public void ScriptCreateDuplicatesOnce() => Assert.Skip(NotRun);
    [Fact] public void ReadsShowCurrentCanonicalStore() => Assert.Skip(NotRun);
    [Fact] public void SecondUserIsRefused() => Assert.Skip(NotRun);
}
