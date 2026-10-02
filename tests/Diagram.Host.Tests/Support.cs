using System.Buffers.Binary;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Host.Core;

namespace Diagram.Host.Tests;

public sealed class TempDir : IDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory("diagram-host-").FullName;
    public string File(string name) => System.IO.Path.Combine(Path, name);
    public void Dispose() { try { Directory.Delete(Path, true); } catch { /* best effort */ } }
}

public static class Png
{
    public static byte[] Create(int width, int height, bool truncateAfterHeader = false)
    {
        var rowBytes = 1 + width * 3;
        byte[] idat;
        if (truncateAfterHeader) idat = [];
        else
        {
            var raw = new byte[height * rowBytes];
            using var ms = new MemoryStream();
            using (var z = new ZLibStream(ms, CompressionLevel.Fastest, true)) z.Write(raw);
            idat = ms.ToArray();
        }
        using var png = new MemoryStream();
        png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var ihdr = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(ihdr, width);
        BinaryPrimitives.WriteInt32BigEndian(ihdr.AsSpan(4), height);
        ihdr[8] = 8; ihdr[9] = 2;
        Chunk(png, "IHDR", ihdr);
        Chunk(png, "IDAT", idat);
        Chunk(png, "IEND", []);
        return png.ToArray();
    }

    private static void Chunk(Stream s, string type, byte[] data)
    {
        var len = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(len, data.Length);
        s.Write(len);
        var typed = new byte[4 + data.Length];
        for (var i = 0; i < 4; i++) typed[i] = (byte)type[i];
        data.CopyTo(typed, 4);
        s.Write(typed);
        uint crc = 0xFFFFFFFF;
        foreach (var b in typed) { crc ^= b; for (var k = 0; k < 8; k++) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320 : crc >> 1; }
        BinaryPrimitives.WriteUInt32BigEndian(len, ~crc);
        s.Write(len);
    }
}

/// <summary>
/// Stand-in for the frontend engine's lifecycle methods: scope check, expected revision,
/// fresh session on replace, saved revision per session. Holds generated DTOs only.
/// </summary>
public sealed class FakeEditor : IEditorChannel
{
    public DiagramDocument Document { get; private set; }
    public string SessionId { get; private set; } = Guid.NewGuid().ToString();
    public long Revision => Document.Revision;
    public long? SavedRevision { get; private set; }
    public bool IsDirty => SavedRevision != Revision;
    public Func<string, Task>? BeforeHandling { get; set; }
    public List<string> Calls { get; } = [];
    public Action<DiagramDocument>? OnReplace { get; set; }
    /// <summary>PNG returned for asset.rasterize; null → the frontend cannot rasterise.</summary>
    public byte[]? RasterPng { get; set; }

    public FakeEditor(DiagramDocument doc) => Document = doc;

    public Scope Scope => new() { DocumentId = Document.Id, SessionId = SessionId };

    /// <summary>Simulates a committed human edit (revision + 1).</summary>
    public void Edit() => Document = Document with { Revision = Document.Revision + 1, Title = Document.Title + "*" };
    public void NewSession() => SessionId = Guid.NewGuid().ToString();

    public async Task<Result<JsonElement>> CallAsync(string method, Scope? scope, JsonObject p, CancellationToken ct)
    {
        Calls.Add(method);
        if (BeforeHandling is not null) await BeforeHandling(method);
        if (scope is null || scope.DocumentId != Document.Id) return Result<JsonElement>.Fail("document_mismatch", "doc");
        if (scope.SessionId != SessionId) return Result<JsonElement>.Fail("session_mismatch", "session");
        switch (method)
        {
            case "doc.snapshot":
                return Ok(new Snapshot { DocumentId = Document.Id, SessionId = SessionId, Revision = Document.Revision, Document = Document });
            case "doc.exportSnapshot":
                var projection = new Projection { DocumentId = Document.Id, SessionId = SessionId, Revision = Document.Revision };
                return Ok(new ExportSnapshot { DocumentId = Document.Id, SessionId = SessionId, Revision = Document.Revision, Document = Document, Projection = projection });
            case "asset.rasterize":
                if (RasterPng is null) return Result<JsonElement>.Fail("not_found", "no raster");
                return Ok(new JsonObject { ["mimeType"] = "image/png", ["data"] = Convert.ToBase64String(RasterPng) });
            case "doc.markSaved":
                SavedRevision = p["revision"]!.GetValue<long>();
                return Ok(new JsonObject());
            case "doc.replace":
                if (p["baseRevision"]!.GetValue<long>() != Revision) return Result<JsonElement>.Fail("revision_conflict", "edited during IO");
                var doc = ContractJson.Deserialize<DiagramDocument>(p["document"]!.ToJsonString());
                OnReplace?.Invoke(doc);
                Document = doc;
                SessionId = Guid.NewGuid().ToString();
                SavedRevision = p["savedRevision"]?.GetValue<long>();
                return Ok(new Snapshot { DocumentId = Document.Id, SessionId = SessionId, Revision = Document.Revision, Document = Document });
        }
        return Result<JsonElement>.Fail("method_not_found", method);
    }

    private static Result<JsonElement> Ok<T>(T value) => Result<JsonElement>.Success(JsonSerializer.SerializeToElement(value, ContractJson.Options));
}

public static class Docs
{
    public const string DocId = "00000000-0000-4000-8000-000000000001";
    public const string PageId = "00000000-0000-4000-8000-000000000002";
    public const string ImageId = "00000000-0000-4000-8000-000000000100";
    public const string ShapeId = "00000000-0000-4000-8000-000000000101";

    public static DiagramDocument WithImage(string sha, string mime = "image/png") => new()
    {
        SchemaVersion = 1, Id = DocId, Title = "Doc", Revision = 3, Metadata = new(),
        Assets = [new Asset { Id = "asset:logo", Name = "Logo", MimeType = mime, Sha256 = sha, Tags = ["logo"], SourcePath = "/somewhere/never/read.png" }],
        Pages =
        [
            new Page
            {
                Id = PageId, Name = "Page-1", WidthPt = 841.89, HeightPt = 595.28, Background = "#FFFFFF",
                Grid = new PageGrid { Visible = true, SpacingPt = 14.17, Snap = true }, Guides = [], Layers = [],
                Elements =
                [
                    new ImageElement { Id = ImageId, Alias = "logo", LayerIds = [], ZIndex = 0, Bounds = new Bounds { X = 10, Y = 10, Width = 100, Height = 40 }, Metadata = new(), AssetId = "asset:logo", Fit = "contain", Opacity = 1, PreserveAspectRatio = true },
                    new ShapeElement
                    {
                        Id = ShapeId, LayerIds = [], ZIndex = 1, Bounds = new Bounds { X = 200, Y = 10, Width = 100, Height = 60 }, Metadata = new(),
                        Geometry = new ShapeGeometry { Preset = "rectangle" },
                        Style = new ShapeStyle { Fill = "#FFFFFF", FillOpacity = 1, Stroke = "#333333", StrokeWidthPt = 1, Dash = "solid", LineCap = "butt", LineJoin = "miter" },
                    },
                ],
            },
        ],
    };
}
