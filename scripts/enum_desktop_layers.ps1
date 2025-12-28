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

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetClassName(
        IntPtr hWnd,
        StringBuilder lpClassName,
        int nMaxCount
    );

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(
        IntPtr hWnd,
        uint uCmd
    );

    public const uint GW_HWNDNEXT = 2;
}
"@

function Get-ClassName($hwnd) {
    $sb = New-Object System.Text.StringBuilder 256
    [Win32]::GetClassName($hwnd, $sb, $sb.Capacity) | Out-Null
    return $sb.ToString()
}

Write-Host "🔍 Scanning desktop window hierarchy..." -ForegroundColor Cyan
Write-Host ""

$foundDefView = $false

[Win32]::EnumWindows({
    param($hWnd, $lParam)

    $class = Get-ClassName $hWnd

    # 查找顶级窗口下是否有 SHELLDLL_DefView
    $defViewHwnd = [IntPtr]::Zero

    [Win32]::EnumChildWindows($hWnd, {
        param($child, $lp)

        $childClass = Get-ClassName $child
        if ($childClass -eq "SHELLDLL_DefView") {
            $script:defViewHwnd = $child
            return $false
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null

    if ($script:defViewHwnd -ne [IntPtr]::Zero) {
        $foundDefView = $true

        Write-Host "🟢 Found SHELLDLL_DefView" -ForegroundColor Green
        Write-Host ("  Parent HWND : 0x{0:X}" -f $hWnd.ToInt64())
        Write-Host ("  Parent Class: {0}" -f $class)

        # 获取下一个兄弟窗口（关键！）
        $next = [Win32]::GetWindow($hWnd, [Win32]::GW_HWNDNEXT)
        if ($next -ne [IntPtr]::Zero) {
            $nextClass = Get-ClassName $next
            Write-Host ""
            Write-Host "👉 Wallpaper candidate (next window):" -ForegroundColor Yellow
            Write-Host ("  HWND  : 0x{0:X}" -f $next.ToInt64())
            Write-Host ("  Class : {0}" -f $nextClass)
        }

        Write-Host ""
        Write-Host "----------------------------------------"
    }

    return $true
}, [IntPtr]::Zero) | Out-Null

if (-not $foundDefView) {
    Write-Host "❌ SHELLDLL_DefView not found (Explorer not ready?)" -ForegroundColor Red
}
