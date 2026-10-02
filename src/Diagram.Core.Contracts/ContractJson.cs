using System.Text.Json;
using System.Text.Json.Serialization;

namespace Diagram.Core.Contracts;

/// <summary>Serializer settings matching the TypeScript wire form exactly.</summary>
public static class ContractJson
{
    public static readonly JsonSerializerOptions Options = Create();

    private static JsonSerializerOptions Create()
    {
        var o = new JsonSerializerOptions
        {
            // TS emits discriminators wherever they fall in the object.
            AllowOutOfOrderMetadataProperties = true,
            NumberHandling = JsonNumberHandling.Strict,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        o.MakeReadOnly(populateMissingResolver: true);
        return o;
    }

    public static T Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options) ?? throw new JsonException("null payload");
    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
}

/// <summary>Uniform access to common element fields across the generated union.</summary>
public static class ElementExtensions
{
    public static string Id(this Element e) => e switch
    {
        ShapeElement s => s.Id, TextElement t => t.Id, ImageElement i => i.Id, ConnectorElement c => c.Id, GroupElement g => g.Id,
        _ => throw new ArgumentOutOfRangeException(nameof(e)),
    };

    public static Bounds Bounds(this Element e) => e switch
    {
        ShapeElement s => s.Bounds, TextElement t => t.Bounds, ImageElement i => i.Bounds, ConnectorElement c => c.Bounds, GroupElement g => g.Bounds,
        _ => throw new ArgumentOutOfRangeException(nameof(e)),
    };

    public static long ZIndex(this Element e) => e switch
    {
        ShapeElement s => s.ZIndex, TextElement t => t.ZIndex, ImageElement i => i.ZIndex, ConnectorElement c => c.ZIndex, GroupElement g => g.ZIndex,
        _ => throw new ArgumentOutOfRangeException(nameof(e)),
    };

    public static string Kind(this Element e) => e switch
    {
        ShapeElement => "shape", TextElement => "text", ImageElement => "image", ConnectorElement => "connector", GroupElement => "group",
        _ => throw new ArgumentOutOfRangeException(nameof(e)),
    };
}
