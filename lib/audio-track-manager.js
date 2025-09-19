/**
 * Audio Track Manager
 * Handles multi-track audio extraction, detection, and management for video editing
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const Logger = require('./logger');

class AudioTrackManager {
    constructor() {
        this.tempRoot = path.join(os.tmpdir(), 'sc-recorder-audio');
        this.sessionPath = null;
        this.currentVideoHash = null;
        this.extractedTracks = [];
        this.ffmpegPath = null;
        this.ffprobePath = null;
        this.logger = new Logger('audio-track-manager');
    }

    /**
     * Initialize the manager and create session folder
     */
    async initialize(ffmpegPath, ffprobePath) {
        this.ffmpegPath = ffmpegPath || 'ffmpeg';
        this.ffprobePath = ffprobePath || 'ffprobe';

        // Clean any existing temp folders
        await this.cleanupTempRoot();

        // Create new session folder
        const sessionId = Date.now();
        this.sessionPath = path.join(this.tempRoot, `session-${sessionId}`);
        await fs.mkdir(this.sessionPath, { recursive: true });

        console.log('AudioTrackManager initialized with session:', this.sessionPath);
        this.logger.log('AudioTrackManager initialized');
        this.logger.log('Session path:', this.sessionPath);
        this.logger.log('FFmpeg path:', this.ffmpegPath);
        this.logger.log('FFprobe path:', this.ffprobePath);
        return this.sessionPath;
    }

    /**
     * Detect audio tracks in a video file
     */
    async detectAudioTracks(videoPath) {
        try {
            console.log(`[AudioTrackManager] Detecting tracks in: ${videoPath}`);
            console.log(`[AudioTrackManager] Using ffprobe: ${this.ffprobePath}`);
            this.logger.log('Detecting audio tracks in:', videoPath);

            // Use ffprobe to get stream information
            const command = `"${this.ffprobePath}" -v quiet -print_format json -show_streams -select_streams a "${videoPath}"`;
            console.log(`[AudioTrackManager] Running command: ${command}`);
            this.logger.log('Running ffprobe command:', command);

            const { stdout } = await execAsync(command);
            const data = JSON.parse(stdout);

            const audioTracks = [];

            if (data.streams) {
                data.streams.forEach((stream, index) => {
                    if (stream.codec_type === 'audio') {
                        audioTracks.push({
                            index: stream.index,
                            streamIndex: index,
                            codec: stream.codec_name,
                            channels: stream.channels,
                            sampleRate: stream.sample_rate,
                            bitrate: stream.bit_rate,
                            duration: stream.duration || data.format?.duration,
                            title: stream.tags?.title || stream.tags?.handler_name || null,
                            language: stream.tags?.language || null
                        });
                    }
                });
            }

            console.log(`Detected ${audioTracks.length} audio tracks in video`);
            this.logger.log(`Detected ${audioTracks.length} audio tracks:`, audioTracks);
            return audioTracks;
        } catch (error) {
            console.error('Failed to detect audio tracks:', error);
            this.logger.error('Failed to detect audio tracks:', error.message);
            this.logger.error('Error stack:', error.stack);
            return [];
        }
    }

    /**
     * Extract audio tracks from video to temp files
     */
    async extractAudioTracks(videoPath, progressCallback) {
        if (!this.sessionPath) {
            throw new Error('AudioTrackManager not initialized');
        }

        // Clean previous extracted tracks
        await this.cleanupExtractedTracks();

        // Detect tracks first
        const tracks = await this.detectAudioTracks(videoPath);

        if (tracks.length <= 1) {
            console.log('Video has only one audio track, no extraction needed');
            this.logger.log('Video has only one audio track, no extraction needed');
            return [];
        }

        this.logger.log(`Found ${tracks.length} audio tracks, will extract tracks 2-${tracks.length}`);

        // Generate hash for this video
        const stat = await fs.stat(videoPath);
        this.currentVideoHash = crypto.createHash('md5')
            .update(videoPath + stat.mtime.toISOString())
            .digest('hex')
            .slice(0, 8);

        const extractedTracks = [];

        // Extract tracks 2+ (skip track 1 which is the pre-mixed)
        for (let i = 1; i < tracks.length; i++) {
            const track = tracks[i];
            // Use WAV format for faster decoding in Web Audio API
            const outputFile = path.join(this.sessionPath, `${this.currentVideoHash}_track${i + 1}.wav`);

            if (progressCallback) {
                // Send simplified progress with percentage
                const progress = Math.round((i / (tracks.length - 1)) * 100);
                progressCallback({
                    current: i,
                    total: tracks.length - 1,
                    message: `Extracting audio tracks... (${progress}%)`
                });
            }

            try {
                // Extract to WAV format with PCM codec for fast Web Audio decoding
                // Use PCM 16-bit at 48kHz to match original sample rate
                const command = `"${this.ffmpegPath}" -i "${videoPath}" -map 0:a:${i} -acodec pcm_s16le -ar 48000 "${outputFile}"`;
                this.logger.log(`Extracting track ${i + 1} with command:`, command);
                await execAsync(command);

                // Determine track label based on configuration and position
                let label = track.title || this.getTrackLabel(i + 1, tracks.length);

                extractedTracks.push({
                    path: outputFile,
                    trackIndex: i + 1,
                    label: label,
                    codec: track.codec,
                    channels: track.channels,
                    duration: track.duration
                });

                // Log to file but don't spam console
                this.logger.log(`Successfully extracted track ${i + 1}: ${label} to ${outputFile}`);
            } catch (error) {
                console.error(`Failed to extract track ${i + 1}:`, error);
                this.logger.error(`Failed to extract track ${i + 1}:`, error.message);
            }
        }

        this.extractedTracks = extractedTracks;
        this.logger.log(`Extraction complete. Extracted ${extractedTracks.length} tracks.`);

        if (progressCallback) {
            progressCallback({
                current: tracks.length - 1,
                total: tracks.length - 1,
                message: 'Audio extraction complete! (100%)',
                complete: true
            });
        }

        return extractedTracks;
    }

    /**
     * Get track label based on position and total tracks
     */
    getTrackLabel(trackIndex, totalTracks) {
        // Track labeling logic based on OBS configuration
        if (trackIndex === 1) {
            return totalTracks > 1 ? 'Pre-mixed Audio' : 'Game Audio';
        } else if (trackIndex === 2) {
            return 'Game Audio';
        } else if (trackIndex === 3) {
            if (totalTracks === 3) {
                // Could be Voice Chat OR Microphone depending on config
                return 'Voice/Mic';
            } else if (totalTracks === 4) {
                return 'Voice Chat';
            }
        } else if (trackIndex === 4) {
            return 'Microphone';
        }

        return `Track ${trackIndex}`;
    }

    /**
     * Clean up extracted tracks for current video
     */
    async cleanupExtractedTracks() {
        if (!this.extractedTracks.length) return;

        for (const track of this.extractedTracks) {
            try {
                await fs.unlink(track.path);
                console.log('Cleaned up track:', track.path);
            } catch (error) {
                console.warn('Failed to delete track file:', track.path, error.message);
            }
        }

        this.extractedTracks = [];
        this.currentVideoHash = null;
    }

    /**
     * Clean up entire temp root folder
     */
    async cleanupTempRoot() {
        try {
            await fs.rm(this.tempRoot, { recursive: true, force: true });
            console.log('Cleaned up temp root:', this.tempRoot);
        } catch (error) {
            console.warn('Failed to clean temp root:', error.message);
        }
    }

    /**
     * Clean up session folder
     */
    async cleanupSession() {
        if (!this.sessionPath) return;

        try {
            await fs.rm(this.sessionPath, { recursive: true, force: true });
            console.log('Cleaned up session:', this.sessionPath);
        } catch (error) {
            console.warn('Failed to clean session:', error.message);
        }

        this.sessionPath = null;
    }

    /**
     * Get extracted track by index
     */
    getTrack(trackIndex) {
        return this.extractedTracks.find(t => t.trackIndex === trackIndex);
    }

    /**
     * Get all extracted tracks
     */
    getTracks() {
        return this.extractedTracks;
    }

    /**
     * Check if video has multiple tracks
     */
    async hasMultipleTracks(videoPath) {
        const tracks = await this.detectAudioTracks(videoPath);
        return tracks.length > 1;
    }

    /**
     * Create audio filter complex for FFmpeg export
     */
    createFilterComplex(trackConfigs, markIn, markOut) {
        const filters = [];
        const inputs = [];
        let filterIndex = 0;

        // Build filter for each track
        trackConfigs.forEach((config, index) => {
            if (!config.enabled) return;

            const input = `[${index + 1}:a]`; // Audio tracks start at index 1
            let filter = input;

            // Apply volume adjustment if needed
            if (config.volume && config.volume !== 100) {
                const volumeRatio = config.volume / 100;
                filter = `${filter}volume=${volumeRatio}[v${filterIndex}]`;
                filters.push(`${input}volume=${volumeRatio}[v${filterIndex}]`);
                filter = `[v${filterIndex}]`;
                filterIndex++;
            }

            // Apply segment trimming if needed
            if (config.segments && config.segments.length > 0) {
                const segmentFilters = [];
                config.segments.forEach((segment, segIndex) => {
                    const segFilter = `${filter}atrim=${segment.startTime}:${segment.endTime}[s${filterIndex}]`;
                    segmentFilters.push(segFilter);
                    filterIndex++;
                });
                filters.push(...segmentFilters);
            } else {
                inputs.push(filter);
            }
        });

        // Mix all enabled tracks
        if (inputs.length > 1) {
            const mixFilter = `${inputs.join('')}amix=inputs=${inputs.length}:duration=longest[out]`;
            filters.push(mixFilter);
            return {
                filterComplex: filters.join(';'),
                audioOutput: '[out]'
            };
        } else if (inputs.length === 1) {
            return {
                filterComplex: null,
                audioOutput: inputs[0]
            };
        }

        return null;
    }
}

module.exports = AudioTrackManager;