; Inno Setup script for Shadow AI — compiled by tools/build-installer.ps1.
; The build script passes /DStagingDir=<assembled payload> and /DRepoRoot=<repo>.
;
; Per-user install (PrivilegesRequired=lowest, install under LocalAppData): Shadow AI
; writes its own config, memories, skills, and SearXNG settings beside the app, so it must
; live in a user-writable directory — Program Files would block those writes for non-admins.

#ifndef StagingDir
  #define StagingDir "..\dist\staging"
#endif
#ifndef RepoRoot
  #define RepoRoot ".."
#endif
#define MyAppName "Shadow AI"
#define MyAppVersion "1.8.4"
#define MyAppPublisher "shadowdoggie"
#define MyAppURL "https://github.com/shadowdoggie/shadow-ai"
#define MyAppLauncher "run.bat"

[Setup]
AppId={{8F3A1C2E-5B7D-4E9A-9C1F-2A6B3D4E5F60}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
DefaultDirName={localappdata}\Programs\ShadowAI
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
LicenseFile={#RepoRoot}\LICENSE
OutputDir={#RepoRoot}\dist
OutputBaseFilename=ShadowAI-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Windows-only product.
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppLauncher}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent shellexec

[UninstallDelete]
; Always remove regenerable, non-personal runtime artifacts (bundled-runtime caches,
; the auto-generated SearXNG config, and the scheduler queue). Personal data — memories,
; skills, settings, the Gemini key, and the Google account — is handled in [Code] below
; and is KEPT by default so a reinstall picks up where the user left off.
Type: filesandordirs; Name: "{app}\runtime"
Type: files; Name: "{app}\searxng\settings.yml"
Type: files; Name: "{app}\scheduled_tasks.json"

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    // Default to KEEP (MB_DEFBUTTON2 = No) so nobody loses their data by accident.
    // Only an explicit Yes wipes the personal/credential data.
    if MsgBox(
        'Do you also want to permanently delete your Shadow AI personal data?' + #13#10 + #13#10 +
        'This includes your memories, learned skills, settings, your Gemini API key, and your connected Google account (sign-in tokens).' + #13#10 + #13#10 +
        'Choose No to keep them on disk so a future reinstall picks up exactly where you left off.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DelTree(ExpandConstant('{app}\secrets'), True, True, True);
      DelTree(ExpandConstant('{app}\skills'), True, True, True);
      DelTree(ExpandConstant('{app}\backups'), True, True, True);
      DeleteFile(ExpandConstant('{app}\memories.json'));
      DeleteFile(ExpandConstant('{app}\config.json'));
    end;
  end;
end;
