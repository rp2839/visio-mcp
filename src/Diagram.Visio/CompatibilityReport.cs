using Diagram.Core.Contracts;

namespace Diagram.Visio;

/// <summary>
/// User-facing summary of a VSDX import/export: what was kept, approximated or dropped.
/// A lossy import must not be silently saved back over its source (Save As guard).
/// </summary>
public sealed record CompatibilityReport(
    int Approximated, int Dropped, int Regenerated, IReadOnlyDictionary<string, int> ByCode, IReadOnlyList<Diagnostic> Diagnostics)
{
    public bool Lossy => Approximated > 0 || Dropped > 0;
    public bool RequiresSaveAs => Lossy;

    public static CompatibilityReport From(IEnumerable<Diagnostic> diagnostics)
    {
        var list = diagnostics.ToList();
        return new CompatibilityReport(
            list.Count(d => d.Action == "approximated"),
            list.Count(d => d.Action == "dropped"),
            list.Count(d => d.Action == "regenerated"),
            list.GroupBy(d => d.Code).OrderBy(g => g.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Count()),
            list);
    }
}
