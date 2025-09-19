const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const { createWriteStream } = require('fs');
const extract = require('extract-zip');

class FFmpegDetector {
    constructor() {
        this.ffmpegPath = null;
        this.capabilities = {
            version: null,
            hwAccel: [],
            encoders: {
                h264: [],
                h265: [],
                av1: []
            },
            decoders: {
                h264: [],
                h265: [],
                av1: []
            }
        };
    }

    /**
     * Download and extract ffmpeg
     */
    async downloadFFmpeg(progressCallback) {
        const ffmpegUrl = 'https://github.com/GyanD/codexffmpeg/releases/download/8.0/ffmpeg-8.0-essentials_build.zip';
        // Always use LOCALAPPDATA for downloaded resources
        const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
        const resourcesPath = path.join(localAppData, 'sc-recorder', 'resources');
        const ffmpegDir = path.join(resourcesPath, 'ffmpeg');
        const zipPath = path.join(resourcesPath, 'ffmpeg-temp.zip');

        try {
            // Ensure directories exist
            await fs.mkdir(resourcesPath, { recursive: true });
            await fs.mkdir(ffmpegDir, { recursive: true });

            // Check if ffmpeg already exists
            const ffmpegExe = path.join(ffmpegDir, 'ffmpeg.exe');
            try {
                await fs.access(ffmpegExe);
                console.log('FFmpeg already exists, skipping download');
                this.ffmpegPath = ffmpegExe;
                if (progressCallback) progressCallback({ message: 'FFmpeg already installed', progress: 100 });
                return ffmpegExe;
            } catch (e) {
                // FFmpeg doesn't exist, proceed with download
            }

            // Download ffmpeg
            if (progressCallback) progressCallback({ message: 'Downloading FFmpeg...', progress: 10 });
            
            await this.downloadFile(ffmpegUrl, zipPath, (progress) => {
                if (progressCallback) {
                    progressCallback({ 
                        message: 'Downloading FFmpeg...', 
                        progress: 10 + (progress * 0.6) // 10-70%
                    });
                }
            });

            if (progressCallback) progressCallback({ message: 'Extracting FFmpeg...', progress: 70 });

            // Extract the zip file using extract-zip
            await extract(zipPath, { dir: resourcesPath });

            // Find the extracted folder (it will be named ffmpeg-8.0-essentials_build)
            const extractedFolder = path.join(resourcesPath, 'ffmpeg-8.0-essentials_build');
            
            // Move files from bin folder to our ffmpeg directory
            const binPath = path.join(extractedFolder, 'bin');
            const files = await fs.readdir(binPath);
            
            for (const file of files) {
                const srcPath = path.join(binPath, file);
                const destPath = path.join(ffmpegDir, file);
                await fs.rename(srcPath, destPath);
            }

            // Clean up
            await fs.rm(extractedFolder, { recursive: true, force: true });
            await fs.unlink(zipPath);

            this.ffmpegPath = ffmpegExe;
            
            if (progressCallback) progressCallback({ message: 'FFmpeg installed successfully', progress: 100 });
            
            return ffmpegExe;
        } catch (error) {
            console.error('Failed to download/extract FFmpeg:', error);
            throw error;
        }
    }

    /**
     * Download file with progress
     */
    downloadFile(url, destPath, progressCallback) {
        return new Promise((resolve, reject) => {
            const file = createWriteStream(destPath);
            
            https.get(url, { 
                headers: { 'User-Agent': 'SC-Recorder' },
                followRedirect: true 
            }, (response) => {
                // Handle redirects
                if (response.statusCode === 302 || response.statusCode === 301) {
                    file.close();
                    this.downloadFile(response.headers.location, destPath, progressCallback)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                const totalSize = parseInt(response.headers['content-length'], 10);
                let downloadedSize = 0;

                response.on('data', (chunk) => {
                    downloadedSize += chunk.length;
                    if (progressCallback && totalSize) {
                        progressCallback(downloadedSize / totalSize);
                    }
                });

                response.pipe(file);

                file.on('finish', () => {
                    file.close(resolve);
                });
            }).on('error', (err) => {
                fs.unlink(destPath, () => {}); // Delete the file on error
                reject(err);
            });

            file.on('error', (err) => {
                fs.unlink(destPath, () => {}); // Delete the file on error
                reject(err);
            });
        });
    }

    /**
     * Detect FFmpeg capabilities
     */
    async detectCapabilities() {
        if (!this.ffmpegPath) {
            // Use LOCALAPPDATA for downloaded resources
            const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
            const resourcesPath = localAppData ? path.join(localAppData, 'sc-recorder', 'resources') : path.join(__dirname, '..', 'resources');
            const ffmpegExe = path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe');
            
            try {
                await fs.access(ffmpegExe);
                this.ffmpegPath = ffmpegExe;
            } catch (e) {
                throw new Error('FFmpeg not found. Please run setup first.');
            }
        }

        // Get version
        await this.detectVersion();
        
        // Detect hardware acceleration methods
        await this.detectHwAccel();
        
        // Detect encoders
        await this.detectEncoders();
        
        // Detect decoders
        await this.detectDecoders();
        
        return this.capabilities;
    }

    /**
     * Detect FFmpeg version
     */
    async detectVersion() {
        return new Promise((resolve) => {
            console.log('Detecting FFmpeg version using:', this.ffmpegPath);
            const ffmpeg = spawn(this.ffmpegPath, ['-version']);
            let output = '';

            ffmpeg.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffmpeg.stderr.on('data', (data) => {
                console.error('FFmpeg stderr:', data.toString());
            });

            ffmpeg.on('close', (code) => {
                console.log('FFmpeg version detection exited with code:', code);
                const versionMatch = output.match(/ffmpeg version ([^\s]+)/);
                if (versionMatch) {
                    this.capabilities.version = versionMatch[1];
                    console.log('Detected FFmpeg version:', this.capabilities.version);
                } else {
                    console.log('Could not parse FFmpeg version from output:', output.substring(0, 200));
                }
                resolve();
            });

            ffmpeg.on('error', (err) => {
                console.error('Failed to detect FFmpeg version:', err);
                resolve();
            });
        });
    }

    /**
     * Detect hardware acceleration methods
     */
    async detectHwAccel() {
        return new Promise((resolve) => {
            const ffmpeg = spawn(this.ffmpegPath, ['-hwaccels']);
            let output = '';

            ffmpeg.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffmpeg.on('close', () => {
                const lines = output.split('\n').slice(1); // Skip first line "Hardware acceleration methods:"
                this.capabilities.hwAccel = lines
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('Hardware'));
                resolve();
            });

            ffmpeg.on('error', (err) => {
                console.error('Failed to detect hardware acceleration:', err);
                resolve();
            });
        });
    }

    /**
     * Detect available encoders
     */
    async detectEncoders() {
        return new Promise((resolve) => {
            const ffmpeg = spawn(this.ffmpegPath, ['-encoders']);
            let output = '';

            ffmpeg.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffmpeg.on('close', () => {
                // Parse H.264 encoders
                const h264Encoders = [];
                if (output.includes('h264_nvenc')) h264Encoders.push('h264_nvenc');
                if (output.includes('h264_amf')) h264Encoders.push('h264_amf');
                if (output.includes('h264_qsv')) h264Encoders.push('h264_qsv');
                if (output.includes('libx264')) h264Encoders.push('libx264');
                
                // Parse H.265/HEVC encoders
                const h265Encoders = [];
                if (output.includes('hevc_nvenc')) h265Encoders.push('hevc_nvenc');
                if (output.includes('hevc_amf')) h265Encoders.push('hevc_amf');
                if (output.includes('hevc_qsv')) h265Encoders.push('hevc_qsv');
                if (output.includes('libx265')) h265Encoders.push('libx265');
                
                // Parse AV1 encoders
                const av1Encoders = [];
                if (output.includes('av1_nvenc')) av1Encoders.push('av1_nvenc');
                if (output.includes('av1_amf')) av1Encoders.push('av1_amf');
                if (output.includes('av1_qsv')) av1Encoders.push('av1_qsv');
                if (output.includes('libsvtav1')) av1Encoders.push('libsvtav1');
                if (output.includes('libaom-av1')) av1Encoders.push('libaom-av1');

                this.capabilities.encoders.h264 = h264Encoders;
                this.capabilities.encoders.h265 = h265Encoders;
                this.capabilities.encoders.av1 = av1Encoders;
                
                resolve();
            });

            ffmpeg.on('error', (err) => {
                console.error('Failed to detect encoders:', err);
                resolve();
            });
        });
    }

    /**
     * Detect available decoders
     */
    async detectDecoders() {
        return new Promise((resolve) => {
            const ffmpeg = spawn(this.ffmpegPath, ['-decoders']);
            let output = '';

            ffmpeg.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffmpeg.on('close', () => {
                // Parse H.264 decoders
                const h264Decoders = [];
                if (output.includes('h264_cuvid')) h264Decoders.push('h264_cuvid');
                if (output.includes('h264_qsv')) h264Decoders.push('h264_qsv');
                if (output.includes('h264')) h264Decoders.push('h264');
                
                // Parse H.265/HEVC decoders
                const h265Decoders = [];
                if (output.includes('hevc_cuvid')) h265Decoders.push('hevc_cuvid');
                if (output.includes('hevc_qsv')) h265Decoders.push('hevc_qsv');
                if (output.includes('hevc')) h265Decoders.push('hevc');
                
                // Parse AV1 decoders
                const av1Decoders = [];
                if (output.includes('av1_cuvid')) av1Decoders.push('av1_cuvid');
                if (output.includes('av1_qsv')) av1Decoders.push('av1_qsv');
                if (output.includes('av1')) av1Decoders.push('av1');

                this.capabilities.decoders.h264 = h264Decoders;
                this.capabilities.decoders.h265 = h265Decoders;
                this.capabilities.decoders.av1 = av1Decoders;
                
                resolve();
            });

            ffmpeg.on('error', (err) => {
                console.error('Failed to detect decoders:', err);
                resolve();
            });
        });
    }

    /**
     * Save capabilities to config file
     */
    async saveCapabilities(configPath) {
        const configFile = path.join(configPath, 'ffmpeg-capabilities.json');
        
        console.log('Saving FFmpeg capabilities to:', configFile);
        console.log('FFmpeg path:', this.ffmpegPath);
        console.log('Capabilities:', JSON.stringify(this.capabilities, null, 2));
        
        const config = {
            ffmpegPath: this.ffmpegPath,
            capabilities: this.capabilities,
            detectedAt: new Date().toISOString()
        };

        try {
            await fs.writeFile(configFile, JSON.stringify(config, null, 2));
            console.log('Successfully saved FFmpeg capabilities');
            
            // Verify file was written
            const stats = await fs.stat(configFile);
            console.log('File size:', stats.size, 'bytes');
        } catch (error) {
            console.error('Failed to save FFmpeg capabilities:', error);
            throw error;
        }
        
        return config;
    }

    /**
     * Load capabilities from config file
     */
    async loadCapabilities(configPath) {
        const configFile = path.join(configPath, 'ffmpeg-capabilities.json');
        
        try {
            const data = await fs.readFile(configFile, 'utf8');
            const config = JSON.parse(data);
            
            this.ffmpegPath = config.ffmpegPath;
            this.capabilities = config.capabilities;
            
            return config;
        } catch (e) {
            return null;
        }
    }
}

module.exports = FFmpegDetector;