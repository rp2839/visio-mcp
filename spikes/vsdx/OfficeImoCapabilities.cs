using System.IO.Compression;
using System.Xml.Linq;
using OfficeIMO.Visio;

namespace VsdxProbe;

public sealed record OfficeImoReport(bool UserCells, bool ConnectorGlue, bool Layers, bool Pictures);

/// <summary>Records what OfficeIMO.Visio 3.4.4 can actually emit for the G1 scene.</summary>
public static class OfficeImoCapabilities
{
    public static OfficeImoReport Probe(string path)
    {
        var doc = VisioDocument.Create(path);
        var page = doc.AddPage("Page-1", 297, 210, VisioMeasurementUnit.Millimeters);
        var rect = page.AddRectangle(30, 30, 50, 25, "Probe");
        rect.SetUserCell("AgentId", "6f1c2b9e-3a4d-4c5e-8f70-112233445566", null!, null!, null!);
        var ellipse = page.AddEllipse(120, 30, 50, 25, "Target");
        page.AddLayer("Agents", "0");
        page.AddToLayer("Agents", rect);
        page.AddConnector("c1", rect, ellipse, ConnectorKind.RightAngle, VisioSide.Right, VisioSide.Left);
        doc.Save();

        using var zip = ZipFile.OpenRead(path);
        XDocument pageXml;
        using (var s = zip.GetEntry("visio/pages/page1.xml")!.Open()) pageXml = XDocument.Load(s);
        var v = ProbeScene.V;
        var userCells = pageXml.Descendants(v + "Section").Any(x => (string?)x.Attribute("N") == "User");
        var glue = pageXml.Descendants(v + "Connect").Count() == 2;
        var layers = pageXml.Descendants(v + "Cell").Any(c => (string?)c.Attribute("N") == "LayerMember");
        var pictures = typeof(VisioPage).GetMethods().Any(m => m.Name.Contains("Image") || m.Name.Contains("Picture"));
        return new OfficeImoReport(userCells, glue, layers, pictures);
    }
}
