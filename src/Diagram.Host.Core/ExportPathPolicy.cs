using System.Text.RegularExpressions;

namespace Diagram.Host.Core;

public sealed record ApprovedDestination(string Path, string Format, bool Overwrite, bool ConsentGiven, string Root);

/// <summary>Asks the human (in the app) to approve an export outside the approved roots or an overwrite.</summary>
public interface IExportConsent
{
    Task<bool> RequestAsync(string clientLabel, string path, string reason, CancellationToken ct);
}

/// <summary>
/// Fail-closed destination policy for MCP exports. Approved roots are the saved document's
/// folder (scope metadata, not an editable document) and the per-user export workspace.
/// No path → a unique safe name in an approved root. UNC/device/ADS/reserved names, traversal
/// through links, and extension mismatches are refused; anything outside a root, or an
/// overwrite, needs consent within 60 s (timeout = deny), and the session must still be
/// current afterwards. The destination is revalidated immediately before writing.
/// </summary>
public sealed partial class ExportPathPolicy(string exportWorkspace, IExportConsent? consent = null, TimeSpan? consentTimeout = null)
{
    public static readonly IReadOnlyDictionary<string, string> Extensions = new Dictionary<string, string>
    {
        ["vsdx"] = ".vsdx", ["svg"] = ".svg", ["png"] = ".png", ["jpeg"] = ".jpg",
    };
    private readonly string workspace = System.IO.Path.GetFullPath(exportWorkspace);
    private readonly TimeSpan timeout = consentTimeout ?? TimeSpan.FromSeconds(60);

    [GeneratedRegex(@"^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(\..*)?$", RegexOptions.IgnoreCase)]
    private static partial Regex Reserved();

    public async Task<Result<ApprovedDestination>> ResolveAsync(string? path, string format, string? documentPath, string title, long revision,
        string clientLabel, Func<CancellationToken, Task<bool>> sessionStillCurrent, CancellationToken ct)
    {
        if (!Extensions.TryGetValue(format, out var ext)) return Fail("invalid_request", "format must be vsdx, svg, png or jpeg");
        var roots = new List<string> { workspace };
        if (documentPath is not null && System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(documentPath)) is { } docDir) roots.Insert(0, docDir);

        if (string.IsNullOrWhiteSpace(path))
        {
            var root = roots[0];
            Directory.CreateDirectory(root);
            var stem = SafeStem(title);
            var candidate = System.IO.Path.Combine(root, $"{stem}-r{revision}{ext}");
            for (var n = 2; File.Exists(candidate); n++) candidate = System.IO.Path.Combine(root, $"{stem}-r{revision}-{n}{ext}");
            return Result<ApprovedDestination>.Success(new ApprovedDestination(candidate, format, false, false, root));
        }

        var syntax = CheckSyntax(path);
        if (syntax is not null) return Fail("path_not_permitted", syntax);
        if (!string.Equals(System.IO.Path.GetExtension(path), ext, StringComparison.OrdinalIgnoreCase)
            && !(format == "jpeg" && string.Equals(System.IO.Path.GetExtension(path), ".jpeg", StringComparison.OrdinalIgnoreCase)))
            return Fail("invalid_request", $"a {format} export must end in {ext}");
        var full = System.IO.Path.GetFullPath(path);
        var link = LinkInPath(full);
        if (link is not null) return Fail("path_not_permitted", $"path goes through a link or junction ({link})");
        var within = roots.FirstOrDefault(r => IsWithin(full, r));
        var overwrite = File.Exists(full);
        if (Directory.Exists(full)) return Fail("path_not_permitted", "destination is a directory");
        var reasons = new List<string>();
        if (within is null) reasons.Add("outside the approved folders");
        if (overwrite) reasons.Add("replaces an existing file");
        var consented = false;
        if (reasons.Count > 0)
        {
            if (consent is null) return Fail("consent_denied", $"export {string.Join(" and ", reasons)} needs approval in the app");
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeout);
            try { consented = await consent.RequestAsync(clientLabel, full, string.Join(" and ", reasons), cts.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { consented = false; }
            if (!consented) return Fail("consent_denied", "the user did not approve this export location");
            if (!await sessionStillCurrent(ct)) return Fail("session_mismatch", "the document changed session while waiting for approval; re-read and retry");
        }
        return Result<ApprovedDestination>.Success(new ApprovedDestination(full, format, overwrite, consented, within ?? System.IO.Path.GetDirectoryName(full)!));
    }

    /// <summary>Immediately before writing: the destination must not have changed kind (new link, directory, or an unapproved overwrite).</summary>
    public Result<bool> Revalidate(ApprovedDestination d)
    {
        if (CheckSyntax(d.Path) is { } s) return Result<bool>.Fail("path_not_permitted", s);
        if (LinkInPath(d.Path) is { } l) return Result<bool>.Fail("path_not_permitted", $"path now goes through a link ({l})");
        if (Directory.Exists(d.Path)) return Result<bool>.Fail("path_not_permitted", "destination is now a directory");
        if (File.Exists(d.Path) && !d.Overwrite) return Result<bool>.Fail("consent_denied", "a file appeared at the destination; overwrite was not approved");
        return Result<bool>.Success(true);
    }

    internal static string? CheckSyntax(string path)
    {
        if (path.Length > 32_000 || path.Contains('\0')) return "path is not valid";
        var p = path.Replace('/', '\\');
        if (p.StartsWith(@"\\?\") || p.StartsWith(@"\\.\") || p.StartsWith(@"\??\")) return "device paths are not allowed";
        if (p.StartsWith(@"\\")) return "network (UNC) paths are not allowed";
        if (!System.IO.Path.IsPathFullyQualified(path) && !(path.Length >= 3 && char.IsLetter(path[0]) && path[1] == ':' && (path[2] is '\\' or '/'))) return "path must be absolute";
        var afterDrive = path.Length >= 2 && char.IsLetter(path[0]) && path[1] == ':' ? path[2..] : path;
        if (afterDrive.Contains(':')) return "alternate data streams are not allowed";
        foreach (var seg in p.Split('\\', StringSplitOptions.RemoveEmptyEntries).Skip(path.Length >= 2 && path[1] == ':' ? 1 : 0))
        {
            if (seg is "." or "..") return "relative segments are not allowed";
            if (seg.EndsWith('.') || seg.EndsWith(' ')) return "names may not end with a dot or space";
            if (Reserved().IsMatch(seg)) return $"'{seg}' is a reserved device name";
            if (seg.IndexOfAny(['<', '>', '"', '|', '?', '*']) >= 0) return "path contains invalid characters";
        }
        return null;
    }

    /// <summary>Returns the first existing ancestor (or the file) that is a symlink/junction/reparse point.</summary>
    internal static string? LinkInPath(string full)
    {
        var cur = full;
        while (!string.IsNullOrEmpty(cur))
        {
            FileSystemInfo? info = File.Exists(cur) ? new FileInfo(cur) : Directory.Exists(cur) ? new DirectoryInfo(cur) : null;
            if (info is not null && (info.LinkTarget is not null || info.Attributes.HasFlag(FileAttributes.ReparsePoint))) return cur;
            var parent = System.IO.Path.GetDirectoryName(cur);
            if (parent == cur) break;
            cur = parent;
        }
        return null;
    }

    private static bool IsWithin(string full, string root)
    {
        var r = System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(root)) + System.IO.Path.DirectorySeparatorChar;
        return full.StartsWith(r, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    }

    private static string SafeStem(string title)
    {
        var s = Regex.Replace(title.ToLowerInvariant(), "[^a-z0-9_-]+", "-").Trim('-');
        if (s.Length == 0 || Reserved().IsMatch(s)) s = "diagram";
        return s.Length > 60 ? s[..60] : s;
    }

    private static Result<ApprovedDestination> Fail(string code, string message) => Result<ApprovedDestination>.Fail(code, message, outcome: "not_applied");
}
