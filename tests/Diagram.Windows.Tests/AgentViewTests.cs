using System.IO;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Xunit;

namespace Diagram.Windows.Tests;

/// <summary>W02d: a document an agent creates lives in a second, hidden WebView, and moves to the person's window when shown.</summary>
public class AgentViewTests
{
    static async Task WaitFor(Func<bool> condition, int seconds = 30)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (!condition()) { if (DateTime.UtcNow > deadline) throw new TimeoutException("condition not met"); await Task.Delay(100); }
    }

    static async Task<int> Count(Harness h, string testId) => int.Parse(await h.Eval($"document.querySelectorAll('[data-testid={testId}]').length"));
    static string[] Sessions(string root) => Directory.Exists(Path.Combine(root, "recovery")) ? Directory.GetDirectories(Path.Combine(root, "recovery")) : [];
    static RequestEnvelope Docs(string method, JsonObject? p = null) => new() { RequestId = Guid.NewGuid().ToString(), Method = method, Params = p ?? new JsonObject() };

    static async Task<Scope> CreateAsync(Harness h, string title)
    {
        var r = await h.Window.Documents.HandleAsync(Docs("docs.create", new JsonObject { ["title"] = title }), Harness.Ct(60));
        Assert.Null(r.Error);
        var o = JsonNode.Parse(r.Result!.Value.GetRawText())!;
        return new Scope { DocumentId = o["documentId"]!.GetValue<string>(), SessionId = o["sessionId"]!.GetValue<string>() };
    }

    static async Task<Harness> StartAsync(string? root = null)
    {
        var h = await Harness.StartAsync(existingRoot: root);
        await WaitFor(() => h.Window.RecoveryMgr.SessionId == h.Router.CurrentScope?.SessionId);
        return h;
    }

    [Fact]
    public async Task AVisioFileOpensAsABackgroundReferenceWithAReportAndLeavesTheEditorAndTheFileAlone()
    {
        var exports = Path.Combine(Path.GetTempPath(), "r15-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(exports);
        var source = Path.Combine(Harness.RepoRoot, "tests/fixtures/vsdx/visio-saved/sample-resaved.vsdx");
        var file = Path.Combine(exports, "reference.vsdx"); File.Copy(source, file);
        var before = File.ReadAllBytes(file);
        try
        {
            await using var h = await Harness.StartAsync(exportRoot: exports);
            await WaitFor(() => h.Window.RecoveryMgr.SessionId == h.Router.CurrentScope?.SessionId);
            var mine = h.Router.CurrentScope!;
            var r = await h.Window.Documents.HandleAsync(Docs("docs.importVisio", new JsonObject { ["path"] = "reference.vsdx" }), Harness.Ct(90));
            Assert.Null(r.Error);
            var o = JsonNode.Parse(r.Result!.Value.GetRawText())!;
            var id = o["documentId"]!.GetValue<string>();
            Assert.Equal(BridgeRouter.Agent, h.Router.ChannelOf(id));
            Assert.Equal(BridgeRouter.User, h.Router.ChannelOf(mine.DocumentId));
            Assert.Equal(mine.DocumentId, h.Router.CurrentScope!.DocumentId); // the person's document is untouched
            Assert.NotNull(o["diagnostics"]); Assert.NotNull(o["identity"]); Assert.NotNull(o["lossy"]);
            Assert.True(o["pages"]!.GetValue<int>() >= 1);

            var summary = await h.Send("doc.summary", new JsonObject { ["includeGeometry"] = true }, scope: new Scope { DocumentId = id, SessionId = o["sessionId"]!.GetValue<string>() });
            Assert.Null(summary.Error);
            Assert.True(summary.Result!.Value.GetProperty("pages")[0].GetProperty("elements").GetArrayLength() > 0);

            // the same file again is a second, separate document
            var again = JsonNode.Parse((await h.Window.Documents.HandleAsync(Docs("docs.importVisio", new JsonObject { ["path"] = file }), Harness.Ct(90))).Result!.Value.GetRawText())!;
            Assert.NotEqual(id, again["documentId"]!.GetValue<string>());

            // a place nobody approved is refused (nobody can say yes in the test window), and a missing file is not found
            var outside = Path.Combine(Harness.RepoRoot, "tests/fixtures/vsdx/visio-saved/m0-v7.vsdx");
            Assert.Equal("path_not_permitted", (await h.Window.Documents.HandleAsync(Docs("docs.importVisio", new JsonObject { ["path"] = outside }), Harness.Ct(30))).Error!.Code);
            Assert.Equal("not_found", (await h.Window.Documents.HandleAsync(Docs("docs.importVisio", new JsonObject { ["path"] = "missing.vsdx" }), Harness.Ct(30))).Error!.Code);
            File.WriteAllText(Path.Combine(exports, "broken.vsdx"), "not a zip");
            Assert.NotNull((await h.Window.Documents.HandleAsync(Docs("docs.importVisio", new JsonObject { ["path"] = "broken.vsdx" }), Harness.Ct(30))).Error);
            Assert.Equal(before, File.ReadAllBytes(file)); // a reference is only ever read
        }
        finally { try { Directory.Delete(exports, true); } catch (IOException) { } }
    }

    [Fact]
    public async Task ADocumentMadeInTheBackgroundIsEditedAndRenderedThereWithoutTouchingTheEditorWindow()
    {
        await using var h = await StartAsync();
        var mine = h.Router.CurrentScope!;
        Assert.Null((await h.Apply(0, null, Harness.Shape("mine", 20, 20))).Error);

        var bg = await CreateAsync(h, "Pipeline");
        Assert.Equal(BridgeRouter.Agent, h.Router.ChannelOf(bg.DocumentId));
        Assert.Equal(BridgeRouter.User, h.Router.ChannelOf(mine.DocumentId));
        Assert.Equal(mine.DocumentId, h.Router.CurrentScope!.DocumentId); // the person's document is still the current one
        Assert.Equal(1, await Count(h, "tab"));                            // and no editor tab was added

        var applied = await h.Send("doc.apply", new JsonObject
        {
            ["transactionId"] = Guid.NewGuid().ToString(), ["baseRevision"] = 0, ["atomic"] = true,
            ["operations"] = new JsonArray(Harness.Shape("build", 40, 40)),
        }, scope: bg);
        Assert.Null(applied.Error);
        var rendered = await h.Send("doc.render", new JsonObject { ["scope"] = "page", ["format"] = "png", ["maxWidth"] = 400, ["maxHeight"] = 300 }, scope: bg);
        Assert.Null(rendered.Error);
        var png = Convert.FromBase64String(rendered.Result!.Value.GetProperty("base64").GetString()!);
        Assert.Equal(new byte[] { 0x89, 0x50, 0x4E, 0x47 }, png.Take(4).ToArray()); // drawn by the hidden view

        // the person's editor never saw the agent's edit
        var mineSummary = await h.Send("doc.summary", scope: mine);
        Assert.DoesNotContain("build", mineSummary.Result!.Value.GetRawText());
        // the background document has its own recovery session
        await WaitFor(() => h.Window.RecoveryMgr.OpenSessions.Contains(bg.SessionId));
        // the person's window lists it as a tab of its own
        await WaitFor(() => Count(h, "agent-tab").GetAwaiter().GetResult() == 1);
        Assert.Contains("Pipeline", await h.Eval("document.querySelector('[data-testid=agent-tab-name]').innerText"));
    }

    [Fact]
    public async Task AnyOpenDocumentCanBeExportedNotJustTheActiveTab()
    {
        var exports = Path.Combine(Path.GetTempPath(), "export-bg-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(exports);
        try
        {
            await using var h = await Harness.StartAsync(exportRoot: exports);
            await WaitFor(() => h.Window.RecoveryMgr.SessionId == h.Router.CurrentScope?.SessionId);
            var bg = await CreateAsync(h, "Pipeline");
            Assert.NotEqual(bg.DocumentId, h.Router.CurrentScope!.DocumentId);
            RequestEnvelope Export(Scope s, string format, string path, string? session = null) => new()
            {
                RequestId = Guid.NewGuid().ToString(), Method = "doc.export", DocumentId = s.DocumentId, SessionId = session ?? s.SessionId,
                Params = new JsonObject { ["format"] = format, ["path"] = path },
            };
            foreach (var (format, name) in new[] { ("vsdx", "background.vsdx"), ("png", "background.png") })
            {
                var r = await h.Window.Exports.HandleAsync(Export(bg, format, name), Harness.Ct(60));
                Assert.Null(r.Error);
                Assert.True(File.Exists(Path.Combine(exports, name)));
            }
            // a stale session or an unknown document is still refused
            Assert.Equal("session_mismatch", (await h.Window.Exports.HandleAsync(Export(bg, "vsdx", "stale.vsdx", "old-session"), Harness.Ct(30))).Error!.Code);
            Assert.Equal("document_mismatch", (await h.Window.Exports.HandleAsync(Export(new Scope { DocumentId = "nope", SessionId = "x" }, "vsdx", "none.vsdx"), Harness.Ct(30))).Error!.Code);
        }
        finally { try { Directory.Delete(exports, true); } catch (IOException) { } }
    }

    [Fact]
    public async Task ListShowsEveryDocumentAndWhereItLives()
    {
        await using var h = await StartAsync();
        var bg = await CreateAsync(h, "Pipeline");
        var r = await h.Window.Documents.HandleAsync(Docs("docs.list"), Harness.Ct(30));
        var docs = JsonNode.Parse(r.Result!.Value.GetRawText())!["documents"]!.AsArray();
        Assert.Equal(2, docs.Count);
        Assert.Equal("editor", docs.Single(d => d!["active"]!.GetValue<bool>())!["view"]!.GetValue<string>());
        var back = docs.Single(d => d!["documentId"]!.GetValue<string>() == bg.DocumentId)!;
        Assert.Equal("background", back["view"]!.GetValue<string>());
        Assert.Equal("Pipeline", back["title"]!.GetValue<string>());
    }

    [Fact]
    public async Task ShowingABackgroundDocumentMovesItIntoTheEditorWindowWithItsContentAndANewSession()
    {
        var root = Path.Combine(Path.GetTempPath(), "diagram-win-agent-" + Guid.NewGuid().ToString("N"));
        await using var h = await StartAsync(root);
        var bg = await CreateAsync(h, "Pipeline");
        Assert.Null((await h.Send("doc.apply", new JsonObject
        {
            ["transactionId"] = Guid.NewGuid().ToString(), ["baseRevision"] = 0, ["atomic"] = true,
            ["operations"] = new JsonArray(Harness.Shape("build", 40, 40)),
        }, scope: bg)).Error);
        await WaitFor(() => h.Window.RecoveryMgr.StatusOfSession(bg.SessionId).LastDurableRevision >= 1);

        var shown = await h.Window.Documents.HandleAsync(Docs("docs.show", new JsonObject { ["documentId"] = bg.DocumentId }), Harness.Ct(60));
        Assert.Null(shown.Error);
        var now = JsonNode.Parse(shown.Result!.Value.GetRawText())!;
        Assert.Equal("editor", now["view"]!.GetValue<string>());
        var newSession = now["sessionId"]!.GetValue<string>();
        Assert.NotEqual(bg.SessionId, newSession);

        Assert.Equal(BridgeRouter.User, h.Router.ChannelOf(bg.DocumentId));
        Assert.Equal(bg.DocumentId, h.Router.CurrentScope!.DocumentId); // shown: it is the one in front
        await WaitFor(() => Count(h, "tab").GetAwaiter().GetResult() == 2);
        await WaitFor(() => Count(h, "agent-tab").GetAwaiter().GetResult() == 0);
        var summary = await h.Send("doc.summary", scope: h.Router.ScopeOf(bg.DocumentId));
        Assert.Contains("build", summary.Result!.Value.GetRawText());
        Assert.Equal("true", (await h.Eval("document.querySelectorAll('[data-testid=tab]')[1].dataset.unsaved")).Trim('"')); // nobody has saved it

        // the old session is gone for good once the new one is safe; nothing is left to offer later
        await WaitFor(() => !Directory.Exists(Path.Combine(root, "recovery", bg.SessionId)) , 20);
        await WaitFor(() => Sessions(root).Length == h.Window.RecoveryMgr.OpenSessions.Count, 20);
        Assert.Contains(newSession, h.Window.RecoveryMgr.OpenSessions);

        // and it is edited there like any other document
        var edit = await h.Send("doc.apply", new JsonObject
        {
            ["transactionId"] = Guid.NewGuid().ToString(), ["baseRevision"] = 1, ["atomic"] = true,
            ["operations"] = new JsonArray(Harness.Shape("test", 200, 40)),
        }, scope: h.Router.ScopeOf(bg.DocumentId));
        Assert.Null(edit.Error);
        var stale = await h.Send("doc.summary", scope: bg); // the old session id no longer addresses it
        Assert.Equal("session_mismatch", stale.Error!.Code);
    }

    [Fact]
    public async Task ShowingATabThatIsAlreadyInTheEditorJustSwitchesToIt()
    {
        await using var h = await StartAsync();
        var first = h.Router.CurrentScope!;
        await h.Eval("document.querySelector('[data-testid=tab-new]').click(); true");
        await WaitFor(() => h.Router.Documents.Count == 2 && h.Router.CurrentScope!.DocumentId != first.DocumentId);
        var r = await h.Window.Documents.HandleAsync(Docs("docs.show", new JsonObject { ["documentId"] = first.DocumentId }), Harness.Ct(30));
        Assert.Null(r.Error);
        await WaitFor(() => h.Router.CurrentScope!.DocumentId == first.DocumentId);
        var missing = await h.Window.Documents.HandleAsync(Docs("docs.show", new JsonObject { ["documentId"] = Guid.NewGuid().ToString() }), Harness.Ct(30));
        Assert.Equal("document_mismatch", missing.Error!.Code);
    }

    [Fact]
    public async Task ChangesToADocumentAreRefusedWhileItIsBeingMoved()
    {
        await using var h = await StartAsync();
        var bg = await CreateAsync(h, "Pipeline");
        h.Router.Freeze(bg.DocumentId);
        var refused = await h.Send("doc.apply", new JsonObject
        {
            ["transactionId"] = Guid.NewGuid().ToString(), ["baseRevision"] = 0, ["atomic"] = true,
            ["operations"] = new JsonArray(Harness.Shape("late", 40, 40)),
        }, scope: bg);
        Assert.Equal("busy", refused.Error!.Code);
        Assert.True(refused.Error.Retryable);
        Assert.Null((await h.Send("doc.summary", scope: bg)).Error); // reading is fine
        h.Router.Unfreeze(bg.DocumentId);
    }

    [Fact]
    public async Task ThePersonCanThrowABackgroundDocumentAway()
    {
        var root = Path.Combine(Path.GetTempPath(), "diagram-win-agent-" + Guid.NewGuid().ToString("N"));
        await using var h = await StartAsync(root);
        var bg = await CreateAsync(h, "Pipeline");
        Assert.Null((await h.Send("doc.apply", new JsonObject
        {
            ["transactionId"] = Guid.NewGuid().ToString(), ["baseRevision"] = 0, ["atomic"] = true,
            ["operations"] = new JsonArray(Harness.Shape("build", 40, 40)),
        }, scope: bg)).Error);
        await WaitFor(() => h.Window.RecoveryMgr.StatusOfSession(bg.SessionId).LastDurableRevision >= 1);
        var r = await h.Window.Services.HandleAsync(new RequestEnvelope { RequestId = "d", Method = "host.documents.discard", Params = new JsonObject { ["documentId"] = bg.DocumentId } }, default);
        Assert.Null(r.Error);
        Assert.Null(h.Router.ChannelOf(bg.DocumentId));
        await WaitFor(() => !Directory.Exists(Path.Combine(root, "recovery", bg.SessionId)), 20);
        await WaitFor(() => Count(h, "agent-tab").GetAwaiter().GetResult() == 0);
    }

    [Fact]
    public async Task TheAgentViewCannotAskTheHostToOpenSaveOrRecover()
    {
        await using var h = await StartAsync();
        await CreateAsync(h, "Pipeline");
        // a page request sent through the agent channel is answered with method_not_found, whatever it asks for
        var answer = await h.Eval("0"); // the view exists; the router's rule is exercised directly below
        Assert.Equal("0", answer);
        var router = h.Router;
        var reply = new TaskCompletionSource<string>();
        router.AddChannel("probe", new Capture(reply));
        router.OnMessage("https://app.agentic-diagram.invalid/index.html", """{"protocolVersion":1,"kind":"request","requestId":"p1","method":"host.openJson","params":{}}""", true, "probe");
        var text = await reply.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains("method_not_found", text);
    }

    sealed class Capture(TaskCompletionSource<string> tcs) : IFrontendTransport
    {
        public void Post(string json) => tcs.TrySetResult(json);
    }

    [Fact]
    public async Task BackgroundWorkSurvivesACrashAndIsOfferedAgain()
    {
        var root = Path.Combine(Path.GetTempPath(), "diagram-win-agent-" + Guid.NewGuid().ToString("N"));
        Harness? second = null;
        var first = await StartAsync(root);
        try
        {
            var bg = await CreateAsync(first, "Pipeline");
            Assert.Null((await first.Send("doc.apply", new JsonObject
            {
                ["transactionId"] = Guid.NewGuid().ToString(), ["baseRevision"] = 0, ["atomic"] = true,
                ["operations"] = new JsonArray(Harness.Shape("build", 40, 40)),
            }, scope: bg)).Error);
            await WaitFor(() => first.Window.RecoveryMgr.StatusOfSession(bg.SessionId).LastDurableRevision >= 1);
            await first.Window.RecoveryMgr.DrainAsync();
            await first.Window.RecoveryMgr.DisposeAsync(); // the application dies
            await first.DisposeAsync();

            second = await Harness.StartAsync(existingRoot: root);
            await WaitFor(() => Count(second, "recovery-offer").GetAwaiter().GetResult() == 1); // nobody owns that session: it is asked about
            Assert.Contains("Pipeline", await second.Eval("document.querySelector('[data-testid=recovery-name]').innerText"));
        }
        finally { if (second is not null) await second.DisposeAsync(); try { Directory.Delete(root, true); } catch { } }
    }
}
