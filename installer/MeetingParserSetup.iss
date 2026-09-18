[Setup]
AppId={{8D1C7F58-5B12-4B57-9C2A-0E71B6A7F345}
AppName=Meeting Parser
AppVersion=0.6.0
AppPublisher=Meeting Parser
DefaultDirName={localappdata}\MeetingParser
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
Uninstallable=yes
OutputDir={#ReleaseDir}
OutputBaseFilename=MeetingParserSetup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no

[Files]
Source: "{#CompanionDir}\MeetingParserHost.exe"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.meetingparser.helper"; ValueType: string; ValueName: ""; ValueData: "{app}\com.meetingparser.helper.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.meetingparser.helper"; ValueType: string; ValueName: ""; ValueData: "{app}\com.meetingparser.helper.json"; Flags: uninsdeletekey

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[InstallDelete]
Type: files; Name: "{app}\MeetingParserDownloader.exe"
Type: files; Name: "{app}\MeetingParserNativeHost.exe"

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM MeetingParserHost.exe"; Flags: runhidden waituntilterminated; RunOnceId: "StopMeetingParserHost"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM MeetingParserNativeHost.exe"; Flags: runhidden waituntilterminated; RunOnceId: "StopMeetingParserNativeHost"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM MeetingParserDownloader.exe"; Flags: runhidden waituntilterminated; RunOnceId: "StopMeetingParserDownloader"

[Code]
procedure WriteNativeHostManifest;
var
  NativeHostPath: string;
  Manifest: string;
begin
  NativeHostPath := ExpandConstant('{app}\MeetingParserHost.exe');
  StringChangeEx(NativeHostPath, '\', '\\', True);
  Manifest := '{' + #13#10 +
    '  "name": "com.meetingparser.helper",' + #13#10 +
    '  "description": "Meeting Parser direct download host",' + #13#10 +
    '  "path": "' + NativeHostPath + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": ["chrome-extension://lofgkifcemmmdnacnllpoehcncdoecnm/"]' + #13#10 +
    '}';
  SaveStringToFile(ExpandConstant('{app}\com.meetingparser.helper.json'), Manifest, False);
end;

procedure StopOwnProcess(const ImageName: string);
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM "' + ImageName + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  NeedsRestart := False;
  StopOwnProcess('MeetingParserHost.exe');
  StopOwnProcess('MeetingParserNativeHost.exe');
  StopOwnProcess('MeetingParserDownloader.exe');
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteNativeHostManifest;
end;
