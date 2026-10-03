using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Diagram.Core.Contracts;

namespace Diagram.Visio;

/// <summary>One path segment in unit-box space (u → right, v → down, 0..1).</summary>
public readonly record struct Seg(char Op, double[] P);

public sealed record Subpath(List<Seg> Segments, bool Closed);

/// <summary>
/// Canonical preset outlines and their native Visio geometry. Exported geometry uses Rel*
/// rows (fractions of Width/Height, Y from the bottom) so shapes stay editable and resize
/// natively. Import converts any supported row type back to unit-space segments.
/// </summary>
public static class GeometryMap
{
    private const double K = 0.5522847498307936; // cubic Bézier quarter-ellipse constant
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    internal static string F(double v) => Math.Round(v, 12).ToString("R", Inv);

    private static List<Seg> Poly(params (double U, double V)[] pts)
    {
        var s = new List<Seg> { new('M', [pts[0].U, pts[0].V]) };
        for (var i = 1; i < pts.Length; i++) s.Add(new('L', [pts[i].U, pts[i].V]));
        return s;
    }

    /// <summary>Quarter ellipse from angle a0 to a1 (radians, y-down, ±π/2 apart) as one cubic.</summary>
    private static Seg Arc(double cx, double cy, double rx, double ry, double a0, double a1)
    {
        var k = 4.0 / 3 * Math.Tan((a1 - a0) / 4);
        double x0 = cx + rx * Math.Cos(a0), y0 = cy + ry * Math.Sin(a0), x1 = cx + rx * Math.Cos(a1), y1 = cy + ry * Math.Sin(a1);
        return new('C', [x0 - k * rx * Math.Sin(a0), y0 + k * ry * Math.Cos(a0), x1 + k * rx * Math.Sin(a1), y1 - k * ry * Math.Cos(a1), x1, y1]);
    }

    private static List<Seg> Ellipse(double cx, double cy, double rx, double ry)
    {
        var s = new List<Seg> { new('M', [cx + rx, cy]) };
        for (var q = 0; q < 4; q++) s.Add(Arc(cx, cy, rx, ry, q * Math.PI / 2, (q + 1) * Math.PI / 2));
        return s;
    }

    public static List<Subpath> Preset(string? preset, double widthPt, double heightPt, double? cornerRadiusPt = null, string? svgPath = null)
    {
        switch (preset)
        {
            case "roundedRect":
            {
                var r = Math.Min(cornerRadiusPt is > 0 ? cornerRadiusPt.Value : Math.Min(widthPt, heightPt) * 0.15, Math.Min(widthPt, heightPt) / 2);
                double rx = r / widthPt, ry = r / heightPt;
                var s = new List<Seg> { new('M', [rx, 0]), new('L', [1 - rx, 0]) };
                s.Add(Arc(1 - rx, ry, rx, ry, -Math.PI / 2, 0));
                s.Add(new('L', [1, 1 - ry]));
                s.Add(Arc(1 - rx, 1 - ry, rx, ry, 0, Math.PI / 2));
                s.Add(new('L', [rx, 1]));
                s.Add(Arc(rx, 1 - ry, rx, ry, Math.PI / 2, Math.PI));
                s.Add(new('L', [0, ry]));
                s.Add(Arc(rx, ry, rx, ry, Math.PI, 3 * Math.PI / 2));
                return [new(s, true)];
            }
            case "ellipse": return [new(Ellipse(0.5, 0.5, 0.5, 0.5), true)];
            case "diamond": return [new(Poly((0.5, 0), (1, 0.5), (0.5, 1), (0, 0.5)), true)];
            case "triangle": return [new(Poly((0.5, 0), (1, 1), (0, 1)), true)];
            case "hexagon": return [new(Poly((0.25, 0), (0.75, 0), (1, 0.5), (0.75, 1), (0.25, 1), (0, 0.5)), true)];
            case "parallelogram": return [new(Poly((0.2, 0), (1, 0), (0.8, 1), (0, 1)), true)];
            case "callout": return [new(Poly((0, 0), (1, 0), (1, 0.75), (0.4, 0.75), (0.2, 1), (0.25, 0.75), (0, 0.75)), true)];
            case "document":
                return [new([new('M', [0, 0]), new('L', [1, 0]), new('L', [1, 0.85]), new('C', [0.75, 0.7, 0.5, 1.05, 0, 0.9])], true)];
            case "cylinder":
            case "database":
            {
                const double ry = 0.1;
                var body = new List<Seg> { new('M', [0, ry]), Arc(0.5, ry, 0.5, ry, Math.PI, 1.5 * Math.PI), Arc(0.5, ry, 0.5, ry, 1.5 * Math.PI, 2 * Math.PI), new('L', [1, 1 - ry]),
                    Arc(0.5, 1 - ry, 0.5, ry, 0, Math.PI / 2), Arc(0.5, 1 - ry, 0.5, ry, Math.PI / 2, Math.PI) };
                var rim = new List<Seg> { new('M', [0, ry]), Arc(0.5, ry, 0.5, ry, Math.PI, Math.PI / 2), Arc(0.5, ry, 0.5, ry, Math.PI / 2, 0) };
                return [new(body, true), new(rim, false)];
            }
            case "cloud":
                return [new([new('M', [0.25, 0.8]), new('C', [0.02, 0.8, 0.02, 0.45, 0.22, 0.45]), new('C', [0.2, 0.15, 0.55, 0.1, 0.6, 0.3]),
                    new('C', [0.75, 0.15, 0.98, 0.3, 0.85, 0.5]), new('C', [1, 0.6, 0.95, 0.8, 0.8, 0.8])], true)];
            case "server":
                return [new(Poly((0, 0), (1, 0), (1, 1), (0, 1)), true), new(Poly((0, 0.33), (1, 0.33)), false), new(Poly((0, 0.66), (1, 0.66)), false)];
            case "application":
                return [new(Poly((0, 0), (1, 0), (1, 1), (0, 1)), true), new(Poly((0, 0.18), (1, 0.18)), false)];
            case "user":
                return [new(Ellipse(0.5, 0.2, 0.18, 0.2), true), new([new('M', [0.1, 1]), new('C', [0.1, 0.5, 0.9, 0.5, 0.9, 1])], true)];
            case "custom" when svgPath is not null:
                return ParseUnitPath(svgPath);
            default:
                return [new(Poly((0, 0), (1, 0), (1, 1), (0, 1)), true)];
        }
    }

    /// <summary>Restricted custom paths: absolute unit-space M/L/C/Z only (as the importer emits).</summary>
    public static List<Subpath> ParseUnitPath(string d)
    {
        var tokens = System.Text.RegularExpressions.Regex.Matches(d, @"[MLCZmlcz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?").Select(m => m.Value).ToList();
        var result = new List<Subpath>();
        List<Seg>? cur = null;
        var i = 0;
        char op = 'M';
        double Next() => double.Parse(tokens[i++], Inv);
        while (i < tokens.Count)
        {
            if (char.IsLetter(tokens[i][0])) op = char.ToUpperInvariant(tokens[i++][0]);
            switch (op)
            {
                case 'M': cur = [new('M', [Next(), Next()])]; result.Add(new(cur, false)); op = 'L'; break;
                case 'L': cur!.Add(new('L', [Next(), Next()])); break;
                case 'C': cur!.Add(new('C', [Next(), Next(), Next(), Next(), Next(), Next()])); break;
                case 'Z': result[^1] = result[^1] with { Closed = true }; break;
                default: throw new FormatException($"unsupported path command {op}");
            }
        }
        return result;
    }

    public static string ToUnitPath(IEnumerable<Subpath> subpaths)
    {
        var sb = new StringBuilder();
        foreach (var sp in subpaths)
        {
            foreach (var s in sp.Segments)
                sb.Append(s.Op).Append(string.Join(' ', s.P.Select(v => F(Math.Round(v, 9))))).Append(' ');
            if (sp.Closed) sb.Append("Z ");
        }
        return sb.ToString().Trim();
    }

    // ---------------- export: Visio Rel rows ----------------
    public static IEnumerable<XElement> ToSections(XNamespace v, IReadOnlyList<Subpath> subpaths, bool noFill, bool noLine, bool noShow)
    {
        for (var ix = 0; ix < subpaths.Count; ix++)
        {
            var sp = subpaths[ix];
            var section = new XElement(v + "Section", new XAttribute("N", "Geometry"), new XAttribute("IX", ix),
                Cell(v, "NoFill", noFill || !sp.Closed ? 1 : 0), Cell(v, "NoLine", noLine ? 1 : 0), Cell(v, "NoShow", noShow ? 1 : 0), Cell(v, "NoSnap", 0));
            var row = 1;
            (double U, double V) first = default, last = default;
            foreach (var s in sp.Segments)
            {
                // Visio Y runs from the bottom of the shape.
                var p = s.P;
                switch (s.Op)
                {
                    case 'M': section.Add(Row(v, "RelMoveTo", row++, ("X", p[0]), ("Y", 1 - p[1]))); first = last = (p[0], p[1]); break;
                    case 'L': section.Add(Row(v, "RelLineTo", row++, ("X", p[0]), ("Y", 1 - p[1]))); last = (p[0], p[1]); break;
                    case 'C':
                        section.Add(Row(v, "RelCubBezTo", row++, ("X", p[4]), ("Y", 1 - p[5]), ("A", p[0]), ("B", 1 - p[1]), ("C", p[2]), ("D", 1 - p[3])));
                        last = (p[4], p[5]);
                        break;
                }
            }
            if (sp.Closed && (Math.Abs(first.U - last.U) > 1e-12 || Math.Abs(first.V - last.V) > 1e-12))
                section.Add(Row(v, "RelLineTo", row, ("X", first.U), ("Y", 1 - first.V)));
            yield return section;
        }
    }

    private static XElement Cell(XNamespace v, string n, double value) => new(v + "Cell", new XAttribute("N", n), new XAttribute("V", F(value)));
    private static XElement Row(XNamespace v, string t, int ix, params (string N, double V)[] cells) =>
        new(v + "Row", new XAttribute("T", t), new XAttribute("IX", ix), cells.Select(c => Cell(v, c.N, c.V)));

    /// <summary>
    /// Hash of geometry exactly as the importer will reconstruct it from the exported Rel rows
    /// (closing segment appended, coincident ends closed) without building and re-parsing XML.
    /// Equivalent to Hash(FromSections(ToSections(subpaths))).
    /// </summary>
    public static string ExportHash(IReadOnlyList<Subpath> subpaths)
    {
        var normalised = new List<Subpath>(subpaths.Count);
        foreach (var sp in subpaths)
        {
            var segs = sp.Segments;
            if (segs.Count == 0) { normalised.Add(sp); continue; }
            var first = (segs[0].P[0], segs[0].P[1]);
            var lastP = segs[^1].P;
            var last = (lastP[^2], lastP[^1]);
            if (sp.Closed && (Math.Abs(first.Item1 - last.Item1) > 1e-12 || Math.Abs(first.Item2 - last.Item2) > 1e-12))
            {
                segs = [.. segs, new Seg('L', [first.Item1, first.Item2])];
                last = first;
            }
            var closed = sp.Closed || (segs.Count > 1 && segs[^1].Op != 'M' && Math.Abs(last.Item1 - first.Item1) < 1e-9 && Math.Abs(last.Item2 - first.Item2) < 1e-9);
            normalised.Add(new Subpath(segs, closed));
        }
        return Hash(normalised);
    }

    /// <summary>Stable hash of exported geometry rows; a mismatch on import means Visio edited the geometry.</summary>
    public static string Hash(IEnumerable<Subpath> subpaths)
    {
        // Same canonical text as ToUnitPath over 6-decimal-rounded coordinates, built without LINQ.
        var sb = new StringBuilder(256);
        foreach (var sp in subpaths)
        {
            foreach (var seg in sp.Segments)
            {
                sb.Append(seg.Op);
                for (var i = 0; i < seg.P.Length; i++)
                {
                    if (i > 0) sb.Append(' ');
                    var v = Math.Round(Math.Round(seg.P[i], 6), 9);
                    sb.Append(F(v == 0 ? 0 : v)); // -0 and 0 must hash alike (row Y values are written as 1 - y)
                }
                sb.Append(' ');
            }
            if (sp.Closed) sb.Append("Z ");
        }
        var text = sb.ToString().Trim();
        Span<byte> digest = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes(text), digest);
        return Convert.ToHexString(digest).ToLowerInvariant()[..32];
    }

    // ---------------- import: any supported row type → unit segments ----------------
    public static (List<Subpath> Subpaths, List<string> Approximations) FromSections(XNamespace v, IEnumerable<XElement> sections, double widthIn, double heightIn, bool includeNoShow = false)
    {
        var result = new List<Subpath>();
        var approx = new List<string>();
        double w = widthIn == 0 ? 1 : widthIn, h = heightIn == 0 ? 1 : heightIn;
        foreach (var sec in sections.OrderBy(s => (int?)s.Attribute("IX") ?? 0))
        {
            if (!includeNoShow && Num(sec, v, "NoShow") == 1) continue;
            var segs = new List<Seg>();
            double cx = 0, cy = 0; // current point in unit space (v down)
            (double, double) U(double xIn, double yIn) => (xIn / w, 1 - yIn / h);
            foreach (var row in sec.Elements(v + "Row").OrderBy(r => (int?)r.Attribute("IX") ?? 0))
            {
                if ((string?)row.Attribute("Del") == "1") continue;
                var t = (string?)row.Attribute("T");
                double X = RowNum(row, v, "X"), Y = RowNum(row, v, "Y");
                switch (t)
                {
                    case "MoveTo": { var (a, b) = U(X, Y); segs = [new('M', [a, b])]; result.Add(new(segs, false)); (cx, cy) = (a, b); break; }
                    case "RelMoveTo": segs = [new('M', [X, 1 - Y])]; result.Add(new(segs, false)); (cx, cy) = (X, 1 - Y); break;
                    case "LineTo": { var (a, b) = U(X, Y); segs.Add(new('L', [a, b])); (cx, cy) = (a, b); break; }
                    case "RelLineTo": segs.Add(new('L', [X, 1 - Y])); (cx, cy) = (X, 1 - Y); break;
                    case "RelCubBezTo":
                        segs.Add(new('C', [RowNum(row, v, "A"), 1 - RowNum(row, v, "B"), RowNum(row, v, "C"), 1 - RowNum(row, v, "D"), X, 1 - Y]));
                        (cx, cy) = (X, 1 - Y);
                        break;
                    case "RelQuadBezTo":
                    {
                        double qa = RowNum(row, v, "A"), qb = 1 - RowNum(row, v, "B"), ex = X, ey = 1 - Y;
                        segs.Add(new('C', [cx + 2.0 / 3 * (qa - cx), cy + 2.0 / 3 * (qb - cy), ex + 2.0 / 3 * (qa - ex), ey + 2.0 / 3 * (qb - ey), ex, ey]));
                        (cx, cy) = (ex, ey);
                        break;
                    }
                    case "Ellipse":
                    {
                        // Centre (X,Y); A,B a point on one axis; C,D a point on the other (local inches).
                        double ax = Math.Abs(RowNum(row, v, "A") - X) + Math.Abs(RowNum(row, v, "C") - X), ay = Math.Abs(RowNum(row, v, "B") - Y) + Math.Abs(RowNum(row, v, "D") - Y);
                        var (ux, uy) = U(X, Y);
                        segs = Ellipse(ux, uy, ax / w, ay / h);
                        result.Add(new(segs, true));
                        break;
                    }
                    case "ArcTo":
                    case "EllipticalArcTo":
                    case "RelEllipticalArcTo":
                    {
                        var rel = t == "RelEllipticalArcTo";
                        var (ex, ey) = rel ? (X, 1 - Y) : U(X, Y);
                        double px, py;
                        if (t == "ArcTo")
                        {
                            // Bow: signed distance from the chord midpoint to the arc apex.
                            var bow = RowNum(row, v, "A");
                            double mx = (cx + ex) / 2, my = (cy + ey) / 2, dx = (ex - cx) * w, dy = (ey - cy) * h, len = Math.Sqrt(dx * dx + dy * dy);
                            (px, py) = len == 0 ? (mx, my) : (mx - dy / len * bow / w, my + dx / len * bow / h);
                        }
                        else (px, py) = rel ? (RowNum(row, v, "A"), 1 - RowNum(row, v, "B")) : U(RowNum(row, v, "A"), RowNum(row, v, "B"));
                        segs.Add(QuadThrough(cx, cy, px, py, ex, ey));
                        approx.Add(t!);
                        (cx, cy) = (ex, ey);
                        break;
                    }
                    case "PolylineTo" when Formula(row, v, "E") is { } poly && ParseCall(poly, "POLYLINE") is { Count: >= 2 } pa:
                    {
                        // POLYLINE(xType, yType, x1, y1, ...): type 0 = fraction of width/height, 1 = local inches.
                        (double, double) P(double px, double py) => (pa[0] == 0 ? px : px / w, 1 - (pa[1] == 0 ? py : py / h));
                        for (var k = 2; k + 1 < pa.Count; k += 2) { var (a, b) = P(pa[k], pa[k + 1]); segs.Add(new('L', [a, b])); }
                        var (ex, ey) = U(X, Y);
                        segs.Add(new('L', [ex, ey]));
                        (cx, cy) = (ex, ey);
                        break;
                    }
                    case "NURBSTo" when Formula(row, v, "E") is { } nurbs && ParseCall(nurbs, "NURBS") is { Count: >= 4 } na:
                    {
                        var (ex, ey) = U(X, Y);
                        var pts = Nurbs(na, (cx, cy), (ex, ey), RowNum(row, v, "A"), RowNum(row, v, "B"), RowNum(row, v, "C"), RowNum(row, v, "D"), w, h);
                        foreach (var (a, b) in pts) segs.Add(new('L', [a, b]));
                        approx.Add("NURBSTo");
                        (cx, cy) = (ex, ey);
                        break;
                    }
                    case "PolylineTo":
                    case "NURBSTo":
                    case "SplineStart":
                    case "SplineKnot":
                    case "InfiniteLine":
                    {
                        var (ex, ey) = U(X, Y);
                        segs.Add(new('L', [ex, ey]));
                        approx.Add(t!);
                        (cx, cy) = (ex, ey);
                        break;
                    }
                }
            }
        }
        for (var i = 0; i < result.Count; i++)
        {
            var s = result[i].Segments;
            if (s.Count > 1 && s[^1].Op != 'M')
            {
                var end = s[^1].P[^2..];
                if (Math.Abs(end[0] - s[0].P[0]) < 1e-9 && Math.Abs(end[1] - s[0].P[1]) < 1e-9) result[i] = result[i] with { Closed = true };
            }
        }
        return (result, approx);
    }

    private static string? Formula(XElement row, XNamespace v, string n)
    {
        var c = row.Elements(v + "Cell").FirstOrDefault(x => (string?)x.Attribute("N") == n);
        return (string?)c?.Attribute("F") is { Length: > 0 } f ? f : (string?)c?.Attribute("V");
    }

    /// <summary>Numeric arguments of NAME(a, b, ...), or null.</summary>
    private static List<double>? ParseCall(string text, string name)
    {
        var i = text.IndexOf(name + "(", StringComparison.OrdinalIgnoreCase);
        var j = text.LastIndexOf(')');
        if (i < 0 || j < i) return null;
        var list = new List<double>();
        foreach (var part in text[(i + name.Length + 1)..j].Split(','))
        {
            if (!double.TryParse(part.Trim(), NumberStyles.Float, Inv, out var d) || !double.IsFinite(d)) return null;
            list.Add(d);
        }
        return list;
    }

    /// <summary>
    /// Samples a Visio NURBSTo row as a polyline in unit space. Control points: the current point,
    /// the NURBS() points (x, y, knot, weight), then the row end (X, Y). Knots: first knot C, the
    /// point knots, last knot A, then knotLast, padded to a clamped vector of the needed length.
    /// </summary>
    private static List<(double, double)> Nurbs(List<double> a, (double U, double V) start, (double U, double V) end,
        double lastKnot, double lastWeight, double firstKnot, double firstWeight, double w, double h)
    {
        int degree = Math.Clamp((int)a[1], 1, 9);
        int xType = (int)a[2], yType = (int)a[3];
        var ctrl = new List<(double X, double Y, double W)> { (start.U, start.V, firstWeight == 0 ? 1 : firstWeight) };
        var knots = new List<double> { firstKnot };
        for (var k = 4; k + 3 < a.Count; k += 4)
        {
            var u = xType == 0 ? a[k] : a[k] / w;
            var vv = 1 - (yType == 0 ? a[k + 1] : a[k + 1] / h);
            ctrl.Add((u, vv, a[k + 3] == 0 ? 1 : a[k + 3]));
            knots.Add(a[k + 2]);
        }
        ctrl.Add((end.U, end.V, lastWeight == 0 ? 1 : lastWeight));
        knots.Add(lastKnot);
        knots.Add(a[0]);
        var n = ctrl.Count;
        degree = Math.Min(degree, n - 1);
        // Clamped knot vector: start/end each repeated degree+1 times so the curve runs from the
        // current point to the row end; interior knots come from the row where it supplies enough.
        double tStart = knots[0], tEnd = Math.Max(knots[^1], knots.Max());
        if (!(tEnd > tStart)) (tStart, tEnd) = (0, 1);
        var needed = n - degree - 1;
        var interior = knots.Where(k => k > tStart && k < tEnd).ToList();
        if (interior.Count != needed) interior = Enumerable.Range(1, Math.Max(0, needed)).Select(k => tStart + (tEnd - tStart) * k / (needed + 1)).ToList();
        knots = [.. Enumerable.Repeat(tStart, degree + 1), .. interior, .. Enumerable.Repeat(tEnd, degree + 1)];
        double t0 = knots[degree], t1 = knots[n];
        var result = new List<(double, double)>();
        if (!(t1 > t0)) { result.Add((end.U, end.V)); return result; }
        var samples = Math.Max(8, n * 8);
        for (var sIx = 1; sIx <= samples; sIx++)
        {
            var t = sIx == samples ? t1 : t0 + (t1 - t0) * sIx / samples;
            result.Add(sIx == samples ? (end.U, end.V) : DeBoor(t, degree, knots, ctrl));
        }
        return result;
    }

    private static (double, double) DeBoor(double t, int p, List<double> knots, List<(double X, double Y, double W)> ctrl)
    {
        var n = ctrl.Count;
        var span = p;
        while (span < n - 1 && t >= knots[span + 1]) span++;
        var d = new (double X, double Y, double W)[p + 1];
        for (var j = 0; j <= p; j++)
        {
            var c = ctrl[Math.Clamp(j + span - p, 0, n - 1)];
            d[j] = (c.X * c.W, c.Y * c.W, c.W);
        }
        for (var r = 1; r <= p; r++)
            for (var j = p; j >= r; j--)
            {
                var i = j + span - p;
                var denom = knots[Math.Min(i + p - r + 1, knots.Count - 1)] - knots[Math.Clamp(i, 0, knots.Count - 1)];
                var alpha = denom == 0 ? 0 : (t - knots[Math.Clamp(i, 0, knots.Count - 1)]) / denom;
                d[j] = ((1 - alpha) * d[j - 1].X + alpha * d[j].X, (1 - alpha) * d[j - 1].Y + alpha * d[j].Y, (1 - alpha) * d[j - 1].W + alpha * d[j].W);
            }
        var res = d[p];
        return res.W == 0 ? (res.X, res.Y) : (res.X / res.W, res.Y / res.W);
    }

    /// <summary>Cubic approximating the curve from S through P (at t=½) to E.</summary>
    private static Seg QuadThrough(double sx, double sy, double px, double py, double ex, double ey)
    {
        double qx = 2 * px - (sx + ex) / 2, qy = 2 * py - (sy + ey) / 2;
        return new('C', [sx + 2.0 / 3 * (qx - sx), sy + 2.0 / 3 * (qy - sy), ex + 2.0 / 3 * (qx - ex), ey + 2.0 / 3 * (qy - ey), ex, ey]);
    }

    private static double Num(XElement parent, XNamespace v, string n) =>
        parent.Elements(v + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == n)?.Attribute("V") is { } a && double.TryParse(a.Value, NumberStyles.Float, Inv, out var d) ? d : 0;

    private static double RowNum(XElement row, XNamespace v, string n) => Num(row, v, n);

    /// <summary>True when the outline is an axis-aligned rectangle filling its box.</summary>
    public static bool IsBox(IReadOnlyList<Subpath> sps) =>
        sps.Count == 1 && sps[0].Segments.All(s => s.Op is 'M' or 'L') && sps[0].Segments.Count is 4 or 5
        && sps[0].Segments.All(s => (Math.Abs(s.P[0]) < 1e-6 || Math.Abs(s.P[0] - 1) < 1e-6) && (Math.Abs(s.P[1]) < 1e-6 || Math.Abs(s.P[1] - 1) < 1e-6));
}
