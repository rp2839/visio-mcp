using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

public sealed record PreparationRecord(string PreparationId, string Sha256, DateTimeOffset ExpiresAt, string Owner);

/// <summary>
/// Validates untrusted image bytes before anything else sees them: magic-byte MIME check,
/// raster header budgets before any pixel decode, SVG allowlist sanitising, hashing of the
/// sanitised bytes and durable blob storage. The returned preparation id is an opaque
/// capability for those approved bytes; it is never a path. sourcePath is informational
/// and is never reread.
/// </summary>
public sealed partial class AssetPreparer(BlobStore blobs, TimeProvider? clock = null)
{
    private readonly TimeProvider clock = clock ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, PreparationRecord> preparations = new();
    public static readonly TimeSpan PreparationLifetime = TimeSpan.FromMinutes(30);

    /// <summary>Counts full pixel decodes; the host never decodes pixels (headers only).</summary>
    public int DecoderCalls { get; private set; }

    public sealed record Options(string Name, string? Slug = null, IReadOnlyList<string>? Tags = null, string? Provenance = null, string? SourcePath = null, string Owner = "local");

    public async Task<Result<PreparedAsset>> PrepareAsync(Stream stream, string declaredMime, Options options, CancellationToken ct)
    {
        var cap = declaredMime == "image/svg+xml" ? InputLimits.SvgBytes : InputLimits.RasterBytes;
        var bytes = await ReadCappedAsync(stream, cap, ct);
        if (bytes is null) return Result<PreparedAsset>.Fail("limit_exceeded", $"{declaredMime} exceeds {cap} bytes");
        return await PrepareBytesAsync(bytes, declaredMime, options, ct);
    }

    public async Task<Result<PreparedAsset>> PrepareBytesAsync(byte[] bytes, string declaredMime, Options options, CancellationToken ct)
    {
        var sniffed = Sniff(bytes);
        if (sniffed is null) return Result<PreparedAsset>.Fail("invalid_request", "unsupported or unrecognised image format");
        if (sniffed != declaredMime) return Result<PreparedAsset>.Fail("invalid_request", $"declared {declaredMime} but content is {sniffed}");
        int? width = null, height = null;
        var sanitised = false;
        if (sniffed == "image/svg+xml")
        {
            if (bytes.Length > InputLimits.SvgBytes) return Result<PreparedAsset>.Fail("limit_exceeded", "SVG exceeds 5 MiB");
            var s = SvgSanitiser.Sanitise(bytes);
            if (!s.Ok) return Result<PreparedAsset>.From(s.Error!);
            (bytes, sanitised, width, height) = (s.Value!.Bytes, s.Value.Changed, s.Value.Width, s.Value.Height);
        }
        else
        {
            if (bytes.Length > InputLimits.RasterBytes) return Result<PreparedAsset>.Fail("limit_exceeded", "raster exceeds 32 MiB");
            var dims = RasterHeader.Read(sniffed, bytes);
            if (dims is null) return Result<PreparedAsset>.Fail("invalid_request", $"{sniffed} header is malformed");
            var (w, h) = dims.Value;
            if (w <= 0 || h <= 0) return Result<PreparedAsset>.Fail("invalid_request", "image has no pixels");
            if (w > InputLimits.RasterSidePx || h > InputLimits.RasterSidePx || (long)w * h > InputLimits.RasterPixels)
                return Result<PreparedAsset>.Fail("limit_exceeded", $"{w}x{h} exceeds the 16384 px side / 64 Mpx budget");
            (width, height) = (w, h);
        }
        // Hash after sanitising; persist durably before any document can reference the hash.
        var sha = await blobs.PutDurableAsync(bytes, ct);
        var slug = Slug(options.Slug ?? options.Name);
        var asset = new Asset
        {
            Id = $"asset:{slug}", Name = options.Name, MimeType = sniffed, Sha256 = sha, WidthPx = width, HeightPx = height,
            Tags = [.. options.Tags ?? []], Provenance = options.Provenance, SourcePath = options.SourcePath,
        };
        var record = new PreparationRecord($"prep-{Guid.NewGuid():N}", sha, clock.GetUtcNow() + PreparationLifetime, options.Owner);
        preparations[record.PreparationId] = record;
        return Result<PreparedAsset>.Success(new PreparedAsset
        {
            Ref = new PreparedAssetRef { PreparationId = record.PreparationId, Asset = asset, ExpiresAt = record.ExpiresAt.ToString("O") },
            ByteLength = bytes.Length,
            Sanitised = sanitised,
        });
    }

    /// <summary>Checked only after a queue-head cache miss: unknown, expired, foreign or tampered refs reject.</summary>
    public Result<bool> Verify(PreparedAssetRef r, string owner = "local")
    {
        if (!preparations.TryGetValue(r.PreparationId, out var rec)) return Result<bool>.Fail("not_found", "unknown asset preparation");
        if (rec.Owner != owner) return Result<bool>.Fail("not_found", "asset preparation belongs to another client");
        if (rec.ExpiresAt < clock.GetUtcNow()) return Result<bool>.Fail("not_found", "asset preparation expired; prepare it again");
        if (rec.Sha256 != r.Asset.Sha256) return Result<bool>.Fail("invalid_request", "prepared asset descriptor does not match approved bytes");
        if (!blobs.Contains(rec.Sha256)) return Result<bool>.Fail("io_error", "prepared bytes are missing from the blob store", retryable: true);
        return Result<bool>.Success(true);
    }

    public static string? Sniff(ReadOnlySpan<byte> b)
    {
        if (b.Length >= 8 && b[..8].SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A })) return "image/png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 2 && b[0] == (byte)'B' && b[1] == (byte)'M') return "image/bmp";
        var head = Encoding.UTF8.GetString(b[..Math.Min(b.Length, 1024)]).TrimStart('﻿', ' ', '\t', '\r', '\n');
        if (head.StartsWith("<?xml", StringComparison.Ordinal) || head.StartsWith("<svg", StringComparison.Ordinal) || head.StartsWith("<!--", StringComparison.Ordinal))
            return head.Contains("<svg", StringComparison.Ordinal) ? "image/svg+xml" : null;
        return null;
    }

    public static string Slug(string name)
    {
        var s = SlugRegex().Replace(name.ToLowerInvariant(), "-").Trim('-', '.', '_');
        if (s.Length == 0) s = "asset";
        return s.Length > 100 ? s[..100] : s;
    }

    [GeneratedRegex("[^a-z0-9_.-]+")]
    private static partial Regex SlugRegex();

    private static async Task<byte[]?> ReadCappedAsync(Stream s, long cap, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        var buf = new byte[81920];
        int n;
        while ((n = await s.ReadAsync(buf, ct)) > 0)
        {
            if (ms.Length + n > cap) return null;
            ms.Write(buf, 0, n);
        }
        return ms.ToArray();
    }
}

/// <summary>Reads raster dimensions from headers only, never allocating pixel buffers.</summary>
public static class RasterHeader
{
    public static (int Width, int Height)? Read(string mime, ReadOnlySpan<byte> b) => mime switch
    {
        "image/png" => Png(b),
        "image/jpeg" => Jpeg(b),
        "image/bmp" => Bmp(b),
        _ => null,
    };

    private static (int, int)? Png(ReadOnlySpan<byte> b)
    {
        if (b.Length < 24 || Encoding.ASCII.GetString(b[12..16]) != "IHDR") return null;
        return (checked((int)BinaryPrimitives.ReadUInt32BigEndian(b[16..])), checked((int)BinaryPrimitives.ReadUInt32BigEndian(b[20..])));
    }

    private static (int, int)? Bmp(ReadOnlySpan<byte> b)
    {
        if (b.Length < 26) return null;
        var w = BinaryPrimitives.ReadInt32LittleEndian(b[18..]);
        var h = BinaryPrimitives.ReadInt32LittleEndian(b[22..]);
        return (w, Math.Abs(h));
    }

    private static (int, int)? Jpeg(ReadOnlySpan<byte> b)
    {
        var i = 2;
        while (i + 9 < b.Length)
        {
            if (b[i] != 0xFF) return null;
            var marker = b[i + 1];
            if (marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
            var len = BinaryPrimitives.ReadUInt16BigEndian(b[(i + 2)..]);
            // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
            if (marker >= 0xC0 && marker <= 0xCF && marker is not 0xC4 and not 0xC8 and not 0xCC)
                return (BinaryPrimitives.ReadUInt16BigEndian(b[(i + 7)..]), BinaryPrimitives.ReadUInt16BigEndian(b[(i + 5)..]));
            i += 2 + len;
        }
        return null;
    }
}

public sealed record SanitisedSvg(byte[] Bytes, bool Changed, int? Width, int? Height);

/// <summary>
/// Allowlist SVG sanitiser: no DTDs/entities, no scripts, event handlers, foreignObject,
/// external references or CSS fetches. External resources reject the asset outright;
/// unsupported-but-inert content is removed and reported as a change.
/// </summary>
public static class SvgSanitiser
{
    private static readonly XNamespace Svg = "http://www.w3.org/2000/svg";
    private static readonly XNamespace XLink = "http://www.w3.org/1999/xlink";
    private static readonly HashSet<string> Elements =
    [
        "svg", "g", "defs", "title", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
        "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use", "symbol", "image", "pattern",
    ];
    private static readonly HashSet<string> Attributes =
    [
        "id", "class", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "points", "viewBox",
        "preserveAspectRatio", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
        "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-miterlimit", "opacity", "font-family", "font-size",
        "font-weight", "font-style", "text-anchor", "dominant-baseline", "offset", "stop-color", "stop-opacity", "gradientUnits",
        "gradientTransform", "clip-path", "clip-rule", "mask", "href", "version", "patternUnits", "spreadMethod", "fx", "fy",
        "dx", "dy", "letter-spacing", "visibility", "display", "style",
    ];
    private static readonly Regex UnsafeCss = new(@"url\s*\(\s*['""]?\s*(?!#)|@import|expression\s*\(|javascript:", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static Result<SanitisedSvg> Sanitise(byte[] input)
    {
        XDocument doc;
        try
        {
            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = InputLimits.SvgBytes * 2,
                MaxCharactersFromEntities = 0, IgnoreProcessingInstructions = true, IgnoreComments = true,
            };
            using var reader = XmlReader.Create(new MemoryStream(input), settings);
            doc = XDocument.Load(reader, LoadOptions.None);
        }
        catch (XmlException e)
        {
            return Result<SanitisedSvg>.Fail("invalid_request", $"SVG is not safe well-formed XML: {e.Message}");
        }
        var root = doc.Root;
        if (root is null || root.Name != Svg + "svg") return Result<SanitisedSvg>.Fail("invalid_request", "root element must be svg:svg");
        if (doc.Descendants().Count() > InputLimits.SvgElements) return Result<SanitisedSvg>.Fail("limit_exceeded", "SVG has too many elements");
        var changed = false;
        foreach (var e in root.DescendantsAndSelf().ToList())
        {
            if (e != root && e.Document is null) continue; // removed together with an ancestor
            if (e.Name.Namespace != Svg || !Elements.Contains(e.Name.LocalName))
            {
                e.Remove();
                changed = true;
                continue;
            }
            foreach (var a in e.Attributes().ToList())
            {
                if (a.IsNamespaceDeclaration) continue;
                var local = a.Name.LocalName;
                var isHref = local == "href" && (a.Name.Namespace == XLink || a.Name.Namespace == XNamespace.None);
                if (isHref)
                {
                    var v = a.Value.Trim();
                    if (v.StartsWith('#')) continue;
                    if (e.Name.LocalName == "image" && (v.StartsWith("data:image/png;base64,") || v.StartsWith("data:image/jpeg;base64,")))
                    {
                        if (v.Length * 3L / 4 > InputLimits.SvgEmbeddedRasterBytes) return Result<SanitisedSvg>.Fail("limit_exceeded", "embedded raster in SVG is too large");
                        continue;
                    }
                    return Result<SanitisedSvg>.Fail("invalid_request", $"SVG references an external resource ({Truncate(v)})");
                }
                if (local.StartsWith("on", StringComparison.OrdinalIgnoreCase) || a.Name.Namespace != XNamespace.None || !Attributes.Contains(local))
                {
                    a.Remove();
                    changed = true;
                    continue;
                }
                if (UnsafeCss.IsMatch(a.Value))
                {
                    if (a.Value.Contains("url", StringComparison.OrdinalIgnoreCase) && !a.Value.Contains("url(#", StringComparison.OrdinalIgnoreCase))
                        return Result<SanitisedSvg>.Fail("invalid_request", "SVG style fetches an external resource");
                    a.Remove();
                    changed = true;
                }
            }
        }
        int? w = Dim(root.Attribute("width")?.Value), h = Dim(root.Attribute("height")?.Value);
        if ((w is null || h is null) && root.Attribute("viewBox")?.Value.Split([' ', ','], StringSplitOptions.RemoveEmptyEntries) is { Length: 4 } vb
            && double.TryParse(vb[2], System.Globalization.CultureInfo.InvariantCulture, out var vw)
            && double.TryParse(vb[3], System.Globalization.CultureInfo.InvariantCulture, out var vh))
            (w, h) = ((int)Math.Ceiling(vw), (int)Math.Ceiling(vh));
        var output = changed ? Encoding.UTF8.GetBytes(doc.Root!.ToString(SaveOptions.DisableFormatting)) : input;
        return Result<SanitisedSvg>.Success(new SanitisedSvg(output, changed, w, h));
    }

    private static int? Dim(string? v) =>
        v is not null && double.TryParse(v.TrimEnd('p', 'x'), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) && d > 0 ? (int)Math.Ceiling(d) : null;

    private static string Truncate(string s) => s.Length > 60 ? s[..60] + "…" : s;
}
