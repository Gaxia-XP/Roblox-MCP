# sync-blender-addon.ps1
# Copy the dev add-on into every detected Blender's scripts/addons folder.
# Run after editing blender/addon/MultiAI_Blender.py, then re-enable (or restart) Blender.

$src = Join-Path $PSScriptRoot "blender\addon\MultiAI_Blender.py"
if (-not (Test-Path $src)) {
    Write-Host "[ERROR] Source not found: $src" -ForegroundColor Red
    exit 1
}

$root = Join-Path $env:APPDATA "Blender Foundation\Blender"
if (-not (Test-Path $root)) {
    Write-Host "[ERROR] No Blender config dir at $root" -ForegroundColor Red
    exit 1
}

$versions = Get-ChildItem $root -Directory | Select-Object -ExpandProperty Name
$copied = 0
foreach ($v in $versions) {
    $addons = Join-Path $root "$v\scripts\addons"
    if (-not (Test-Path $addons)) { New-Item -ItemType Directory -Force -Path $addons | Out-Null }
    $dst = Join-Path $addons "MultiAI_Blender.py"
    Copy-Item -Path $src -Destination $dst -Force
    $size = (Get-Item $dst).Length
    Write-Host "[OK] Synced to Blender $v ($size bytes)" -ForegroundColor Green
    Write-Host "  -> $dst" -ForegroundColor DarkGray
    $copied++
}

if ($copied -eq 0) {
    Write-Host "[WARN] No Blender versions found under $root" -ForegroundColor Yellow
    exit 1
}
Write-Host ""
Write-Host "Next: In each Blender, Edit > Preferences > Add-ons > search 'Multi-AI' > enable (once)." -ForegroundColor Yellow
Write-Host "      Already enabled? Disable+enable to reload, or restart Blender." -ForegroundColor Yellow
