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
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C if exist $\"$INSTDIR\resources\bin\kabegame-plugin-editor.exe$\" move /Y $\"$INSTDIR\resources\bin\kabegame-plugin-editor.exe$\" $\"$INSTDIR$\"' $0
  DetailPrint "Move kabegame-plugin-editor.exe -> $INSTDIR (exit code: $0)"
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C if exist $\"$INSTDIR\resources\bin\kabegame-cli.exe$\" move /Y $\"$INSTDIR\resources\bin\kabegame-cli.exe$\" $\"$INSTDIR$\"' $0
  DetailPrint "Move kabegame-cli.exe -> $INSTDIR (exit code: $0)"
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C if exist $\"$INSTDIR\resources\bin\kabegame-cliw.exe$\" move /Y $\"$INSTDIR\resources\bin\kabegame-cliw.exe$\" $\"$INSTDIR$\"' $0
  DetailPrint "Move kabegame-cliw.exe -> $INSTDIR (exit code: $0)"

  ; Register .kgpg file association -> kabegame-cliw.exe plugin import "%1"
  ; (kabegame-cliw.exe is built as Windows subsystem and launches kabegame-cli.exe with CREATE_NO_WINDOW)
  ; HKCR is a merged view of HKLM\Software\Classes and HKCU\Software\Classes.
  ; We write to HKCU to avoid requiring admin.
  WriteRegStr HKCU "Software\Classes\.kgpg" "" "Kabegame.KGPG"
  WriteRegStr HKCU "Software\Classes\Kabegame.KGPG" "" "Kabegame 插件包 (.kgpg)"
  WriteRegStr HKCU "Software\Classes\Kabegame.KGPG\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\Kabegame.KGPG\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\Kabegame.KGPG\shell\open" "" "导入插件"
  WriteRegStr HKCU "Software\Classes\Kabegame.KGPG\shell\open\command" "" '"$INSTDIR\kabegame-cliw.exe" plugin import "%1"'

  ; Mark install dir as system + readonly so Explorer applies desktop.ini customization
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib +s +r $\"$INSTDIR$\"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove our customization to avoid leaving extra files/attributes that can prevent clean uninstall.
  IfFileExists "$INSTDIR\desktop.ini" 0 +3
    ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib -h -s $\"$INSTDIR\desktop.ini$\"'
    Delete "$INSTDIR\desktop.ini"

  ; Delete extra executables moved to install root (best-effort).
  IfFileExists "$INSTDIR\kabegame-plugin-editor.exe" 0 +2
    Delete "$INSTDIR\kabegame-plugin-editor.exe"
  IfFileExists "$INSTDIR\kabegame-cli.exe" 0 +2
    Delete "$INSTDIR\kabegame-cli.exe"
  IfFileExists "$INSTDIR\kabegame-cliw.exe" 0 +2
    Delete "$INSTDIR\kabegame-cliw.exe"

  ; Remove folder attributes (best-effort).
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib -s -r $\"$INSTDIR$\"'

  ; Unregister .kgpg association (best-effort, only if it's ours)
  ReadRegStr $0 HKCU "Software\Classes\.kgpg" ""
  StrCmp $0 "Kabegame.KGPG" 0 +3
    DeleteRegKey HKCU "Software\Classes\.kgpg"
    DeleteRegKey HKCU "Software\Classes\Kabegame.KGPG"
!macroend






