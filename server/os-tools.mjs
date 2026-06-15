// server/os-tools.mjs — OS-level tools that bypass the Roblox plugin entirely.
//   • simulateInputOS   — Win32 SendInput (keyboard + mouse)
//   • screenshotDiff    — two-shot comparison (Studio window or full screen)
//   • captureStudioWindow — Win32 PrintWindow on Studio
//   • captureScreenshot — primary screen (or region) via CopyFromScreen
// All implemented via spawned PowerShell scripts. Self-contained — no shared
// state with server.mjs.

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// OS-level input simulation (replaces VirtualInputManager approach)
// Uses Win32 API via PowerShell. Works regardless of Edit / Play mode and
// regardless of whether the plugin polling loop is paused.
// ---------------------------------------------------------------------------

// Virtual-key codes (used by MapVirtualKey to derive hardware scan codes).
const VK = {
  A:0x41,B:0x42,C:0x43,D:0x44,E:0x45,F:0x46,G:0x47,H:0x48,I:0x49,J:0x4A,
  K:0x4B,L:0x4C,M:0x4D,N:0x4E,O:0x4F,P:0x50,Q:0x51,R:0x52,S:0x53,T:0x54,
  U:0x55,V:0x56,W:0x57,X:0x58,Y:0x59,Z:0x5A,
  Zero:0x30,One:0x31,Two:0x32,Three:0x33,Four:0x34,Five:0x35,Six:0x36,Seven:0x37,Eight:0x38,Nine:0x39,
  Space:0x20,Return:0x0D,Enter:0x0D,Tab:0x09,Escape:0x1B,Backspace:0x08,Delete:0x2E,
  LeftShift:0xA0,RightShift:0xA1,LeftControl:0xA2,RightControl:0xA3,LeftAlt:0xA4,RightAlt:0xA5,
  Up:0x26,Down:0x28,Left:0x25,Right:0x27,
  F1:0x70,F2:0x71,F3:0x72,F4:0x73,F5:0x74,F6:0x75,F7:0x76,F8:0x77,F9:0x78,F10:0x79,F11:0x7A,F12:0x7B,
};

// Keys that require the "extended key" flag (E0 prefix) — arrows, right-modifier keys, etc.
const EXTENDED_KEYS = new Set([
  "Up","Down","Left","Right","Delete","RightAlt","RightControl","Enter","Return",
]);

/**
 * Build a PowerShell script that calls SendInput with hardware scancodes.
 *
 * Why SendInput + scancode?
 *   Roblox (and many DirectX games) read raw input. The legacy keybd_event API
 *   injects at a higher level and games using raw input devices may miss it.
 *   SendInput with KEYEVENTF_SCANCODE (0x08) is the closest thing to a real key
 *   press at the OS level and is what most game-automation tools use.
 */
export function simulateInputOS(actions) {
  const lines = [];
  const push = (s) => lines.push(s);

  push(`$ErrorActionPreference = 'Stop'`);
  push(`Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NI {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);

    public const uint INPUT_KEYBOARD = 1;
    public const uint INPUT_MOUSE = 0;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_SCANCODE = 0x0008;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;

    public static void Key(ushort vk, bool down, bool extended) {
        ushort scan = (ushort)MapVirtualKey(vk, 0);
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].u.ki.wVk = 0;
        inp[0].u.ki.wScan = scan;
        uint flags = KEYEVENTF_SCANCODE;
        if (!down) flags |= KEYEVENTF_KEYUP;
        if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
        inp[0].u.ki.dwFlags = flags;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MouseAbs(int x, int y) {
        // Normalized 0..65535 over the virtual screen
        int sw = GetSystemMetrics(0);
        int sh = GetSystemMetrics(1);
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].u.mi.dx = (int)((x * 65535.0) / sw);
        inp[0].u.mi.dy = (int)((y * 65535.0) / sh);
        inp[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MouseButton(uint flag) {
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].u.mi.dwFlags = flag;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@`);

  // Auto-focus Roblox Studio so input goes there.
  push(`try {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -like "*Roblox Studio*" } | Select-Object -First 1
  if ($p) { [NI]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }
  Start-Sleep -Milliseconds 250
} catch {}`);

  const keyDown = (vk, ext) => `[NI]::Key(${vk}, $true, $${ext ? "true" : "false"})`;
  const keyUp   = (vk, ext) => `[NI]::Key(${vk}, $false, $${ext ? "true" : "false"})`;
  const sleep = (ms) => `Start-Sleep -Milliseconds ${ms}`;

  const mouseBtnDown = (b) =>
    b === "right" ? `[NI]::MouseButton(0x08)` :
    b === "middle" ? `[NI]::MouseButton(0x20)` :
                     `[NI]::MouseButton(0x02)`;
  const mouseBtnUp = (b) =>
    b === "right" ? `[NI]::MouseButton(0x10)` :
    b === "middle" ? `[NI]::MouseButton(0x40)` :
                     `[NI]::MouseButton(0x04)`;

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    switch (a.type) {
      case "key_press": {
        const v = VK[a.key];
        if (!v) throw new Error(`unknown key: ${a.key}`);
        const ext = EXTENDED_KEYS.has(a.key);
        push(keyDown(v, ext));
        push(sleep(60));
        push(keyUp(v, ext));
        break;
      }
      case "key_hold": {
        const v = VK[a.key];
        if (!v) throw new Error(`unknown key: ${a.key}`);
        const ext = EXTENDED_KEYS.has(a.key);
        const ms = Math.max(50, Math.round((a.duration ?? 1) * 1000));
        push(keyDown(v, ext));
        push(sleep(ms));
        push(keyUp(v, ext));
        break;
      }
      case "key_down": {
        // Press-and-hold. Caller is responsible for calling key_up later.
        const v = VK[a.key];
        if (!v) throw new Error(`unknown key: ${a.key}`);
        const ext = EXTENDED_KEYS.has(a.key);
        push(keyDown(v, ext));
        break;
      }
      case "key_up": {
        // Release a key previously pressed with key_down.
        const v = VK[a.key];
        if (!v) throw new Error(`unknown key: ${a.key}`);
        const ext = EXTENDED_KEYS.has(a.key);
        push(keyUp(v, ext));
        break;
      }
      case "mouse_click": {
        const x = a.x | 0, y = a.y | 0;
        const b = a.button ?? "left";
        push(`[NI]::SetCursorPos(${x}, ${y})`);
        push(`[NI]::MouseAbs(${x}, ${y})`);
        push(sleep(30));
        push(mouseBtnDown(b));
        push(sleep(60));
        push(mouseBtnUp(b));
        break;
      }
      case "mouse_move":
        push(`[NI]::SetCursorPos(${a.x | 0}, ${a.y | 0})`);
        push(`[NI]::MouseAbs(${a.x | 0}, ${a.y | 0})`);
        break;
      case "mouse_drag": {
        const fx = a.from_x | 0, fy = a.from_y | 0;
        const tx = a.to_x | 0, ty = a.to_y | 0;
        const btn = a.button ?? "left";
        push(`[NI]::SetCursorPos(${fx}, ${fy})`);
        push(`[NI]::MouseAbs(${fx}, ${fy})`);
        push(sleep(50));
        push(mouseBtnDown(btn));
        for (let s = 1; s <= 12; s++) {
          const px = Math.round(fx + (tx - fx) * s / 12);
          const py = Math.round(fy + (ty - fy) * s / 12);
          push(sleep(25));
          push(`[NI]::SetCursorPos(${px}, ${py})`);
          push(`[NI]::MouseAbs(${px}, ${py})`);
        }
        push(sleep(50));
        push(mouseBtnUp(btn));
        break;
      }
      case "wait":
        push(sleep(Math.round((a.duration ?? 0.5) * 1000)));
        break;
      default:
        throw new Error(`unknown action #${i + 1}: ${a.type}`);
    }
  }

  const ps = lines.join("\n");
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(`PowerShell failed: ${r.stderr || r.stdout}`);
  return { ok: true, executed: actions.length };
}

// ---------------------------------------------------------------------------
// Studio-window capture via Win32 PrintWindow
// Captures the Roblox Studio main window (including viewport + panels) by
// using PrintWindow with PW_RENDERFULLCONTENT (2). This works even when the
// window is not focused or partially obscured, and skips other apps entirely.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Screenshot diff: take 2 screenshots wrapping a delay, compute % pixels
// changed (sampled). Used to verify "did anything visibly happen?".
// ---------------------------------------------------------------------------

export function screenshotDiff({ delay_seconds = 1, threshold = 10, target = "screen" } = {}) {
  const tmp1 = join(tmpdir(), `mcp_diff1_${randomUUID()}.png`);
  const tmp2 = join(tmpdir(), `mcp_diff2_${randomUUID()}.png`);
  const isStudio = target === "studio";

  // Studio mode uses Win32 PrintWindow on the Studio window (works unfocused,
  // ignores other apps/taskbar). Screen mode uses CopyFromScreen on the primary
  // monitor (captures everything visible).
  const captureSetup = isStudio ? `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W32D {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$studio = Get-Process |
    Where-Object { $_.MainWindowTitle -like "*Roblox Studio*" -and $_.MainWindowHandle -ne 0 } |
    Sort-Object -Property WorkingSet64 -Descending |
    Select-Object -First 1
if (-not $studio) { Write-Error "No Roblox Studio window found. Is Studio running?"; exit 1 }
$hwnd = $studio.MainWindowHandle
if ([W32D]::IsIconic($hwnd)) {
    [W32D]::ShowWindow($hwnd, 9) | Out-Null
    Start-Sleep -Milliseconds 200
}

function Capture($path) {
    $rect = New-Object W32D+RECT
    [W32D]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $h -le 0) { Write-Error "Invalid window dimensions"; exit 1 }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [W32D]::PrintWindow($hwnd, $hdc, 2) | Out-Null
    $g.ReleaseHdc($hdc); $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return @{ Width = $w; Height = $h }
}
` : `
function Capture($path) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return @{ Width = $b.Width; Height = $b.Height }
}
`;

  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${captureSetup}

$dim1 = Capture('${tmp1.replace(/\\/g, "\\\\")}')
Start-Sleep -Seconds ${delay_seconds | 0}
$dim2 = Capture('${tmp2.replace(/\\/g, "\\\\")}')

if ($dim1.Width -ne $dim2.Width -or $dim1.Height -ne $dim2.Height) {
    Write-Error "Captures have different dimensions ($($dim1.Width)x$($dim1.Height) vs $($dim2.Width)x$($dim2.Height)) — window resized between shots?"
    exit 1
}

# Sampled pixel diff: every 8th pixel, compare RGB sum delta > threshold
$b1 = New-Object System.Drawing.Bitmap '${tmp1.replace(/\\/g, "\\\\")}'
$b2 = New-Object System.Drawing.Bitmap '${tmp2.replace(/\\/g, "\\\\")}'
$thr = ${threshold | 0}
$total = 0; $diff = 0
for ($y = 0; $y -lt $b1.Height; $y += 8) {
  for ($x = 0; $x -lt $b1.Width; $x += 8) {
    $p1 = $b1.GetPixel($x, $y); $p2 = $b2.GetPixel($x, $y)
    $d = [Math]::Abs($p1.R - $p2.R) + [Math]::Abs($p1.G - $p2.G) + [Math]::Abs($p1.B - $p2.B)
    if ($d -gt $thr) { $diff++ }
    $total++
  }
}
$b1.Dispose(); $b2.Dispose()
Write-Output "WIDTH=$($dim1.Width)"
Write-Output "HEIGHT=$($dim1.Height)"
Write-Output "TOTAL=$total"
Write-Output "DIFF=$diff"
`;
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`screenshot_diff failed: ${r.stderr || r.stdout}`);
  const meta = {};
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const m = line.match(/^(WIDTH|HEIGHT|TOTAL|DIFF)=(\d+)$/);
    if (m) meta[m[1].toLowerCase()] = Number(m[2]);
  }
  const before = readFileSync(tmp1).toString("base64");
  const after  = readFileSync(tmp2).toString("base64");
  try { unlinkSync(tmp1); unlinkSync(tmp2); } catch {}
  const percent = meta.total ? (meta.diff / meta.total) * 100 : 0;
  return {
    before_b64: before, after_b64: after,
    width: meta.width, height: meta.height,
    pixels_sampled: meta.total, pixels_changed: meta.diff,
    percent_changed: Math.round(percent * 100) / 100,
    target,
  };
}

export function captureStudioWindow({ format = "jpeg", maxWidth = 1280 } = {}) {
  const ext = format === "png" ? "png" : "jpg";
  const fmtEnum = format === "png" ? "Png" : "Jpeg";
  const tmpFile = join(tmpdir(), `mcp_studio_${randomUUID()}.${ext}`);
  const pathEscaped = tmpFile.replace(/\\/g, "\\\\").replace(/'/g, "''");
  // SECURITY: maxWidth is interpolated into the PowerShell script — it MUST be a
  // plain integer or it becomes a command-injection sink. Never interpolate raw.
  const mw = Number.isFinite(Number(maxWidth)) ? Math.max(0, Math.trunc(Number(maxWidth))) : 1280;

  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W32 {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# Find Roblox Studio window (largest one matching the title)
$studio = Get-Process |
    Where-Object { $_.MainWindowTitle -like "*Roblox Studio*" -and $_.MainWindowHandle -ne 0 } |
    Sort-Object -Property WorkingSet64 -Descending |
    Select-Object -First 1

if (-not $studio) {
    Write-Error "No Roblox Studio window found. Is Studio running?"
    exit 1
}

$hwnd = $studio.MainWindowHandle

# If minimized, restore it (PrintWindow on a minimized window returns a blank image)
if ([W32]::IsIconic($hwnd)) {
    [W32]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
    Start-Sleep -Milliseconds 200
}

$rect = New-Object W32+RECT
[W32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Error "Invalid window dimensions"; exit 1 }

$bitmap = New-Object System.Drawing.Bitmap $w, $h
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
# PW_RENDERFULLCONTENT = 2 — works with DWM-composited windows like Studio
$ok = [W32]::PrintWindow($hwnd, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

if (-not $ok) { $bitmap.Dispose(); Write-Error "PrintWindow failed"; exit 1 }

# Optional resize
$maxW = ${mw}
if ($maxW -gt 0 -and $bitmap.Width -gt $maxW) {
    $ratio = $maxW / $bitmap.Width
    $newH = [int]($bitmap.Height * $ratio)
    $resized = New-Object System.Drawing.Bitmap $bitmap, $maxW, $newH
    $resized.Save('${pathEscaped}', [System.Drawing.Imaging.ImageFormat]::${fmtEnum})
    $resized.Dispose()
} else {
    $bitmap.Save('${pathEscaped}', [System.Drawing.Imaging.ImageFormat]::${fmtEnum})
}
$bitmap.Dispose()

# Emit window dimensions so caller can use them
Write-Output "WIDTH=$w"
Write-Output "HEIGHT=$h"
Write-Output "LEFT=$($rect.Left)"
Write-Output "TOP=$($rect.Top)"
`;

  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });

  if (result.status !== 0) {
    throw new Error(`PrintWindow capture failed: ${result.stderr || result.stdout || "unknown"}`);
  }

  // Parse window metadata from stdout
  const meta = {};
  for (const line of (result.stdout || "").split(/\r?\n/)) {
    const m = line.match(/^(WIDTH|HEIGHT|LEFT|TOP)=(-?\d+)$/);
    if (m) meta[m[1].toLowerCase()] = Number(m[2]);
  }

  const data = readFileSync(tmpFile);
  try { unlinkSync(tmpFile); } catch {}
  return {
    base64: data.toString("base64"),
    mimeType: format === "png" ? "image/png" : "image/jpeg",
    sizeBytes: data.length,
    window: meta, // { width, height, left, top } of the Studio window
  };
}

// ---------------------------------------------------------------------------
// Screenshot capture (OS-level, no plugin involvement)
// Uses PowerShell + System.Drawing — built into Windows, no extra deps.
// ---------------------------------------------------------------------------

export function captureScreenshot({ format = "jpeg", maxWidth = 1280, region = null } = {}) {
  const ext = format === "png" ? "png" : "jpg";
  const fmtEnum = format === "png" ? "Png" : "Jpeg";
  const tmpFile = join(tmpdir(), `mcp_screenshot_${randomUUID()}.${ext}`);
  const pathEscaped = tmpFile.replace(/\\/g, "\\\\").replace(/'/g, "''");
  // SECURITY: maxWidth is interpolated into the PowerShell script — coerce to a
  // plain integer so it can never carry a command-injection payload.
  const mw = Number.isFinite(Number(maxWidth)) ? Math.max(0, Math.trunc(Number(maxWidth))) : 1280;
  const resizeBlock =
    mw > 0
      ? `if ($bitmap.Width -gt ${mw}) {
           $ratio = ${mw} / $bitmap.Width;
           $newH = [int]($bitmap.Height * $ratio);
           $resized = New-Object System.Drawing.Bitmap $bitmap, ${mw}, $newH;
           $resized.Save('${pathEscaped}', [System.Drawing.Imaging.ImageFormat]::${fmtEnum});
           $resized.Dispose();
         } else {
           $bitmap.Save('${pathEscaped}', [System.Drawing.Imaging.ImageFormat]::${fmtEnum});
         }`
      : `$bitmap.Save('${pathEscaped}', [System.Drawing.Imaging.ImageFormat]::${fmtEnum});`;

  // Region: { x, y, width, height } in screen pixels. If null → whole primary screen.
  const regionBlock = region
    ? `$srcX = ${region.x | 0}; $srcY = ${region.y | 0};
       $regionW = ${region.width | 0}; $regionH = ${region.height | 0};
       $bitmap = New-Object System.Drawing.Bitmap $regionW, $regionH;
       $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
       $graphics.CopyFromScreen($srcX, $srcY, 0, 0, (New-Object System.Drawing.Size $regionW, $regionH));`
    : `$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
       $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
       $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
       $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);`;

  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms;
    Add-Type -AssemblyName System.Drawing;
    ${regionBlock}
    ${resizeBlock}
    $graphics.Dispose();
    $bitmap.Dispose();
  `.replace(/\s+/g, " ").trim();

  const result = spawnSync("powershell", ["-NoProfile", "-Command", psScript], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(`PowerShell failed: ${result.stderr || result.stdout || "unknown"}`);
  }

  const data = readFileSync(tmpFile);
  try { unlinkSync(tmpFile); } catch {}
  return {
    base64: data.toString("base64"),
    mimeType: format === "png" ? "image/png" : "image/jpeg",
    sizeBytes: data.length,
  };
}
