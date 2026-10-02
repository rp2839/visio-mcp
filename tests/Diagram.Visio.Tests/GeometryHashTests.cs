using System.Xml.Linq;
using Diagram.Visio;
using Xunit;

namespace Diagram.Visio.Tests;

public sealed class GeometryHashTests
{
    private static readonly XNamespace V = "http://schemas.microsoft.com/office/visio/2012/main";

    [Theory]
    [InlineData("rectangle")] [InlineData("roundedRect")] [InlineData("ellipse")] [InlineData("diamond")] [InlineData("triangle")]
    [InlineData("hexagon")] [InlineData("parallelogram")] [InlineData("cylinder")] [InlineData("document")] [InlineData("cloud")]
    [InlineData("arrowRight")] [InlineData("callout")] [InlineData("star")] [InlineData("process")] [InlineData("decision")]
    public void ExportHashEqualsHashOfReimportedRows(string preset)
    {
        foreach (var (w, h) in new[] { (100.0, 60.0), (37.5, 91.25), (80, 50) })
        {
            var sub = GeometryMap.Preset(preset, w, h, 6);
            var slow = GeometryMap.Hash(GeometryMap.FromSections(V, GeometryMap.ToSections(V, sub, false, false, false), 1, 1).Subpaths);
            Assert.Equal(slow, GeometryMap.ExportHash(sub));
        }
    }
}
