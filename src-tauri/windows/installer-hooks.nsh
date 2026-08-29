; Guard rail for a Windows productName change, dormant today.
;
; tauri.windows.conf.json deliberately pins productName to "Locally Uncensored"
; (only the window title says "LU") because the stock NSIS template discovers a
; previous install ONLY under the CURRENT product name's registry key. If a
; future release ever ships a different Windows productName without migration,
; every updating user ends up with TWO entries in Apps & Features and stale
; shortcuts that keep launching the old build (which re-offers the update,
; forever). The 2.5.7 rebrand nearly did exactly that.
;
; The !if below compiles this hook away while the name is unchanged. The moment
; a build uses a new productName, the hook turns live: it finds the old-name
; install and removes it silently before the new files land. The old
; uninstaller only deletes app data when its confirm-page checkbox is ticked -
; that page never shows in silent mode - so chats, settings, and models under
; the com.purpledoubled.locally-uncensored app-data folders survive untouched
; (the bundle identifier must never change).

!macro LU_REMOVE_OLD_NSIS ROOT
  ClearErrors
  ReadRegStr $R7 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\Locally Uncensored" "UninstallString"
  ReadRegStr $R8 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\Locally Uncensored" "InstallLocation"
  ${If} $R7 != ""
    ; both values are written quoted by the old installer - strip the quotes
    StrCpy $R9 $R7 1
    ${If} $R9 == '"'
      StrCpy $R7 $R7 "" 1
      StrCpy $R9 $R7 1 -1
      ${If} $R9 == '"'
        StrCpy $R7 $R7 -1
      ${EndIf}
    ${EndIf}
    StrCpy $R9 $R8 1
    ${If} $R9 == '"'
      StrCpy $R8 $R8 "" 1
      StrCpy $R9 $R8 1 -1
      ${If} $R9 == '"'
        StrCpy $R8 $R8 -1
      ${EndIf}
    ${EndIf}

    ; the old app can still be running (manual installs while 2.5.6 is open);
    ; stop it and its children (sidecars) so no file stays locked. Older
    ; releases shipped the exe under the cargo name, newer ones under the
    ; product name - kill both spellings.
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "locally-uncensored.exe"'
    Pop $R9
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "Locally Uncensored.exe"'
    Pop $R9

    ${If} ${FileExists} "$R7"
      ${If} $R8 != ""
        ; _?= keeps the uninstaller running in place so ExecWait really waits;
        ; it then can't delete itself, so we sweep the leftovers ourselves
        ExecWait '"$R7" /S _?=$R8' $R9
        Delete "$R7"
        ; only remove the folder when it really is the old install dir
        StrCpy $R9 $R8 "" -18
        ${If} $R9 == "Locally Uncensored"
          RMDir /r "$R8"
        ${EndIf}
      ${Else}
        ; no recorded location: let it uninstall from its temp copy
        ExecWait '"$R7" /S' $R9
        Sleep 2000
      ${EndIf}
    ${EndIf}

    ; belt and braces - harmless when the uninstaller already cleaned these
    DeleteRegKey ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\Locally Uncensored"
    DeleteRegKey ${ROOT} "Software\PurpleDoubleD\Locally Uncensored"
    DeleteRegKey /ifempty ${ROOT} "Software\PurpleDoubleD"
  ${EndIf}
!macroend

; Free the bundled engine before the new files land. Live in EVERY build.
;
; aldrich_ironhart, 2026-08-10: the update stopped at "Error opening file for
; writing: D:\Locally Uncensored\llama-server.exe" with Abort, Retry, Ignore.
; The sidecar is our own (externalBin), and Windows locks a running
; image against writes, so the copy cannot succeed while it lives. Rust kills it
; on every orderly exit (state.rs shutdown_subprocesses), which is exactly why
; the installer never accounted for the cases that are left: the app still open
; during a manual install, or a sidecar orphaned by a crash. Retry then loops on
; the same lock and Ignore is worse than it looks, it leaves the new app running
; last release's engine.
;
; The test is the write itself, not a process list: if the file opens for
; writing, nothing holds it and we touch nothing.
;
; And when something does hold it, only OUR copy may die. `taskkill /F /T /IM`
; matches by image name for the whole session, so the first version of this
; hook also hard-killed a llama.cpp server the user had started themselves,
; mid-generation, during an update they never watched. llama.cpp is one of the
; backends this app detects, so having one running is normal, and everywhere
; else the app leaves a stranger alone: an engine start that meets one on its
; port refuses and asks the user to quit it (commands/engine.rs), and every
; kill in Rust goes by PID. The installer was the single place that swung at a
; name. It now ends exactly the processes whose image IS the file about to be
; overwritten. The path comes from WMI rather than Get-Process because the
; installer is 32 bit and .NET cannot read MainModule of a 64 bit process from
; there, which is what our own engine is.
;
; Last resort, when the lock outlives the four rounds because someone else
; holds it (a scanner, a backup agent, a process this user may not touch):
; Windows refuses to WRITE a locked image but still allows it to be RENAMED, so
; the old engine moves aside and the update lands. That is the whole point of
; the hook, and it beats the stock dialog where Retry loops on the same lock
; and Ignore leaves the new app running last release's engine. The leftover is
; swept at the start of the next install.
; The file name is a parameter since GitHub #120 renamed the sidecar to
; lu-llama-server.exe. An update coming from 2.6.6 or older still finds the old
; llama-server.exe in the install folder, possibly with a live process on it,
; so both names get freed and the one we no longer ship gets swept away.
!macro LU_FREE_SIDECAR EXE
  Push $R3
  Push $R4
  Push $R9
  Delete "$INSTDIR\${EXE}.old"
  StrCpy $R4 0
  ${Do}
    ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
      ${ExitDo}
    ${EndIf}
    ClearErrors
    FileOpen $R3 "$INSTDIR\${EXE}" a
    ${IfNot} ${Errors}
      FileClose $R3
      ${ExitDo}
    ${EndIf}
    ${If} $R4 >= 4
      ; Still locked after four rounds, so it is not our engine holding it.
      ; Move it out of the way instead of spinning here or failing the copy.
      Rename "$INSTDIR\${EXE}" "$INSTDIR\${EXE}.old"
      ${ExitDo}
    ${EndIf}
    IntOp $R4 $R4 + 1
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -eq '$INSTDIR\${EXE}' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
    Pop $R9
    Sleep 800
  ${Loop}
  Pop $R9
  Pop $R4
  Pop $R3
!macroend

; What 2.6.6 and older left behind. We do not ship this file any more, so it is
; freed for the same reason (a live orphan would keep answering on our port)
; and then removed rather than left as a 3 GB stranger in the install folder.
!macro LU_SWEEP_OLD_SIDECAR
  !insertmacro LU_FREE_SIDECAR "llama-server.exe"
  Delete "$INSTDIR\llama-server.exe"
  Delete "$INSTDIR\llama-server.exe.old"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro LU_FREE_SIDECAR "lu-llama-server.exe"
  !insertmacro LU_SWEEP_OLD_SIDECAR

!if "${PRODUCTNAME}" != "Locally Uncensored"
  !insertmacro LU_REMOVE_OLD_NSIS HKCU
  !insertmacro LU_REMOVE_OLD_NSIS HKLM

  ; orphaned shortcuts of the old name in the active shell context (the old
  ; uninstaller removes its own; this only catches leftovers)
  Delete "$DESKTOP\Locally Uncensored.lnk"
  Delete "$SMPROGRAMS\Locally Uncensored.lnk"

  ; an old per-machine MSI (WiX) install lives under a {GUID} key; match it by
  ; display name + publisher and remove it quietly. Best effort: without
  ; elevation msiexec fails and we are simply no worse off than before.
  StrCpy $R5 0
  lu_wix_scan:
    EnumRegKey $R6 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R5
    StrCmp $R6 "" lu_wix_done
    IntOp $R5 $R5 + 1
    StrCpy $R9 $R6 1
    StrCmp $R9 "{" 0 lu_wix_scan
    ReadRegStr $R7 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R6" "DisplayName"
    ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R6" "Publisher"
    StrCmp "$R7$R8" "Locally UncensoredPurpleDoubleD" 0 lu_wix_scan
    nsExec::Exec '"$SYSDIR\msiexec.exe" /x $R6 /qn'
    Pop $R9
    Goto lu_wix_scan
  lu_wix_done:
!endif
!macroend
