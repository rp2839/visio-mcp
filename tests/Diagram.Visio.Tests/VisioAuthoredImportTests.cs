using Diagram.Core.Contracts;
using Diagram.Visio;
using Xunit;

namespace Diagram.Visio.Tests;

/// <summary>Import of Visio-authored (stencil/master/theme) drawings; regression tests for Windows findings 3–5.</summary>
public sealed class VisioAuthoredImportTests
{
    private static async Task<(DiagramDocument Doc, IReadOnlyList<Diagnostic> Diags)> ImportAsync()
    {
        var r = await Scene.ImportAsync(VisioAuthored.Build());
        return (r.Document, r.Diagnostics);
    }

    private static Element ByNative(DiagramDocument d, int nativeIndex) => d.Pages[0].Elements.OrderBy(e => e.ZIndex()).ElementAt(nativeIndex);

    private static List<(double U, double V)> Points(string svg) =>
        System.Text.RegularExpressions.Regex.Matches(svg, @"-?\d+(\.\d+)?(e-?\d+)?").Select(m => double.Parse(m.Value, System.Globalization.CultureInfo.InvariantCulture))
            .Chunk(2).Where(c => c.Length == 2).Select(c => (c[0], c[1])).ToList();

    [Fact]
    public async Task PartialLocalGeometryMergesOverMasterRows()
    {
        var (doc, _) = await ImportAsync();
        var circle = (ShapeElement)ByNative(doc, 0);
        Assert.NotEqual("rectangle", circle.Geometry.Preset);
        Assert.Contains("C", circle.Geometry.SvgPath);
        var cp = Points(circle.Geometry.SvgPath!);
        Assert.InRange(cp.Min(p => p.U), -0.01, 0.01); Assert.InRange(cp.Max(p => p.U), 0.99, 1.01); // spans the full 2 in width (X/A/C local)
        Assert.InRange(cp.Min(p => p.V), -0.01, 0.01); Assert.InRange(cp.Max(p => p.V), 0.99, 1.01); // Y/B/D inherited from the master
        Assert.Equal("Circle", circle.Text?.Value); // master text inherited

        var pentagon = (ShapeElement)ByNative(doc, 1);
        Assert.Equal("custom", pentagon.Geometry.Preset);
        var pp = Points(pentagon.Geometry.SvgPath!).Distinct().ToList();
        Assert.Equal(5, pp.Count);
        Assert.Contains(pp, p => Math.Abs(p.U - 0.5) < 1e-6 && Math.Abs(p.V) < 1e-6);       // apex: local X 1 in of 2, inherited Y
        Assert.Contains(pp, p => Math.Abs(p.U - 0.809) < 1e-6 && Math.Abs(p.V - 1) < 1e-6); // local X 1.618 of 2, inherited Y 0
    }

    [Fact]
    public async Task NurbsAndPolylineRowsKeepTheirOutline()
    {
        var (doc, _) = await ImportAsync();
        var cloud = (ShapeElement)ByNative(doc, 2);
        Assert.Equal("custom", cloud.Geometry.Preset);
        var pts = Points(cloud.Geometry.SvgPath!);
        Assert.True(pts.Count > 10, "NURBS sampled into a curve, not one line");
        Assert.Contains(pts, p => p.V < 0.2);                      // bulges up towards the control points (y 1.2 in Visio)
        Assert.Contains(pts, p => Math.Abs(p.U - 0.75) < 1e-6 && Math.Abs(p.V - 1) < 1e-6); // polyline vertex
    }

    [Fact]
    public async Task ThemeAndStyleSheetColoursResolve()
    {
        var (doc, diags) = await ImportAsync();
        var circle = (ShapeElement)ByNative(doc, 0);
        Assert.Equal(VisioAuthored.Accent1, circle.Style.Fill);   // style sheet THEMEVAL + master QuickStyleFillColor=2
        Assert.Equal(VisioAuthored.Light, circle.Text!.Colour);   // QuickStyleFontColor=1, not black/white-on-white guess
        Assert.Equal("#000000", circle.Style.Stroke);              // QuickStyleLineColor=0 (dark)
        Assert.InRange(circle.Style.StrokeWidthPt, 0.74, 0.76);    // LineWeight from style sheet 0 via 3
        Assert.Equal(12, circle.Text.FontSizePt, 3);               // Character Size from style sheet 0
        Assert.Equal(VisioAuthored.Accent3, ((ShapeElement)ByNative(doc, 3)).Style.Fill); // local QuickStyleFillColor wins
        Assert.Equal(VisioAuthored.Variation1, ((ShapeElement)ByNative(doc, 4)).Style.Fill); // variation colour 100
        Assert.Equal("#00FF00", ((ShapeElement)ByNative(doc, 5)).Style.Fill); // value cached on the shape itself is trusted
        Assert.Contains(diags, d => d.Code == "theme_colour");
    }

    [Fact]
    public async Task ConnectorRouteStyles()
    {
        var (doc, _) = await ImportAsync();
        var routes = doc.Pages[0].Elements.OfType<ConnectorElement>().OrderBy(c => c.ZIndex).Select(c => c.Route).ToList();
        Assert.Equal(["straight", "straight", "orthogonal", "straight"], routes); // 16+1, 0+1, 1+0, 2+0
    }

    [Theory]
    [InlineData(16, 1, "straight")] [InlineData(0, 1, "straight")] [InlineData(2, 0, "straight")] [InlineData(1, 1, "orthogonal")]
    [InlineData(16, 0, "orthogonal")] [InlineData(0, 2, "curved")] [InlineData(1, 0, "orthogonal")]
    public void RouteRule(double srs, double clre, string expected) => Assert.Equal(expected, DirectVsdxImporter.RouteOf(srs, clre));
}
