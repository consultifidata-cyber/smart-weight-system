; ============================================================
; Smart Weight System — Inno Setup 6 Installer
;
; Build:
;   iscc setup.iss /DAppVersion=v1.0.0
;
; Output:
;   installer/Output/SmartWeightSetup.exe
;
; Requires (built by CI before iscc runs):
;   installer/assets/node-runtime/   — portable Node.js (exact build version)
;   installer/assets/tools/nssm.exe  — NSSM service manager
; ============================================================

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif

#define AppName    "Smart Weight System"
#define AppPublisher "ConsultiFi"
#define ServiceName  "SmartWeightSystem"
#define HealthPort   5099

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppCopyright=Copyright (C) {#AppPublisher}

; Fixed install directory — no user prompt
DefaultDirName=C:\SmartWeightSystem
DisableDirPage=yes

; No program group needed (headless service)
DisableProgramGroupPage=yes

; Output
OutputDir=Output
OutputBaseFilename=SmartWeightSetup
SetupIconFile=

; Elevation
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=

; Architecture — Windows 10/11 x64 only
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Compression (best ratio for node_modules)
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes

; UI
WizardStyle=modern
ShowLanguageDialog=no
CloseApplications=no
RestartIfNeededByRun=no

; Uninstaller
UninstallDisplayName={#AppName}
UninstallFilesDir={app}\uninstall

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; ── Files ───────────────────────────────────────────────────────────────────

[Files]
; ── Node.js portable runtime (same version used to build native modules) ────
Source: "assets\node-runtime\*"; \
  DestDir: "{app}\node-runtime"; \
  Flags: recursesubdirs createallsubdirs

; ── Tools: NSSM + PowerShell scripts ────────────────────────────────────────
Source: "assets\tools\nssm.exe"; \
  DestDir: "{app}\tools"
Source: "tools\install-service.ps1";   DestDir: "{app}\tools"
Source: "tools\remove-service.ps1";    DestDir: "{app}\tools"
Source: "tools\service-status.ps1";    DestDir: "{app}\tools"
Source: "tools\detect-hardware.ps1";   DestDir: "{app}\tools"
Source: "tools\generate-env.ps1";      DestDir: "{app}\tools"
Source: "tools\add-firewall-rules.ps1"; DestDir: "{app}\tools"
Source: "tools\health-report.ps1";     DestDir: "{app}\tools"

; ── Application: deploy scripts ─────────────────────────────────────────────
Source: "..\deploy\launcher.js";       DestDir: "{app}\deploy"
Source: "..\deploy\ecosystem.config.js"; DestDir: "{app}\deploy"
Source: "..\deploy\config-template.env"; DestDir: "{app}\deploy"
Source: "..\deploy\start-all.bat";     DestDir: "{app}\deploy"
Source: "..\deploy\stop-all.bat";      DestDir: "{app}\deploy"
Source: "..\deploy\health-check.bat";  DestDir: "{app}\deploy"
Source: "..\deploy\update.bat";        DestDir: "{app}\deploy"

; ── Application: root ────────────────────────────────────────────────────────
Source: "..\package.json"; DestDir: "{app}"

; ── Application: services ────────────────────────────────────────────────────
Source: "..\weight-service\*"; \
  DestDir: "{app}\weight-service"; \
  Flags: recursesubdirs createallsubdirs; \
  Excludes: ".git,.gitignore,*.test.ts"

Source: "..\print-service\*"; \
  DestDir: "{app}\print-service"; \
  Flags: recursesubdirs createallsubdirs; \
  Excludes: ".git,.gitignore,*.test.ts"

Source: "..\sync-service\*"; \
  DestDir: "{app}\sync-service"; \
  Flags: recursesubdirs createallsubdirs; \
  Excludes: ".git,.gitignore,*.test.ts"

Source: "..\web-ui\*"; \
  DestDir: "{app}\web-ui"; \
  Flags: recursesubdirs createallsubdirs; \
  Excludes: ".git,.gitignore"

; ── Shared node_modules (pre-built native binaries from CI) ──────────────────
Source: "..\node_modules\*"; \
  DestDir: "{app}\node_modules"; \
  Flags: recursesubdirs createallsubdirs

; ── Detection script — extracted to temp for wizard (before file extraction) ─
Source: "tools\detect-hardware.ps1"; \
  DestDir: "{tmp}"; \
  Flags: deleteafterinstall

; ── Directories ─────────────────────────────────────────────────────────────
[Dirs]
Name: "{app}\logs"
Name: "{app}\tools"
Name: "{app}\node-runtime"
Name: "{app}\uninstall"

; ── Run: post-install scripts ────────────────────────────────────────────────
[Run]
; 1. Add firewall rules
Filename: "powershell.exe"; \
  Parameters: "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\add-firewall-rules.ps1"""; \
  Flags: runhidden waituntilterminated; \
  StatusMsg: "Configuring firewall rules..."

; 2. Generate .env from wizard inputs
Filename: "powershell.exe"; \
  Parameters: "{code:GetEnvParameters}"; \
  Flags: runhidden waituntilterminated; \
  StatusMsg: "Writing station configuration..."

; 3. Install Windows Service (NSSM)
Filename: "powershell.exe"; \
  Parameters: "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\install-service.ps1"" -InstallDir ""{app}"" -NssmPath ""{app}\tools\nssm.exe"" -NodePath ""{app}\node-runtime\node.exe"" -Force"; \
  Flags: runhidden waituntilterminated; \
  StatusMsg: "Installing Windows Service..."

; 4. Open browser when done (optional — user can close)
Filename: "http://localhost:3000"; \
  Flags: shellexec nowait skipifsilent postinstall; \
  Description: "Open Smart Weight System dashboard"

; ── Uninstall: stop and remove service ──────────────────────────────────────
[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\remove-service.ps1"" -NssmPath ""{app}\tools\nssm.exe"" -Force"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "StopService"

; ── Pascal code: wizard pages + hardware detection ──────────────────────────
[Code]

// ── Global state ─────────────────────────────────────────────────────────────
var
  // Custom wizard page: Hardware Detection
  PageHardware : TWizardPage;

  // Controls on hardware page
  LblPrinterTitle   : TNewStaticText;
  LblPrinterHint    : TNewStaticText;
  ComboPrinter      : TNewComboBox;
  LblScaleTitle     : TNewStaticText;
  LblScaleHint      : TNewStaticText;
  ComboScale        : TNewComboBox;

  // Input query pages
  PageServer  : TInputQueryWizardPage;
  PageStation : TInputQueryWizardPage;

  // Parallel data arrays: index → value
  PrinterPathArr      : array of String;  // \\.\USBPRINxx paths OR COMx (CDC mode)
  PrinterIfaceArr     : array of String;  // 'USB' or 'COM'
  ScalePortArr        : array of String;  // COMx ports

// ── File reading helper ───────────────────────────────────────────────────────
function ReadFileLines(const Filename: String): TStringList;
begin
  Result := TStringList.Create;
  try
    if FileExists(Filename) then
      Result.LoadFromFile(Filename);
  except
    // swallow — empty list means no detection results
  end;
end;

// ── Parse pipe-delimited detection results ────────────────────────────────────
// Printer format: "Display|\\.\USBPRINxx|VID|PROTOCOL|USB"
//              or "Display|COMx|VID|PROTOCOL|COM"
// Scale format:   "Display|COMx|VID|CONFIDENCE"
// Stores path in DataArr and interface type in IfaceArr (printers only).
procedure ParseDetectionFile(
  const Filename: String;
  ComboBox: TNewComboBox;
  var DataArr:  array of String;
  var IfaceArr: array of String);   // pass empty array for scale detection
var
  Lines: TStringList;
  i, P: Integer;
  Line, Display, Rest, PathVal, IfaceVal: String;
begin
  ComboBox.Items.Clear;
  SetArrayLength(DataArr,  0);
  SetArrayLength(IfaceArr, 0);

  Lines := ReadFileLines(Filename);
  try
    for i := 0 to Lines.Count - 1 do begin
      Line := Trim(Lines[i]);
      if Line = '' then Continue;

      // Field 1: Display Name
      P := Pos('|', Line);
      if P > 0 then begin
        Display := Copy(Line, 1, P - 1);
        Rest    := Copy(Line, P + 1, Length(Line));
      end else begin
        Display := Line;
        Rest    := '';
      end;

      // Field 2: Path (\\.\USBPRINxx or COMx)
      P := Pos('|', Rest);
      if P > 0 then begin
        PathVal := Copy(Rest, 1, P - 1);
        Rest    := Copy(Rest, P + 1, Length(Rest));
      end else begin
        PathVal := Rest;
        Rest    := '';
      end;

      // Skip VID (field 3) and PROTOCOL (field 4) — grab field 5: interface type
      IfaceVal := 'USB';   // default
      // Skip over VID|PROTOCOL|
      P := Pos('|', Rest); if P > 0 then Rest := Copy(Rest, P + 1, Length(Rest));
      P := Pos('|', Rest); if P > 0 then begin
        IfaceVal := Trim(Copy(Rest, P + 1, Length(Rest)));
        if IfaceVal = '' then IfaceVal := 'USB';
      end;

      ComboBox.Items.Add(Display);
      SetArrayLength(DataArr,  GetArrayLength(DataArr)  + 1);
      SetArrayLength(IfaceArr, GetArrayLength(IfaceArr) + 1);
      DataArr [GetArrayLength(DataArr)  - 1] := PathVal;
      IfaceArr[GetArrayLength(IfaceArr) - 1] := IfaceVal;
    end;
  finally
    Lines.Free;
  end;

  // Always offer manual-entry at the bottom
  ComboBox.Items.Add('[ Enter path/port manually... ]');
  SetArrayLength(DataArr,  GetArrayLength(DataArr)  + 1);
  SetArrayLength(IfaceArr, GetArrayLength(IfaceArr) + 1);
  DataArr [GetArrayLength(DataArr)  - 1] := '';
  IfaceArr[GetArrayLength(IfaceArr) - 1] := 'USB';

  if ComboBox.Items.Count > 0 then
    ComboBox.ItemIndex := 0;
end;

// ── Run hardware detection before showing wizard ──────────────────────────────
procedure RunHardwareDetection;
var
  TmpDir, ScriptPath, PrinterFile, ScaleFile: String;
  ResultCode: Integer;
  _DummyIface: array of String;  // throw-away; scale file has no interface column
begin
  TmpDir     := ExpandConstant('{tmp}');
  ScriptPath := TmpDir + '\detect-hardware.ps1';

  // Extracted via [Files] Flags:deleteafterinstall to {tmp}
  if not FileExists(ScriptPath) then begin
    Log('detect-hardware.ps1 not found in {tmp} — skipping detection');
    Exit;
  end;

  Log('Running hardware detection script...');
  Exec(
    'powershell.exe',
    '-NonInteractive -NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '" -OutputDir "' + TmpDir + '"',
    TmpDir,
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
  Log('Detection script exit code: ' + IntToStr(ResultCode));

  PrinterFile := TmpDir + '\sws_printers.txt';
  ScaleFile   := TmpDir + '\sws_scales.txt';

  SetArrayLength(_DummyIface, 0);
  ParseDetectionFile(PrinterFile, ComboPrinter, PrinterPathArr, PrinterIfaceArr);
  ParseDetectionFile(ScaleFile,   ComboScale,   ScalePortArr,   _DummyIface);

  Log('Printers detected: ' + IntToStr(GetArrayLength(PrinterPathArr) - 1));  // -1 for manual entry
  Log('Scales detected:   ' + IntToStr(GetArrayLength(ScalePortArr)   - 1));
end;

// ── Get currently selected printer path ──────────────────────────────────────
function GetSelectedPrinterPath: String;
var
  Idx: Integer;
begin
  Idx    := ComboPrinter.ItemIndex;
  Result := '';
  if (Idx >= 0) and (Idx < GetArrayLength(PrinterPathArr)) then
    Result := PrinterPathArr[Idx];

  if Result = '' then begin
    Result := Trim(ComboPrinter.Text);
    if Pos('[', Result) = 1 then Result := '';  // '[ Enter ... ]' → empty
  end;
end;

// ── Get currently selected printer interface type (USB or COM) ────────────────
function GetSelectedPrinterIface: String;
var
  Idx: Integer;
begin
  Result := 'USB';  // default
  Idx    := ComboPrinter.ItemIndex;
  if (Idx >= 0) and (Idx < GetArrayLength(PrinterIfaceArr)) then
    Result := PrinterIfaceArr[Idx];
  if Result = '' then Result := 'USB';
end;

// ── Get currently selected scale port ────────────────────────────────────────
function GetSelectedScalePort: String;
var
  Idx: Integer;
begin
  Idx    := ComboScale.ItemIndex;
  Result := '';
  if (Idx >= 0) and (Idx < GetArrayLength(ScalePortArr)) then
    Result := ScalePortArr[Idx];

  if Result = '' then begin
    Result := Trim(ComboScale.Text);
    if Pos('[', Result) = 1 then Result := '';
  end;
end;

// ── Escape a string for use inside PowerShell single-quoted strings ──────────
// Standalone (Inno Setup Pascal does not support nested functions).
function EscPS(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '''', '''''', True);
end;

// ── Build PowerShell parameter string for generate-env.ps1 ───────────────────
// Called by [Run] section via {code:GetEnvParameters}
function GetEnvParameters(Param: String): String;
var
  InstallDir, PrinterPath, PrinterIface, ScalePort: String;
  DjangoUrl, DjangoToken, PlantId, StationId: String;
begin
  InstallDir   := ExpandConstant('{app}');
  PrinterPath  := GetSelectedPrinterPath;
  PrinterIface := GetSelectedPrinterIface;
  ScalePort    := GetSelectedScalePort;
  DjangoUrl    := PageServer.Values[0];
  DjangoToken  := PageServer.Values[1];
  PlantId      := PageStation.Values[0];
  StationId    := PageStation.Values[1];

  Result :=
    '-NonInteractive -NoProfile -ExecutionPolicy Bypass' +
    ' -File ''' + EscPS(InstallDir) + '\tools\generate-env.ps1''' +
    ' -InstallDir '''        + EscPS(InstallDir)   + '''' +
    ' -PrinterUsbDevice '''  + EscPS(PrinterPath)  + '''' +
    ' -PrinterInterface '''  + EscPS(PrinterIface) + '''' +
    ' -ScalePort '''         + EscPS(ScalePort)    + '''' +
    ' -DjangoUrl '''         + EscPS(DjangoUrl)    + '''' +
    ' -DjangoToken '''       + EscPS(DjangoToken)  + '''' +
    ' -PlantId '''           + EscPS(PlantId)      + '''' +
    ' -StationId '''         + EscPS(StationId)    + '''';
end;

// ── Re-scan button handler ────────────────────────────────────────────────────
// Called when technician clicks RE-SCAN after plugging in hardware.
// Re-runs the PowerShell detection script and repopulates both dropdowns.
procedure OnRescanClick(Sender: TObject);
begin
  WizardForm.NextButton.Enabled := False;
  try
    RunHardwareDetection();
  finally
    WizardForm.NextButton.Enabled := True;
  end;
end;

// ── Create all custom wizard pages ───────────────────────────────────────────
procedure InitializeWizard;
var
  Y: Integer;
  BtnRescan: TNewButton;   // Re-scan button — declared here (Pascal requires all vars at top)
begin
  // ── Page 1: Hardware Detection ───────────────────────────────────────────
  PageHardware := CreateCustomPage(
    wpWelcome,
    'Hardware Detection',
    'The installer scanned for connected hardware. ' +
    'Confirm the detected devices or select manually.'
  );

  Y := 0;

  // Printer section
  LblPrinterTitle := TNewStaticText.Create(PageHardware);
  LblPrinterTitle.Parent  := PageHardware.Surface;
  LblPrinterTitle.Caption := 'Label Printer (USB):';
  LblPrinterTitle.Font.Style := [fsBold];
  LblPrinterTitle.Left    := 0;
  LblPrinterTitle.Top     := Y;
  LblPrinterTitle.Width   := PageHardware.SurfaceWidth;
  LblPrinterTitle.AutoSize := True;

  Y := Y + 20;
  ComboPrinter := TNewComboBox.Create(PageHardware);
  ComboPrinter.Parent := PageHardware.Surface;
  ComboPrinter.Left   := 0;
  ComboPrinter.Top    := Y;
  ComboPrinter.Width  := PageHardware.SurfaceWidth;
  ComboPrinter.Style  := csDropDown;  // editable — allows manual path entry

  Y := Y + 26;
  LblPrinterHint := TNewStaticText.Create(PageHardware);
  LblPrinterHint.Parent  := PageHardware.Surface;
  LblPrinterHint.Caption :=
    'Label printer (TVS LP 46 NEO, TSC, SNBC, Zebra, etc.).'#13#10 +
    'Connect via USB and power on — no driver installation required.'#13#10 +
    'Shows as USB device (\\.\USBPRINxx) or USB-CDC [COM port].'#13#10 +
    'Not listed? Connect USB cable, power on, then press Back and Next.';
  LblPrinterHint.Left    := 0;
  LblPrinterHint.Top     := Y;
  LblPrinterHint.Width   := PageHardware.SurfaceWidth;
  LblPrinterHint.AutoSize := True;

  Y := Y + 56;

  // Separator line
  Y := Y + 8;

  // Scale section
  LblScaleTitle := TNewStaticText.Create(PageHardware);
  LblScaleTitle.Parent  := PageHardware.Surface;
  LblScaleTitle.Caption := 'Weighing Scale (USB-Serial COM port):';
  LblScaleTitle.Font.Style := [fsBold];
  LblScaleTitle.Left    := 0;
  LblScaleTitle.Top     := Y;
  LblScaleTitle.Width   := PageHardware.SurfaceWidth;
  LblScaleTitle.AutoSize := True;

  Y := Y + 20;
  ComboScale := TNewComboBox.Create(PageHardware);
  ComboScale.Parent := PageHardware.Surface;
  ComboScale.Left   := 0;
  ComboScale.Top    := Y;
  ComboScale.Width  := PageHardware.SurfaceWidth;
  ComboScale.Style  := csDropDown;  // editable

  Y := Y + 26;
  LblScaleHint := TNewStaticText.Create(PageHardware);
  LblScaleHint.Parent  := PageHardware.Surface;
  LblScaleHint.Caption :=
    'USB-to-serial adapter (CH340, FTDI, CP210x, Prolific).'#13#10 +
    'Connect scale USB cable and power on — driver auto-installed by Windows.'#13#10 +
    'Not listed? Click RE-SCAN after connecting, or type COM port manually (e.g. COM3).';
  LblScaleHint.Left    := 0;
  LblScaleHint.Top     := Y;
  LblScaleHint.Width   := PageHardware.SurfaceWidth;
  LblScaleHint.AutoSize := True;

  // ── RE-SCAN button — lets technician re-detect after connecting hardware ───
  // Placed below scale hint. Calls RunHardwareDetection() which re-runs the
  // PowerShell script and repopulates both dropdowns without leaving the page.
  Y := Y + 52;
  BtnRescan := TNewButton.Create(PageHardware);
  BtnRescan.Parent  := PageHardware.Surface;
  BtnRescan.Caption := '↻  RE-SCAN HARDWARE  (plug in devices first, then click)';
  BtnRescan.Left    := 0;
  BtnRescan.Top     := Y;
  BtnRescan.Width   := PageHardware.SurfaceWidth;
  BtnRescan.Height  := 36;
  BtnRescan.OnClick := @OnRescanClick;

  // ── Page 2: Server Configuration ─────────────────────────────────────────
  PageServer := CreateInputQueryPage(
    PageHardware.ID,
    'Server Configuration',
    'Enter the Django ERP server details. ' +
    'Get these from your system administrator.',
    ''
  );
  // TInputQueryWizardPage.Add(prompt, isPassword) — 2 params only in Inno Setup 6
  // Default values set via Values[i] after Add() calls complete.
  PageServer.Add('Django Server URL:', False);
  PageServer.Add('API Token (from WeighStation admin):', True);
  PageServer.Values[0] := 'http://192.168.1.100:8000';
  PageServer.Values[1] := '';

  // ── Page 3: Station Configuration ────────────────────────────────────────
  PageStation := CreateInputQueryPage(
    PageServer.ID,
    'Station Identity',
    'Configure this weighing station. ' +
    'Station ID must be unique within the plant.',
    ''
  );
  PageStation.Add('Plant ID:', False);
  PageStation.Add('Station ID:', False);
  PageStation.Values[0] := 'A1';
  PageStation.Values[1] := 'ST01';

  // Run detection (happens after pages are created, before first page shown)
  RunHardwareDetection;
end;

// ── Validation ────────────────────────────────────────────────────────────────
function NextButtonClick(CurPageID: Integer): Boolean;
var
  PPath, SPort, Url, Token, Plant, Station: String;
begin
  Result := True;

  if CurPageID = PageHardware.ID then begin
    PPath := GetSelectedPrinterPath;
    SPort := GetSelectedScalePort;

    if PPath = '' then begin
      MsgBox(
        'No printer selected.' + #13#10 +
        'Connect the label printer USB cable and click Back, then Next to re-scan.' + #13#10 +
        'Or type the device path manually (e.g. \\.\USBPRIN01).',
        mbInformation, MB_OK
      );
      // Allow continuing — technician may not have printer yet
    end;

    if SPort = '' then begin
      MsgBox(
        'No scale COM port selected.' + #13#10 +
        'Connect the scale USB cable and click Back, then Next to re-scan.' + #13#10 +
        'Or type the port manually (e.g. COM3).',
        mbInformation, MB_OK
      );
      // Allow continuing — will auto-detect at runtime via SCALE_AUTO_DETECT
    end;
  end;

  if CurPageID = PageServer.ID then begin
    Url   := Trim(PageServer.Values[0]);
    Token := Trim(PageServer.Values[1]);

    if Url = '' then begin
      MsgBox('Server URL is required.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if (Pos('http://', Url) <> 1) and (Pos('https://', Url) <> 1) then begin
      MsgBox(
        'Server URL must start with http:// or https://' + #13#10 +
        'Example: http://192.168.1.100:8000',
        mbError, MB_OK
      );
      Result := False;
      Exit;
    end;
    if Token = '' then begin
      MsgBox('API Token is required.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;

  if CurPageID = PageStation.ID then begin
    Plant   := Trim(PageStation.Values[0]);
    Station := Trim(PageStation.Values[1]);
    if (Plant = '') or (Station = '') then begin
      MsgBox('Both Plant ID and Station ID are required.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;
end;

// ── Success page text ─────────────────────────────────────────────────────────
function UpdateReadyMemo(
  Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  PPath, SPort, PrinterLine, ScaleLine: String;
begin
  PPath := GetSelectedPrinterPath;
  SPort := GetSelectedScalePort;

  // Inno Setup Pascal has no inline-if — use explicit if/else blocks
  if PPath <> '' then
    PrinterLine := PPath + ' [' + GetSelectedPrinterIface + ']'
  else
    PrinterLine := '(auto-detect at runtime)';

  if SPort <> '' then
    ScaleLine := SPort
  else
    ScaleLine := '(auto-detect at runtime)';

  Result :=
    'Installation Summary' + NewLine + NewLine +
    Space + 'Install folder : C:\SmartWeightSystem' + NewLine +
    Space + 'Printer device : ' + PrinterLine + NewLine +
    Space + 'Scale COM port : ' + ScaleLine + NewLine +
    Space + 'Server URL     : ' + PageServer.Values[0] + NewLine +
    Space + 'Station ID     : ' + PageStation.Values[1] + NewLine +
    Space + 'Plant ID       : ' + PageStation.Values[0] + NewLine + NewLine +
    'After clicking Install:' + NewLine +
    Space + '1. Files extracted (~30s)' + NewLine +
    Space + '2. Windows Service registered' + NewLine +
    Space + '3. System starts automatically' + NewLine +
    Space + '4. Browser opens to http://localhost:3000';
end;

// ── Custom Finish page — show URLs, log path, support command ─────────────────
procedure CurPageChanged(CurPageID: Integer);
var
  FinishText: String;
begin
  if CurPageID = wpFinished then begin
    // #13#10 must never start a line — ISPP preprocessor misreads it as a directive.
    // Keep all #13#10 sequences at the END of their line.
    FinishText :=
      'Smart Weight System has been installed.' + #13#10 + #13#10 +
      'Open the web dashboard:' + #13#10 +
      '  http://localhost:3000' + #13#10 + #13#10 +
      'Check that all services are running:' + #13#10 +
      '  http://localhost:5099/health' + #13#10 + #13#10 +
      'If something is not working:' + #13#10 +
      '  1. Check logs:  C:\SmartWeightSystem\logs\launcher.log' + #13#10 +
      '  2. Run health report (creates zip on Desktop for support):' + #13#10 +
      '     powershell -File "C:\SmartWeightSystem\tools\health-report.ps1"' + #13#10 + #13#10 +
      'To restart the system:' + #13#10 +
      '  net stop SmartWeightSystem  &&  net start SmartWeightSystem';

    WizardForm.FinishedLabel.Caption := FinishText;
  end;
end;
