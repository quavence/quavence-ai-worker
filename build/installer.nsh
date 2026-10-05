!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Install Quavence AI Worker"
  !define MUI_WELCOMEPAGE_TEXT "This wizard will install Quavence AI Worker on your computer.$\r$\n$\r$\nLocal AI runtime (LM Studio or Ollama) is not bundled. Install and configure it separately before starting the worker."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "Quavence AI Worker installed"
  !define MUI_FINISHPAGE_TEXT "Quavence AI Worker has been installed on your computer.$\r$\n$\r$\nConfigure LM Studio or Ollama separately, then paste your worker token."
  !insertmacro MUI_PAGE_FINISH
!macroend

Var consentPageDialog
Var consentCheckLocalRuntime
Var consentCheckResourceUsage
Var consentCheckNetworkCalls

Function ConsentPageCreate
  nsDialogs::Create 1018
  Pop $consentPageDialog
  ${If} $consentPageDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 14u "Before install, review and accept:"
  Pop $0
  ${NSD_CreateLabel} 0 16u 100% 48u "This installer will install the Quavence AI Worker desktop app only.$\r$\n$\r$\nLocal AI runtime (LM Studio, Ollama) and models are not bundled. Install and configure them separately before starting the worker.$\r$\nHub runtime policy remains the source of truth for approved models."
  Pop $1

  ${NSD_CreateCheckbox} 0 68u 100% 16u "I understand the worker requires a separate local AI runtime and approved models."
  Pop $consentCheckLocalRuntime

  ${NSD_CreateCheckbox} 0 88u 100% 12u "I understand CPU/RAM usage may increase during tasks."
  Pop $consentCheckResourceUsage

  ${NSD_CreateCheckbox} 0 104u 100% 12u "I consent to network calls to Quavence Hub for task claim and submit."
  Pop $consentCheckNetworkCalls

  nsDialogs::Show
FunctionEnd

Function ConsentPageLeave
  ${NSD_GetState} $consentCheckLocalRuntime $0
  ${If} $0 <> ${BST_CHECKED}
    MessageBox MB_ICONEXCLAMATION|MB_OK "Please confirm you will provide a separate local AI runtime and approved models."
    Abort
  ${EndIf}

  ${NSD_GetState} $consentCheckResourceUsage $1
  ${If} $1 <> ${BST_CHECKED}
    MessageBox MB_ICONEXCLAMATION|MB_OK "Please accept CPU/RAM usage consent to continue installation."
    Abort
  ${EndIf}

  ${NSD_GetState} $consentCheckNetworkCalls $2
  ${If} $2 <> ${BST_CHECKED}
    MessageBox MB_ICONEXCLAMATION|MB_OK "Please accept network call consent to continue installation."
    Abort
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  Page custom ConsentPageCreate ConsentPageLeave
!macroend

!macro customInstall
  SetDetailsPrint both
  DetailPrint "Quavence AI Worker desktop shell installed. Configure LM Studio or Ollama separately."
  DeleteRegValue SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString"

  ; Use a dedicated .ico for shortcuts (not the .exe) so Windows desktop icon cache
  ; does not keep serving the legacy embedded executable icon.
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    Delete "$DESKTOP\Quavence AI Worker.lnk"
    CreateShortCut "$DESKTOP\Quavence AI Worker.lnk" "$INSTDIR\Quavence AI Worker.exe" "" "$INSTDIR\QuavenceAIWorker-icon.ico" 0 "" "" "Desktop launcher for Quavence AI Worker"
  !endif
  Delete "$SMPROGRAMS\Quavence AI Worker.lnk"
  CreateShortCut "$SMPROGRAMS\Quavence AI Worker.lnk" "$INSTDIR\Quavence AI Worker.exe" "" "$INSTDIR\QuavenceAIWorker-icon.ico" 0 "" "" "Desktop launcher for Quavence AI Worker"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!else

!macro customUnWelcomePage
  !define MUI_UNWELCOMEPAGE_TITLE "Uninstall Quavence AI Worker"
  !define MUI_UNWELCOMEPAGE_TEXT "This wizard will remove Quavence AI Worker from your computer."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUninstallPage
  !define MUI_UNFINISHPAGE_TITLE "Quavence AI Worker removed"
  !define MUI_UNFINISHPAGE_TEXT "Quavence AI Worker has been removed from your computer."
!macroend

!endif
