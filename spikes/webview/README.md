# I04 — WebView2 operation → live canvas probe (G4)

Disposable probe, split so most of it can be tested without Windows:

| Part | Where | Runs on |
|---|---|---|
| Host bridge rules (exact origin, top-level only, readiness, correlations, crash → unknown) | `core/ProbeBridge.cs` (net10.0) | Linux tests: `spikes/webview.tests` (11/11) |
| Frontend bridge (scope → cache → revision, one revision per batch, editor.ready) | `spikes/canvas/src/bridge.ts` | Chromium tests: `spikes/canvas/tests/bridge.spec.ts` (4/4) |
| WPF + WebView2 shell (virtual host mapping, navigation/new-window denial, frame messages, ProcessFailed, dispatcher posting) | `MainWindow.xaml.cs` | **Compiles** on Linux with `EnableWindowsTargeting`; **not run** |

```sh
dotnet test spikes/webview.tests/WebViewProbe.Tests.csproj       # 11/11
dotnet build spikes/webview/WebViewProbe.csproj                   # builds (Microsoft.Web.WebView2 1.0.4258.31)
cd spikes/canvas && PROBE_CHROMIUM=/opt/pw-browsers/chromium npx playwright test tests/bridge.spec.ts   # 4/4
```

Red evidence: the tests passed on first run, so mutations were used. Disabling the frontend
transaction cache failed `DuplicateTransactionChangesOnce` (1/4). Replacing the exact origin
check with a string-prefix check failed 3 origin/child-frame cases (3/11). Both were reverted.

## NOT RUN (Windows required)

`dotnet test spikes/webview.tests` checks the bridge rules against a fake channel, not
CoreWebView2. Still to do on Windows: build `spikes/canvas` into `bin/.../frontend`, launch
`WebViewProbe.exe`, click "Agent: move rectangle" and check that the canvas visibly moves and the
status revision matches; confirm navigation to another origin is blocked; kill the renderer
process mid-request and confirm `timeout_unknown`/`unknown`; record the Evergreen runtime version.
