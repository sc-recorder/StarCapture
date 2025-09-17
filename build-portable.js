const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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
    fs.mkdirSync(path.join(PORTABLE_DIR, 'config'), { recursive: true });
    
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
            } else if (file !== 'config') {
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

// Copy config files from electron-builder extraResources
function copyConfigFiles() {
    // Config files should be in the resources folder from electron-builder
    const configSource = path.join(WIN_UNPACKED_DIR, 'resources', 'config');
    const configDest = path.join(PORTABLE_DIR, 'resources', 'config');
    
    if (fs.existsSync(configSource)) {
        if (!fs.existsSync(configDest)) {
            fs.mkdirSync(configDest, { recursive: true });
        }
        
        const files = fs.readdirSync(configSource);
        files.forEach(file => {
            if (file.endsWith('.json')) {
                const sourcePath = path.join(configSource, file);
                const destPath = path.join(configDest, file);
                fs.copyFileSync(sourcePath, destPath);
                console.log(`Copied config/${file}`);
            }
        });
    } else {
        console.warn('Warning: config/ directory not found in electron-builder output');
    }
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

// Create build info JSON file
function createBuildInfo(zipFileName) {
    const buildInfo = {
        build: zipFileName,
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

        // Create build info JSON
        const buildInfo = createBuildInfo(fileName);

        console.log('\n✅ Build process complete!');
        console.log(`📦 ZIP Archive: ${path.join(DIST_DIR, fileName)}`);
        console.log(`📄 Build Info: ${path.join(DIST_DIR, 'current.json')}`);
        console.log('\nBuild info:');
        console.log(JSON.stringify(buildInfo, null, 2));
    } catch (error) {
        console.error('Error creating portable package:', error);
        process.exit(1);
    }
})();