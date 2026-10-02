using System.IO.Compression;
using System.Xml;
using Diagram.Core.Contracts;
using Diagram.Visio.Abstractions;

namespace Diagram.Visio;

/// <summary>D7 limits for untrusted packages (POC defaults; record any change with evidence).</summary>
public sealed record PackageLimits(
    long CompressedBytes = 100L * 1024 * 1024,
    int Entries = 10_000,
    long ExpandedBytes = 512L * 1024 * 1024,
    long EntryExpandedBytes = 64L * 1024 * 1024,
    double MaxRatio = 200,
    int XmlMaxDepth = 256,
    long XmlMaxCharacters = 64L * 1024 * 1024);

public sealed record GuardedPackage(byte[] Bytes, IReadOnlyList<Diagnostic> Diagnostics);

/// <summary>
/// Validates a VSDX before any backend parses it: counts actual decompressed bytes per entry
/// and cumulatively (headers are not trusted), rejects traversal/absolute names, external
/// relationships and DTDs/entities, and marks macros/OLE parts as inert (never executed).
/// </summary>
public static class PackageGuard
{
    public static XmlReaderSettings SafeXml(PackageLimits limits) => new()
    {
        DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersFromEntities = 0,
        MaxCharactersInDocument = limits.XmlMaxCharacters, IgnoreProcessingInstructions = true, Async = false,
    };

    public static async Task<GuardedPackage> ValidateAsync(Stream input, PackageLimits? limits = null, CancellationToken ct = default)
    {
        limits ??= new PackageLimits();
        var bytes = await ReadCappedAsync(input, limits.CompressedBytes, ct);
        var diagnostics = new List<Diagnostic>();
        ZipArchive zip;
        try { zip = new ZipArchive(new MemoryStream(bytes, writable: false), ZipArchiveMode.Read); }
        catch (InvalidDataException) { throw new VsdxException("invalid_request", "not a ZIP/OPC package"); }
        using (zip)
        {
            if (zip.Entries.Count > limits.Entries) throw new VsdxException("limit_exceeded", $"package has {zip.Entries.Count} entries");
            long total = 0;
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in zip.Entries)
            {
                ct.ThrowIfCancellationRequested();
                var name = entry.FullName;
                if (name.StartsWith('/') || name.StartsWith('\\') || name.Contains("..") || name.Contains(':') || name.Contains('\\') || Path.IsPathRooted(name))
                    throw new VsdxException("invalid_request", $"unsafe part name '{name}'");
                if (!names.Add(name)) throw new VsdxException("invalid_request", $"duplicate part name '{name}'");
                // Count real decompressed bytes; never trust Length from the header.
                long expanded = 0;
                using (var s = entry.Open())
                {
                    var buf = new byte[81920];
                    int n;
                    while ((n = s.Read(buf)) > 0)
                    {
                        expanded += n;
                        total += n;
                        if (expanded > limits.EntryExpandedBytes) throw new VsdxException("limit_exceeded", $"part '{name}' expands beyond {limits.EntryExpandedBytes} bytes");
                        if (total > limits.ExpandedBytes) throw new VsdxException("limit_exceeded", "package expands beyond the total budget");
                        if (entry.CompressedLength > 0 && expanded > 1024 * 1024 && expanded / (double)entry.CompressedLength > limits.MaxRatio)
                            throw new VsdxException("limit_exceeded", $"part '{name}' compression ratio exceeds {limits.MaxRatio}:1");
                    }
                }
                var lower = name.ToLowerInvariant();
                if (lower.EndsWith(".xml") || lower.EndsWith(".rels")) ValidateXml(entry, name, limits);
                if (lower.Contains("vbaproject") || lower.EndsWith(".bin") && lower.Contains("vba"))
                    diagnostics.Add(new Diagnostic { Severity = "warning", Code = "macro_inert", Action = "dropped", Detail = $"macro part '{name}' is never executed and is not carried into the canonical document" });
                if (lower.Contains("/embeddings/") || lower.Contains("oleobject"))
                    diagnostics.Add(new Diagnostic { Severity = "warning", Code = "ole_inert", Action = "dropped", Detail = $"embedded object '{name}' is inert and not imported" });
            }
            if (zip.GetEntry("[Content_Types].xml") is null) throw new VsdxException("invalid_request", "missing [Content_Types].xml");
        }
        return new GuardedPackage(bytes, diagnostics);
    }

    private static void ValidateXml(ZipArchiveEntry entry, string name, PackageLimits limits)
    {
        try
        {
            using var s = entry.Open();
            using var r = XmlReader.Create(s, SafeXml(limits));
            while (r.Read())
            {
                if (r.Depth > limits.XmlMaxDepth) throw new VsdxException("limit_exceeded", $"XML in '{name}' nests deeper than {limits.XmlMaxDepth}");
                if (r.NodeType == XmlNodeType.Element && r.LocalName == "Relationship" && string.Equals(r.GetAttribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase))
                    throw new VsdxException("invalid_request", $"external relationship in '{name}' is not allowed");
            }
        }
        catch (XmlException e)
        {
            throw new VsdxException("invalid_request", $"unsafe or malformed XML in '{name}': {e.Message}");
        }
    }

    private static async Task<byte[]> ReadCappedAsync(Stream s, long cap, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        var buf = new byte[81920];
        int n;
        while ((n = await s.ReadAsync(buf, ct)) > 0)
        {
            if (ms.Length + n > cap) throw new VsdxException("limit_exceeded", $"package exceeds {cap} bytes");
            ms.Write(buf, 0, n);
        }
        return ms.ToArray();
    }
}
