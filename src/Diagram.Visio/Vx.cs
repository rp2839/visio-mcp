using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

namespace Diagram.Visio;

/// <summary>Small helpers for VSDX/OPC XML.</summary>
internal static class Vx
{
    public static readonly XNamespace V = "http://schemas.microsoft.com/office/visio/2012/main";
    public static readonly XNamespace R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    public static readonly XNamespace Pr = "http://schemas.openxmlformats.org/package/2006/relationships";
    public static readonly XNamespace Ct = "http://schemas.openxmlformats.org/package/2006/content-types";
    public const string RelDocument = "http://schemas.microsoft.com/visio/2010/relationships/document";
    public const string RelPages = "http://schemas.microsoft.com/visio/2010/relationships/pages";
    public const string RelWindows = "http://schemas.microsoft.com/visio/2010/relationships/windows";
    public const string RelPage = "http://schemas.microsoft.com/visio/2010/relationships/page";
    public const string RelImage = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
    public const string RelSvgSource = "http://schemas.agentic-diagram.invalid/relationships/svg-source";
    public const string RelCore = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
    public const string RelApp = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static string F(double d) => Math.Round(d, 12).ToString("R", Inv);
    public static double In(double pt) => pt / 72.0;

    public static XElement Cell(string n, object v, string? formula = null, string? unit = null)
    {
        var e = new XElement(V + "Cell", new XAttribute("N", n), new XAttribute("V", v switch
        {
            double d => F(d),
            bool b => b ? "1" : "0",
            _ => Convert.ToString(v, Inv)!,
        }));
        if (unit is not null) e.Add(new XAttribute("U", unit));
        if (formula is not null) e.Add(new XAttribute("F", formula));
        return e;
    }

    public static XElement Section(string n, params object[] content) => new(V + "Section", new XAttribute("N", n), content);

    public static XElement UserRow(string name, string value) => new(V + "Row", new XAttribute("N", name),
        new XElement(V + "Cell", new XAttribute("N", "Value"), new XAttribute("V", value), new XAttribute("U", "STR"),
            new XAttribute("F", "\"" + value.Replace("\"", "\"\"") + "\"")),
        new XElement(V + "Cell", new XAttribute("N", "Prompt"), new XAttribute("V", ""), new XAttribute("F", "No Formula")));

    public static string? CellV(XElement? parent, string n) => (string?)parent?.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == n)?.Attribute("V");
    public static string? CellF(XElement? parent, string n) => (string?)parent?.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == n)?.Attribute("F");

    public static double? Num(XElement? parent, string n) =>
        CellV(parent, n) is { } s && double.TryParse(s, NumberStyles.Float, Inv, out var d) && double.IsFinite(d) ? d : null;

    public static IEnumerable<XElement> Sections(XElement shape, string n) => shape.Elements(V + "Section").Where(s => (string?)s.Attribute("N") == n);

    public static string? User(XElement shape, string name) => Sections(shape, "User").Elements(V + "Row")
        .FirstOrDefault(r => (string?)r.Attribute("N") == name)?.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == "Value")?.Attribute("V")?.Value;

    public static XDocument Rels(IEnumerable<(string Id, string Type, string Target)> rels) => new(new XElement(Pr + "Relationships",
        rels.Select(r => new XElement(Pr + "Relationship", new XAttribute("Id", r.Id), new XAttribute("Type", r.Type), new XAttribute("Target", r.Target)))));

    public static void Write(ZipArchive zip, string name, XDocument doc)
    {
        using var s = zip.CreateEntry(name, CompressionLevel.Optimal).Open();
        doc.Declaration = new XDeclaration("1.0", "utf-8", "yes");
        doc.Save(s, SaveOptions.DisableFormatting);
    }

    public static void Write(ZipArchive zip, string name, ReadOnlySpan<byte> bytes)
    {
        using var s = zip.CreateEntry(name, CompressionLevel.Optimal).Open();
        s.Write(bytes);
    }

    public static XDocument Load(ZipArchive zip, string name)
    {
        var e = zip.GetEntry(name) ?? throw new Abstractions.VsdxException("invalid_request", $"missing part {name}");
        using var s = e.Open();
        using var r = System.Xml.XmlReader.Create(s, PackageGuard.SafeXml(new PackageLimits()));
        return XDocument.Load(r);
    }

    public static XDocument Parse(byte[] bytes)
    {
        using var r = System.Xml.XmlReader.Create(new MemoryStream(bytes), PackageGuard.SafeXml(new PackageLimits()));
        return XDocument.Load(r);
    }

    public static byte[] Bytes(ZipArchive zip, string name)
    {
        var e = zip.GetEntry(name) ?? throw new Abstractions.VsdxException("invalid_request", $"missing part {name}");
        using var s = e.Open();
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    public static string Resolve(string baseDir, string target)
    {
        if (target.StartsWith('/')) return target.TrimStart('/');
        var parts = new List<string>(baseDir.Split('/', StringSplitOptions.RemoveEmptyEntries));
        foreach (var seg in target.Split('/'))
        {
            if (seg == "..") { if (parts.Count > 0) parts.RemoveAt(parts.Count - 1); }
            else if (seg != ".") parts.Add(seg);
        }
        return string.Join('/', parts);
    }

    public static string Utf8(byte[] b) => Encoding.UTF8.GetString(b);
}
