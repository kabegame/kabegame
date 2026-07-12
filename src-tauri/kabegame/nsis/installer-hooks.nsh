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

  ; Move extra executables/DLLs from resources/bin to install root ($INSTDIR).
  ; We intentionally avoid Tauri sidecar/externalBin and instead ship exe as resources.
  ; Move each *.dll with FindFirst/FindNext to avoid cmd for-loop quoting issues when $INSTDIR has spaces.
  FindFirst $0 $1 "$INSTDIR\resources\bin\*.dll"
  dll_move_loop:
    StrCmp $1 "" dll_move_done
    ExecWait '$\"$SYSDIR\cmd.exe$\" /C move /Y $\"$INSTDIR\resources\bin\$1$\" $\"$INSTDIR$\"' $2
    DetailPrint "Move $1 -> $INSTDIR (exit $2)"
    FindNext $0 $1
    Goto dll_move_loop
  dll_move_done:
  FindClose $0

  ; CEF subprocess helper must live next to kabegame.exe.
  IfFileExists "$INSTDIR\resources\bin\kabegame-cef-helper.exe" 0 helper_move_done
    ExecWait '$\"$SYSDIR\cmd.exe$\" /C move /Y $\"$INSTDIR\resources\bin\kabegame-cef-helper.exe$\" $\"$INSTDIR$\"' $2
    DetailPrint "Move kabegame-cef-helper.exe -> $INSTDIR (exit $2)"
  helper_move_done:

  ; Move the CEF runtime from resources/cef to install root. libcef.dll is
  ; load-time linked and CEF requires dll/pak/dat files and locales/ to sit
  ; next to the exe, so they cannot stay under resources\.
  IfFileExists "$INSTDIR\resources\cef\libcef.dll" 0 cef_all_done
  FindFirst $0 $1 "$INSTDIR\resources\cef\*.*"
  cef_move_loop:
    StrCmp $1 "" cef_move_done
    StrCmp $1 "." cef_move_next
    StrCmp $1 ".." cef_move_next
    StrCmp $1 "locales" cef_move_next
    ExecWait '$\"$SYSDIR\cmd.exe$\" /C move /Y $\"$INSTDIR\resources\cef\$1$\" $\"$INSTDIR$\"' $2
    DetailPrint "Move CEF $1 -> $INSTDIR (exit $2)"
  cef_move_next:
    FindNext $0 $1
    Goto cef_move_loop
  cef_move_done:
  FindClose $0

  CreateDirectory "$INSTDIR\locales"
  FindFirst $0 $1 "$INSTDIR\resources\cef\locales\*.pak"
  cef_locale_move_loop:
    StrCmp $1 "" cef_locale_move_done
    ExecWait '$\"$SYSDIR\cmd.exe$\" /C move /Y $\"$INSTDIR\resources\cef\locales\$1$\" $\"$INSTDIR\locales$\"' $2
    DetailPrint "Move CEF locale $1 -> $INSTDIR\locales (exit $2)"
    FindNext $0 $1
    Goto cef_locale_move_loop
  cef_locale_move_done:
  FindClose $0

  ; Remove the now-empty staging dirs (best-effort; RMDir only removes empty dirs)
  RMDir "$INSTDIR\resources\cef\locales"
  RMDir "$INSTDIR\resources\cef"
  cef_all_done:

  ; Mark install dir as system + readonly so Explorer applies desktop.ini customization
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib +s +r $\"$INSTDIR$\"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove our customization to avoid leaving extra files/attributes that can prevent clean uninstall.
  IfFileExists "$INSTDIR\desktop.ini" 0 +3
    ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib -h -s $\"$INSTDIR\desktop.ini$\"'
    Delete "$INSTDIR\desktop.ini"

  ; Delete all DLLs we moved from resources/bin (dokan2.dll and other bin/*.dll)
  ; This sweep also removes the CEF DLLs (libcef.dll, chrome_elf.dll, ...).
  FindFirst $0 $1 "$INSTDIR\*.dll"
  dll_del_loop:
    StrCmp $1 "" dll_del_done
    Delete "$INSTDIR\$1"
    FindNext $0 $1
    Goto dll_del_loop
  dll_del_done:
  FindClose $0

  ; Delete non-DLL CEF runtime files moved to install root (best-effort)
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  ; CEF verbose log written next to the exe (if any)
  Delete "$INSTDIR\debug.log"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\kabegame-cef-helper.exe"

  ; Remove folder attributes (best-effort).
  ExecWait '$\"$SYSDIR\cmd.exe$\" /C attrib -s -r $\"$INSTDIR$\"'

  ; .kgpg 关联交由 Tauri bundler 根据 tauri.conf.json > bundle > fileAssociations 处理
!macroend






