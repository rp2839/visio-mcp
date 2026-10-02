using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace Diagram.App;

/// <summary>
/// WPF shell: WebView2 lifecycle, dialogs and approved IO. All CoreWebView2 access happens on
/// the dispatcher; host code never blocks the dispatcher waiting for a frontend reply.
/// The only editable document lives in the frontend engine.
/// </summary>
public partial class MainWindow : Window, IWebMessageChannel
{
    private readonly string dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgenticDiagram");
    private BridgeRouter? bridge;
    private SessionCoordinator? sessions;
    private VsdxCoordinator? vsdx;
    private AssetPreparer? preparer;
    private AssetLibrary? library;
    private RecoveryJournal? journal;
    private CheckpointStore? checkpoints;
    private bool recoveryOffered;
    private string? currentPath;
    private HostRequestHandler? hostRequests;
    private readonly CancellationTokenSource shutdown = new();

    public event Action<WebMessage>? MessageReceived;
    public event Action? ProcessFailed;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await InitAsync();
    }

    private async Task InitAsync()
    {
        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(dataRoot, "webview"));
        await View.EnsureCoreWebView2Async(env);
        var core = View.CoreWebView2;
        core.SetVirtualHostNameToFolderMapping(BridgeRouter.Origin.Host, Path.Combine(AppContext.BaseDirectory, "frontend"), CoreWebView2HostResourceAccessKind.DenyCors);
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = true;
        core.Settings.AreDefaultContextMenusEnabled = false;
#if !DEBUG
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.NavigationStarting += (_, e) => { if (!BridgeRouter.IsTrustedSource(e.Uri, true)) e.Cancel = true; };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.WebResourceRequested += (_, e) => e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
        core.AddWebResourceRequestedFilter("http://*", CoreWebView2WebResourceContext.All);
        core.WebMessageReceived += (_, e) => MessageReceived?.Invoke(new WebMessage(e.Source, true, e.WebMessageAsJson));
        core.FrameCreated += (_, f) => f.Frame.WebMessageReceived += (_, e) => MessageReceived?.Invoke(new WebMessage(e.Source, false, e.WebMessageAsJson));
        core.ProcessFailed += (_, _) => ProcessFailed?.Invoke();

        var blobs = new BlobStore(Path.Combine(dataRoot, "blobs"));
        preparer = new AssetPreparer(blobs);
        bridge = new BridgeRouter(this);
        sessions = new SessionCoordinator(bridge, blobs, preparer);
        vsdx = new VsdxCoordinator(bridge, blobs, preparer);
        library = new AssetLibrary(Path.Combine(dataRoot, "library"), blobs, preparer);
        journal = new RecoveryJournal(Path.Combine(dataRoot, "recovery"), blobs);
        checkpoints = new CheckpointStore(Path.Combine(dataRoot, "recovery"), blobs, journal);
        // Read the previous run's durable state before this run's first checkpoint replaces it.
        var pendingRecovery = await checkpoints.ReadRecoveryAsync(shutdown.Token);
        bridge.RegisterHostHandler("host.recoveryAppend", async (p, ct) =>
        {
            var ev = p["event"].Deserialize<CommittedEvent>(ContractJson.Options);
            if (ev is null) return Result<JsonNode?>.Fail("invalid_request", "event required");
            var r = await journal.AppendDurableAsync(ev, ct);
            return r.Ok ? Result<JsonNode?>.Success(new JsonObject { ["revision"] = r.Value!.Revision, ["sequence"] = r.Value.Sequence }) : Result<JsonNode?>.From(r.Error!);
        });
        bridge.RegisterHostHandler("host.recoveryCheckpoint", async (p, ct) =>
        {
            if (pendingRecovery is not null && !recoveryOffered) return Result<JsonNode?>.Fail("busy", "recovery decision pending", retryable: true);
            var snap = p["snapshot"].Deserialize<Snapshot>(ContractJson.Options);
            if (snap is null) return Result<JsonNode?>.Fail("invalid_request", "snapshot required");
            var r = await checkpoints.PublishAsync(snap, p["sequence"]?.GetValue<long>() ?? 0, ct);
            return r.Ok ? Result<JsonNode?>.Success(new JsonObject { ["revision"] = r.Value!.Revision }) : Result<JsonNode?>.From(r.Error!);
        });
        bridge.EventReceived += e =>
        {
            if (e["method"]?.GetValue<string>() != "editor.ready" || recoveryOffered) return;
            Dispatcher.InvokeAsync(async () => await OfferRecoveryAsync(pendingRecovery));
        };
        bridge.RegisterHostHandler("host.prepareAsset", PrepareAssetAsync);
        bridge.RegisterHostHandler("host.readBlob", async (p, ct) =>
        {
            var sha = p["sha256"]?.GetValue<string>() ?? "";
            var bytes = await blobs.ReadAsync(sha, ct);
            return Result<JsonNode?>.Success(new JsonObject { ["base64"] = Convert.ToBase64String(bytes.Span) });
        });
        bridge.RendererFailed += () => Dispatcher.InvokeAsync(() => Status.Text = "Editor renderer failed; reload to recover the last durable state.");
        core.Navigate(new Uri(BridgeRouter.Origin, "index.html").ToString());

        // Live MCP control: per-user pipe; requests reach the frontend engine through the bridge.
        var exports = new ExportService(bridge, vsdx, new ExportPathPolicy(Path.Combine(dataRoot, "exports"), new DialogConsent(this)), () => currentPath);
        hostRequests = new HostRequestHandler(bridge, [new AssetsListService(library, new AssetResolver(library, preparer, bridge), bridge), exports], preparer, blobs);
        var pipe = new Diagram.Ipc.PipeServer(Diagram.Ipc.Handshake.PipeName());
        _ = pipe.StartAsync((req, conn, ct) => hostRequests.HandleAsync(req, ct), shutdown.Token);
        Closed += (_, _) => shutdown.Cancel();
    }

    /// <summary>After a crash: offer the last durable state (validated replay in the frontend, new dirty session).</summary>
    private async Task OfferRecoveryAsync(RecoveryCandidate? candidate)
    {
        recoveryOffered = true;
        if (candidate is null || CurrentScope() is not { } scope) return;
        var lost = candidate.Report.Count(d => d.Action == "dropped");
        var ask = $"Recover the unsaved diagram (revision {candidate.Revision})?" + (lost > 0 ? $"\n\n{lost} damaged journal item(s) could not be recovered." : "");
        if (MessageBox.Show(this, ask, "Agentic Diagram — recovery", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        var snap = await bridge!.CallAsync("doc.snapshot", scope, new JsonObject(), CancellationToken.None);
        if (!snap.Ok) return;
        var r = await bridge.CallAsync("recovery.restore", scope, new JsonObject
        {
            ["baseRevision"] = snap.Value.GetProperty("revision").GetInt64(),
            ["candidate"] = new JsonObject
            {
                ["base"] = JsonNode.Parse(ContractJson.Serialize(candidate.Base)),
                ["tail"] = JsonNode.Parse(JsonSerializer.Serialize(candidate.Tail, ContractJson.Options)),
            },
        }, CancellationToken.None);
        Status.Text = r.Ok ? $"Recovered revision {candidate.Revision}; old agent sessions must re-read the document." : $"Recovery failed: {r.Error!.Message}";
    }

    private sealed class DialogConsent(MainWindow owner) : IExportConsent
    {
        public Task<bool> RequestAsync(string client, string path, string reason, CancellationToken ct) =>
            owner.Dispatcher.InvokeAsync(() => MessageBox.Show(owner, $"{client} wants to export to\n{path}\n\nThis {reason}. Allow?", "Export approval",
                MessageBoxButton.YesNo, MessageBoxImage.Warning) == MessageBoxResult.Yes).Task;
    }

    public void PostJson(string json) => Dispatcher.InvokeAsync(() => View.CoreWebView2?.PostWebMessageAsJson(json));

    private async Task<Result<JsonNode?>> PrepareAssetAsync(JsonObject p, CancellationToken ct)
    {
        // The frontend asks; the host shows the picker. Paths never cross the bridge.
        var path = await Dispatcher.InvokeAsync(() =>
        {
            var dlg = new OpenFileDialog { Filter = "Images|*.png;*.jpg;*.jpeg;*.bmp;*.svg" };
            return dlg.ShowDialog(this) == true ? dlg.FileName : null;
        });
        if (path is null) return Result<JsonNode?>.Fail("consent_denied", "no file chosen");
        var mime = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".bmp" => "image/bmp", ".svg" => "image/svg+xml", _ => "",
        };
        await using var stream = File.OpenRead(path);
        var prepared = await preparer!.PrepareAsync(stream, mime, new AssetPreparer.Options(Path.GetFileNameWithoutExtension(path), SourcePath: path), ct);
        // A file the user picked is approved: also publish it to the per-user library (new slugs only).
        if (prepared.Ok && library is not null)
            await library.AddAsync(await File.ReadAllBytesAsync(path, ct), mime, new AssetPreparer.Options(Path.GetFileNameWithoutExtension(path)), ct);
        return prepared.Ok ? Result<JsonNode?>.Success(JsonNode.Parse(ContractJson.Serialize(prepared.Value!))) : Result<JsonNode?>.From(prepared.Error!);
    }

    private Scope? CurrentScope() => bridge?.DocumentId is { } d && bridge.SessionId is { } s ? new Scope { DocumentId = d, SessionId = s } : null;

    private async void OnOpen(object sender, RoutedEventArgs e)
    {
        if (sessions is null || CurrentScope() is not { } scope) return;
        var dlg = new OpenFileDialog { Filter = "Diagrams|*.diagram.json;*.vsdx|Diagram JSON|*.diagram.json|Visio drawing|*.vsdx" };
        if (dlg.ShowDialog(this) != true) return;
        var snap = await bridge!.CallAsync("doc.snapshot", scope, new JsonObject(), CancellationToken.None);
        if (!snap.Ok) { Status.Text = snap.Error!.Message; return; }
        var expected = new ExpectedState(scope.DocumentId, scope.SessionId, snap.Value.GetProperty("revision").GetInt64());
        if (IsVsdx(dlg.FileName))
        {
            var native = await vsdx!.OpenAsync(dlg.FileName, expected, CancellationToken.None);
            if (!native.Ok) { Status.Text = $"Open failed: {native.Error!.Message}"; return; }
            var report = native.Value!.Report;
            // Lossy import: keep the document dirty with no save path so Save becomes Save As.
            currentPath = native.Value.SaveAsRequired ? null : dlg.FileName;
            Status.Text = native.Value.SaveAsRequired
                ? $"Opened {dlg.FileName} with {report.Approximated} approximated and {report.Dropped} dropped items ({string.Join(", ", report.ByCode.Keys)}); use Save As."
                : $"Opened {dlg.FileName}";
            return;
        }
        var opened = await sessions.OpenJsonAsync(dlg.FileName, expected, CancellationToken.None);
        Status.Text = opened.Ok ? $"Opened {dlg.FileName}" : $"Open failed: {opened.Error!.Message}";
        if (opened.Ok) currentPath = dlg.FileName;
    }

    private async void OnSave(object sender, RoutedEventArgs e)
    {
        if (currentPath is null) { OnSaveAs(sender, e); return; }
        await SaveAsync(currentPath);
    }

    private async void OnSaveAs(object sender, RoutedEventArgs e)
    {
        var dlg = new SaveFileDialog { Filter = "Diagram JSON|*.diagram.json|Visio drawing|*.vsdx", FileName = "diagram.diagram.json" };
        if (dlg.ShowDialog(this) == true) await SaveAsync(dlg.FileName);
    }

    private async Task SaveAsync(string path)
    {
        if (sessions is null || CurrentScope() is not { } scope) return;
        if (IsVsdx(path))
        {
            var native = await vsdx!.ExportAsync(path, scope, markSaved: true, CancellationToken.None);
            if (!native.Ok) { Status.Text = $"Save failed: {native.Error!.Message}"; return; }
            var r = native.Value!.Report;
            Status.Text = native.Value.MarkedClean ? $"Saved revision {native.Value.Revision} as VSDX" : $"Saved VSDX but {r.Dropped} item(s) were dropped; document left unsaved ({string.Join(", ", r.ByCode.Keys)})";
            if (native.Value.MarkedClean) currentPath = path;
            return;
        }
        var saved = await sessions.SaveJsonAsync(path, scope, CancellationToken.None);
        Status.Text = saved.Ok ? $"Saved revision {saved.Value!.Revision}{(saved.Value.MarkedClean ? "" : " (document changed session; not marked clean)")}" : $"Save failed: {saved.Error!.Message}";
        if (saved.Ok) currentPath = path;
    }

    private static bool IsVsdx(string path) => path.EndsWith(".vsdx", StringComparison.OrdinalIgnoreCase);

    /// <summary>Export a copy: never changes the current save path or clean state.</summary>
    private async void OnExportVsdx(object sender, RoutedEventArgs e)
    {
        if (vsdx is null || CurrentScope() is not { } scope) return;
        var dlg = new SaveFileDialog { Filter = "Visio drawing|*.vsdx", FileName = "diagram.vsdx" };
        if (dlg.ShowDialog(this) != true) return;
        var r = await vsdx.ExportAsync(dlg.FileName, scope, markSaved: false, CancellationToken.None);
        Status.Text = r.Ok ? $"Exported revision {r.Value!.Revision} ({r.Value.Report.Approximated} approximated, {r.Value.Report.Dropped} dropped)" : $"Export failed: {r.Error!.Message}";
    }

    private void OnExit(object sender, RoutedEventArgs e) => Close();
}
