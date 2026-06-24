# sync-plugin.ps1
# Copy the development plugin file to Roblox Studio's plugin folder.
# Run after editing plugin/MultiAIPlugin.lua, then reload the plugin in Studio.

$src = Join-Path $PSScriptRoot "plugin\MultiAIPlugin.lua"
$dst = Join-Path $env:LOCALAPPDATA "Roblox\Plugins\MultiAIPlugin.lua"

if (-not (Test-Path $src)) {
    Write-Host "[ERROR] Source not found: $src" -ForegroundColor Red
    exit 1
}

# Resolve the outer token to bake into the plugin's AUTH_TOKEN.
# Mirrors the broker's OUTER_TOKEN precedence (server.mjs / loadOrMintMachineToken):
#   explicit ROBLOX_MCP_TOKEN env > (ROBLOX_MCP_ALLOW_TOKENLESS=1 ? "" : machine-token file) > "".
$token = $env:ROBLOX_MCP_TOKEN
if ([string]::IsNullOrEmpty($token)) {
    if ($env:ROBLOX_MCP_ALLOW_TOKENLESS -eq "1") {
        # Operator opted out of machine-token auth — the broker's loadOrMintMachineToken
        # returns "" under this flag, so bake an empty AUTH_TOKEN to match (no auth).
        $token = ""
    } else {
        $tokenFile = Join-Path $env:LOCALAPPDATA "Roblox-MCP\broker-token"
        if (Test-Path $tokenFile) {
            $token = (Get-Content -Path $tokenFile -Raw).Trim()
        }
    }
}
if ([string]::IsNullOrEmpty($token)) { $token = "" }

# Read source, rewrite the AUTH_TOKEN line, then write to destination.
# Regex matches any previously-baked value so re-syncs are idempotent.
$content = Get-Content -Path $src -Raw
$escaped = $token.Replace('\', '\\').Replace('"', '\"')
$content = $content -replace '(?m)^(local AUTH_TOKEN = ")[^"]*(")', "local AUTH_TOKEN = `"$escaped`""
Set-Content -Path $dst -Value $content -Encoding utf8 -NoNewline

$size = (Get-Item $dst).Length
Write-Host "[OK] Synced plugin ($size bytes)" -ForegroundColor Green
Write-Host "     $src" -ForegroundColor DarkGray
Write-Host "  -> $dst" -ForegroundColor DarkGray

if ($token -ne "") {
    Write-Host "[OK] Baked AUTH_TOKEN into plugin (machine-token auth ENABLED)" -ForegroundColor Green
} else {
    Write-Host "[WARN] No token found — plugin installed WITHOUT auth (start the broker once, then re-run to bake the machine token)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Next: In Roblox Studio, click Plugins tab -> right-click MultiAIPlugin -> Reload" -ForegroundColor Yellow
