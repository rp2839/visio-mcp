using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;

namespace Diagram.Host.Core;

/// <summary>
/// Resolves asset IDs with explicit scope. Document scope: a bare slug is the pinned document
/// version. Library scope: the current version, or a specific earlier hash. A library asset
/// whose slug is already pinned in the document with different bytes resolves to
/// asset:&lt;slug&gt;~&lt;full-sha256&gt;, and the result says so.
/// </summary>
public sealed class AssetResolver(AssetLibrary library, AssetPreparer preparer, IEditorChannel editor)
{
    public sealed record Resolved(PreparedAsset Prepared, string Scope, int? Version, bool Versioned);

    public async Task<Result<Resolved>> ResolveAsync(string id, Scope scope, string? sha256, CancellationToken ct)
    {
        var doc = await DocumentAssetsAsync(scope, ct);
        if (!doc.Ok) return Result<Resolved>.From(doc.Error!);
        var pinned = doc.Value!.FirstOrDefault(a => a.Id == id);
        if (pinned is not null && (sha256 is null || sha256 == pinned.Sha256))
        {
            var issued = preparer.Issue(pinned, 0);
            return issued.Ok ? Result<Resolved>.Success(new Resolved(issued.Value!, "document", null, id.Contains('~'))) : Result<Resolved>.From(issued.Error!);
        }
        var lib = await library.GetAsync(id.Split('~')[0], ct);
        if (lib is null) return Result<Resolved>.Fail("not_found", $"asset {id} is in neither the document nor the library");
        var sha = sha256 ?? lib.Sha256;
        if (sha != lib.Sha256 && !lib.PreviousSha256.Contains(sha)) return Result<Resolved>.Fail("not_found", $"library asset {lib.Id} has no version {sha[..Math.Min(12, sha.Length)]}…");
        var collides = doc.Value!.Any(a => a.Id == lib.Id && a.Sha256 != sha);
        var asset = lib.ToAsset(collides ? $"{lib.Id}~{sha}" : lib.Id) with { Sha256 = sha };
        var r = preparer.Issue(asset, lib.ByteLength);
        return r.Ok ? Result<Resolved>.Success(new Resolved(r.Value!, "library", lib.Version, collides)) : Result<Resolved>.From(r.Error!);
    }

    private async Task<Result<List<Asset>>> DocumentAssetsAsync(Scope scope, CancellationToken ct)
    {
        var snap = await editor.CallAsync("doc.snapshot", scope, new JsonObject(), ct);
        if (!snap.Ok) return Result<List<Asset>>.From(snap.Error!);
        return Result<List<Asset>>.Success(snap.Value.Deserialize<Snapshot>(ContractJson.Options)!.Document.Assets);
    }
}

/// <summary>
/// assets.list: document assets (scope "document", pinned) plus per-user library assets (scope
/// "library", version), each library entry with a fresh preparedRef usable in registerAsset or
/// DrawScript `asset import`.
/// </summary>
public sealed class AssetsListService(AssetLibrary library, AssetResolver resolver, IEditorChannel editor) : IHostRequestService
{
    public bool Handles(string method) => method == "assets.list";

    public async Task<ResponseEnvelope> HandleAsync(RequestEnvelope request, CancellationToken ct)
    {
        if (request.DocumentId is null || request.SessionId is null) return HostRequestHandler.Error(request.RequestId, "invalid_request", "documentId and sessionId are required");
        var scope = new Scope { DocumentId = request.DocumentId, SessionId = request.SessionId };
        string? query = null;
        List<string>? tags = null;
        if (request.Params.ValueKind == JsonValueKind.Object)
        {
            if (request.Params.TryGetProperty("query", out var q) && q.ValueKind == JsonValueKind.String) query = q.GetString();
            if (request.Params.TryGetProperty("tags", out var t) && t.ValueKind == JsonValueKind.Array) tags = t.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList();
        }
        var snap = await editor.CallAsync("doc.snapshot", scope, new JsonObject(), ct);
        if (!snap.Ok) return HostRequestHandler.Error(request.RequestId, snap.Error!.Code, snap.Error.Message, snap.Error.Retryable);
        var snapshot = snap.Value.Deserialize<Snapshot>(ContractJson.Options)!;
        var items = new JsonArray();
        foreach (var a in snapshot.Document.Assets.Where(a => Matches(a.Name, a.Id, a.Tags, query) && (tags is null || tags.All(x => a.Tags.Contains(x, StringComparer.OrdinalIgnoreCase)))))
        {
            var node = JsonNode.Parse(ContractJson.Serialize(a with { SourcePath = null, EmbeddedData = null }))!.AsObject();
            node["scope"] = "document";
            node["version"] = a.Id.Contains('~') ? a.Sha256[..12] : "pinned";
            node["usedBy"] = snapshot.Document.Pages.SelectMany(p => p.Elements).OfType<ImageElement>().Count(i => i.AssetId == a.Id);
            items.Add(node);
        }
        foreach (var l in await library.ListAsync(query, tags, ct))
        {
            var resolved = await resolver.ResolveAsync(l.Id, scope, l.Sha256, ct);
            if (resolved.Ok && resolved.Value!.Scope == "document") continue; // already listed as the pinned document asset
            var node = JsonNode.Parse(ContractJson.Serialize(l.ToAsset()))!.AsObject();
            node["scope"] = "library";
            node["version"] = l.Version;
            if (resolved.Ok)
            {
                node["documentAssetId"] = resolved.Value!.Prepared.Ref.Asset.Id;
                node["preparedRef"] = JsonNode.Parse(ContractJson.Serialize(resolved.Value.Prepared.Ref));
            }
            items.Add(node);
        }
        var result = new JsonObject { ["documentId"] = snapshot.DocumentId, ["sessionId"] = snapshot.SessionId, ["revision"] = snapshot.Revision, ["assets"] = items };
        return new ResponseEnvelope
        {
            ProtocolVersion = 1, Kind = "response", RequestId = request.RequestId, DocumentId = snapshot.DocumentId, SessionId = snapshot.SessionId,
            Result = JsonSerializer.SerializeToElement(result),
        };
    }

    private static bool Matches(string name, string id, IEnumerable<string> tags, string? q) => string.IsNullOrWhiteSpace(q)
        || name.Contains(q, StringComparison.OrdinalIgnoreCase) || id.Contains(q, StringComparison.OrdinalIgnoreCase) || tags.Any(t => t.Contains(q, StringComparison.OrdinalIgnoreCase));
}
