Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Win32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(
        IntPtr hWnd,
        EnumWindowsProc lpEnumFunc,
        IntPtr lParam
    );

    [DllImport("user32.dll")]
    public static extern int GetClassName(
        IntPtr hWnd,
        StringBuilder lpClassName,
        int nMaxCount
    );

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        int Msg,
        IntPtr wParam,
        IntPtr lParam,
        SendMessageTimeoutFlags flags,
        int timeout,
        out IntPtr lpdwResult
    );

    public enum SendMessageTimeoutFlags : uint {
        SMTO_NORMAL = 0x0
    }
}
"@

function Get-ClassName($hwnd) {
    $sb = New-Object System.Text.StringBuilder 256
    [Win32]::GetClassName($hwnd, $sb, $sb.Capacity) | Out-Null
    return $sb.ToString()
}

Write-Host "🧠 Step 1: Send 0x052C to Progman" -ForegroundColor Cyan

$progman = [Win32]::FindWindow("Progman", $null)
if ($progman -eq [IntPtr]::Zero) {
    Write-Host "❌ Progman not found" -ForegroundColor Red
    exit
}

[IntPtr]$out = [IntPtr]::Zero
[Win32]::SendMessageTimeout(
    $progman,
    0x052C,
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    [Win32+SendMessageTimeoutFlags]::SMTO_NORMAL,
    100,
    [ref]$out
) | Out-Null

Start-Sleep -Milliseconds 300

Write-Host "🔍 Step 2: Scanning WorkerW windows..." -ForegroundColor Cyan
Write-Host ""

$wallpaperWorkerW = $null

[Win32]::EnumWindows({
    param($hWnd, $lParam)

    $class = Get-ClassName $hWnd
    if ($class -ne "WorkerW") { return $true }

    $hasDefView = $false

    [Win32]::EnumChildWindows($hWnd, {
        param($child, $lp)
        if ((Get-ClassName $child) -eq "SHELLDLL_DefView") {
            $script:hasDefView = $true
            return $false
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null

    if (-not $hasDefView) {
        $script:wallpaperWorkerW = $hWnd
        return $false
    }

    return $true
}, [IntPtr]::Zero) | Out-Null

if ($wallpaperWorkerW -ne $null) {
    Write-Host "✅ Wallpaper WorkerW FOUND!" -ForegroundColor Green
    Write-Host ("   HWND : 0x{0:X}" -f $wallpaperWorkerW.ToInt64())
    Write-Host "   👉 这是你要挂壁纸 / Tauri 窗口的目标"
} else {
    Write-Host "❌ Wallpaper WorkerW NOT found" -ForegroundColor Red
    Write-Host "   Explorer 可能未完成初始化，重试一次～"
}
