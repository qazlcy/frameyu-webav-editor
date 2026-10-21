param([switch]$Mock, [switch]$Check)
$ErrorActionPreference = 'Stop'
try {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    Set-Location -LiteralPath $projectRoot
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $candidates = @(
        $(if ($nodeCommand) { $nodeCommand.Source }),
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique
    $nodePath = $null
    foreach ($candidate in $candidates) {
        $versionText = & $candidate --version
        if ($LASTEXITCODE -ne 0) { continue }
        $version = [version]($versionText.Trim().TrimStart('v'))
        if ($version -ge [version]'22.10.0') { $nodePath = $candidate; break }
    }
    if (-not $nodePath) { throw 'Node.js 22.10+ is required. Install Node.js LTS with npm, then reopen this launcher.' }
    if (-not (Test-Path -LiteralPath 'node_modules\vite\bin\vite.js' -PathType Leaf)) {
        throw 'Project dependencies are missing. Install Node.js LTS with npm, then run npm.cmd ci in this folder.'
    }
    Write-Host "Node: $nodePath"
    if ($Check) {
        Write-Host 'Startup check passed. No services started; no environment file loaded.'
        exit 0
    }
    Write-Host 'Open http://127.0.0.1:5173 . Press Ctrl+C to stop both services.'
    $nodeArgs = @('scripts/start-ai.mjs')
    if ($Mock) { $nodeArgs += '--mock' }
    & $nodePath @nodeArgs
    exit $LASTEXITCODE
} catch {
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
