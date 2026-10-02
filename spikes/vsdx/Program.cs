using System.Text.Json;
using VsdxProbe;

// Usage: dotnet run --project spikes/vsdx -- --output <path.vsdx> [--read <path.vsdx>]
var output = Arg("--output");
var read = Arg("--read");
if (output is not null)
{
    var manifest = ProbeScene.Write(output, ProbeScene.Default(Guid.Parse("6f1c2b9e-3a4d-4c5e-8f70-112233445566")) with { SvgSource = ProbeScene.SampleSvg });
    Console.WriteLine(JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
}
if (read is not null)
    Console.WriteLine(JsonSerializer.Serialize(ProbeScene.Read(read), new JsonSerializerOptions { WriteIndented = true }));
if (output is null && read is null) { Console.Error.WriteLine("usage: --output <file.vsdx> | --read <file.vsdx>"); return 2; }
return 0;

string? Arg(string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
