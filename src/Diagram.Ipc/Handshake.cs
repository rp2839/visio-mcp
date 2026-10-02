using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Diagram.Ipc;

public static class Handshake
{
    public const int ProtocolVersion = 1;
    public const string Method = "app.hello";

    /// <summary>
    /// Pipe name scoped by user, logon session and protocol version. On Windows the SID and the
    /// session id are used; elsewhere the user name and UID-scoped socket directory apply.
    /// </summary>
    public static string PipeName()
    {
        string user;
        if (OperatingSystem.IsWindows())
        {
            using var id = WindowsIdentity.GetCurrent();
            user = $"{id.User?.Value}-{System.Diagnostics.Process.GetCurrentProcess().SessionId}";
        }
        else user = Environment.UserName;
        return $"AgenticDiagram-{user}-v{ProtocolVersion}";
    }

    public static readonly string[] Capabilities =
    [
        "doc.summary", "doc.getObjects", "doc.apply", "doc.executeScript", "doc.getChanges", "doc.inspectLayout", "doc.render",
        "doc.export", "assets.list", "app.current",
    ];
}
