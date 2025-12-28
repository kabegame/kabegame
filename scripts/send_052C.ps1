Add-Type @"
using System;
using System.Runtime.InteropServices;

namespace DesktopMagic {
    public class ProgmanHelper {

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr FindWindow(
            string lpClassName,
            string lpWindowName
        );

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd,
            int Msg,
            IntPtr wParam,
            IntPtr lParam,
            int flags,
            int timeout,
            out IntPtr lpdwResult
        );
    }
}
"@

# 1️⃣ 尝试不同方式查找 Progman
$progman = [DesktopMagic.ProgmanHelper]::FindWindow("Progman", $null)

if ($progman -eq [IntPtr]::Zero) {
    $progman = [DesktopMagic.ProgmanHelper]::FindWindow("Progman", "Program Manager")
}

if ($progman -eq [IntPtr]::Zero) {
    Write-Host "Progman still not found"
    exit 1
}

Write-Host ("Progman found: 0x{0:X}" -f $progman.ToInt64())

# 2️⃣ 发送 0x052C
$result = [IntPtr]::Zero

[DesktopMagic.ProgmanHelper]::SendMessageTimeout(
    $progman,
    0x052C,
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    0,
    100,
    [ref]$result
) | Out-Null

Write-Host "0x052C sent"
