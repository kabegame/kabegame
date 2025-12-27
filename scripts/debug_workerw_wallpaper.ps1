param(
  [string]$TitleContains = "Kabegami Wallpaper",
  [switch]$DoSetParent
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
  public static extern IntPtr FindWindowA(string lpClassName, string lpWindowName);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
  public static extern IntPtr FindWindowExA(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetClassNameA(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowTextA(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeoutA(
    IntPtr hWnd,
    uint Msg,
    IntPtr wParam,
    IntPtr lParam,
    uint fuFlags,
    uint uTimeout,
    out IntPtr lpdwResult
  );

  public const uint SMTO_ABORTIFHUNG = 0x0002;
}
"@

function Get-WindowInfo([IntPtr]$hWnd) {
  $cls = New-Object System.Text.StringBuilder 256
  [void][Win32]::GetClassNameA($hWnd, $cls, $cls.Capacity)
  $txt = New-Object System.Text.StringBuilder 512
  [void][Win32]::GetWindowTextA($hWnd, $txt, $txt.Capacity)
  $pid = 0
  [void][Win32]::GetWindowThreadProcessId($hWnd, [ref]$pid)
  [pscustomobject]@{
    Hwnd  = ("0x{0:X}" -f $hWnd.ToInt64())
    Class = $cls.ToString()
    Title = $txt.ToString()
    Pid   = $pid
  }
}

function Get-WorkerW {
  # 经典做法：
  # 1) 找 Progman
  # 2) 给 Progman 发 0x052C 让系统生成/刷新 WorkerW
  # 3) EnumWindows 找到包含 SHELLDLL_DefView 的顶层窗口
  # 4) 再找其后面的 WorkerW（兄弟窗口）
  $progman = [Win32]::FindWindowA("Progman", $null)
  if ($progman -eq [IntPtr]::Zero) { throw "FindWindowA('Progman') 失败，LastError=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

  $dummy = [IntPtr]::Zero
  [void][Win32]::SendMessageTimeoutA($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, [Win32]::SMTO_ABORTIFHUNG, 1000, [ref]$dummy)

  $found = [IntPtr]::Zero

  $cb = [Win32+EnumWindowsProc]{
    param([IntPtr]$top, [IntPtr]$lparam)
    $defView = [Win32]::FindWindowExA($top, [IntPtr]::Zero, "SHELLDLL_DefView", $null)
    if ($defView -ne [IntPtr]::Zero) {
      # 找到包含桌面图标的窗口，取它后面的 WorkerW
      $worker = [Win32]::FindWindowExA([IntPtr]::Zero, $top, "WorkerW", $null)
      if ($worker -ne [IntPtr]::Zero) {
        $script:found = $worker
        return $false
      }
    }
    return $true
  }

  [void][Win32]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}

Write-Host "=== WorkerW/Wallpaper Debug ==="
Write-Host ("TitleContains = '{0}'" -f $TitleContains)

$workerw = Get-WorkerW
Write-Host ("WorkerW = {0}" -f ("0x{0:X}" -f $workerw.ToInt64()))

Write-Host "`n--- Top-level windows matching TitleContains ---"
$matches = New-Object System.Collections.Generic.List[object]

$cb2 = [Win32+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $info = Get-WindowInfo $hWnd
  if ($info.Title -and $info.Title.Contains($TitleContains)) {
    $script:matches.Add($info) | Out-Null
  }
  return $true
}
[void][Win32]::EnumWindows($cb2, [IntPtr]::Zero)
$matches | Format-Table -AutoSize

if ($matches.Count -eq 0) {
  Write-Host "`n[WARN] No window title contains the given string."
  Write-Host "       Start the app first and ensure the wallpaper window title matches TitleContains."
  exit 0
}

$target = $matches[$matches.Count - 1]
Write-Host ("`nTarget = {0}  PID={1}  Class={2}  Title='{3}'" -f $target.Hwnd, $target.Pid, $target.Class, $target.Title)

if (-not $DoSetParent) {
  Write-Host "`n(Dry-run) Pass -DoSetParent to actually call SetParent."
  exit 0
}

if ($workerw -eq [IntPtr]::Zero) {
  throw "WorkerW not found; cannot SetParent."
}

Write-Host "`n--- Calling SetParent ---"
# $target.Hwnd is like "0x1234ABCD"
$hex = $target.Hwnd
if ($hex.StartsWith("0x")) { $hex = $hex.Substring(2) }
$h = [IntPtr]::new([Convert]::ToInt64($hex, 16))
$r = [Win32]::SetParent($h, $workerw)
$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
Write-Host ("SetParent returned = 0x{0:X}  LastError={1}" -f $r.ToInt64(), $err)

if ($r -eq [IntPtr]::Zero) {
  throw ("SetParent failed. LastError={0}" -f $err)
}

Write-Host "OK"


