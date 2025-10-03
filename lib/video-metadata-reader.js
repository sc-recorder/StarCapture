const { exec } = require('child_process');
const path = require('path');

class VideoMetadataReader {

    constructor(ffmpegPath = null) {
        this.ffmpegPath = ffmpegPath || 'ffmpeg'; // Default to system ffmpeg
    }

    /**
     * Detect video framerate from metadata
     */
    async detectVideoFramerate(videoPath) {
        try {
            if (!videoPath || !videoPath.trim()) {
                console.warn('No video path provided, using default FPS');
                return 30;
            }

            // Check if file exists
            const fs = require('fs').promises;
            try {
                await fs.access(videoPath);
            } catch (error) {
                console.warn(`Video file not accessible: ${videoPath}, using default FPS`);
                return 30;
            }

            console.log(`Detecting framerate for: ${path.basename(videoPath)}`);

            // Try to get FPS via FFprobe / FFmpeg
            const fps = await this.getFramerateViaFFmpeg(videoPath);
            if (fps && fps > 0) {
                const normalized = this.normalizeFramerate(fps);
                console.log(`Detected framerate: ${fps} fps -> ${normalized} fps`);
                return normalized;
            }

            console.warn('Could not detect FPS via FFmpeg, using default');
            return 30;

        } catch (error) {
            console.error('Error detecting video framerate:', error);
            return 30; // Safe fallback
        }
    }

    /**
     * Get framerate using FFmpeg/ffprobe
     */
    async getFramerateViaFFmpeg(videoPath) {
        return new Promise((resolve, reject) => {
            const ffprobeCmd = `"${this.ffmpegPath}" -i "${videoPath}" -select_streams v:0 -show_entries stream=r_frame_rate,avg_frame_rate -v quiet -of csv=p=0`;

            exec(ffprobeCmd, { timeout: 10000 }, (error, stdout, stderr) => { // 10 second timeout
                if (error) {
                    console.warn('FFmpeg framerate detection failed:', error.message);
                    resolve(null);
                    return;
                }

                try {
                    const lines = stdout.trim().split('\n').filter(line => line.trim());
                    if (lines.length === 0) {
                        resolve(null);
                        return;
                    }

                    // First line is r_frame_rate, second might be avg_frame_rate
                    const rFrameRateLine = lines[0].trim();

                    // r_frame_rate format: "30/1" or "60000/1001" for 59.94fps
                    if (rFrameRateLine && rFrameRateLine.includes('/')) {
                        const [num, den] = rFrameRateLine.split('/').map(Number);
                        if (num && den && den !== 0) {
                            const fps = num / den;
                            if (fps > 0 && fps < 1000) { // Sanity check
                                resolve(fps);
                                return;
                            }
                        }
                    }

                    // Try avg_frame_rate if r_frame_rate didn't work
                    if (lines.length > 1) {
                        const avgFrameRateLine = lines[1].trim();
                        if (avgFrameRateLine && avgFrameRateLine.includes('/')) {
                            const [num, den] = avgFrameRateLine.split('/').map(Number);
                            if (num && den && den !== 0) {
                                const fps = num / den;
                                if (fps > 0 && fps < 1000) {
                                    resolve(fps);
                                    return;
                                }
                            }
                        }
                    }

                    resolve(null);

                } catch (parseError) {
                    console.error('Error parsing FFmpeg output:', parseError);
                    resolve(null);
                }
            });
        });
    }

    /**
     * Normalize detected framerate to standard values
     */
    normalizeFramerate(fps) {
        if (!fps || fps <= 0) return 30;

        // Common frame rates to round to
        const standardRates = [24, 25, 30, 50, 60];

        // Find closest standard rate
        let closest = standardRates[0];
        let minDiff = Math.abs(fps - closest);

        for (const rate of standardRates) {
            const diff = Math.abs(fps - rate);
            if (diff < minDiff) {
                minDiff = diff;
                closest = rate;
            }
        }

        // If detected FPS is very close to standard rate (< 2fps difference), use standard
        if (minDiff < 2) {
            return closest;
        }

        // Otherwise return original (for variable frame rates or unusual rates)
        return Math.round(fps);
    }

    /**
     * Get basic video metadata (alternative method)
     */
    async getVideoMetadata(videoPath) {
        return new Promise((resolve, reject) => {
            const ffprobeCmd = `"${this.ffmpegPath}" -i "${videoPath}" -v quiet -print_format json -show_format -show_streams`;

            exec(ffprobeCmd, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }

                try {
                    const metadata = JSON.parse(stdout);
                    const videoStream = metadata.streams.find(s => s.codec_type === 'video');

                    if (videoStream) {
                        resolve({
                            duration: parseFloat(videoStream.duration || 0),
                            width: parseInt(videoStream.width || 0),
                            height: parseInt(videoStream.height || 0),
                            framerate: this.extractFramerateFromStream(videoStream)
                        });
                    } else {
                        reject(new Error('No video stream found'));
                    }
                } catch (parseError) {
                    reject(parseError);
                }
            });
        });
    }

    /**
     * Extract framerate from video stream info
     */
    extractFramerateFromStream(videoStream) {
        // Try r_frame_rate first
        if (videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
            if (num && den && den !== 0) {
                return num / den;
            }
        }

        // Fallback to avg_frame_rate
        if (videoStream.avg_frame_rate) {
            const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
            if (num && den && den !== 0) {
                return num / den;
            }
        }

        return null;
    }

    /**
     * Set custom ffmpeg path
     */
    setFFmpegPath(ffmpegPath) {
        this.ffmpegPath = ffmpegPath;
    }
}

module.exports = VideoMetadataReader;
