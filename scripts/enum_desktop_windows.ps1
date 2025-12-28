Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Win32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindowEx(
        IntPtr hwndParent,
        IntPtr hwndChildAfter,
        string lpszClass,
        string lpszWindow
    );
}
"@

$results = New-Object System.Collections.Generic.List[object]

$callback = [Win32+EnumWindowsProc] {
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    $classSb = New-Object System.Text.StringBuilder 256
    $titleSb = New-Object System.Text.StringBuilder 256

    [Win32]::GetClassName($hWnd, $classSb, $classSb.Capacity) | Out-Null
    [Win32]::GetWindowText($hWnd, $titleSb, $titleSb.Capacity) | Out-Null

    $class = $classSb.ToString()
    $title = $titleSb.ToString()

    if ($class -eq "Progman" -or $class -eq "WorkerW") {
        $defView = [Win32]::FindWindowEx(
            $hWnd,
            [IntPtr]::Zero,
            "SHELLDLL_DefView",
            $null
        )

        $results.Add([PSCustomObject]@{
                HWND            = ("0x{0:X}" -f $hWnd.ToInt64())
                Class           = $class
                Title           = $title
                HasDesktopIcons = ($defView -ne [IntPtr]::Zero)
            })
    }

    return $true  # ⚠️ 必须是真正的 bool
}

[Win32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

$results | Format-Table -AutoSize
