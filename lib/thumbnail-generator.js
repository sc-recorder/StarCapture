/**
 * Thumbnail Generator Module
 * Generates thumbnails for video events at specified timestamps
 * Supports both small thumbnails for timeline and full-res main thumbnail
 */

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const FFmpegDetector = require('./ffmpeg-detector');

class ThumbnailGenerator {
    constructor() {
        this.ffmpegPath = null;
        this.ffprobePath = null;
        this.outputQuality = 75; // Lower quality for smaller files
        this.mainOutputQuality = 90; // Higher quality for main thumbnail
        this.thumbnailHeight = 180; // Fixed height for all thumbnails
        this.maxAspectRatio = 2.39; // Maximum 21:9 (anything wider gets cropped)
        this.cropMode = 'center'; // 'center' | 'smart'
        this.initialized = false;
    }

    /**
     * Initialize FFmpeg paths using existing detector
     */
    async initialize() {
        if (this.initialized) return;

        try {
            // Use existing FFmpegDetector to get paths
            const detector = new FFmpegDetector();

            // Try to load existing capabilities first
            const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
            const configPath = path.join(localAppData, 'sc-recorder');
            await detector.loadCapabilities(configPath);

            if (!detector.ffmpegPath) {
                // Fall back to default paths if not loaded
                const resourcesPath = path.join(localAppData, 'sc-recorder', 'resources');
                detector.ffmpegPath = path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe');
            }

            this.ffmpegPath = detector.ffmpegPath;
            this.ffprobePath = detector.ffmpegPath.replace('ffmpeg.exe', 'ffprobe.exe');

            // Set paths for fluent-ffmpeg
            ffmpeg.setFfmpegPath(this.ffmpegPath);
            ffmpeg.setFfprobePath(this.ffprobePath);

            this.initialized = true;
            console.log('[ThumbnailGenerator] Initialized with FFmpeg:', this.ffmpegPath);
        } catch (error) {
            console.error('[ThumbnailGenerator] Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * Generate thumbnails from video for all events
     */
    async generateFromVideo(videoPath, events, outputFolder, options = {}) {
        await this.initialize();

        // Get video info first to detect aspect ratio
        const videoInfo = await this.getVideoInfo(videoPath);
        const aspectRatio = videoInfo.width / videoInfo.height;

        console.log(`[ThumbnailGenerator] Video info: ${videoInfo.width}x${videoInfo.height}, AR: ${aspectRatio.toFixed(2)}`);

        // Create output folder if it doesn't exist
        await fs.mkdir(outputFolder, { recursive: true });

        // Extract frames at event timestamps with proper scaling
        const thumbnails = [];
        const validEvents = events.filter(e =>
            e.videoOffset !== undefined && e.videoOffset !== null && e.videoOffset >= 0
        );

        console.log(`[ThumbnailGenerator] Processing ${validEvents.length} events with valid timestamps`);

        for (let i = 0; i < validEvents.length; i++) {
            const event = validEvents[i];
            const thumbnailPath = path.join(outputFolder, `${event.id}.jpg`);

            try {
                await this.extractFrame(
                    videoPath,
                    event.videoOffset,
                    thumbnailPath,
                    videoInfo
                );

                thumbnails.push({
                    eventId: event.id,
                    path: thumbnailPath,
                    success: true
                });

                // Report progress
                if (options.onProgress) {
                    options.onProgress({
                        current: i + 1,
                        total: validEvents.length,
                        eventName: event.name || event.type
                    });
                }
            } catch (error) {
                console.error(`[ThumbnailGenerator] Failed to generate thumbnail for event ${event.id}:`, error);
                thumbnails.push({
                    eventId: event.id,
                    path: null,
                    success: false,
                    error: error.message
                });
            }
        }

        // Handle main thumbnail selection
        let mainThumbnailPath = null;
        const mainEventId = options.mainEventId || this.selectRandomEvent(validEvents);

        if (mainEventId) {
            const parsed = path.parse(videoPath);
            mainThumbnailPath = path.join(parsed.dir, `${parsed.name}_main_thumb.jpg`);

            try {
                await this.generateMainThumbnail(videoPath, validEvents, mainEventId);
                console.log(`[ThumbnailGenerator] Generated main thumbnail for event ${mainEventId}`);
            } catch (error) {
                console.error('[ThumbnailGenerator] Failed to generate main thumbnail:', error);
                mainThumbnailPath = null;
            }
        }

        return {
            success: true,
            thumbnails: thumbnails,
            mainThumbnail: mainThumbnailPath ? path.basename(mainThumbnailPath) : null,
            count: thumbnails.filter(t => t.success).length,
            total: validEvents.length
        };
    }

    /**
     * Generate full resolution main thumbnail
     */
    async generateMainThumbnail(videoPath, events, eventId) {
        const event = events.find(e => e.id === eventId);
        if (!event) {
            console.error(`[ThumbnailGenerator] Event ${eventId} not found for main thumbnail`);
            return null;
        }

        const videoInfo = await this.getVideoInfo(videoPath);
        const parsed = path.parse(videoPath);
        const mainThumbPath = path.join(parsed.dir, `${parsed.name}_main_thumb.jpg`);

        // Extract at full resolution with high quality
        await this.extractFrameFullRes(
            videoPath,
            event.videoOffset || 0,
            mainThumbPath,
            videoInfo,
            this.mainOutputQuality
        );

        return mainThumbPath;
    }

    /**
     * Select random event for main thumbnail
     */
    selectRandomEvent(events) {
        // Filter events with valid timestamps
        const validEvents = events.filter(e =>
            e.videoOffset !== undefined && e.videoOffset !== null && e.videoOffset >= 0
        );

        if (validEvents.length === 0) return null;

        // Select random event
        const randomIndex = Math.floor(Math.random() * validEvents.length);
        return validEvents[randomIndex].id;
    }

    /**
     * Extract frame at full resolution for main thumbnail
     */
    async extractFrameFullRes(videoPath, timestamp, outputPath, videoInfo, quality = 90) {
        return new Promise((resolve, reject) => {
            console.log(`[ThumbnailGenerator] Extracting full-res frame at ${timestamp}s to ${outputPath}`);

            ffmpeg(videoPath)
                .seekInput(timestamp) // Seek to timestamp (fast seek before input)
                .frames(1) // Extract single frame
                .outputOptions([
                    '-q:v', Math.round((100 - quality) / 33).toString() // JPEG quality (0-2, 0 is best)
                ])
                .on('end', () => {
                    console.log(`[ThumbnailGenerator] Full-res thumbnail saved: ${outputPath}`);
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error(`[ThumbnailGenerator] Full-res extraction failed:`, err);
                    reject(new Error(`Thumbnail extraction failed: ${err.message}`));
                })
                .save(outputPath);
        });
    }

    /**
     * Extract frame with scaling for timeline thumbnails
     */
    async extractFrame(videoPath, timestamp, outputPath, videoInfo) {
        // Build FFmpeg scaling filter based on aspect ratio
        const scaleFilter = this.buildScaleFilter(videoInfo);

        return new Promise((resolve, reject) => {
            console.log(`[ThumbnailGenerator] Extracting frame at ${timestamp}s with filter: ${scaleFilter}`);

            ffmpeg(videoPath)
                .seekInput(timestamp) // Seek to timestamp (fast seek before input)
                .frames(1) // Extract single frame
                .videoFilters(scaleFilter) // Apply crop/scale filter
                .outputOptions([
                    '-q:v', Math.round((100 - this.outputQuality) / 33).toString() // JPEG quality
                ])
                .on('end', () => {
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error(`[ThumbnailGenerator] Frame extraction failed at ${timestamp}s:`, err);
                    reject(new Error(`Thumbnail extraction failed: ${err.message}`));
                })
                .save(outputPath);
        });
    }

    /**
     * Build scaling filter for thumbnails
     */
    buildScaleFilter(videoInfo) {
        const aspectRatio = videoInfo.width / videoInfo.height;
        const targetHeight = this.thumbnailHeight;

        // If video is wider than max aspect ratio (21:9), crop it first
        if (aspectRatio > this.maxAspectRatio) {
            // Calculate crop width to achieve max aspect ratio
            const cropWidth = Math.round(videoInfo.height * this.maxAspectRatio);
            const cropX = Math.round((videoInfo.width - cropWidth) / 2); // Center crop

            // For 32:9 -> crop to 21:9 from center, preserving middle 67% of width
            // Then scale to target height maintaining the 21:9 aspect
            const targetWidth = Math.round(targetHeight * this.maxAspectRatio); // ~430px for 180px height

            return `crop=${cropWidth}:${videoInfo.height}:${cropX}:0,scale=${targetWidth}:${targetHeight}`;
        } else {
            // For content already at or below 21:9, just scale to target height
            const targetWidth = Math.round(targetHeight * aspectRatio);

            // This will produce variable width thumbnails but consistent height
            // 16:9 content = 320×180
            // 21:9 content = 430×180
            // 16:10 content = 288×180
            return `scale=${targetWidth}:${targetHeight}`;
        }
    }

    /**
     * Get video information using ffprobe
     */
    async getVideoInfo(videoPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) {
                    reject(new Error(`Failed to probe video: ${err.message}`));
                    return;
                }

                // Find video stream
                const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                if (!videoStream) {
                    reject(new Error('No video stream found'));
                    return;
                }

                resolve({
                    width: videoStream.width,
                    height: videoStream.height,
                    duration: metadata.format.duration,
                    fps: eval(videoStream.r_frame_rate) // e.g., "30/1" -> 30
                });
            });
        });
    }

    /**
     * Check if thumbnails exist for a video
     */
    async checkThumbnails(videoPath) {
        const parsed = path.parse(videoPath);
        const thumbnailFolder = path.join(parsed.dir, `${parsed.name}_thumbs`);
        const mainThumbPath = path.join(parsed.dir, `${parsed.name}_main_thumb.jpg`);

        let thumbnailCount = 0;
        let folderExists = false;
        let mainThumbExists = false;

        try {
            await fs.access(thumbnailFolder);
            folderExists = true;

            const files = await fs.readdir(thumbnailFolder);
            thumbnailCount = files.filter(f => f.endsWith('.jpg')).length;
        } catch (e) {
            // Folder doesn't exist
        }

        try {
            await fs.access(mainThumbPath);
            mainThumbExists = true;
        } catch (e) {
            // Main thumbnail doesn't exist
        }

        return {
            exists: folderExists || mainThumbExists,
            folderExists: folderExists,
            mainThumbExists: mainThumbExists,
            count: thumbnailCount,
            path: thumbnailFolder,
            mainThumbPath: mainThumbExists ? mainThumbPath : null
        };
    }
}

module.exports = ThumbnailGenerator;