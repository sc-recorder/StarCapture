# StarCapture Source Distribution

Version 1.0.0-beta1

## Requirements

- Windows 10/11 (64-bit)
- Node.js 18.x or higher
- npm 8.x or higher
- 4GB RAM minimum
- DirectX 11 compatible GPU

## Installation

1. Extract this archive to a folder

2. Install dependencies:
   ```
   npm install
   ```

3. Run the application:
   ```
   npm start
   ```

The setup wizard will download OBS Studio and FFmpeg on first run (approximately 250MB).

## Building

To create a portable executable:

```
npm run dist:win
npm run portable
```

The executable will be in dist/StarCapture-v1.0.0-beta1/

## License

GPL v3 - See LICENSE file for details

## Support

Report issues at: https://github.com/anthropics/starcapture/issues
