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

# Create Release ZIP
npm run release     # Builds everything and creates final ZIP
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