param(
    [UInt64]$ProgmanHwnd = 196862,
    [UInt64]$WorkerWHwnd = 460728,
    [string]$ProcessName = 'kabegami-crawler',
    [int]$MaxFilterRows = 250,
    [int]$MaxTopRows = 80,
    [switch]$FixZOrder,
    [int]$FixRepeat = 5,
    [int]$FixSleepMs = 120
)

$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public static class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static string ClassName(IntPtr hWnd) {
    var sb = new StringBuilder(256);
    var n = GetClassName(hWnd, sb, sb.Capacity);
    return n > 0 ? sb.ToString() : "";
  }

  public static string Title(IntPtr hWnd) {
    int len = GetWindowTextLength(hWnd);
    var sb = new StringBuilder(Math.Max(len + 1, 256));
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public static bool HasDefView(IntPtr hWnd) {
    return FindDescendant(hWnd, "SHELLDLL_DefView") != IntPtr.Zero;
  }

  public static bool HasFolderView(IntPtr hWnd) {
    var def = FindDescendant(hWnd, "SHELLDLL_DefView");
    if (def == IntPtr.Zero) return false;
    return FindDescendant(def, "SysListView32") != IntPtr.Zero;
  }

  public static IntPtr FindDescendant(IntPtr root, string className) {
    if (root == IntPtr.Zero) return IntPtr.Zero;
    var q = new Queue<IntPtr>();
    q.Enqueue(root);
    while (q.Count > 0) {
      var cur = q.Dequeue();
      // enumerate immediate children of cur
      EnumChildWindows(cur, (child, lp) => {
        q.Enqueue(child);
        return true;
      }, IntPtr.Zero);

      // don't match root itself unless it is actually the class (rare for our use)
      if (cur != root) {
        var cls = ClassName(cur);
        if (cls == className) return cur;
      }
    }
    return IntPtr.Zero;
  }

  public static IntPtr RootTopLevel(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return IntPtr.Zero;
    IntPtr cur = hWnd;
    while (true) {
      var p = GetParent(cur);
      if (p == IntPtr.Zero) return cur;
      cur = p;
    }
  }
}
'@

Add-Type -TypeDefinition $code -Language CSharp | Out-Null

$progman = [IntPtr]::new([Int64]$ProgmanHwnd)
$workerw = [IntPtr]::new([Int64]$WorkerWHwnd)

$HWND_TOP = [IntPtr]::Zero
$HWND_BOTTOM = [IntPtr]::new(1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_NOACTIVATE = 0x0010
$SWP_SHOWWINDOW = 0x0040

if ($FixZOrder) {
    Write-Host "=== FixZOrder: trying to force WorkerW->BOTTOM and Progman->TOP (repeat=$FixRepeat, sleep=${FixSleepMs}ms) ==="
    for ($i = 0; $i -lt $FixRepeat; $i++) {
        if ($WorkerWHwnd -ne 0) {
            # clear potential topmost grouping then send to bottom
            [Win32]::SetWindowPos($workerw, $HWND_NOTOPMOST, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE)) | Out-Null
            [Win32]::SetWindowPos($workerw, $HWND_BOTTOM, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE)) | Out-Null
        }
        if ($ProgmanHwnd -ne 0) {
            [Win32]::SetWindowPos($progman, $HWND_TOP, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW)) | Out-Null
        }
        Start-Sleep -Milliseconds $FixSleepMs
    }
    Write-Host "=== FixZOrder done ==="
}

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
$targetPid = if ($proc) { $proc.Id } else { 0 }

$rows = New-Object System.Collections.Generic.List[object]

[Win32]::EnumWindows({
        param([IntPtr]$hWnd, [IntPtr]$lParam)

        $cls = [Win32]::ClassName($hWnd)
        $vis = [Win32]::IsWindowVisible($hWnd)
        $winPid = 0
        [Win32]::GetWindowThreadProcessId($hWnd, [ref]$winPid) | Out-Null

        $r = New-Object Win32+RECT
        $ok = [Win32]::GetWindowRect($hWnd, [ref]$r)
        $w = if ($ok) { $r.Right - $r.Left } else { 0 }
        $h = if ($ok) { $r.Bottom - $r.Top } else { 0 }

        $hasDef = [Win32]::HasDefView($hWnd)
        $hasFolder = [Win32]::HasFolderView($hWnd)
        $title = [Win32]::Title($hWnd)

        $tag = @()
        if ($hWnd -eq $progman) { $tag += 'Progman' }
        if ($hWnd -eq $workerw) { $tag += 'WorkerW' }
        if ($targetPid -ne 0 -and $winPid -eq $targetPid) { $tag += $ProcessName }

        $rows.Add([pscustomobject]@{
                Z             = $rows.Count   # 0 = topmost (EnumWindows order)
                Hwnd          = ('0x{0:X}' -f $hWnd.ToInt64())
                Class         = $cls
                Vis           = [int]$vis
                Pid           = $winPid
                Rect          = if ($ok) { "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)" } else { "" }
                Size          = "${w}x${h}"
                HasDefView    = [int]$hasDef
                HasFolderView = [int]$hasFolder
                Title         = if ($title.Length -gt 80) { $title.Substring(0, 80) + '…' } else { $title }
                Tag           = ($tag -join ',')
            }) | Out-Null

        return $true
    }, [IntPtr]::Zero) | Out-Null

Write-Host ("=== {0} pid: {1} ===" -f $ProcessName, $targetPid)
Write-Host ("=== Filtered: Progman/WorkerW/{0} (show first {1}) ===" -f $ProcessName, $MaxFilterRows)
$rows |
Where-Object { $_.Tag -ne '' -or $_.Class -in @('Progman', 'WorkerW') } |
Select-Object -First $MaxFilterRows |
Format-Table -AutoSize

Write-Host ""
Write-Host ("=== Top-level windows in z-order (0=topmost), show first {0} ===" -f $MaxTopRows)
$rows | Select-Object -First $MaxTopRows | Format-Table -AutoSize

Write-Host ""
Write-Host "=== Descendant scan: SysListView32 roots (first 50) ==="
$list = New-Object System.Collections.Generic.List[object]
[Win32]::EnumWindows({
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        # For each top-level window, search for SysListView32 anywhere underneath
        $fv = [Win32]::FindDescendant($hWnd, 'SysListView32')
        if ($fv -ne [IntPtr]::Zero) {
            $root = [Win32]::RootTopLevel($fv)
            $clsRoot = [Win32]::ClassName($root)
            $clsTop = [Win32]::ClassName($hWnd)
            $list.Add([pscustomobject]@{
                    TopHwnd        = ('0x{0:X}' -f $hWnd.ToInt64())
                    TopClass       = $clsTop
                    FolderViewHwnd = ('0x{0:X}' -f $fv.ToInt64())
                    RootHwnd       = ('0x{0:X}' -f $root.ToInt64())
                    RootClass      = $clsRoot
                    RootIsProgman  = [int]($root -eq $progman)
                    RootIsWorkerW  = [int]($root -eq $workerw)
                }) | Out-Null
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null

$list | Select-Object -First 50 | Format-Table -AutoSize


