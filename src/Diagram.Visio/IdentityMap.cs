using System.Security.Cryptography;
using System.Text;
using Diagram.Core.Contracts;

namespace Diagram.Visio;

/// <summary>
/// D6 identity rules. Valid unique AgentIds survive unchanged. Visio copy/paste duplicates
/// User cells: the shape whose recorded AgentNativeRef matches its own page/native ID keeps
/// the UUID (else the first in document order); copies get a UUIDv5 derived from document
/// identity, page and native ID, so re-importing unchanged bytes is repeatable.
/// </summary>
public sealed class IdentityMap(Guid documentSeed)
{
    public static readonly Guid Namespace = Guid.Parse("b6b4c2e1-0d5f-4d8b-9f43-6a8a2f9c1e77");
    private readonly HashSet<string> used = [];
    public int Preserved { get; private set; }
    public int Regenerated { get; private set; }
    public int Generated { get; private set; }

    public sealed record Candidate(int PageIndex, string NativeId, string? AgentId, string? NativeRef, int Order);

    public static Guid UuidV5(Guid ns, string name)
    {
        var hash = SHA1.HashData([.. ns.ToByteArray(bigEndian: true), .. Encoding.UTF8.GetBytes(name)]);
        var b = hash[..16];
        b[6] = (byte)((b[6] & 0x0F) | 0x50);
        b[8] = (byte)((b[8] & 0x3F) | 0x80);
        return new Guid(b, bigEndian: true);
    }

    public static bool IsUuid(string? s) => s is { Length: 36 } && Guid.TryParse(s, out _) && s == s.ToLowerInvariant();

    public string Derived(string kind, string key) => UuidV5(documentSeed, $"{kind}:{key}").ToString();

    /// <summary>Assigns final UUIDs for every candidate (keyed by "page:native").</summary>
    public Dictionary<string, string> Assign(IReadOnlyList<Candidate> candidates, List<Diagnostic> diagnostics)
    {
        var result = new Dictionary<string, string>();
        var keepers = candidates.Where(c => IsUuid(c.AgentId))
            .GroupBy(c => c.AgentId!)
            .ToDictionary(g => g.Key, g => g.OrderBy(c => c.NativeRef == $"{c.PageIndex}:{c.NativeId}" ? 0 : 1).ThenBy(c => c.Order).First());
        foreach (var c in candidates.OrderBy(c => c.Order))
        {
            var key = $"{c.PageIndex}:{c.NativeId}";
            if (IsUuid(c.AgentId) && keepers[c.AgentId!] == c && used.Add(c.AgentId!))
            {
                result[key] = c.AgentId!;
                Preserved++;
                continue;
            }
            var id = Derived("shape", key);
            while (!used.Add(id)) id = UuidV5(Guid.Parse(id), "collision").ToString();
            result[key] = id;
            if (IsUuid(c.AgentId))
            {
                Regenerated++;
                diagnostics.Add(new Diagnostic { Severity = "warning", Code = "duplicate_agent_id", Action = "regenerated", PageId = null, SourceShapeId = c.NativeId, ElementId = id, Detail = $"copy of {c.AgentId} received a new UUID" });
            }
            else
            {
                Generated++;
                diagnostics.Add(new Diagnostic { Severity = "info", Code = c.AgentId is null ? "missing_agent_id" : "invalid_agent_id", Action = "regenerated", SourceShapeId = c.NativeId, ElementId = id, Detail = "UUID derived from document identity, page and native shape ID; written back on next save" });
            }
        }
        return result;
    }
}
