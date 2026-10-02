using Diagram.Core.Contracts;

namespace Diagram.Visio.Abstractions;

public sealed record ImportOptions(string? SourcePath = null);

public sealed record IdentityReport(int Preserved, int Regenerated, int Generated, bool DocumentIdentityPreserved);

/// <summary>Whole-candidate import: validated blobs keyed by SHA-256, diagnostics for every loss.</summary>
public sealed record ImportResult(DiagramDocument Document, IReadOnlyDictionary<string, byte[]> Blobs, IReadOnlyList<Diagnostic> Diagnostics, IdentityReport Identity)
{
    public bool Lossy => Diagnostics.Any(d => d.Action is "dropped" or "approximated");
}

public interface IVsdxImporter
{
    /// <summary>Stream must already have passed PackageGuard.</summary>
    Task<ImportResult> ImportAsync(Stream validatedPackage, ImportOptions options, CancellationToken ct);
}

public sealed class VsdxException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
