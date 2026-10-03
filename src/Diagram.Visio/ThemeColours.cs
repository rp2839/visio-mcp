using System.Xml.Linq;

namespace Diagram.Visio;

/// <summary>
/// Colours of a Visio theme part (DrawingML clrScheme plus Visio variation colours), addressed
/// the way QuickStyle*Color cells do: 0 Dark, 1 Light, 2–7 Accent 1–6, and 100+ variation
/// colours of the current variation scheme. Fill matrices (tints, gradients) are not applied.
/// </summary>
internal sealed class ThemeColours
{
    private readonly Dictionary<string, string> scheme = new(StringComparer.Ordinal);
    private readonly List<List<string>> variations = [];

    public bool Available => scheme.Count > 0;

    public ThemeColours(XDocument? theme)
    {
        if (theme?.Root is null) return;
        var clr = theme.Descendants().FirstOrDefault(e => e.Name.LocalName == "clrScheme");
        if (clr is not null)
            foreach (var slot in clr.Elements())
                if (Rgb(slot) is { } rgb) scheme[slot.Name.LocalName] = rgb;
        foreach (var v in theme.Descendants().Where(e => e.Name.LocalName == "variationClrScheme"))
            variations.Add(v.Elements().Where(e => e.Name.LocalName.StartsWith("varColor", StringComparison.Ordinal))
                .OrderBy(e => e.Name.LocalName, StringComparer.Ordinal).Select(Rgb).OfType<string>().ToList());
    }

    private static string? Rgb(XElement slot)
    {
        var c = slot.Elements().FirstOrDefault();
        var hex = c?.Name.LocalName switch
        {
            "srgbClr" => (string?)c.Attribute("val"),
            "sysClr" => (string?)c.Attribute("lastClr"),
            _ => null,
        };
        return hex is { Length: 6 } ? "#" + hex.ToUpperInvariant() : null;
    }

    /// <summary>Colour for a QuickStyle colour index, or null when the theme does not define it.</summary>
    public string? ForQuickStyle(int index, int variation = 0)
    {
        if (index >= 100)
        {
            var scheme = variations.Count == 0 ? null : variations[Math.Clamp(variation, 0, variations.Count - 1)];
            if (scheme is not null && index - 100 < scheme.Count) return scheme[index - 100];
            index = 2 + (index - 100); // no variation colours: nearest accent
        }
        var slot = index switch
        {
            0 => "dk1", 1 => "lt1", 2 => "accent1", 3 => "accent2", 4 => "accent3", 5 => "accent4", 6 => "accent5", 7 => "accent6", _ => null,
        };
        return slot is not null && scheme.TryGetValue(slot, out var rgb) ? rgb : null;
    }
}
