using System.Globalization;
using System.Xml.Linq;

namespace Diagram.Visio;

/// <summary>
/// Visio ShapeSheet inheritance for import: a shape's effective cells are, in increasing
/// priority, its style sheets (Line/Fill/Text chains), its master shape, then its own local
/// values. Visio stores only the cells that differ from what would be inherited, so an instance
/// can carry a partial Geometry section (for example a MoveTo row holding only Y) that is only
/// meaningful merged over the master's rows. Sections merge by name + IX, rows by IX (or N for
/// named rows), cells by name; a Del="1" row or section removes the inherited one.
/// Cells taken from a style sheet or master are tagged with <see cref="OriginAttr"/> so theme
/// resolution can tell a value cached for this shape from one cached for another context.
/// </summary>
internal sealed class SheetInheritance
{
    public const string OriginAttr = "adOrigin"; // "style" | "master"; absent = local
    private static readonly XNamespace V = Vx.V;

    private static readonly HashSet<string> LineCells = new(StringComparer.Ordinal)
    {
        "LineWeight", "LineColor", "LinePattern", "Rounding", "EndArrowSize", "BeginArrow", "EndArrow", "LineCap", "BeginArrowSize",
        "LineColorTrans", "CompoundType",
    };
    private static readonly HashSet<string> FillCells = new(StringComparer.Ordinal)
    {
        "FillForegnd", "FillBkgnd", "FillPattern", "ShdwForegnd", "ShdwBkgnd", "ShdwPattern", "FillForegndTrans", "FillBkgndTrans",
        "ShdwForegndTrans", "ShdwBkgndTrans", "ShapeShdwType", "ShapeShdwOffsetX", "ShapeShdwOffsetY", "ShapeShdwObliqueAngle",
        "ShapeShdwScaleFactor", "ShapeShdwBlur", "ShapeShdwShow",
    };
    private static readonly HashSet<string> TextCells = new(StringComparer.Ordinal)
    {
        "LeftMargin", "RightMargin", "TopMargin", "BottomMargin", "VerticalAlign", "TextBkgnd", "DefaultTabStop", "TextDirection", "TextBkgndTrans",
    };
    private static readonly HashSet<string> TextSections = new(StringComparer.Ordinal) { "Character", "Paragraph", "Tabs" };

    private static bool IsThemeCell(string n) => n.StartsWith("QuickStyle", StringComparison.Ordinal) || n is "ColorSchemeIndex" or "EffectSchemeIndex"
        or "ConnectorSchemeIndex" or "FontSchemeIndex" or "ThemeIndex" or "VariationColorIndex" or "VariationStyleIndex" or "EmbellishmentIndex";

    private readonly Dictionary<string, XElement> styleSheets;
    private readonly Dictionary<(string Category, string Id), XElement> chainCache = new();

    public SheetInheritance(XElement? documentRoot)
    {
        styleSheets = documentRoot?.Element(V + "StyleSheets")?.Elements(V + "StyleSheet")
            .Where(s => s.Attribute("ID") is not null).GroupBy(s => (string)s.Attribute("ID")!).ToDictionary(g => g.Key, g => g.First()) ?? new();
    }

    /// <summary>The shape with style-sheet, master and local values merged (children shapes are not copied).</summary>
    public XElement Effective(XElement local, XElement? master)
    {
        var styled = StyleContribution(local, master);
        var withMaster = master is null ? styled : Merge(styled, Tag(Strip(master), "master"));
        return Merge(withMaster, Strip(local));
    }

    private XElement StyleContribution(XElement local, XElement? master)
    {
        var result = new XElement(V + "Shape");
        // Line, then text, then fill: theme cells present in several chains end up from the fill chain.
        foreach (var (category, attr) in new[] { ("line", "LineStyle"), ("text", "TextStyle"), ("fill", "FillStyle") })
        {
            var id = (string?)local.Attribute(attr) ?? (string?)master?.Attribute(attr);
            if (id is null) continue;
            result = Merge(result, Chain(category, attr, id));
        }
        return Tag(result, "style");
    }

    /// <summary>Category cells of a style sheet merged over its ancestors (cycle-safe).</summary>
    private XElement Chain(string category, string attr, string id)
    {
        if (chainCache.TryGetValue((category, id), out var cached)) return cached;
        var lineage = new List<XElement>();
        var seen = new HashSet<string>();
        for (var cur = id; cur is not null && seen.Add(cur) && styleSheets.TryGetValue(cur, out var sheet); cur = (string?)sheet.Attribute(attr))
            lineage.Add(sheet);
        var result = new XElement(V + "Shape");
        for (var i = lineage.Count - 1; i >= 0; i--) result = Merge(result, Filter(lineage[i], category));
        return chainCache[(category, id)] = result;
    }

    private static XElement Filter(XElement sheet, string category)
    {
        var cells = category switch { "line" => LineCells, "fill" => FillCells, _ => TextCells };
        var e = new XElement(V + "Shape");
        foreach (var c in sheet.Elements(V + "Cell"))
            if ((string?)c.Attribute("N") is { } n && (cells.Contains(n) || IsThemeCell(n))) e.Add(new XElement(c));
        if (category == "text")
            foreach (var s in sheet.Elements(V + "Section"))
                if (TextSections.Contains((string?)s.Attribute("N") ?? "")) e.Add(new XElement(s));
        return e;
    }

    /// <summary>Copy without child shapes (inheritance never copies sub-shapes).</summary>
    private static XElement Strip(XElement shape)
    {
        var e = new XElement(shape.Name, shape.Attributes());
        foreach (var n in shape.Nodes()) if (n is not XElement x || x.Name != V + "Shapes") e.Add(n is XElement xe ? new XElement(xe) : n);
        return e;
    }

    private static XElement Tag(XElement shape, string origin)
    {
        foreach (var c in shape.Descendants(V + "Cell")) c.SetAttributeValue(OriginAttr, origin);
        return shape;
    }

    /// <summary>Overlays <paramref name="over"/> on <paramref name="baseEl"/>.</summary>
    internal static XElement Merge(XElement baseEl, XElement over)
    {
        var r = new XElement(over.Name);
        foreach (var a in baseEl.Attributes()) r.SetAttributeValue(a.Name, a.Value);
        foreach (var a in over.Attributes()) r.SetAttributeValue(a.Name, a.Value);
        r.Add(MergeCells(baseEl, over));
        // Sections, keyed by name + IX.
        var baseSections = baseEl.Elements(V + "Section").ToList();
        var overSections = over.Elements(V + "Section").ToList();
        static string Key(XElement s) => $"{(string?)s.Attribute("N")}#{(string?)s.Attribute("IX")}";
        var overByKey = overSections.GroupBy(Key).ToDictionary(g => g.Key, g => g.Last());
        var done = new HashSet<string>();
        foreach (var b in baseSections)
        {
            var k = Key(b);
            if (!done.Add(k)) continue;
            if (overByKey.TryGetValue(k, out var o))
            {
                if ((string?)o.Attribute("Del") != "1") r.Add(MergeSection(b, o));
            }
            else r.Add(new XElement(b));
        }
        foreach (var o in overSections)
            if (done.Add(Key(o)) && (string?)o.Attribute("Del") != "1") r.Add(new XElement(o));
        // Other content (Text, ForeignData, Data1-3, ...): the overriding shape's when present.
        var names = baseEl.Elements().Concat(over.Elements()).Select(e => e.Name).Where(n => n != V + "Cell" && n != V + "Section" && n != V + "Shapes").Distinct().ToList();
        foreach (var n in names)
        {
            var src = over.Elements(n).Any() ? over : baseEl;
            foreach (var e in src.Elements(n)) r.Add(new XElement(e));
        }
        return r;
    }

    private static IEnumerable<XElement> MergeCells(XElement baseEl, XElement over)
    {
        var cells = new Dictionary<string, XElement>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var c in baseEl.Elements(V + "Cell").Concat(over.Elements(V + "Cell")))
        {
            if ((string?)c.Attribute("N") is not { } n) continue;
            if (!cells.ContainsKey(n)) order.Add(n);
            cells[n] = new XElement(c);
        }
        return order.Select(n => cells[n]);
    }

    private static XElement MergeSection(XElement b, XElement o)
    {
        var r = new XElement(o.Name);
        foreach (var a in b.Attributes()) r.SetAttributeValue(a.Name, a.Value);
        foreach (var a in o.Attributes()) r.SetAttributeValue(a.Name, a.Value);
        r.Add(MergeCells(b, o));
        static string RowKey(XElement row) => (string?)row.Attribute("N") ?? $"#{(string?)row.Attribute("IX")}";
        var rows = new Dictionary<string, XElement>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var row in b.Elements(V + "Row")) { var k = RowKey(row); if (!rows.ContainsKey(k)) order.Add(k); rows[k] = new XElement(row); }
        foreach (var row in o.Elements(V + "Row"))
        {
            var k = RowKey(row);
            if ((string?)row.Attribute("Del") == "1") { rows.Remove(k); continue; }
            if (rows.TryGetValue(k, out var inherited))
            {
                var merged = new XElement(row.Name);
                foreach (var a in inherited.Attributes()) merged.SetAttributeValue(a.Name, a.Value); // keeps T when the local row omits it
                foreach (var a in row.Attributes()) merged.SetAttributeValue(a.Name, a.Value);
                merged.Add(MergeCells(inherited, row));
                rows[k] = merged;
            }
            else { order.Add(k); rows[k] = new XElement(row); }
        }
        r.Add(order.Where(rows.ContainsKey).Distinct().Select(k => rows[k])
            .OrderBy(x => int.TryParse((string?)x.Attribute("IX"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var ix) ? ix : int.MaxValue));
        return r;
    }
}
