using System.IO.Compression;
using System.Text;

namespace Diagram.Visio.Tests;

/// <summary>
/// Builds a package shaped like a Visio-saved stencil diagram (not app-authored): style sheets
/// with THEMEVAL cells, a theme part, masters, and instances that store only the cells that differ
/// from their master (partial Geometry rows without T, missing X or Y). No Agent* cells.
/// </summary>
public static class VisioAuthored
{
    private const string Ns = "http://schemas.microsoft.com/office/visio/2012/main";
    private const string RNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private const string PRel = "http://schemas.openxmlformats.org/package/2006/relationships";

    public const string Accent1 = "#5B9BD5", Accent3 = "#A5A5A5", Light = "#FFFFFF", Variation1 = "#123456";

    private static string Rels(params (string Id, string Type, string Target)[] r) =>
        $"<Relationships xmlns=\"{PRel}\">" + string.Concat(r.Select(x => $"<Relationship Id=\"{x.Id}\" Type=\"{x.Type}\" Target=\"{x.Target}\"/>")) + "</Relationships>";

    private const string Theme = """
        <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office">
        <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
        <a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
        <a:accent1><a:srgbClr val="5B9BD5"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
        <a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="4472C4"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
        <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme></a:themeElements>
        <a:extLst><a:ext uri="{E5B1A0C4-0000-0000-0000-000000000000}"><vt:variationClrSchemeLst xmlns:vt="http://schemas.microsoft.com/office/visio/2012/theme">
        <vt:variationClrScheme><vt:varColor1><a:srgbClr val="123456"/></vt:varColor1><vt:varColor2><a:srgbClr val="654321"/></vt:varColor2></vt:variationClrScheme>
        </vt:variationClrSchemeLst></a:ext></a:extLst></a:theme>
        """;

    // Style sheet 0 has plain cached colours; style sheet 3 ("Theme") is themed and inherits from 0.
    private const string Document = $"""
        <VisioDocument xmlns="{Ns}" xmlns:r="{RNs}"><FaceNames><FaceName ID="0" NameU="Calibri"/></FaceNames><StyleSheets>
        <StyleSheet ID="0" NameU="No Style" LineStyle="0" FillStyle="0" TextStyle="0">
          <Cell N="LineWeight" V="0.01041666666666667"/><Cell N="LineColor" V="#000000"/><Cell N="LinePattern" V="1"/>
          <Cell N="FillForegnd" V="#ffffff"/><Cell N="FillPattern" V="1"/><Cell N="VerticalAlign" V="1"/>
          <Section N="Character"><Row IX="0"><Cell N="Font" V="0"/><Cell N="Color" V="#000000"/><Cell N="Size" V="0.1666666666666667"/></Row></Section>
        </StyleSheet>
        <StyleSheet ID="3" NameU="Theme" LineStyle="0" FillStyle="0" TextStyle="0">
          <Cell N="LineColor" V="Themed" F="THEMEVAL()"/><Cell N="FillForegnd" V="#ffffff" F="THEMEVAL()"/>
          <Section N="Character"><Row IX="0"><Cell N="Color" V="Themed" F="THEMEVAL()"/></Row></Section>
        </StyleSheet></StyleSheets></VisioDocument>
        """;

    private static string Master(string body) => $"<MasterContents xmlns=\"{Ns}\" xmlns:r=\"{RNs}\"><Shapes>{body}</Shapes></MasterContents>";

    // Master geometry is cached for a 1 in × 1 in master. Theme: fill accent1, text light, line dark.
    private const string ThemeCells = "<Cell N=\"QuickStyleFillColor\" V=\"2\"/><Cell N=\"QuickStyleLineColor\" V=\"0\"/><Cell N=\"QuickStyleFontColor\" V=\"1\"/>";
    private static string Circle => Master($"""
        <Shape ID="5" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3"><Cell N="Width" V="1"/><Cell N="Height" V="1"/><Cell N="LocPinX" V="0.5"/><Cell N="LocPinY" V="0.5"/>{ThemeCells}
        <Section N="Geometry" IX="0"><Cell N="NoFill" V="0"/><Row T="Ellipse" IX="1"><Cell N="X" V="0.5"/><Cell N="Y" V="0.5"/><Cell N="A" V="1"/><Cell N="B" V="0.5"/><Cell N="C" V="0.5"/><Cell N="D" V="1"/></Row></Section>
        <Text>Circle</Text></Shape>
        """);
    private static string Pentagon => Master($"""
        <Shape ID="5" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3"><Cell N="Width" V="1"/><Cell N="Height" V="1"/>{ThemeCells}
        <Section N="Geometry" IX="0"><Row T="MoveTo" IX="1"><Cell N="X" V="0.5"/><Cell N="Y" V="1"/></Row><Row T="LineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0.618"/></Row>
        <Row T="LineTo" IX="3"><Cell N="X" V="0.809"/><Cell N="Y" V="0"/></Row><Row T="LineTo" IX="4"><Cell N="X" V="0.191"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0.618"/></Row><Row T="LineTo" IX="6"><Cell N="X" V="0.5"/><Cell N="Y" V="1"/></Row></Section></Shape>
        """);
    private static string Cloud => Master($"""
        <Shape ID="5" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3"><Cell N="Width" V="1"/><Cell N="Height" V="1"/>{ThemeCells}
        <Section N="Geometry" IX="0"><Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0.5"/></Row>
        <Row T="NURBSTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0.5"/><Cell N="A" V="1"/><Cell N="B" V="1"/><Cell N="C" V="0"/><Cell N="D" V="1"/>
          <Cell N="E" V="0" F="NURBS(1, 3, 0, 0, 0.1, 1.2, 0, 1, 0.9, 1.2, 0, 1)"/></Row>
        <Row T="PolylineTo" IX="3"><Cell N="X" V="0"/><Cell N="Y" V="0.5"/><Cell N="E" V="0" F="POLYLINE(0, 0, 0.75, 0, 0.25, 0)"/></Row></Section></Shape>
        """);
    private static string Connector => Master("""<Shape ID="5" Type="Shape" LineStyle="3" FillStyle="3" TextStyle="3"><Cell N="ObjType" V="2"/><Cell N="QuickStyleLineColor" V="0"/></Shape>""");

    private static string Instance(int id, int master, double pinX, double pinY, double w, double h, string extra = "") =>
        $"""<Shape ID="{id}" Master="{master}" Type="Shape"><Cell N="PinX" V="{pinX}"/><Cell N="PinY" V="{pinY}"/><Cell N="Width" V="{w}"/><Cell N="Height" V="{h}"/><Cell N="LocPinX" V="{w / 2}"/><Cell N="LocPinY" V="{h / 2}"/>{extra}</Shape>""";

    private static string Conn(int id, double bx, double by, double ex, double ey, int srs, int clre) =>
        $"""<Shape ID="{id}" Master="5" Type="Shape"><Cell N="BeginX" V="{bx}"/><Cell N="BeginY" V="{by}"/><Cell N="EndX" V="{ex}"/><Cell N="EndY" V="{ey}"/><Cell N="ShapeRouteStyle" V="{srs}"/><Cell N="ConLineRouteExt" V="{clre}"/></Shape>""";

    /// <summary>
    /// Shapes: 1 circle 2×1 (partial Ellipse row: X/A/C only, no T); 2 pentagon 2×1 (partial rows:
    /// X only); 3 cloud; 4 circle with local QuickStyleFillColor=4 (accent3); 6 circle with variation
    /// colour 100; 7 circle with a local cached colour (#00FF00 + THEMEVAL); 10-13 connectors.
    /// </summary>
    public static byte[] Build()
    {
        var page = $"""
            <PageContents xmlns="{Ns}" xmlns:r="{RNs}"><Shapes>
            {Instance(1, 2, 2, 6, 2, 1, "<Section N=\"Geometry\" IX=\"0\"><Row IX=\"1\"><Cell N=\"X\" V=\"1\"/><Cell N=\"A\" V=\"2\"/><Cell N=\"C\" V=\"1\"/></Row></Section>")}
            {Instance(2, 3, 5, 6, 2, 1, "<Section N=\"Geometry\" IX=\"0\"><Row IX=\"1\"><Cell N=\"X\" V=\"1\"/></Row><Row IX=\"2\"><Cell N=\"X\" V=\"2\"/></Row><Row IX=\"3\"><Cell N=\"X\" V=\"1.618\"/></Row><Row IX=\"4\"><Cell N=\"X\" V=\"0.382\"/></Row><Row IX=\"6\"><Cell N=\"X\" V=\"1\"/></Row></Section>")}
            {Instance(3, 4, 8, 6, 1, 1)}
            {Instance(4, 2, 2, 3, 1, 1, "<Cell N=\"QuickStyleFillColor\" V=\"4\"/>")}
            {Instance(6, 2, 4, 3, 1, 1, "<Cell N=\"QuickStyleFillColor\" V=\"100\"/>")}
            {Instance(7, 2, 6, 3, 1, 1, "<Cell N=\"FillForegnd\" V=\"#00ff00\" F=\"THEMEVAL()\"/>")}
            {Conn(10, 1, 1, 3, 1, 16, 1)}
            {Conn(11, 1, 2, 3, 2, 0, 1)}
            {Conn(12, 1, 3, 3, 3, 1, 0)}
            {Conn(13, 1, 4, 3, 4, 2, 0)}
            </Shapes></PageContents>
            """;
        var parts = new Dictionary<string, string>
        {
            ["[Content_Types].xml"] = """
                <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
                <Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/></Types>
                """,
            ["_rels/.rels"] = Rels(("rId1", "http://schemas.microsoft.com/visio/2010/relationships/document", "visio/document.xml")),
            ["visio/document.xml"] = Document,
            ["visio/_rels/document.xml.rels"] = Rels(("rId1", "http://schemas.microsoft.com/visio/2010/relationships/pages", "pages/pages.xml"),
                ("rId2", "http://schemas.microsoft.com/visio/2010/relationships/masters", "masters/masters.xml"),
                ("rId3", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme", "theme/theme1.xml")),
            ["visio/theme/theme1.xml"] = Theme,
            ["visio/masters/masters.xml"] = $"""<Masters xmlns="{Ns}" xmlns:r="{RNs}"><Master ID="2" NameU="Circle"><Rel r:id="rId1"/></Master><Master ID="3" NameU="Pentagon"><Rel r:id="rId2"/></Master><Master ID="4" NameU="Cloud"><Rel r:id="rId3"/></Master><Master ID="5" NameU="Dynamic connector"><Rel r:id="rId4"/></Master></Masters>""",
            ["visio/masters/_rels/masters.xml.rels"] = Rels(("rId1", "http://schemas.microsoft.com/visio/2010/relationships/master", "master1.xml"), ("rId2", "http://schemas.microsoft.com/visio/2010/relationships/master", "master2.xml"),
                ("rId3", "http://schemas.microsoft.com/visio/2010/relationships/master", "master3.xml"), ("rId4", "http://schemas.microsoft.com/visio/2010/relationships/master", "master4.xml")),
            ["visio/masters/master1.xml"] = Circle,
            ["visio/masters/master2.xml"] = Pentagon,
            ["visio/masters/master3.xml"] = Cloud,
            ["visio/masters/master4.xml"] = Connector,
            ["visio/pages/pages.xml"] = $"""<Pages xmlns="{Ns}" xmlns:r="{RNs}"><Page ID="0" NameU="Page-1"><PageSheet><Cell N="PageWidth" V="11"/><Cell N="PageHeight" V="8.5"/></PageSheet><Rel r:id="rId1"/></Page></Pages>""",
            ["visio/pages/_rels/pages.xml.rels"] = Rels(("rId1", "http://schemas.microsoft.com/visio/2010/relationships/page", "page1.xml")),
            ["visio/pages/page1.xml"] = page,
        };
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
            foreach (var (name, xml) in parts)
            {
                using var s = zip.CreateEntry(name).Open();
                s.Write(Encoding.UTF8.GetBytes(xml.Trim()));
            }
        return ms.ToArray();
    }
}
