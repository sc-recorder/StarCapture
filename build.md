# SC Recorder Build Guide

## Quick Commands

```bash
# Development
npm run dev

# Build Portable Distribution
npm run dist:win    # Build with electron-builder (ignore symlink errors)
npm run portable    # Create portable package with icon

# Build Source Distribution (for developers)
npm run source:dist # Creates sc-recorder-source-dist.zip

# Create Release (run these separately due to module conflicts)
npm run dist:win    # Step 1: Build with electron-builder
npm run portable    # Step 2: Create portable package
npm run source:dist # Step 3: Create source distribution

# Publish to S3 (after building)
npm run publish:release     # Publish ZIP, EXE, and current.json (complete release)
npm run publish:all         # Publish ZIP and EXE only (not source)
npm run publish:zip         # Publish portable ZIP only
npm run publish:source      # Publish source ZIP only (separate)
npm run publish:exe         # Publish installer EXE only
npm run publish:log-patterns # Publish log patterns config only
npm run publish:current     # Publish current.json for auto-updates
```

## Build Process

### Portable Distribution Build

1. **Clean previous builds**
   ```bash
   rm -rf dist
   ```

2. **Build with electron-builder**
   ```bash
   npm run dist:win
   ```
   *Note: Ignore symlink errors - they're harmless*

3. **Create portable package**
   ```bash
   npm run portable
   ```
   Final executable: `dist/sc-recorder-v{version}/SC Recorder.exe`

### Source Distribution Build

For sharing source code with other developers:

```bash
npm run source:dist
```

This creates `sc-recorder-source-dist.zip` containing:
- All JavaScript source files
- HTML/CSS files
- package.json (for dependencies)
- Build resources (icons, etc.)
- Documentation

**Excludes:**
- node_modules
- dist folder
- OBS/FFmpeg binaries
- User data and logs

## Prerequisites

- Node.js 18.x or higher
- npm 8.x or higher
- Windows 10/11 (64-bit)

## Configuration

### Logging Configuration

Log levels are configured in `package.json` under the `logging` key:

```json
"logging": {
  "level": "info",
  "console": {
    "enabled": false,
    "statusUpdates": false,
    "recordingStats": false
  },
  "file": {
    "enabled": true,
    "level": "info",
    "recordingStats": false
  }
}
```

**Log Levels** (from least to most verbose):
- `error` - Only errors
- `warn` - Errors and warnings
- `info` - Errors, warnings, and informational messages (recommended for production)
- `debug` - Everything including debug information (development only)

**Settings:**
- `logging.level` - Global log level (applies to both console and file by default)
- `file.enabled` - Enable/disable file logging
- `file.level` - File-specific log level (overrides global level)
- `file.recordingStats` - Log recording stats every second (creates large logs, disabled by default)
- `console.enabled` - Enable console logging in browser dev tools
- `console.statusUpdates` - Log every status update (very verbose)
- `console.recordingStats` - Log recording stats to console

**Production Recommendations:**
- Keep `file.level: "info"` to avoid multi-GB log files
- Keep `file.recordingStats: false` to prevent excessive I/O during recording
- Keep `console.enabled: false` unless debugging in production

**Log File Location:**
- Windows: `%APPDATA%\sc-recorder\logs\`
- Files: `{component-name}-{timestamp}.log` and `{component-name}-latest.log`

## Publishing to S3

### One-Time Setup

1. **Configure S3 credentials**
   ```bash
   # Copy the template
   cp secrets/s3-config.example.json secrets/s3-config.json

   # Edit with your S3 details
   # - endpoint: Your S3-compatible endpoint
   # - baseUrl: Public URL for downloads
   # - bucket: Your bucket name
   # - accessKeyId/secretAccessKey: Your credentials
   ```

2. **Install dependencies** (if not already done)
   ```bash
   npm install
   ```

### Publishing Process

1. **Build the releases first** (run separately due to module conflicts)
   ```bash
   npm run dist:win     # Build with electron-builder
   npm run portable     # Create portable package
   npm run source:dist  # Create source distribution

   # Note: These must be run as separate commands, not chained
   ```

2. **Publish to S3**
   ```bash
   # Publish main release files (ZIP and EXE)
   npm run publish:all

   # Or publish specific files
   npm run publish:zip          # Portable ZIP only
   npm run publish:exe          # Windows installer only
   npm run publish:source       # Source code ZIP (separately)
   npm run publish:log-patterns # SC log patterns config
   npm run publish:current      # Version info for auto-updates
   ```

3. **Force overwrite existing files** (if needed)
   ```bash
   node scripts/publish-to-s3.js all --force
   ```

### What Gets Published

Files are organized in S3:
- `StarCapture-v{version}.zip` - Portable application
- `StarCapture-Setup-v{version}.exe` - Windows installer
- `StarCapture-{version}-source.zip` - Source code (published separately)
- `sc-log-patterns.json` - Star Citizen log patterns
- `current.json` - Latest version info for auto-updates

The script will:
- Check if files already exist (skip unless --force)
- Calculate MD5 checksums
- Show upload progress
- Generate public download URLs
- Display file sizes and metadata

### Typical Workflow

```bash
# Complete release and publish workflow
# Build steps (must be run separately)
npm run dist:win     # Step 1: Build with electron-builder
npm run portable     # Step 2: Create portable package
npm run source:dist  # Step 3: Create source distribution

# Then publish to S3
npm run publish:release # Upload ZIP, EXE, and current.json (recommended)

# The script will show URLs like:
# 🔗 Public URL: https://your-cdn.com/bucket/releases/v1.0.0/SC-Recorder-1.0.0-win-portable.zip
```

**Important:** The build commands must be run separately (not chained with && or &) due to module conflicts.