namespace VsdxProbe;

public enum ProbeKind { Rectangle, Ellipse, TextBox, Picture }

public sealed record ProbeElement(Guid AgentId, ProbeKind Kind, double X, double Y, double Width, double Height, string? Text = null, string? Fill = null);

public sealed record ProbeBounds(double X, double Y, double Width, double Height);

public sealed record ProbeDiagnostic(string Severity, string Code, string Action, string Detail);

/// <summary>Plain probe scene in canonical units (points, top-left origin, clockwise degrees).</summary>
public sealed record ProbeSceneDto(
    double PageWidthPt,
    double PageHeightPt,
    IReadOnlyList<ProbeElement> Elements,
    Guid ConnectorId,
    Guid ConnectorFrom,
    Guid ConnectorTo,
    double RectangleRotationDeg = 0,
    string? ConnectorFromPort = null,
    string? ConnectorToPort = null,
    byte[]? PictureBytes = null,
    string? SvgSource = null,
    string LayerName = "Agents");

public sealed class ProbeManifest
{
    public double PageWidthPt { get; set; }
    public double PageHeightPt { get; set; }
    public int DrawableCount { get; set; }
    public Guid RectangleAgentId { get; set; }
    public string RectangleId { get; set; } = "";
    public string EllipseId { get; set; } = "";
    public string? ConnectorFromShapeId { get; set; }
    public string? ConnectorToShapeId { get; set; }
    public string? ConnectorFromPort { get; set; }
    public string? ConnectorToPort { get; set; }
    public string RectangleText { get; set; } = "";
    public string? RectangleFill { get; set; }
    public double RectangleRotationDeg { get; set; }
    public List<string> RectangleLayers { get; } = new();
    public string ImageHash { get; set; } = "";
    public bool HasPageBitmap { get; set; }
    public string? PreservedSvgSource { get; set; }
    public List<Guid> AgentIds { get; } = new();
    public Dictionary<Guid, ProbeBounds> Bounds { get; } = new();
    public List<ProbeDiagnostic> Diagnostics { get; } = new();
}
