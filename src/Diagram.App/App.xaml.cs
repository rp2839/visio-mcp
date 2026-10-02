using System.Threading;
using System.Windows;

namespace Diagram.App;

public partial class App : Application
{
    private Mutex? single;

    private void OnStartup(object sender, StartupEventArgs e)
    {
        // One instance per Windows user/logon session; a second launch exits (the first stays active).
        single = new Mutex(initiallyOwned: true, $@"Local\AgenticDiagram-{Environment.UserName}-v1", out var created);
        if (!created) { Shutdown(); return; }
        new MainWindow().Show();
    }
}
