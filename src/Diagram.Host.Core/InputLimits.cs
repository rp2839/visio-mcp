namespace Diagram.Host.Core;

/// <summary>D7 proposed POC resource limits. Changed defaults must be recorded with evidence.</summary>
public static class InputLimits
{
    public const long VsdxCompressedBytes = 100L * 1024 * 1024;
    public const int VsdxEntries = 10_000;
    public const long VsdxExpandedBytes = 512L * 1024 * 1024;
    public const long VsdxEntryExpandedBytes = 64L * 1024 * 1024;
    public const double VsdxMaxCompressionRatio = 200;
    public const int XmlMaxDepth = 256;
    public const long XmlMaxCharacters = 64L * 1024 * 1024;

    public const long NativeJsonBytes = 64L * 1024 * 1024;
    public const int NativeJsonDepth = 128;
    public const int NativeJsonStringChars = 1024 * 1024;

    public const long RasterBytes = 32L * 1024 * 1024;
    public const int RasterSidePx = 16_384;
    public const long RasterPixels = 64L * 1024 * 1024;

    public const long SvgBytes = 5L * 1024 * 1024;
    public const int SvgElements = 50_000;
    public const long SvgEmbeddedRasterBytes = 8L * 1024 * 1024;

    public const long PreviewPixels = 16L * 1024 * 1024;
    public const long PreviewBytes = 16L * 1024 * 1024;

    public const int MaxOperations = 1000;
    public const int ScriptBytes = 1024 * 1024;

    public const uint PipeFrameBytes = 32u * 1024 * 1024;
    public const int PipeClients = 8;
    public const int PipePendingPerConnection = 16;
    public const int PipeWriterQueue = 64;
}
