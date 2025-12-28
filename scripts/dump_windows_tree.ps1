Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Win32 {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWnd, EnumProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
}
"@

function Get-ClassName($hWnd) {
    $sb = New-Object System.Text.StringBuilder 256
    [Win32]::GetClassName($hWnd, $sb, $sb.Capacity) | Out-Null
    return $sb.ToString()
}

Write-Host "`n===== TOP LEVEL WINDOWS =====`n"

# ?? ï€ë∂àœëÔÅCñhé~îÌ GC
$enumProc = [Win32+EnumProc] {
    param($hWnd, $lParam)

    $class = Get-ClassName $hWnd
    if ($class) {
        Write-Host ("HWND=0x{0:X}  Class={1}" -f $hWnd.ToInt64(), $class)
    }
    return $true
}

[Win32]::EnumWindows($enumProc, [IntPtr]::Zero)

Write-Host "`n===== DESKTOP RELATED WINDOWS =====`n"

$desktopProc = [Win32+EnumProc] {
    param($hWnd, $lParam)

    $class = Get-ClassName $hWnd
    if ($class -in @("Progman", "WorkerW")) {
        Write-Host ("[DESKTOP] HWND=0x{0:X}  Class={1}" -f $hWnd.ToInt64(), $class)

        [Win32]::EnumChildWindows($hWnd, [Win32+EnumProc] {
                param($child, $l)
                $childClass = Get-ClassName $child
                Write-Host ("    Ñ§Ñü HWND=0x{0:X}  Class={1}" -f $child.ToInt64(), $childClass)
                return $true
            }, [IntPtr]::Zero)
    }
    return $true
}

[Win32]::EnumWindows($desktopProc, [IntPtr]::Zero)
