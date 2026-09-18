[Setup]
AppId={{8D1C7F58-5B12-4B57-9C2A-0E71B6A7F345}
AppName=Meeting Parser
AppVersion=0.5.0
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

[Files]
Source: "{#CompanionDir}\MeetingParserDownloader.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#CompanionDir}\MeetingParserNativeHost.exe"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.meetingparser.helper"; ValueType: string; ValueName: ""; ValueData: "{app}\com.meetingparser.helper.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.meetingparser.helper"; ValueType: string; ValueName: ""; ValueData: "{app}\com.meetingparser.helper.json"; Flags: uninsdeletekey

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
procedure WriteNativeHostManifest;
var
  NativeHostPath: string;
  Manifest: string;
begin
  NativeHostPath := ExpandConstant('{app}\MeetingParserNativeHost.exe');
  StringChangeEx(NativeHostPath, '\', '\\', True);
  Manifest := '{' + #13#10 +
    '  "name": "com.meetingparser.helper",' + #13#10 +
    '  "description": "Meeting Parser local downloader starter",' + #13#10 +
    '  "path": "' + NativeHostPath + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": ["chrome-extension://lofgkifcemmmdnacnllpoehcncdoecnm/"]' + #13#10 +
    '}';
  SaveStringToFile(ExpandConstant('{app}\com.meetingparser.helper.json'), Manifest, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteNativeHostManifest;
end;
