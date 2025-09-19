/**
 * Web Audio Manager
 * Handles multi-track audio playback using Web Audio API
 * Synchronizes with video element playback
 */

class WebAudioManager {
    constructor() {
        this.audioContext = null;
        this.tracks = new Map(); // trackId -> track object
        this.masterGainNode = null;
        this.isPlaying = false;
        this.videoElement = null;
        this.startTime = 0;
        this.pauseTime = 0;
        this.syncInterval = null; // Interval for sync monitoring
        this.syncOffset = 0; // Manual sync offset in seconds (positive = delay audio, negative = advance audio)
    }

    /**
     * Initialize the Web Audio context
     */
    async initialize(videoElement) {
        try {
            console.log('[WebAudioManager] Initializing...');

            // Create audio context
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // Create master gain node
            this.masterGainNode = this.audioContext.createGain();
            this.masterGainNode.connect(this.audioContext.destination);

            // Store video element reference
            this.videoElement = videoElement;

            // Setup video sync listeners
            this.setupVideoSync();

            console.log('[WebAudioManager] Initialized successfully');
            return true;
        } catch (error) {
            console.error('[WebAudioManager] Failed to initialize:', error);
            return false;
        }
    }

    /**
     * Decode audio in chunks to avoid blocking the main thread
     */
    async decodeInChunks(arrayBuffer, trackId, label, onProgress) {
        console.log(`[WebAudioManager] Starting chunked decode for ${trackId}`);

        const startTime = performance.now();
        let audioBuffer;

        try {
            // Report initial progress
            if (onProgress) {
                onProgress(`Decoding ${label}...`, 0.1);
            }

            // Yield to UI before decode
            await new Promise(resolve => setTimeout(resolve, 10));

            // Clone buffer to avoid issues
            const bufferCopy = arrayBuffer.slice(0);

            // Decode with progress simulation
            const decodePromise = this.audioContext.decodeAudioData(bufferCopy);

            // Simulate progress updates while decoding
            let progress = 0.1;
            const progressInterval = setInterval(() => {
                progress = Math.min(progress + 0.1, 0.9);
                if (onProgress) {
                    onProgress(`Decoding ${label}...`, progress);
                }
            }, 500);

            // Wait for decode to complete
            audioBuffer = await decodePromise;

            // Clear progress interval
            clearInterval(progressInterval);

            // Report completion
            if (onProgress) {
                onProgress(`Completed ${label}`, 1);
            }

            const decodeTime = performance.now() - startTime;
            console.log(`[WebAudioManager] Chunked decode completed in ${decodeTime.toFixed(0)}ms`);

            return audioBuffer;

        } catch (error) {
            console.error(`[WebAudioManager] Chunked decode failed:`, error);
            throw error;
        }
    }

    /**
     * Decode audio using Web Worker for validation and progress
     */
    async decodeWithWorker(arrayBuffer, trackId, label, onProgress) {
        return new Promise((resolve, reject) => {
            console.log(`[WebAudioManager] Starting worker-assisted decode for ${trackId}`);

            // Create worker
            const worker = new Worker('./lib/audio-decoder.worker.js');
            let timeout = null;

            // Set up timeout (60 seconds for decode)
            timeout = setTimeout(() => {
                console.error(`[WebAudioManager] Worker decode timeout for ${trackId}`);
                worker.terminate();
                reject(new Error('Audio decode timeout - file may be too large'));
            }, 60000);

            worker.onmessage = async (e) => {
                const { type, id } = e.data;

                if (type === 'progress') {
                    // Report progress
                    if (onProgress) {
                        onProgress(e.data.message, e.data.progress);
                    }
                    console.log(`[WebAudioManager] Worker progress: ${e.data.message}`);
                } else if (type === 'needsDecode') {
                    // Worker validated the file, now decode on main thread with chunking
                    clearTimeout(timeout);
                    worker.terminate();

                    try {
                        console.log(`[WebAudioManager] Worker validation complete, decoding on main thread...`);

                        // Use the returned arrayBuffer for decoding
                        const audioBuffer = await this.decodeInChunks(e.data.arrayBuffer, trackId, e.data.trackLabel, onProgress);

                        resolve(audioBuffer);
                    } catch (error) {
                        console.error(`[WebAudioManager] Main thread decode failed:`, error);
                        reject(error);
                    }
                } else if (type === 'error') {
                    clearTimeout(timeout);
                    console.error(`[WebAudioManager] Worker error:`, e.data.error);
                    worker.terminate();
                    reject(new Error(e.data.error));
                }
            };

            worker.onerror = (error) => {
                clearTimeout(timeout);
                console.error(`[WebAudioManager] Worker error:`, error);
                worker.terminate();
                reject(new Error(`Worker error: ${error.message || error}`));
            };

            // Send arrayBuffer to worker with transfer
            // This transfers ownership to the worker, making it unavailable in main thread
            worker.postMessage({
                arrayBuffer,
                id: trackId,
                trackLabel: label
            }, [arrayBuffer]);
        });
    }

    /**
     * Load an audio track from file path
     */
    async loadTrack(trackId, filePath, label, onProgress) {
        if (!this.audioContext) {
            console.error('[WebAudioManager] Audio context not initialized');
            return false;
        }

        try {
            console.log(`[WebAudioManager] Loading track ${trackId}: ${label}`);
            console.log(`[WebAudioManager] Original file path: ${filePath}`);

            // Yield to allow renderer to breathe before starting
            await new Promise(resolve => setTimeout(resolve, 10));

            let arrayBuffer;

            // Check file extension - MKA files might need special handling
            const fileExt = filePath.toLowerCase().split('.').pop();

            if (fileExt === 'mka' && arrayBuffer === undefined) {
                console.warn(`[WebAudioManager] MKA files can be large and cause decoder blocking. Consider using smaller audio formats.`);
            }

            // Use fetch to load files - this was working before OAuth changes
            const fileUrl = `file:///${filePath.replace(/\\/g, '/')}`;
            console.log(`[WebAudioManager] Loading file via fetch: ${fileUrl}`);

            const response = await fetch(fileUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch audio file: ${response.status}`);
            }

            arrayBuffer = await response.arrayBuffer();
            console.log(`[WebAudioManager] Successfully loaded audio file via fetch, size: ${arrayBuffer.byteLength} bytes`);

            // For very large files, warn about potential blocking
            if (arrayBuffer.byteLength > 50 * 1024 * 1024) { // > 50MB
                console.warn(`[WebAudioManager] Large audio file (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB) - using worker decode`);
            }

            let audioBuffer;

            // Try worker-based decode first
            try {
                // Use worker for decoding to avoid blocking main thread
                audioBuffer = await this.decodeWithWorker(arrayBuffer, trackId, label, onProgress);
                console.log(`[WebAudioManager] Successfully decoded with worker`);
            } catch (workerError) {
                // Log detailed error information for debugging
                console.error(`[WebAudioManager] Worker decode failed for track ${trackId}:`, workerError);
                console.error(`[WebAudioManager] File details:`, {
                    path: filePath,
                    size: `${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`,
                    sizeBytes: arrayBuffer.byteLength,
                    label: label,
                    trackId: trackId,
                    errorType: workerError.name,
                    errorMessage: workerError.message,
                    errorStack: workerError.stack
                });

                // Don't attempt fallback that would freeze the UI
                // Instead, return a clear error state that the application can handle
                const errorMessage = workerError.message || 'Unknown error';
                const fileSizeMB = (arrayBuffer.byteLength / 1024 / 1024).toFixed(1);

                // Provide specific guidance based on the error
                if (errorMessage.includes('timeout')) {
                    throw new Error(`Audio decode timed out after 60 seconds. File size: ${fileSizeMB}MB. The file may be corrupted or use an unsupported codec. Check logs/audio-track-manager-latest.log for details.`);
                } else if (errorMessage.includes('Worker error')) {
                    throw new Error(`Failed to initialize audio processor. Please reload the application. If the problem persists, check the browser console (F12) for details.`);
                } else if (errorMessage.includes('Unable to decode')) {
                    throw new Error(`Audio format not supported or file corrupted. File: ${label} (${fileSizeMB}MB). Supported formats: WAV, MP3, AAC. Check logs/audio-track-manager-latest.log for technical details.`);
                } else {
                    throw new Error(`Unable to decode audio track "${label}" (${fileSizeMB}MB). Error: ${errorMessage}. Full details available in logs/audio-track-manager-latest.log`);
                }
            }

            console.log(`[WebAudioManager] Track ${trackId} decoded - Duration: ${audioBuffer.duration.toFixed(3)}s, Sample rate: ${audioBuffer.sampleRate}Hz, Channels: ${audioBuffer.numberOfChannels}`);

            // Create track object
            const track = {
                id: trackId,
                label: label,
                buffer: audioBuffer,
                source: null,
                gainNode: this.audioContext.createGain(),
                volume: 50, // Start at 50% volume to prevent loud playback
                muted: false,
                solo: false
            };

            // Set initial gain to 50%
            track.gainNode.gain.setValueAtTime(0.5, this.audioContext.currentTime);

            // Connect gain node to master
            track.gainNode.connect(this.masterGainNode);

            // Store track
            this.tracks.set(trackId, track);

            console.log(`[WebAudioManager] Track ${trackId} loaded successfully`);
            return true;
        } catch (error) {
            console.error(`[WebAudioManager] Failed to load track ${trackId}:`, error);
            return false;
        }
    }

    /**
     * Setup synchronization with video element
     */
    setupVideoSync() {
        if (!this.videoElement) return;

        // Debounce timer for seeking
        let seekTimer = null;
        let syncCheckInterval = null;

        // Listen for play event - wait for video to actually start
        this.videoElement.addEventListener('play', () => {
            console.log('[WebAudioManager] Video play event received, waiting for actual playback...');

            // Wait for video to actually start moving
            let lastTime = this.videoElement.currentTime;
            let checkCount = 0;

            const waitForVideoStart = setInterval(() => {
                const currentTime = this.videoElement.currentTime;
                checkCount++;

                // Video has started if time has advanced
                if (currentTime > lastTime) {
                    clearInterval(waitForVideoStart);
                    console.log(`[WebAudioManager] Video actually started at ${currentTime.toFixed(3)}s after ${checkCount} checks`);
                    this.play();

                    // Start continuous sync monitoring
                    this.startSyncMonitoring();
                } else if (checkCount > 50) { // Timeout after ~500ms
                    clearInterval(waitForVideoStart);
                    console.log('[WebAudioManager] Video start timeout, starting audio anyway');
                    this.play();
                }

                lastTime = currentTime;
            }, 10); // Check every 10ms
        });

        // Listen for pause event
        this.videoElement.addEventListener('pause', () => {
            console.log('[WebAudioManager] Video pause event');
            // Clear any pending seek
            if (seekTimer) {
                clearTimeout(seekTimer);
                seekTimer = null;
            }
            // Stop sync monitoring
            this.stopSyncMonitoring();
            this.pause();
        });

        // Listen for seeking event (start of seek)
        this.videoElement.addEventListener('seeking', () => {
            console.log('[WebAudioManager] Video seeking...');
            // Stop audio immediately when seeking starts
            if (this.isPlaying) {
                this.tracks.forEach(track => {
                    if (track.source) {
                        try {
                            track.source.stop(0);
                        } catch (e) {}
                        track.source.disconnect();
                        track.source = null;
                    }
                });
                this.isPlaying = false;
            }
        });

        // Listen for seeked event (end of seek)
        this.videoElement.addEventListener('seeked', () => {
            console.log('[WebAudioManager] Video seeked to:', this.videoElement.currentTime);
            // Debounce rapid seeks
            if (seekTimer) clearTimeout(seekTimer);
            seekTimer = setTimeout(() => {
                this.seek(this.videoElement.currentTime);
            }, 100);
        });

        // Listen for ended event
        this.videoElement.addEventListener('ended', () => {
            console.log('[WebAudioManager] Video ended');
            this.stopSyncMonitoring();
            this.stop();
        });
    }

    /**
     * Start monitoring sync and adjust video playback rate to maintain sync
     */
    startSyncMonitoring() {
        if (this.syncInterval) return;

        console.log('[WebAudioManager] Starting sync monitoring...');

        // Record initial relationship between audio and video time
        this.syncStartAudioTime = this.audioContext.currentTime;
        this.syncStartVideoTime = this.videoElement.currentTime;

        this.syncInterval = setInterval(() => {
            if (!this.isPlaying || !this.videoElement || this.videoElement.paused) {
                return;
            }

            // Calculate how much time has passed for both audio and video
            const audioElapsed = this.audioContext.currentTime - this.syncStartAudioTime;
            const videoElapsed = this.videoElement.currentTime - this.syncStartVideoTime;

            // The drift is the difference between elapsed times
            const drift = audioElapsed - videoElapsed;

            // Log detailed timing info periodically (every 5 seconds)
            if (Math.floor(audioElapsed) % 5 === 0 && Math.floor(audioElapsed * 10) % 10 === 0) {
                const driftRate = drift / audioElapsed; // Drift per second
                console.log(`[WebAudioManager] Timing at ${audioElapsed.toFixed(0)}s: Audio: ${audioElapsed.toFixed(3)}s, Video: ${videoElapsed.toFixed(3)}s, Drift: ${(drift * 1000).toFixed(0)}ms (${(driftRate * 1000).toFixed(1)}ms/s)`);

                // Check audio buffer vs video duration
                if (this.videoElement.duration && this.tracks.size > 0) {
                    const firstTrack = this.tracks.values().next().value;
                    if (firstTrack && firstTrack.buffer) {
                        console.log(`[WebAudioManager] Video duration: ${this.videoElement.duration.toFixed(3)}s, Audio buffer duration: ${firstTrack.buffer.duration.toFixed(3)}s`);
                    }
                }
            }

            // Small drift is acceptable
            if (Math.abs(drift) < 0.05) { // Within 50ms is good
                // Reset playback rate to normal
                if (this.videoElement.playbackRate !== 1.0) {
                    this.videoElement.playbackRate = 1.0;
                }
                return;
            }

            // Adjust video playback rate more aggressively
            if (drift > 0) {
                // Audio is ahead, speed up video
                const rate = Math.min(1.5, 1.0 + Math.min(drift * 2, 0.5)); // Up to 50% speed increase
                this.videoElement.playbackRate = rate;
                if (Math.abs(drift) > 0.1) { // Only log significant drifts
                    console.log(`[WebAudioManager] Audio ahead by ${(drift * 1000).toFixed(0)}ms, video rate: ${rate.toFixed(2)}`);
                }
            } else {
                // Video is ahead, slow down video
                const rate = Math.max(0.5, 1.0 + Math.max(drift * 2, -0.5)); // Up to 50% speed decrease
                this.videoElement.playbackRate = rate;
                if (Math.abs(drift) > 0.1) {
                    console.log(`[WebAudioManager] Video ahead by ${(-drift * 1000).toFixed(0)}ms, video rate: ${rate.toFixed(2)}`);
                }
            }

            // If drift is too large, do a hard resync
            if (Math.abs(drift) > 1.0) { // More than 1 second off
                console.log(`[WebAudioManager] Large drift detected (${(drift * 1000).toFixed(0)}ms), performing hard resync...`);
                this.videoElement.playbackRate = 1.0;
                // Stop and restart audio at current video position
                this.pause();
                setTimeout(() => {
                    if (!this.videoElement.paused) {
                        this.play();
                        this.startSyncMonitoring();
                    }
                }, 50);
            }
        }, 100); // Check every 100ms
    }

    /**
     * Stop monitoring sync
     */
    stopSyncMonitoring() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
            // Reset playback rate
            if (this.videoElement) {
                this.videoElement.playbackRate = 1.0;
            }
            console.log('[WebAudioManager] Stopped sync monitoring');
        }
    }

    /**
     * Start playback of all tracks
     */
    async play() {
        if (this.isPlaying || this.tracks.size === 0) return;

        try {
            const currentTime = this.videoElement ? this.videoElement.currentTime : 0;

            // Resume audio context if suspended
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            // Get precise timing
            const now = this.audioContext.currentTime;

            console.log(`[WebAudioManager] Starting audio playback - Video time: ${currentTime.toFixed(3)}s, Audio context time: ${now.toFixed(3)}s`);

            // Start all tracks synchronized to current video position
            this.tracks.forEach(track => {
                // Create new source
                track.source = this.audioContext.createBufferSource();
                track.source.buffer = track.buffer;

                // Set volume with smooth ramp to prevent crackling
                const targetGain = track.muted ? 0 : (track.volume / 100);
                track.gainNode.gain.setValueAtTime(0, now);
                track.gainNode.gain.linearRampToValueAtTime(targetGain, now + 0.02);

                track.source.connect(track.gainNode);

                // Start audio at exact video position with sync offset applied
                // Use when parameter to schedule precisely
                const when = now + 0.01; // Tiny delay to ensure everything is ready
                // Apply sync offset: positive offset delays audio (start earlier in buffer)
                const offsetTime = Math.max(0, currentTime + this.syncOffset);
                track.source.start(when, offsetTime);

                console.log(`[WebAudioManager] Track ${track.id} scheduled to start at context time ${when.toFixed(3)}s, from position ${offsetTime.toFixed(3)}s (sync offset: ${(this.syncOffset * 1000).toFixed(0)}ms)`);
            });

            this.isPlaying = true;
            this.startTime = now - currentTime;

            console.log(`[WebAudioManager] Playback initiated - startTime set to ${this.startTime.toFixed(3)}s`);
        } catch (error) {
            console.error('[WebAudioManager] Failed to start playback:', error);
        }
    }

    /**
     * Pause playback of all tracks
     */
    pause() {
        if (!this.isPlaying) return;

        try {
            // Stop all tracks
            this.tracks.forEach(track => {
                if (track.source) {
                    track.source.stop();
                    track.source.disconnect();
                    track.source = null;
                }
            });

            this.isPlaying = false;
            this.pauseTime = this.audioContext.currentTime - this.startTime;

            console.log('[WebAudioManager] Playback paused');
        } catch (error) {
            console.error('[WebAudioManager] Failed to pause playback:', error);
        }
    }

    /**
     * Stop playback of all tracks
     */
    stop() {
        this.pause();
        this.startTime = 0;
        this.pauseTime = 0;
        console.log('[WebAudioManager] Playback stopped');
    }

    /**
     * Seek to specific time
     */
    async seek(time) {
        const wasPlaying = this.isPlaying;

        // Stop current playback immediately
        if (this.isPlaying) {
            // Stop all tracks without delay
            this.tracks.forEach(track => {
                if (track.source) {
                    try {
                        track.source.stop(0);
                    } catch (e) {
                        // Source may already be stopped
                    }
                    track.source.disconnect();
                    track.source = null;
                }
            });
            this.isPlaying = false;
        }

        // Update pause time
        this.pauseTime = time;

        // Wait a bit for video to stabilize
        await new Promise(resolve => setTimeout(resolve, 50));

        // Resume if was playing
        if (wasPlaying && this.videoElement && !this.videoElement.paused) {
            await this.play();
        }
    }

    /**
     * Set volume for a track (0-100)
     */
    setTrackVolume(trackId, volume) {
        const track = this.tracks.get(trackId);
        if (!track) return;

        track.volume = volume;
        track.gainNode.gain.value = track.muted ? 0 : volume / 100;

        console.log(`[WebAudioManager] Track ${trackId} volume set to ${volume}`);
    }

    /**
     * Mute/unmute a track
     */
    setTrackMute(trackId, muted) {
        const track = this.tracks.get(trackId);
        if (!track) return;

        track.muted = muted;
        track.gainNode.gain.value = muted ? 0 : track.volume / 100;

        console.log(`[WebAudioManager] Track ${trackId} ${muted ? 'muted' : 'unmuted'}`);
    }

    /**
     * Set the manual sync offset
     * @param {number} offsetMs - Offset in milliseconds (positive = delay audio, negative = advance audio)
     */
    setSyncOffset(offsetMs) {
        this.syncOffset = offsetMs / 1000; // Convert to seconds
        console.log(`[WebAudioManager] Sync offset set to ${offsetMs}ms`);

        // If playing, restart playback with new offset
        if (this.isPlaying && this.videoElement) {
            const currentTime = this.videoElement.currentTime;
            const wasPlaying = !this.videoElement.paused;

            // Stop current playback
            this.pause();

            // Restart if was playing
            if (wasPlaying) {
                setTimeout(() => {
                    this.play();
                }, 50);
            }
        }
    }

    /**
     * Get the current sync offset in milliseconds
     */
    getSyncOffset() {
        return this.syncOffset * 1000;
    }

    /**
     * Solo/unsolo a track
     */
    setTrackSolo(trackId, solo) {
        const track = this.tracks.get(trackId);
        if (!track) return;

        track.solo = solo;

        // Update all track gains based on solo status
        const hasSoloTracks = Array.from(this.tracks.values()).some(t => t.solo);

        this.tracks.forEach(t => {
            if (hasSoloTracks) {
                // If any track is soloed, only play soloed tracks
                t.gainNode.gain.value = (t.solo && !t.muted) ? t.volume / 100 : 0;
            } else {
                // No soloed tracks, play all unmuted tracks
                t.gainNode.gain.value = t.muted ? 0 : t.volume / 100;
            }
        });

        console.log(`[WebAudioManager] Track ${trackId} solo ${solo ? 'enabled' : 'disabled'}`);
    }

    /**
     * Clean up resources
     */
    dispose() {
        // Stop playback
        this.stop();

        // Disconnect all nodes
        this.tracks.forEach(track => {
            track.gainNode.disconnect();
        });

        if (this.masterGainNode) {
            this.masterGainNode.disconnect();
        }

        // Clear tracks
        this.tracks.clear();

        // Close audio context
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        console.log('[WebAudioManager] Disposed');
    }
}

// Export for use in renderer process
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WebAudioManager;
}