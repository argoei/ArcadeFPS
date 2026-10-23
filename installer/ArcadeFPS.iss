; ArcadeFPS 安装脚本（Inno Setup 6）—— 框架依赖版（配置与 GhibliMeadow 一致）
; 编译：ISCC.exe installer\ArcadeFPS.iss
; 产物：release\ArcadeFPS-Setup-1.0.0.exe
;
; 本包【不含】.NET 运行时。必需依赖：
;   Microsoft.WindowsDesktop.App 8.0.x（.NET 8 Desktop Runtime，x64）
;   Microsoft Edge WebView2 Runtime（渲染引擎）
; 依赖由独立分发包提供；安装器会检测，并在同目录找到安装器时联动安装。
;
; 注意：本文件必须以 UTF-8 with BOM 保存，否则中文界面与中文文件名会乱码。

#define MyAppName "街机枪战 · ARCADE FPS"
#define MyAppVersion "1.0.0"
#define MyAppExeName "ArcadeFPS.exe"
#define MyAppPublisher "ArcadeFPS"
#define MyAppURL "https://github.com/argoei/ArcadeFPS"

; 依赖清单
#define DotnetRuntimeFile "windowsdesktop-runtime-8.0.32-win-x64.exe"
#define WebView2File "MicrosoftEdgeWebview2Setup.exe"

[Setup]
AppId={{19532EE7-BE86-4A7B-8774-6588700C2EBB}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\ArcadeFPS
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
OutputDir=..\release
OutputBaseFilename=ArcadeFPS-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 安装包与卸载程序的图标（准星图标）
SetupIconFile=..\src\ArcadeFPS\app.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 用户级安装：装到 %LocalAppData%\Programs，不需要管理员权限
PrivilegesRequired=lowest
MinVersion=10.0.17763
CloseApplications=yes
RestartApplications=no
DisableWelcomePage=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："

[Files]
; 框架依赖发布产物，不含 .NET 运行时
Source: "..\release\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Comment: "启动街机枪战（Esc 退出回桌面）"
Name: "{autoprograms}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Comment: "启动街机枪战"; Tasks: desktopicon

[Run]
; 用 cmd /c start 让游戏进程脱离安装器的进程树（安装器退出不连带终止游戏）
Filename: "{cmd}"; Parameters: "/c start """" ""{app}\{#MyAppExeName}"""; \
    WorkingDir: "{app}"; Description: "立即启动游戏"; \
    Flags: nowait postinstall skipifsilent runhidden

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#MyAppExeName}"; \
    Flags: runhidden waituntilterminated; RunOnceId: "KillGame"

[UninstallDelete]
; 日志与 WebView2 用户数据（可能积累几十 MB 缓存）
Type: filesandordirs; Name: "{localappdata}\ArcadeFPS"

[Code]

{ ---------- 依赖检测 ---------- }

{ .NET 8 Desktop Runtime：查 dotnet 共享框架目录下的 8.* }
function HasDesktopRuntime8(): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;
  if FindFirst(ExpandConstant('{commonpf}\dotnet\shared\Microsoft.WindowsDesktop.App\8.*'), FindRec) then
  begin
    try
      Result := (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0;
    finally
      FindClose(FindRec);
    end;
  end;
end;

function IsWebView2Installed(): Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  if Result then
    Result := (Version <> '') and (Version <> '0.0.0.0');
end;

{ ---------- 查找同目录的依赖安装器 ---------- }

function FindSiblingInstaller(const FileName: String): String;
var
  Candidate: String;
begin
  Result := '';
  Candidate := ExpandConstant('{src}\') + FileName;
  if FileExists(Candidate) then
    Result := Candidate
  else
  begin
    Candidate := ExpandConstant('{src}\deps\') + FileName;
    if FileExists(Candidate) then
      Result := Candidate;
  end;
end;

{ ---------- 安装前：按依赖清单逐项检查 ---------- }

function InitializeSetup(): Boolean;
var
  Installer: String;
  ResultCode: Integer;
  ErrCode: Integer;
begin
  Result := True;

  { 依赖 1：.NET 8 Desktop Runtime（必需，缺失则程序无法启动） }
  if not HasDesktopRuntime8() then
  begin
    Installer := FindSiblingInstaller('{#DotnetRuntimeFile}');
    if Installer <> '' then
    begin
      if MsgBox('未检测到 .NET 8 Desktop Runtime —— 这是本程序的必需依赖。' + #13#10#13#10 +
                '已在安装程序同目录找到依赖包：' + #13#10 +
                '  ' + ExtractFileName(Installer) + #13#10#13#10 +
                '现在自动安装吗？约需 1~2 分钟，完成后会继续安装主程序。',
                mbConfirmation, MB_YESNO) = IDYES then
      begin
        if (not Exec(Installer, '/install /quiet /norestart', '',
                     SW_SHOW, ewWaitUntilTerminated, ResultCode))
           or (ResultCode <> 0) then
          MsgBox('依赖安装未成功（退出码 ' + IntToStr(ResultCode) + '）。' + #13#10 +
                 '请手动运行该安装器后重试。', mbError, MB_OK)
        else if not HasDesktopRuntime8() then
          MsgBox('依赖安装器已执行，但仍未检测到 .NET 8 Desktop Runtime。' + #13#10 +
                 '可能需要重启系统后再安装本程序。', mbInformation, MB_OK);
      end
      else
        Result := MsgBox('缺少必需依赖时主程序无法启动。仍要继续安装主程序吗？',
                         mbConfirmation, MB_YESNO) = IDYES;
    end
    else
    begin
      Result := MsgBox('未检测到 .NET 8 Desktop Runtime —— 这是本程序的必需依赖。' + #13#10#13#10 +
                '请先下载「依赖分发包」并解压，把其中的：' + #13#10 +
                '  ' + '{#DotnetRuntimeFile}' + #13#10 +
                '与本安装程序放在同一目录，重跑本安装程序即可自动识别。' + #13#10#13#10 +
                '仍要继续安装主程序吗？（装完也无法启动）',
                mbInformation, MB_YESNO) = IDYES;
    end;
  end;

  { 依赖 2：WebView2 Runtime（渲染引擎，Win11 通常已预装） }
  if not IsWebView2Installed() then
  begin
    Installer := FindSiblingInstaller('{#WebView2File}');
    if Installer <> '' then
    begin
      if MsgBox('未检测到 Microsoft Edge WebView2 运行时（本程序的渲染引擎）。' + #13#10#13#10 +
                '已在同目录找到：' + ExtractFileName(Installer) + #13#10#13#10 +
                '现在自动安装吗？',
                mbConfirmation, MB_YESNO) = IDYES then
      begin
        Exec(Installer, '/silent /install', '', SW_SHOW, ewWaitUntilTerminated, ResultCode);
      end;
    end
    else if MsgBox('未检测到 Microsoft Edge WebView2 运行时。' + #13#10#13#10 +
                   '本程序的画面由它渲染。Windows 11 一般已预装，' + #13#10 +
                   'Windows 10 可能需要单独安装。' + #13#10#13#10 +
                   '是否现在打开微软官方下载页？',
                   mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://go.microsoft.com/fwlink/p/?LinkId=2124703',
                '', '', SW_SHOW, ewNoWait, ErrCode);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  { 升级安装时先结束正在运行的旧实例，否则文件被占用会写不进去 }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM ArcadeFPS.exe',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
