<#
.SYNOPSIS  Builds a release package: artifacts\dist\AgenticDiagram-<version>.zip with the app, the MCP companion and the install scripts.
.EXAMPLE   pwsh -File tools/installer/package.ps1 -Version 0.2.1
.NOTES     The package is not signed. Signing needs a code-signing certificate: pass -SignWith <thumbprint> where signtool.exe is installed.
#>
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(\.\d+)?$')][string]$Version,
    [string]$OutDir,
    [string]$SignWith
)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $OutDir) { $OutDir = Join-Path $root 'artifacts\dist' }
$stage = Join-Path ([IO.Path]::GetTempPath()) ("agentic-package-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage, $OutDir | Out-Null
try {
    $notes = Join-Path $root 'RELEASE-NOTES.md'
    if (-not (Select-String -Path $notes -Pattern "^##\s+v?$([regex]::Escape($Version))\b" -Quiet)) { throw "RELEASE-NOTES.md has no '## $Version' section. Say what changed before packaging." }
    npm --prefix "$root\src\web" run build | Out-Null
    if ($LASTEXITCODE) { throw 'The web build failed.' }
    dotnet publish "$root\src\Diagram.App" -c Release -p:Version=$Version -o "$stage\app" | Out-Null
    if ($LASTEXITCODE) { throw 'Publishing the app failed.' }
    dotnet publish "$root\src\Diagram.Mcp" -c Release -p:Version=$Version -o "$stage\mcp" | Out-Null
    if ($LASTEXITCODE) { throw 'Publishing the MCP companion failed.' }
    foreach ($f in 'lib.ps1', 'install.ps1', 'uninstall.ps1', 'register-mcp.ps1') { Copy-Item (Join-Path $PSScriptRoot $f) $stage }
    Copy-Item $notes $stage
    Copy-Item (Join-Path $root 'LICENSE') $stage -ErrorAction SilentlyContinue
    Set-Content -Path (Join-Path $stage 'version.txt') -Value $Version
    if ($SignWith) {
        $signtool = Get-Command signtool.exe -ErrorAction Stop
        Get-ChildItem $stage -Recurse -Include *.exe, *.dll | Where-Object { $_.Name -like 'Diagram.*' } |
            ForEach-Object { & $signtool.Source sign /sha1 $SignWith /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $_.FullName; if ($LASTEXITCODE) { throw "Signing $($_.Name) failed." } }
    }
    $zip = Join-Path $OutDir "AgenticDiagram-$Version.zip"
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path "$stage\*" -DestinationPath $zip
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -Path "$zip.sha256" -Value "$hash  $(Split-Path $zip -Leaf)"
    Write-Output $zip
    Write-Output "SHA-256 $hash$(if (-not $SignWith) { '  (unsigned)' })"
} finally { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
