using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using ModelContextProtocol.Protocol;

namespace Diagram.Mcp;

/// <summary>Maps application responses to MCP tool results: structured JSON plus readable text.</summary>
internal static class ToolResults
{
    public static CallToolResult From(ResponseEnvelope r)
    {
        if (r.Error is { } e) return Error(e);
        var json = r.Result.ValueKind == JsonValueKind.Undefined ? "{}" : r.Result.GetRawText();
        return new CallToolResult { Content = [new TextContentBlock { Text = json }], StructuredContent = JsonDocument.Parse(json).RootElement.Clone() };
    }

    public static CallToolResult Error(AppError e)
    {
        var json = ContractJson.Serialize(e);
        return new CallToolResult { IsError = true, Content = [new TextContentBlock { Text = json }], StructuredContent = JsonDocument.Parse(json).RootElement.Clone() };
    }

    public static CallToolResult Invalid(string message) => Error(new AppError { Code = "invalid_request", Message = message, Retryable = false, Outcome = "not_applied" });

    /// <summary>Render results carry a real MCP image block plus JSON metadata (never hidden text-only base64).</summary>
    public static CallToolResult Image(ResponseEnvelope r)
    {
        if (r.Error is { } e) return Error(e);
        var meta = JsonNode.Parse(r.Result.GetRawText())!.AsObject();
        var data = meta["data"]?.GetValue<string>() ?? "";
        var mime = meta["mimeType"]?.GetValue<string>() ?? "image/png";
        meta.Remove("data");
        var metaJson = meta.ToJsonString();
        return new CallToolResult
        {
            Content = [ImageContentBlock.FromBytes(Convert.FromBase64String(data), mime), new TextContentBlock { Text = metaJson }],
            StructuredContent = JsonDocument.Parse(metaJson).RootElement.Clone(),
        };
    }
}
