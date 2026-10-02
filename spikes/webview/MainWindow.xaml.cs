using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using WebViewProbe.Bridge;

namespace WebViewProbe;

/// <summary>WPF shell: CoreWebView2 adapter for <see cref="ProbeBridge"/>. Windows-only.</summary>
public partial class MainWindow : Window, IWebMessageChannel
{
    private ProbeBridge? bridge;
    public event Action<WebMessage>? MessageReceived;
    public event Action? ProcessFailed;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await InitAsync();
    }

    private async Task InitAsync()
    {
        await View.EnsureCoreWebView2Async();
        var core = View.CoreWebView2;
        var dist = Path.Combine(AppContext.BaseDirectory, "frontend");
        core.SetVirtualHostNameToFolderMapping(ProbeBridge.Origin.Host, dist, CoreWebView2HostResourceAccessKind.DenyCors);
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = true;
        core.NavigationStarting += (_, e) => { if (!ProbeBridge.IsTrustedSource(e.Uri, true)) e.Cancel = true; };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.WebMessageReceived += (_, e) => MessageReceived?.Invoke(new WebMessage(e.Source, true, e.WebMessageAsJson));
        core.FrameCreated += (_, f) => f.Frame.WebMessageReceived += (_, e) => MessageReceived?.Invoke(new WebMessage(e.Source, false, e.WebMessageAsJson));
        core.ProcessFailed += (_, _) => ProcessFailed?.Invoke();
        bridge = new ProbeBridge(this);
        core.Navigate(new Uri(ProbeBridge.Origin, "index.html").ToString());
    }

    public void PostJson(string json) => Dispatcher.InvokeAsync(() => View.CoreWebView2.PostWebMessageAsJson(json));

    private async void OnMoveClick(object sender, RoutedEventArgs e)
    {
        if (bridge is null) return;
        var request = new RequestEnvelope(Guid.NewGuid().ToString(), "doc.apply", bridge.DocumentId, bridge.SessionId, new JsonObject
        {
            ["transactionId"] = Guid.NewGuid().ToString(),
            ["baseRevision"] = int.Parse(Status.Tag?.ToString() ?? "0"),
            ["atomic"] = true,
            ["operations"] = new JsonArray(new JsonObject { ["op"] = "move", ["target"] = "rect", ["dx"] = 40, ["dy"] = 0 }),
        });
        var response = await bridge.SendAsync(request, CancellationToken.None);
        Status.Tag = response.Revision ?? Status.Tag;
        Status.Text = response.Ok ? $"revision {response.Revision}, changed {response.Result?["changed"]?.ToJsonString()}" : $"{response.Error!.Code}: {response.Error.Message}";
    }
}
