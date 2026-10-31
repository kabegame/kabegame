; Tauri NSIS installer hooks.
; This file is included by the generated installer.nsi when configured via:
; bundle.windows.nsis.installerHooks = "nsis/installer-hooks.nsh"
;
; Goal: make the install directory show the app icon in Windows Explorer
; by writing desktop.ini and setting required folder/file attributes.
;
; Only native NSIS instructions are used here (Rename / SetFileAttributes):
; spawning cmd.exe for move/attrib flashes one console window per file.

; Move a file within $INSTDIR, overwriting the destination (like `move /Y`).
; Rename is MoveFile, so source and destination must be on the same volume,
; which always holds inside $INSTDIR. It fails if the destination exists,
; hence the Delete first.
!macro KABEGAME_MOVE_FILE SRC DST
  Delete "${DST}"
  ClearErrors
  Rename "${SRC}" "${DST}"
  ${If} ${Errors}
    DetailPrint "Move failed: ${SRC} -> ${DST}"
  ${Else}
    DetailPrint "Move ${SRC} -> ${DST}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Create / update desktop.ini
  WriteINIStr "$INSTDIR\desktop.ini" ".ShellClassInfo" "IconResource" "${MAINBINARYNAME}.exe,0"

  ; Mark desktop.ini as hidden + system
  SetFileAttributes "$INSTDIR\desktop.ini" HIDDEN|SYSTEM

  ; Move extra executables/DLLs from resources/bin to install root ($INSTDIR).
  ; We intentionally avoid Tauri sidecar/externalBin and instead ship exe as resources.
  FindFirst $0 $1 "$INSTDIR\resources\bin\*.dll"
  dll_move_loop:
    StrCmp $1 "" dll_move_done
    !insertmacro KABEGAME_MOVE_FILE "$INSTDIR\resources\bin\$1" "$INSTDIR\$1"
    FindNext $0 $1
    Goto dll_move_loop
  dll_move_done:
  FindClose $0

  ; kabegame-cef-helper.exe is no longer staged under resources\bin: it is a
  ; first-class bundle binary (tauri.conf.json top-level `bins`, fork patch 09)
  ; that NSIS installs directly to $INSTDIR and deletes on uninstall.

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
    !insertmacro KABEGAME_MOVE_FILE "$INSTDIR\resources\cef\$1" "$INSTDIR\$1"
  cef_move_next:
    FindNext $0 $1
    Goto cef_move_loop
  cef_move_done:
  FindClose $0

  CreateDirectory "$INSTDIR\locales"
  FindFirst $0 $1 "$INSTDIR\resources\cef\locales\*.pak"
  cef_locale_move_loop:
    StrCmp $1 "" cef_locale_move_done
    !insertmacro KABEGAME_MOVE_FILE "$INSTDIR\resources\cef\locales\$1" "$INSTDIR\locales\$1"
    FindNext $0 $1
    Goto cef_locale_move_loop
  cef_locale_move_done:
  FindClose $0

  ; Remove the now-empty staging dirs (best-effort; RMDir only removes empty dirs)
  RMDir "$INSTDIR\resources\cef\locales"
  RMDir "$INSTDIR\resources\cef"
  cef_all_done:

  ; Mark install dir as system + readonly so Explorer applies desktop.ini customization
  SetFileAttributes "$INSTDIR" SYSTEM|READONLY
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove our customization to avoid leaving extra files/attributes that can prevent clean uninstall.
  IfFileExists "$INSTDIR\desktop.ini" 0 +3
    SetFileAttributes "$INSTDIR\desktop.ini" NORMAL
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
  ; kabegame-cef-helper.exe: deleted by the generated uninstaller's native
  ; binaries section (it is a bundle binary since fork patch 09).

  ; Remove folder attributes (best-effort).
  SetFileAttributes "$INSTDIR" NORMAL

  ; .kgpg 关联交由 Tauri bundler 根据 tauri.conf.json > bundle > fileAssociations 处理
!macroend
