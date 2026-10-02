using Diagram.Core.Contracts;

namespace Diagram.Visio.Abstractions;

/// <summary>Supplies approved bytes by SHA-256 only; mappers never open arbitrary paths.</summary>
public interface IAssetBlobSource
{
    Task<ReadOnlyMemory<byte>> ReadAsync(string sha256, CancellationToken ct);
    /// <summary>PNG derivative for an SVG asset (rendered by the frontend), or null when unavailable.</summary>
    Task<ReadOnlyMemory<byte>?> ReadRasterFallbackAsync(string sha256, CancellationToken ct);
}

public sealed record ExportOptions(string BackendName = "direct-opc", bool SelfCheck = true);

public sealed record ExportResult(byte[] Package, IReadOnlyList<Diagnostic> Diagnostics, IReadOnlyDictionary<string, string> NativeIds);

public interface IVsdxExporter
{
    /// <summary>Maps one revision-matched export snapshot (document + projection sidecar) to a package.</summary>
    Task<ExportResult> ExportAsync(ExportSnapshot snapshot, IAssetBlobSource blobs, ExportOptions options, CancellationToken ct);
}
