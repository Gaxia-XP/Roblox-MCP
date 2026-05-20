# sync-plugin.ps1
# Copy the development plugin file to Roblox Studio's plugin folder.
# Run after editing plugin/MultiAIPlugin.lua, then reload the plugin in Studio.

$src = Join-Path $PSScriptRoot "plugin\MultiAIPlugin.lua"
$dst = Join-Path $env:LOCALAPPDATA "Roblox\Plugins\MultiAIPlugin.lua"

if (-not (Test-Path $src)) {
    Write-Host "[ERROR] Source not found: $src" -ForegroundColor Red
    exit 1
}

Copy-Item -Path $src -Destination $dst -Force
$size = (Get-Item $dst).Length
Write-Host "[OK] Synced plugin ($size bytes)" -ForegroundColor Green
Write-Host "     $src" -ForegroundColor DarkGray
Write-Host "  -> $dst" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Next: In Roblox Studio, click Plugins tab -> right-click MultiAIPlugin -> Reload" -ForegroundColor Yellow
