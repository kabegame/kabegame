; Tauri NSIS installer hooks.
; This file is included by the generated installer.nsi when configured via:
; bundle.windows.nsis.installerHooks = "nsis/installer-hooks.nsh"
;
; Goal: make the install directory show the app icon in Windows Explorer
; by writing desktop.ini and setting required folder/file attributes.

!macro NSIS_HOOK_POSTINSTALL
  ; Create / update desktop.ini
  WriteINIStr "$INSTDIR\desktop.ini" ".ShellClassInfo" "IconResource" "${MAINBINARYNAME}.exe,0"

  ; Mark desktop.ini as hidden + system
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib +h +s $\"$INSTDIR\desktop.ini$\"'

  ; Move extra executables from resources/bin to install root ($INSTDIR).
  ; We intentionally avoid Tauri sidecar/externalBin and instead ship exe as resources.
  ; Check if dokan2.dll is bundled (not present in light mode)
  IfFileExists "$INSTDIR\resources\bin\dokan2.dll" +4 0
    DetailPrint "dokan2.dll not bundled (light mode), skipping Dokan setup."
    ; is light mode, skip copy binary
    Goto no_light_done

  ; Move dokan2.dll next to main exe so Windows loader can resolve it at process start.
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C if exist $\"$INSTDIR\resources\bin\dokan2.dll$\" move /Y $\"$INSTDIR\resources\bin\dokan2.dll$\" $\"$INSTDIR$\"' $0
  DetailPrint "Move dokan2.dll -> $INSTDIR (exit code: $0)"

  ; Ensure Dokan driver is installed (dokan2.sys). Bundled installer is optional.
  ; Notes:
  ; - dokan2.dll alone is NOT enough; the kernel driver must be installed.
  ; - If NSIS is not elevated, we fallback to running the installer via UAC (runas).
  ;
  ; Expected bundled installer path:
  ; - $INSTDIR\resources\bin\dokan-installer.exe
  ; NOTE:
  ; - 仅检查 dokan2.dll 不可靠；驱动关键文件是 dokan2.sys。
  ; - 32-bit NSIS 在 64-bit Windows 上访问 $SYSDIR 会被重定向到 SysWOW64，而 dokan2.sys 在真实
  ;   System32\drivers 下，导致“已安装仍重复安装”。先用 $WINDIR\SysNative\drivers 检测（仅 32 位进程
  ;   在 64 位系统上可见，指向真实 System32），否则用 $SYSDIR\drivers（64 位进程或 32 位系统）。
  ; 检测路径：优先 $WINDIR\SysNative\drivers\dokan2.sys，否则 $SYSDIR\drivers\dokan2.sys
  IfFileExists "$WINDIR\SysNative\drivers\dokan2.sys" dokan_driver_ok
  IfFileExists "$SYSDIR\drivers\dokan2.sys" dokan_driver_ok
  ; 两处都不存在，需要安装
  IfFileExists "$INSTDIR\resources\bin\dokan-installer.exe" +1 dokan_driver_ok
  DetailPrint "Dokan driver not found; installing (via runas)..."
  ; Marker: record that we attempted to launch installer (for debugging)
  FileOpen $2 "$INSTDIR\dokan-install-attempt.txt" w
  FileWrite $2 "attempted\r\n"
  FileClose $2
  ; Always use runas to guarantee elevation (GetAccountType may be Admin but not elevated).
  ExecShell "runas" '"$INSTDIR\resources\bin\dokan-installer.exe"' "/S"
  DetailPrint "Dokan installer launched (runas, silent)."
  ; Re-check (best-effort)
  IfFileExists "$WINDIR\SysNative\drivers\dokan2.sys" 0 +2
  DetailPrint "Dokan driver installed."
  IfFileExists "$SYSDIR\drivers\dokan2.sys" 0 +2
  DetailPrint "Dokan driver installed."
  dokan_driver_ok:

  ExecWait '$\"$SYSDIR\cmd.exe$\" /C if exist $\"$INSTDIR\resources\bin\kabegame-cli.exe$\" move /Y $\"$INSTDIR\resources\bin\kabegame-cli.exe$\" $\"$INSTDIR$\"' $0
  DetailPrint "Move kabegame-cli.exe -> $INSTDIR (exit code: $0)"
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C if exist $\"$INSTDIR\resources\bin\kabegame-cliw.exe$\" move /Y $\"$INSTDIR\resources\bin\kabegame-cliw.exe$\" $\"$INSTDIR$\"' $0
  DetailPrint "Move kabegame-cliw.exe -> $INSTDIR (exit code: $0)"

  no_light_done:

  ; Mark install dir as system + readonly so Explorer applies desktop.ini customization
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib +s +r $\"$INSTDIR$\"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove our customization to avoid leaving extra files/attributes that can prevent clean uninstall.
  IfFileExists "$INSTDIR\desktop.ini" 0 +3
    ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib -h -s $\"$INSTDIR\desktop.ini$\"'
    Delete "$INSTDIR\desktop.ini"

  ; Delete extra executables moved to install root (best-effort).
  IfFileExists "$INSTDIR\kabegame-cli.exe" 0 +2
    Delete "$INSTDIR\kabegame-cli.exe"
  IfFileExists "$INSTDIR\kabegame-cliw.exe" 0 +2
    Delete "$INSTDIR\kabegame-cliw.exe"

  IfFileExists "$INSTDIR\dokan2.dll" 0 +2
    Delete "$INSTDIR\dokan2.dll"

  ; Remove folder attributes (best-effort).
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib -s -r $\"$INSTDIR$\"'

  ; .kgpg 关联交由 Tauri bundler 根据 tauri.conf.json > bundle > fileAssociations 处理
!macroend






