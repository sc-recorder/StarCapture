const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const archiver = require('archiver');

// Load version from package.json
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const VERSION = packageJson.version;

// Configuration
const DIST_DIR = path.join(__dirname, 'dist');
const PORTABLE_DIR = path.join(DIST_DIR, `StarCapture-v${VERSION}`);
const WIN_UNPACKED_DIR = path.join(DIST_DIR, 'win-unpacked');

// Ensure dist directory exists
if (!fs.existsSync(DIST_DIR)) {
    console.error('Error: dist/ directory not found. Run "npm run build:portable" first.');
    process.exit(1);
}

// Check if electron-builder output exists
if (!fs.existsSync(WIN_UNPACKED_DIR)) {
    console.error('Error: dist/win-unpacked/ not found. Run "npm run build:portable" first.');
    process.exit(1);
}

console.log('Creating portable distribution package...');

// Create portable directory structure
function createDirectoryStructure() {
    // Remove old portable directory if it exists
    if (fs.existsSync(PORTABLE_DIR)) {
        fs.rmSync(PORTABLE_DIR, { recursive: true, force: true });
        console.log('Removed old portable directory');
    }

    // Create new structure
    fs.mkdirSync(PORTABLE_DIR, { recursive: true });
    fs.mkdirSync(path.join(PORTABLE_DIR, 'resources'), { recursive: true });
    fs.mkdirSync(path.join(PORTABLE_DIR, 'resources', 'obs-studio'), { recursive: true });
    fs.mkdirSync(path.join(PORTABLE_DIR, 'resources', 'ffmpeg'), { recursive: true });
    // No config folder - patterns auto-download from S3
    
    console.log('Created directory structure');
}


// Copy all files from win-unpacked (including DLLs and resources)
async function copyAllFiles() {
    const files = fs.readdirSync(WIN_UNPACKED_DIR);
    const exeName = 'StarCapture.exe';
    
    // Critical files that must be copied
    const criticalFiles = [
        'snapshot_blob.bin',
        'v8_context_snapshot.bin',
        'vk_swiftshader.dll',
        'vk_swiftshader_icd.json',
        'vulkan-1.dll'
    ];
    
    console.log(`Found ${files.length} files/directories to copy`);
    
    for (const file of files) {
        const sourcePath = path.join(WIN_UNPACKED_DIR, file);
        const destPath = path.join(PORTABLE_DIR, file);
        
        const stat = fs.statSync(sourcePath);
        
        if (stat.isDirectory()) {
            // Special handling for resources directory
            if (file === 'resources') {
                console.log(`Copying resources directory...`);
                // Copy the resources directory but we'll handle obs-studio and ffmpeg separately
                copyAppResources(sourcePath, destPath);
            } else {
                // Copy other directories normally
                console.log(`Copying directory: ${file}`);
                copyDirectoryRecursive(sourcePath, destPath);
            }
        } else {
            // Copy file
            console.log(`Copying file: ${file} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
            fs.copyFileSync(sourcePath, destPath);
            
            // Don't set icon yet - do it after all files are copied
            // if (file === exeName) {
            //     await setExeIcon(destPath);
            // }
        }
    }
    
    // Verify critical files were copied
    console.log('\nVerifying critical files...');
    for (const file of criticalFiles) {
        const destPath = path.join(PORTABLE_DIR, file);
        if (fs.existsSync(destPath)) {
            console.log(`✓ ${file}`);
        } else {
            console.error(`✗ MISSING: ${file}`);
            // Try to copy it explicitly if it exists in source
            const sourcePath = path.join(WIN_UNPACKED_DIR, file);
            if (fs.existsSync(sourcePath)) {
                console.log(`  Copying missing file: ${file}`);
                fs.copyFileSync(sourcePath, destPath);
            }
        }
    }
    
    console.log('Copied all application files');
    
    // Now set the icon after all files are copied
    const exePath = path.join(PORTABLE_DIR, exeName);
    if (fs.existsSync(exePath)) {
        console.log('\nSetting custom icon...');
        try {
            await setExeIcon(exePath);
        } catch (error) {
            console.error('Icon setting failed, but continuing:', error.message);
        }
    }
}

// Set icon for the executable
async function setExeIcon(exePath) {
    try {
        const rcedit = require('rcedit');
        const iconPath = path.join(__dirname, 'build', 'icon.ico');
        
        if (fs.existsSync(iconPath)) {
            console.log('Setting custom icon for executable...');
            await new Promise((resolve, reject) => {
                // Add a timeout in case rcedit hangs
                const timeout = setTimeout(() => {
                    console.error('Icon setting timed out after 30 seconds');
                    reject(new Error('Timeout'));
                }, 30000);
                
                rcedit(exePath, {
                    icon: iconPath
                }, (error) => {
                    clearTimeout(timeout);
                    if (error) {
                        console.error('Failed to set icon:', error);
                        reject(error);
                    } else {
                        console.log('Custom icon set successfully');
                        resolve();
                    }
                });
            });
        } else {
            console.warn('Icon file not found at:', iconPath);
        }
    } catch (error) {
        console.error('Error setting icon:', error);
        // Continue even if icon setting fails
    }
}

// Helper function to copy directory recursively
function copyDirectoryRecursive(source, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const files = fs.readdirSync(source);
    
    files.forEach(file => {
        const sourcePath = path.join(source, file);
        const destPath = path.join(dest, file);
        
        const stat = fs.statSync(sourcePath);
        
        if (stat.isDirectory()) {
            copyDirectoryRecursive(sourcePath, destPath);
        } else {
            fs.copyFileSync(sourcePath, destPath);
        }
    });
}

// Copy app resources (ASAR file and config)
function copyAppResources(source, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const files = fs.readdirSync(source);
    
    files.forEach(file => {
        const sourcePath = path.join(source, file);
        const destPath = path.join(dest, file);
        
        // Copy app.asar and any other electron resources
        // but skip obs-studio and ffmpeg folders (they'll be downloaded on first run)
        if (file === 'app.asar' || file === 'app.asar.unpacked' || file === 'config') {
            const stat = fs.statSync(sourcePath);
            if (stat.isDirectory()) {
                copyDirectoryRecursive(sourcePath, destPath);
            } else {
                fs.copyFileSync(sourcePath, destPath);
            }
            console.log(`Copied resource: ${file}`);
        }
    });
}

// No longer need to copy config files - patterns auto-download from S3
function copyConfigFiles() {
    console.log('Skipping config files - patterns will auto-download from S3 on first run');
}

// Create README for users
function createReadme() {
    const readmeContent = `StarCapture - Portable Version
==============================

QUICK START:
1. Run "StarCapture.exe" to start the application
2. The setup wizard will launch on first run
3. Follow the wizard to download OBS and FFmpeg
4. Configure your recording settings
5. Start recording your Star Citizen gameplay!

IMPORTANT NOTES:
- On first run, Windows may show a security warning. Click "More info" then "Run anyway"
- The setup wizard will download ~250MB of required components
- Ensure you have a stable internet connection for the initial setup
- All settings and recordings are stored in this folder (portable)

FOLDER STRUCTURE:
- resources/     : Application resources and external tools
  - config/      : Configuration files (sc-log-patterns.json)
  - obs-studio/  : OBS Studio (downloaded on first run)
  - ffmpeg/      : FFmpeg (downloaded on first run)
- logs/          : Application logs (created at runtime)
- User settings stored in %APPDATA%/sc-recorder/

SYSTEM REQUIREMENTS:
- Windows 10 or later (64-bit)
- 500MB free disk space (after OBS/FFmpeg download)
- Star Citizen installed
- DirectX 11 compatible graphics

TROUBLESHOOTING:
- If the app doesn't start, check Windows Defender isn't blocking it
- If download fails, check your firewall settings
- Logs are saved in the logs/ folder for debugging

For more information, visit: https://github.com/your-repo/sc-recorder

Version: ${VERSION}
`;
    
    const readmePath = path.join(PORTABLE_DIR, 'README.txt');
    fs.writeFileSync(readmePath, readmeContent);
    console.log('Created README.txt');
}

// Create ZIP archive of the portable folder
async function createZipArchive() {
    const zipFileName = `StarCapture-v${VERSION}.zip`;
    const zipPath = path.join(DIST_DIR, zipFileName);

    console.log(`\nCreating ZIP archive: ${zipFileName}...`);

    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', {
            zlib: { level: 9 } // Maximum compression
        });

        output.on('close', () => {
            const sizeInMB = (archive.pointer() / 1024 / 1024).toFixed(2);
            console.log(`ZIP archive created: ${zipFileName} (${sizeInMB} MB)`);
            resolve({ fileName: zipFileName, size: archive.pointer() });
        });

        archive.on('error', (err) => {
            reject(err);
        });

        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                console.warn('Archive warning:', err);
            } else {
                reject(err);
            }
        });

        archive.pipe(output);
        archive.directory(PORTABLE_DIR, `StarCapture-v${VERSION}`);
        archive.finalize();
    });
}

// Create Inno Setup script
function createInnoSetupScript() {
    const scriptFileName = `StarCapture-v${VERSION}.iss`;
    const scriptPath = path.join(DIST_DIR, scriptFileName);

    // Format version for Windows (needs to be X.X.X.X format)
    const formatVersionForWindows = (version) => {
        // Remove pre-release tags like -beta3
        let cleanVersion = version.replace(/-.*$/, '');
        // Split into parts
        let parts = cleanVersion.split('.');
        // Ensure we have at least 3 parts
        while (parts.length < 3) {
            parts.push('0');
        }
        // Take only first 3 parts and join
        return parts.slice(0, 3).join('.');
    };

    const windowsVersion = formatVersionForWindows(VERSION);

    const innoScript = `; StarCapture Inno Setup Script
; Version: ${VERSION}
; Generated: ${new Date().toISOString()}

#define MyAppName "StarCapture"
#define MyAppVersion "${VERSION}"
#define MyAppPublisher "SC Recorder"
#define MyAppURL "https://starcapture.video"
#define MyAppExeName "StarCapture.exe"
#define MyAppIcon "..\\build\\icon.ico"

[Setup]
AppId={{E5D8C4B1-7F2A-4B3C-9D6E-1A8F9C3D2B5E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
; LicenseFile is optional - comment out if no LICENSE file exists
; LicenseFile=..\\LICENSE
OutputDir=.
OutputBaseFilename=StarCapture-Setup-v${VERSION}
SetupIconFile={#MyAppIcon}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\\{#MyAppExeName}
UninstallDisplayName={#MyAppName} v{#MyAppVersion}
VersionInfoVersion=${windowsVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Star Citizen Gameplay Recorder
VersionInfoProductName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "quicklaunchicon"; Description: "{cm:CreateQuickLaunchIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked; OnlyBelowVersion: 6.1

[Files]
; Main application files
Source: "StarCapture-v${VERSION}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Note: Don't use "Flags: ignoreversion" on any shared system files

[Icons]
Name: "{group}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; IconFilename: "{app}\\{#MyAppExeName}"
Name: "{group}\\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; Tasks: desktopicon; IconFilename: "{app}\\{#MyAppExeName}"
Name: "{userappdata}\\Microsoft\\Internet Explorer\\Quick Launch\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; Tasks: quicklaunchicon; IconFilename: "{app}\\{#MyAppExeName}"

[Run]
Filename: "{app}\\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Clean up folders created at runtime
Type: filesandordirs; Name: "{app}\\resources\\obs-studio"
Type: filesandordirs; Name: "{app}\\resources\\ffmpeg"
Type: filesandordirs; Name: "{app}\\logs"
Type: filesandordirs; Name: "{app}\\recordings"
Type: filesandordirs; Name: "{app}\\saved"

[Code]
var
  DeleteExternalDeps: Boolean;
  DeleteUserSettings: Boolean;

function InitializeSetup(): Boolean;
begin
  Result := True;
  // Star Citizen check disabled - users can install StarCapture before Star Citizen
end;

procedure InitializeWizard();
begin
  // Set custom wizard window size if needed
  WizardForm.Width := 500;
  WizardForm.Height := 400;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  NeedsRestart := False;
  // Running instance check disabled - Windows will handle file replacement
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    // Create config directory if it doesn't exist
    ForceDirectories(ExpandConstant('{app}\\config'));

    // Set Windows Defender exclusion (optional, requires admin)
    // This helps prevent false positives and performance issues
    try
      Exec('powershell.exe',
           '-Command "Add-MpPreference -ExclusionPath ''' + ExpandConstant('{app}') + '''"',
           '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    except
      // Silently continue if this fails
    end;
  end;
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;

  // Ask user about removing external dependencies
  DeleteExternalDeps := MsgBox('Do you want to remove OBS and FFmpeg from LocalAppData?' + #13#10 + #13#10 + 'This will delete the downloaded external dependencies.', mbConfirmation, MB_YESNO) = IDYES;

  // Ask user about removing settings
  DeleteUserSettings := MsgBox('Do you want to remove all settings and saved filters?' + #13#10 + #13#10 + 'This will delete all your StarCapture configuration and preferences.', mbConfirmation, MB_YESNO) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
  LocalAppDataPath: String;
  AppDataPath: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    // Remove Windows Defender exclusion
    try
      Exec('powershell.exe',
           '-Command "Remove-MpPreference -ExclusionPath ''' + ExpandConstant('{app}') + '''"',
           '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    except
      // Silently continue if this fails
    end;
  end;

  if CurUninstallStep = usPostUninstall then
  begin
    // Always clean up the basic AppData folder
    AppDataPath := ExpandConstant('{userappdata}\\sc-recorder');

    // Clean up LocalAppData external dependencies if user chose to
    if DeleteExternalDeps then
    begin
      LocalAppDataPath := ExpandConstant('{localappdata}\\sc-recorder');
      // Delete the entire sc-recorder folder from LocalAppData
      if DirExists(LocalAppDataPath) then
      begin
        DelTree(LocalAppDataPath, True, True, True);
      end;
    end;

    // Clean up all user settings and saved filters if user chose to
    if DeleteUserSettings then
    begin
      if DirExists(AppDataPath) then
      begin
        DelTree(AppDataPath, True, True, True);
      end;
    end;
  end;
end;
`;

    fs.writeFileSync(scriptPath, innoScript);
    console.log(`Created Inno Setup script: ${scriptFileName}`);

    return scriptFileName;
}

// Compile Inno Setup script to create installer
async function compileInnoSetup(scriptFileName) {
    const scriptPath = path.join(DIST_DIR, scriptFileName);
    const innoSetupPath = 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe';

    // Check if Inno Setup is installed
    if (!fs.existsSync(innoSetupPath)) {
        console.log('⚠️  Inno Setup not found at:', innoSetupPath);
        console.log('   Skipping installer compilation. Install Inno Setup to enable automatic building.');
        return null;
    }

    console.log('\n📦 Compiling installer with Inno Setup...');

    return new Promise((resolve, reject) => {
        const process = spawn(innoSetupPath, [scriptPath, '/Q'], {
            cwd: DIST_DIR,
            stdio: 'pipe'
        });

        let output = '';

        process.stdout.on('data', (data) => {
            output += data.toString();
            // Show progress dots
            process.stdout.write('.');
        });

        process.stderr.on('data', (data) => {
            console.error('Inno Setup error:', data.toString());
        });

        process.on('close', (code) => {
            console.log(''); // New line after dots

            if (code === 0) {
                const installerName = `StarCapture-Setup-v${VERSION}.exe`;
                const installerPath = path.join(DIST_DIR, installerName);

                if (fs.existsSync(installerPath)) {
                    const stats = fs.statSync(installerPath);
                    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
                    console.log(`✅ Installer compiled successfully: ${installerName} (${sizeMB} MB)`);
                    resolve(installerName);
                } else {
                    console.error('❌ Installer file not found after compilation');
                    resolve(null);
                }
            } else {
                console.error(`❌ Inno Setup compilation failed with code ${code}`);
                if (output) {
                    console.error('Output:', output);
                }
                resolve(null);
            }
        });

        process.on('error', (err) => {
            console.error('Failed to start Inno Setup:', err.message);
            resolve(null);
        });
    });
}

// Create build info JSON file
function createBuildInfo(zipFileName, issFileName, installerFileName) {
    const buildInfo = {
        build: zipFileName,
        installer: installerFileName || 'Not compiled (Inno Setup not found)',
        innoScript: issFileName,
        version: VERSION,
        timestamp: new Date().toISOString(),
        platform: 'win32',
        arch: 'x64'
    };

    const buildInfoPath = path.join(DIST_DIR, 'current.json');
    fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2));
    console.log(`\nCreated current.json with build metadata`);
    return buildInfo;
}

// Main execution
(async () => {
    try {
        createDirectoryStructure();
        await copyAllFiles();  // This now copies everything from electron-builder output
        copyConfigFiles();
        createReadme();

        console.log('\n✅ Portable package created successfully!');
        console.log(`📁 Location: ${PORTABLE_DIR}`);
        console.log(`📦 Version: ${VERSION}`);

        // Create ZIP archive
        const { fileName } = await createZipArchive();

        // Create Inno Setup script
        const issFileName = createInnoSetupScript();

        // Compile installer if Inno Setup is available
        const installerFileName = await compileInnoSetup(issFileName);

        // Create build info JSON
        const buildInfo = createBuildInfo(fileName, issFileName, installerFileName);

        console.log('\n✅ Build process complete!');
        console.log(`📦 ZIP Archive: ${path.join(DIST_DIR, fileName)}`);
        console.log(`📄 Inno Script: ${path.join(DIST_DIR, issFileName)}`);

        if (installerFileName) {
            console.log(`🚀 Installer: ${path.join(DIST_DIR, installerFileName)}`);
        } else {
            console.log('ℹ️  To create installer manually: Open the .iss file in Inno Setup Compiler');
        }

        console.log(`📄 Build Info: ${path.join(DIST_DIR, 'current.json')}`);
        console.log('\nBuild info:');
        console.log(JSON.stringify(buildInfo, null, 2));
    } catch (error) {
        console.error('Error creating portable package:', error);
        process.exit(1);
    }
})();