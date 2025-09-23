/**
 * Video Editor Controller
 * Handles video editing functionality including clipping and concatenation
 * Phase 2: Basic controller with video element references
 */

class VideoEditorController {
    constructor() {
        console.log('Initializing VideoEditorController...');

        // Get DOM elements
        this.videoPlayer = document.getElementById('edit-video-player');
        this.videoOverlay = document.getElementById('edit-video-overlay');
        
        // Mode elements
        this.clipModeBtn = document.getElementById('clip-mode-btn');
        this.concatModeBtn = document.getElementById('concat-mode-btn');
        
        // Button elements
        this.browseBtn = document.getElementById('edit-browse-recordings-btn');
        this.loadVideoBtn = document.getElementById('edit-load-video-btn');
        this.loadEventsBtn = document.getElementById('edit-load-events-btn');
        this.exportBtn = document.getElementById('export-video-btn');
        
        // State
        this.currentMode = 'clip';
        this.currentVideo = null;
        this.currentEvents = [];
        this.lastHighlightedEvent = -1;
        this.markIn = null;
        this.markOut = null;
        this.fps = 30; // Default to 30fps, will update when video loads
        this.generateThumbnails = false; // Checkbox state for thumbnail generation
        this.selectedMainThumbnailEventId = null; // For tracking selected main thumbnail event

        // Audio mixer state
        this.audioTracks = [];
        this.audioSegments = {};
        this.selectedSegment = null;
        this.isDragging = false;
        this.dragType = null; // 'move', 'resize-left', 'resize-right'
        this.dragStartX = 0;
        this.dragStartTime = 0;

        // Multi-track audio support
        this.audioTrackManager = null;
        this.hasMultipleTracks = false;
        this.extractedAudioTracks = [];
        this.audioElements = []; // For Web Audio API playback
        this.isMultiTrackMode = false;
        this.webAudioManager = null; // Web Audio API manager
        
        // Initialize shared video browser with error handling
        try {
            this.videoBrowser = new SharedVideoBrowser({
                modalId: 'edit-video-browser-modal',
                onVideoSelected: (video) => this.handleVideoSelected(video)
            });
        } catch (error) {
            console.error('Failed to initialize SharedVideoBrowser in video editor:', error);
            this.videoBrowser = null;
        }
        
        // Setup event listeners
        this.setupEventListeners();

        // Initialize audio mixer
        this.initializeAudioMixer();

        // Initialize audio track manager if available
        this.initializeAudioTrackManager();

        // Add cleanup handler for window unload/reload
        window.addEventListener('beforeunload', async () => {
            console.log('[VideoEditor] Window unloading, cleaning up resources...');
            // Clean up audio tracks
            if (this.extractedAudioTracks && this.extractedAudioTracks.length > 0) {
                try {
                    await ipcRenderer.invoke('cleanup-audio-tracks');
                } catch (error) {
                    console.error('Error cleaning up audio tracks:', error);
                }
            }
            // Clean up Web Audio
            if (this.webAudioManager) {
                this.webAudioManager.dispose();
                this.webAudioManager = null;
            }
        });

        console.log('VideoEditorController initialized');
    }

    /**
     * Initialize audio track manager for multi-track support
     */
    async initializeAudioTrackManager() {
        // Check for ipcRenderer availability - try multiple ways
        let ipc = null;
        try {
            ipc = window.ipcRenderer || (typeof ipcRenderer !== 'undefined' ? ipcRenderer : null);
        } catch (e) {
            console.error('Error accessing ipcRenderer:', e);
        }

        if (!ipc) {
            console.error('ipcRenderer not available - cannot initialize AudioTrackManager');
            this.audioTrackManager = false;
            return;
        }

        try {
            console.log('Initializing AudioTrackManager via IPC...');
            // Initialize via IPC - no need to access configManager in renderer
            const result = await ipc.invoke('init-audio-track-manager');
            if (result && result.success) {
                console.log('AudioTrackManager initialized successfully via IPC');
                this.audioTrackManager = true; // Flag that it's available
            } else {
                console.error('Failed to initialize AudioTrackManager via IPC:', result?.error || 'Unknown error');
                this.audioTrackManager = false;
            }
        } catch (error) {
            console.error('Failed to call init-audio-track-manager IPC:', error);
            this.audioTrackManager = false;
        }
    }
    
    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Mode toggle buttons
        if (this.clipModeBtn) {
            this.clipModeBtn.addEventListener('click', () => this.setMode('clip'));
        }
        if (this.concatModeBtn) {
            this.concatModeBtn.addEventListener('click', () => this.setMode('concatenate'));
        }
        
        // Button clicks
        if (this.browseBtn) {
            this.browseBtn.addEventListener('click', () => this.browseRecordings());
        }
        if (this.loadVideoBtn) {
            this.loadVideoBtn.addEventListener('click', () => this.loadVideo());
        }
        if (this.loadEventsBtn) {
            this.loadEventsBtn.addEventListener('click', () => this.loadEvents());
        }
        if (this.exportBtn) {
            this.exportBtn.addEventListener('click', () => this.exportVideo());
        }
        
        // Mark In/Out buttons
        document.getElementById('mark-in-btn')?.addEventListener('click', () => this.markInPoint());
        document.getElementById('mark-out-btn')?.addEventListener('click', () => this.markOutPoint());
        document.getElementById('clear-in-btn')?.addEventListener('click', () => this.clearInPoint());
        document.getElementById('clear-out-btn')?.addEventListener('click', () => this.clearOutPoint());
        
        // Frame navigation buttons
        document.getElementById('frame-back-btn')?.addEventListener('click', () => this.stepFrames(-1));
        document.getElementById('frame-forward-btn')?.addEventListener('click', () => this.stepFrames(1));
        
        // Restart button
        document.getElementById('restart-clip-btn')?.addEventListener('click', () => this.restartFromMarkIn());
        
        // Frame step input
        document.getElementById('frame-step')?.addEventListener('change', (e) => {
            // Validate input
            const value = parseInt(e.target.value);
            if (value < 1) e.target.value = 1;
            if (value > 60) e.target.value = 60;
        });
        
        // Transcode toggle
        document.getElementById('transcode-enable')?.addEventListener('change', (e) => {
            const transcodeOptions = document.getElementById('transcode-options');
            if (transcodeOptions) {
                transcodeOptions.style.display = e.target.checked ? 'block' : 'none';
            }
        });
        
        // Volume sliders
        document.querySelectorAll('.volume-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const valueSpan = e.target.parentElement.querySelector('.volume-value');
                if (valueSpan) {
                    valueSpan.textContent = e.target.value + '%';
                }
            });
        });

        // Thumbnail generation checkbox
        const thumbnailCheckbox = document.getElementById('generate-thumbnails-check');
        if (thumbnailCheckbox) {
            thumbnailCheckbox.addEventListener('change', (e) => {
                this.generateThumbnails = e.target.checked;
            });
        }
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT') return; // Don't trigger when typing in inputs
            
            switch(e.key.toLowerCase()) {
                case 'i':
                    if (!e.ctrlKey && !e.altKey) this.markInPoint();
                    break;
                case 'o':
                    if (!e.ctrlKey && !e.altKey) this.markOutPoint();
                    break;
                case 'arrowleft':
                    if (e.shiftKey) this.stepFrames(-1);
                    break;
                case 'arrowright':
                    if (e.shiftKey) this.stepFrames(1);
                    break;
            }
        });
        
        // Video player events
        if (this.videoPlayer) {
            this.videoPlayer.addEventListener('loadedmetadata', () => this.onVideoLoaded());
            this.videoPlayer.addEventListener('error', (e) => this.onVideoError(e));
            this.videoPlayer.addEventListener('timeupdate', () => this.onVideoTimeUpdate());
            
            // Track if playback is active for boundary checking
            this.isPlaying = false;
            this.videoPlayer.addEventListener('play', () => {
                this.isPlaying = true;
                // Only jump to mark in if we're at the very beginning (0) or past mark out
                // This allows manual seeking within bounds
                const currentTime = this.videoPlayer.currentTime;
                if (currentTime === 0 || (this.markOut !== null && currentTime >= this.markOut)) {
                    if (this.markIn !== null) {
                        this.videoPlayer.currentTime = this.markIn;
                        console.log('Starting playback from mark in point');
                    }
                }
            });
            
            this.videoPlayer.addEventListener('pause', () => {
                this.isPlaying = false;
            });

            // Update audio tracks when seeking
            this.videoPlayer.addEventListener('seeked', () => {
                if (this.videoPlayer) {
                    this.updateAudioTracksForSegments(this.videoPlayer.currentTime);
                }
            });
        }

        // Audio sync adjustment controls
        this.setupAudioSyncControls();
    }

    /**
     * Setup audio sync adjustment controls
     */
    setupAudioSyncControls() {
        const syncMinus50 = document.getElementById('sync-minus-50');
        const syncMinus10 = document.getElementById('sync-minus-10');
        const syncPlus10 = document.getElementById('sync-plus-10');
        const syncPlus50 = document.getElementById('sync-plus-50');
        const syncReset = document.getElementById('sync-reset');
        const syncDisplay = document.getElementById('sync-offset-display');

        if (syncMinus50) {
            syncMinus50.addEventListener('click', () => {
                if (this.webAudioManager) {
                    const currentOffset = this.webAudioManager.getSyncOffset();
                    const newOffset = currentOffset - 50;
                    this.webAudioManager.setSyncOffset(newOffset);
                    if (syncDisplay) syncDisplay.textContent = `${newOffset}ms`;
                }
            });
        }

        if (syncMinus10) {
            syncMinus10.addEventListener('click', () => {
                if (this.webAudioManager) {
                    const currentOffset = this.webAudioManager.getSyncOffset();
                    const newOffset = currentOffset - 10;
                    this.webAudioManager.setSyncOffset(newOffset);
                    if (syncDisplay) syncDisplay.textContent = `${newOffset}ms`;
                }
            });
        }

        if (syncPlus10) {
            syncPlus10.addEventListener('click', () => {
                if (this.webAudioManager) {
                    const currentOffset = this.webAudioManager.getSyncOffset();
                    const newOffset = currentOffset + 10;
                    this.webAudioManager.setSyncOffset(newOffset);
                    if (syncDisplay) syncDisplay.textContent = `${newOffset}ms`;
                }
            });
        }

        if (syncPlus50) {
            syncPlus50.addEventListener('click', () => {
                if (this.webAudioManager) {
                    const currentOffset = this.webAudioManager.getSyncOffset();
                    const newOffset = currentOffset + 50;
                    this.webAudioManager.setSyncOffset(newOffset);
                    if (syncDisplay) syncDisplay.textContent = `${newOffset}ms`;
                }
            });
        }

        if (syncReset) {
            syncReset.addEventListener('click', () => {
                if (this.webAudioManager) {
                    this.webAudioManager.setSyncOffset(0);
                    if (syncDisplay) syncDisplay.textContent = '0ms';
                }
            });
        }
    }
    
    /**
     * Set editing mode (clip or concatenate)
     */
    setMode(mode) {
        if (this.currentMode === mode) return; // Already in this mode
        
        this.currentMode = mode;
        console.log('Mode changed to:', this.currentMode);
        
        // Update button states
        if (mode === 'clip') {
            this.clipModeBtn?.classList.add('active');
            this.concatModeBtn?.classList.remove('active');
        } else {
            this.clipModeBtn?.classList.remove('active');
            this.concatModeBtn?.classList.add('active');
        }
        
        // TODO: Update UI based on mode (Phase 10)
    }
    
    /**
     * Browse recordings - show video browser modal
     */
    browseRecordings() {
        console.log('Browse recordings clicked');
        this.videoBrowser.show();
    }
    
    /**
     * Handle video selection from browser - loads both video and events
     */
    async handleVideoSelected(video) {

        // Load the video
        if (this.videoPlayer && video.path) {
            // Clean up previous tracks if any
            if (this.extractedAudioTracks.length > 0) {
                await ipcRenderer.invoke('cleanup-audio-tracks');
                this.extractedAudioTracks = [];
            }

            // Clean up Web Audio if active
            if (this.webAudioManager) {
                this.webAudioManager.dispose();
                this.webAudioManager = null;
                // Unmute video element
                this.videoPlayer.muted = false;
            }

            this.currentVideo = video.path;

            // Set flag that we're potentially extracting audio to prevent video repaint
            this.extractingAudio = true;

            // Load video FIRST so it can decode while we extract audio
            const fileUrl = `file://${video.path.replace(/\\/g, '/')}`;
            this.videoPlayer.src = fileUrl;
            this.videoPlayer.load();

            // Now check for multi-track audio and extract if needed
            await this.checkAndExtractAudioTracks(video.path);

            // Clear extraction flag after completion
            this.extractingAudio = false;

            // Don't hide overlay yet - wait until audio tracks are fully loaded

            // Add error handling for codec issues
            this.videoPlayer.onerror = (e) => {
                console.error('Video playback error:', e);
                const error = this.videoPlayer.error;
                if (error) {
                    let errorMsg = 'Video playback failed: ';
                    switch(error.code) {
                        case error.MEDIA_ERR_DECODE:
                            errorMsg += 'Video decode error (codec may not be supported)';
                            break;
                        case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
                            errorMsg += 'Video format not supported. HEVC/AV1 may require transcoding.';
                            break;
                        default:
                            errorMsg += 'Unable to play video';
                    }
                    console.error(errorMsg);
                    this.videoOverlay.classList.remove('hidden');
                    this.videoOverlay.querySelector('.overlay-message').textContent = errorMsg;
                }
            };

            this.videoPlayer.onloadedmetadata = () => {
                console.log('Video loaded in editor:', video.path);
            }

            // Always load associated events if they exist
            if (video.hasEvents && video.jsonPath) {
                this.loadEventsFromFile(video.jsonPath);
            } else {
                // Clear events if video has no associated events
                this.currentEvents = [];
                this.updateTimeline();
            }
        }
    }
    
    /**
     * Load events from JSON file
     */
    async loadEventsFromFile(jsonPath) {
        try {
            const content = await ipcRenderer.invoke('read-file', jsonPath);
            const eventData = JSON.parse(content);
            
            if (eventData && eventData.events) {
                this.currentEvents = eventData.events;
                
                // Update timeline with events
                this.updateTimeline();
            }
        } catch (error) {
            console.error('Failed to load events:', error);
        }
    }
    
    /**
     * Update timeline with events (matches post view implementation)
     */
    updateTimeline() {
        const timelineEvents = document.getElementById('edit-timeline-events');
        const timelineCount = document.getElementById('edit-timeline-count');
        
        if (!timelineEvents) return;
        
        // Clear existing events
        timelineEvents.innerHTML = '';
        
        // Update count
        if (timelineCount) {
            timelineCount.textContent = `${this.currentEvents.length} events`;
        }
        
        // Display each event
        this.currentEvents.forEach((event, index) => {
            const eventEl = document.createElement('div');
            const eventTime = event.videoOffset || 0;
            
            // Check if event is within clip bounds
            const isOutOfBounds = this.isEventOutOfClipBounds(eventTime);
            
            eventEl.className = `timeline-event ${event.category || event.type || ''} ${isOutOfBounds ? 'out-of-bounds' : ''}`;
            eventEl.dataset.index = index;
            eventEl.dataset.time = eventTime;
            eventEl.dataset.eventId = event.id;

            // Format the timecode
            const timecode = event.videoTimecode || this.formatTime(eventTime);

            // Check if this event is selected as main thumbnail
            const isMainThumbnail = event.id === this.selectedMainThumbnailEventId;

            eventEl.innerHTML = `
                <div class="timeline-event-content">
                    <div class="timeline-event-time">${timecode}</div>
                    <div class="timeline-event-title">${event.name || event.type || 'Unknown Event'}</div>
                    <div class="timeline-event-desc">${event.message || ''}</div>
                </div>
                <button class="main-thumbnail-icon ${isMainThumbnail ? 'active' : ''}"
                        onclick="event.stopPropagation(); window.videoEditorController.toggleMainThumbnail('${event.id}')"
                        title="Set as main thumbnail">
                    📷
                </button>
            `;
            
            // Add click handler to jump to event
            eventEl.addEventListener('click', () => this.jumpToEvent(index));
            
            timelineEvents.appendChild(eventEl);
        });
    }
    
    /**
     * Toggle main thumbnail selection for an event
     */
    toggleMainThumbnail(eventId) {
        // If clicking the same event, deselect it
        if (this.selectedMainThumbnailEventId === eventId) {
            this.selectedMainThumbnailEventId = null;
        } else {
            // Select new event
            this.selectedMainThumbnailEventId = eventId;
        }

        // Update all camera icons
        document.querySelectorAll('.main-thumbnail-icon').forEach(icon => {
            const eventEl = icon.closest('.timeline-event');
            if (eventEl && eventEl.dataset.eventId === this.selectedMainThumbnailEventId) {
                icon.classList.add('active');
            } else {
                icon.classList.remove('active');
            }
        });
    }

    /**
     * Jump to event in video
     */
    jumpToEvent(index) {
        const event = this.currentEvents[index];
        if (!event || !this.videoPlayer) return;


        // Highlight the event
        this.highlightEvent(index);

        // Set video time
        const time = event.videoOffset || 0;
        this.videoPlayer.currentTime = time;
    }
    
    /**
     * Highlight event in timeline
     */
    highlightEvent(index) {
        // Remove active class from all events
        const allEvents = document.querySelectorAll('#edit-timeline-events .timeline-event');
        allEvents.forEach(el => el.classList.remove('active'));
        
        // Add active class to selected event
        const selectedEvent = document.querySelector(`#edit-timeline-events .timeline-event[data-index="${index}"]`);
        if (selectedEvent) {
            selectedEvent.classList.add('active');
            // Scroll into view if needed
            selectedEvent.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
    
    /**
     * Format time in seconds to HH:MM:SS
     */
    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    
    /**
     * Load video manually using file dialog
     */
    async loadVideo() {
        console.log('Load video manually clicked');

        try {
            const result = await ipcRenderer.invoke('show-open-dialog', {
                title: 'Select Video File',
                filters: [
                    { name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'webm', 'mov'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                properties: ['openFile']
            });

            if (!result.canceled && result.filePaths.length > 0) {
                const videoPath = result.filePaths[0];

                // Clean up previous tracks if any
                if (this.extractedAudioTracks.length > 0) {
                    await ipcRenderer.invoke('cleanup-audio-tracks');
                    this.extractedAudioTracks = [];
                }

                // Clean up Web Audio if active
                if (this.webAudioManager) {
                    this.webAudioManager.dispose();
                    this.webAudioManager = null;
                    // Unmute video element
                    this.videoPlayer.muted = false;
                }

                // Load the video
                this.currentVideo = videoPath;

                // Set flag that we're potentially extracting audio to prevent video repaint
                this.extractingAudio = true;

                // Load video FIRST so it can decode while we extract audio
                const fileUrl = `file://${videoPath.replace(/\\/g, '/')}`;
                this.videoPlayer.src = fileUrl;
                this.videoPlayer.load();

                // Now check for multi-track audio and extract if needed
                await this.checkAndExtractAudioTracks(videoPath);

                // Clear extraction flag after completion
                this.extractingAudio = false;

                // Don't hide overlay yet - wait until audio tracks are fully loaded

                // Clear events when manually loading video
                this.currentEvents = [];
                this.updateTimeline();
            }
        } catch (error) {
            console.error('Failed to open file dialog:', error);
        }
    }
    
    /**
     * Load events manually using file dialog
     */
    async loadEvents() {
        console.log('Load events manually clicked');
        
        try {
            const result = await ipcRenderer.invoke('show-open-dialog', {
                title: 'Select Events JSON File',
                filters: [
                    { name: 'JSON Files', extensions: ['json'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                properties: ['openFile']
            });
            
            if (!result.canceled && result.filePaths.length > 0) {
                const jsonPath = result.filePaths[0];
                
                // Load the events
                await this.loadEventsFromFile(jsonPath);
            }
        } catch (error) {
            console.error('Failed to open file dialog:', error);
        }
    }
    
    /**
     * Export video with audio mixer settings
     */
    async exportVideo() {
        console.log('Export video clicked');

        if (!this.currentVideo) {
            this.showExportError('No video loaded to export', true);
            return;
        }

        // Track export start time
        this.exportStartTime = Date.now();

        // Show export progress modal
        this.showExportModal();

        try {
            // Get FFmpeg path from main process
            const ffmpegInfo = await ipcRenderer.invoke('get-ffmpeg-path');

            // Gather export settings
            const exportSettings = this.gatherExportSettings();
            exportSettings.ffmpegPath = ffmpegInfo.ffmpegPath;

            if (!exportSettings.outputPath) {
                this.showExportError('Please specify an output filename', true);
                return;
            }

            // Show progress dialog
            this.showExportProgress('Preparing export...');

            // Prepare data for fluent-ffmpeg export
            const exportData = {
                inputPath: exportSettings.inputPath,
                outputPath: exportSettings.outputPath,
                markIn: exportSettings.markIn,
                markOut: exportSettings.markOut,
                videoCodec: exportSettings.videoCodec,
                videoQuality: exportSettings.videoQuality,
                videoPreset: exportSettings.videoPreset,
                isMultiTrackMode: exportSettings.isMultiTrackMode,
                hasMultipleTracks: exportSettings.hasMultipleTracks,
                extractedTracks: exportSettings.extractedTracks,
                audioSegments: exportSettings.audioMixer?.segments || [],
                events: this.currentEvents || [] // Include events for JSON export
            };


            // Update progress: cutting video
            this.updateExportProgress('cut');
            await this.delay(500); // Small delay for UI update

            // If there are audio tracks, show audio mixing step
            if (exportData.audioSegments && exportData.audioSegments.length > 0) {
                this.updateExportProgress('audio');
                await this.delay(500);
            }

            // Update progress: encoding
            this.updateExportProgress('encode');

            // Execute FFmpeg via IPC using fluent-ffmpeg
            const result = await ipcRenderer.invoke('export-video-fluent', exportData);

            if (result.success) {
                // Update progress: saving
                this.updateExportProgress('save');
                await this.delay(500);

                // Generate thumbnails if checkbox is checked
                if (this.generateThumbnails && this.currentEvents && this.currentEvents.length > 0) {
                    await this.generateThumbnailsForExport(exportSettings.outputPath);
                }

                // Mark all as completed
                this.updateExportProgress('completed');

                // Calculate export time
                const exportEndTime = Date.now();
                const exportDuration = exportEndTime - this.exportStartTime;

                console.log(`Video exported successfully to: ${exportSettings.outputPath}`);

                // Update modal to show completion state
                const modal = document.getElementById('export-progress-modal');
                if (modal) {
                    const header = modal.querySelector('.modal-header h3');
                    if (header) header.textContent = 'Export Complete!';
                }

                // Show export statistics
                this.showExportStats(exportSettings.outputPath, exportDuration, exportData);

                // Show completion buttons and hide cancel button
                this.showCompletionButtons(exportSettings.outputDir);
            } else {
                console.error('Export failed:', result.error);
                this.showExportError(`Export failed: ${result.error || 'Unknown error'}\nCheck console (F12) for details.`);
            }
        } catch (error) {
            console.error('Export error:', error);
            this.showExportError(`Export failed: ${error.message || 'Unknown error'}\nCheck console (F12) for details.`);
        }
    }

    /**
     * Gather all export settings from UI
     */
    gatherExportSettings() {
        const settings = {};

        // Get filename and format
        const filename = document.getElementById('export-filename')?.value || 'output_video';
        const container = document.getElementById('container-format')?.value || 'mkv';

        // Build output path - determine edited folder location
        let outputDir = '';

        // First, try to determine if the video is in a structured recording folder
        const videoPath = this.currentVideo.replace(/\\/g, '/');
        const pathParts = videoPath.split('/');

        // Check if the video is in recordings or saved folder
        const recordingsIndex = pathParts.lastIndexOf('recordings');
        const savedIndex = pathParts.lastIndexOf('saved');

        if (recordingsIndex !== -1 || savedIndex !== -1) {
            // Video is in our structured folder - use edited folder at same level
            const folderIndex = Math.max(recordingsIndex, savedIndex);
            const basePath = pathParts.slice(0, folderIndex).join('/');
            outputDir = `${basePath}/edited`;
        } else {
            // Fallback: Try to get base recording path from config
            let basePath = '';
            try {
                if (window.configManager && window.configManager.config) {
                    basePath = window.configManager.config.settings?.recording?.outputPath || '';
                }
            } catch (error) {
                console.warn('Could not access configManager for output path:', error);
            }

            if (basePath) {
                // Use the edited subfolder in the configured path
                outputDir = `${basePath}/edited`.replace(/\\/g, '/');
            } else {
                // Last fallback: use same directory as input video
                const lastSlash = videoPath.lastIndexOf('/');
                outputDir = videoPath.substring(0, lastSlash);
            }
        }

        // Convert forward slashes to backslashes for Windows
        outputDir = outputDir.replace(/\//g, '\\');

        settings.outputDir = outputDir;
        settings.outputPath = `${outputDir}\\${filename}.${container}`;
        settings.container = container;


        // Input video
        settings.inputPath = this.currentVideo;

        // Time range (mark in/out)
        settings.markIn = this.markIn;
        settings.markOut = this.markOut;

        if (this.videoPlayer) {
            settings.duration = this.videoPlayer.duration;
        }

        // Transcoding settings
        settings.transcode = document.getElementById('transcode-enable')?.checked || false;
        if (settings.transcode) {
            settings.videoCodec = document.getElementById('video-codec')?.value || 'copy';
            settings.videoQuality = document.getElementById('video-quality')?.value || '23';
            settings.videoPreset = document.getElementById('video-preset')?.value || 'medium';
        } else {
            settings.videoCodec = 'copy';
        }

        // Audio settings - get the mixer configuration
        settings.audioMixer = this.getAudioMixerConfig();
        settings.hasMultipleTracks = this.hasMultipleTracks;
        settings.isMultiTrackMode = this.isMultiTrackMode;
        settings.extractedTracks = this.extractedAudioTracks;

        return settings;
    }

    /**
     * Build FFmpeg command from settings
     */
    buildFFmpegCommand(settings) {
        // Use the FFmpeg path passed from settings (got from main process)
        const ffmpegPath = settings.ffmpegPath || 'ffmpeg';

        // Build command as array for proper execution
        const args = [ffmpegPath, '-y']; // -y to overwrite output

        // Input file
        args.push('-i', settings.inputPath);

        // Add extracted audio tracks as additional inputs if in multi-track mode
        if (settings.isMultiTrackMode && settings.extractedTracks && settings.extractedTracks.length > 0) {
            settings.extractedTracks.forEach(track => {
                args.push('-i', track.path);
            });
        }

        // Time range filtering
        if (settings.markIn !== null && settings.markIn !== undefined) {
            args.push('-ss', settings.markIn.toFixed(3));
        }
        if (settings.markOut !== null && settings.markOut !== undefined && settings.duration) {
            const duration = settings.markOut - (settings.markIn || 0);
            args.push('-t', duration.toFixed(3));
        }

        // Build complex filter for audio mixing if needed
        const audioFilter = this.buildAudioFilter(settings);
        if (audioFilter) {
            args.push('-filter_complex', audioFilter);
            // Map the filtered audio
            args.push('-map', '0:v'); // Video from first input
            args.push('-map', '[mixed]'); // Mixed audio from filter
        } else {
            // Simple copy or single track
            args.push('-map', '0:v'); // Video stream

            if (settings.hasMultipleTracks && !settings.isMultiTrackMode) {
                // Use only the first (pre-mixed) audio track
                args.push('-map', '0:a:0');
            } else {
                // Copy all audio tracks
                args.push('-map', '0:a');
            }
        }

        // Video codec settings
        if (settings.videoCodec === 'copy') {
            args.push('-c:v', 'copy');
        } else if (settings.videoCodec === 'libx264') {
            args.push('-c:v', 'libx264');
            args.push('-crf', settings.videoQuality);
            args.push('-preset', settings.videoPreset);
        } else if (settings.videoCodec === 'libx265') {
            args.push('-c:v', 'libx265');
            args.push('-crf', settings.videoQuality);
            args.push('-preset', settings.videoPreset);
        }

        // Audio codec (always copy if no complex filter)
        if (!audioFilter) {
            args.push('-c:a', 'copy');
        } else {
            // Re-encode audio when using complex filters
            args.push('-c:a', 'aac');
            args.push('-b:a', '192k');
        }

        // Output file
        args.push(settings.outputPath);

        // Return as array for proper execution
        return args;
    }

    /**
     * Build audio filter for complex mixing
     */
    buildAudioFilter(settings) {
        // Only build complex filter if we have multi-track mode AND segments defined
        if (!settings.isMultiTrackMode || !settings.audioMixer || !settings.audioMixer.segments || settings.audioMixer.segments.length === 0) {
            console.log('No audio filter needed - multi-track:', settings.isMultiTrackMode, 'segments:', settings.audioMixer?.segments?.length || 0);
            return null;
        }


        // Build a complex filter graph for audio mixing
        const filters = [];
        const inputs = [];

        // Input mapping:
        // 0 = main video file (contains track 1 - pre-mixed audio)
        // 1 = first extracted file (track 2)
        // 2 = second extracted file (track 3)
        // 3 = third extracted file (track 4)

        settings.audioMixer.segments.forEach((segment, index) => {
            const trackId = segment.trackId;
            const trackNum = parseInt(trackId.split('-')[1]);

            // Determine which input file has this track
            let inputIndex;
            if (trackNum === 1) {
                // Track 1 is in the main video file
                inputIndex = 0;
            } else {
                // Find the extracted track
                const extractedTrack = settings.extractedTracks.find(t => t.trackIndex === trackNum);
                if (!extractedTrack) {
                    console.warn(`No extracted track found for track ${trackNum}, skipping segment`);
                    return;
                }
                // Extracted tracks are inputs 1, 2, 3...
                inputIndex = settings.extractedTracks.indexOf(extractedTrack) + 1;
            }


            // Create a filter for this segment
            const segmentFilter = `[${inputIndex}:a]`;

            // Apply time-based enable/disable
            // Need to adjust time if we're using -ss for cutting
            let adjustedStart = segment.startTime;
            let adjustedEnd = segment.endTime;

            if (settings.markIn) {
                // Adjust segment times relative to the mark in point
                adjustedStart = Math.max(0, segment.startTime - settings.markIn);
                adjustedEnd = Math.max(0, segment.endTime - settings.markIn);
            }

            let enableFilter = `aselect='between(t,${adjustedStart},${adjustedEnd})',asetpts=N/SR/TB`;

            // Apply volume if needed
            if (segment.volume && segment.volume !== 0) {
                const volumeDb = segment.volume;
                enableFilter += `,volume=${volumeDb}dB`;
            }

            filters.push(`${segmentFilter}${enableFilter}[seg${index}]`);
            inputs.push(`[seg${index}]`);
        });

        // Mix all segments together
        if (inputs.length > 0) {
            filters.push(`${inputs.join('')}amix=inputs=${inputs.length}:duration=longest[mixed]`);
            const finalFilter = filters.join(';');
            return finalFilter;
        }

        return null;
    }

    /**
     * Show export progress dialog
     */
    showExportProgress(message) {
        // You could create a progress modal here
    }

    /**
     * Hide export progress dialog
     */
    hideExportProgress() {
        // Hide the progress modal
        console.log('Export complete');
    }
    
    /**
     * Called when video metadata is loaded
     */
    onVideoLoaded() {

        // Force a repaint for H.265 videos which may have rendering issues
        // Wrapped in try-catch to prevent white screen issues
        try {
            // Only do this if we're not in multi-track mode or extracting audio
            if (!this.isMultiTrackMode && !this.extractingAudio) {
                this.videoPlayer.style.display = 'none';
                this.videoPlayer.offsetHeight; // Force reflow
                this.videoPlayer.style.display = 'block';
            }
        } catch (error) {
            console.error('[VideoEditor] Error during video repaint:', error);
            // Ensure video is visible even if repaint fails
            this.videoPlayer.style.display = 'block';
        }

        // Ensure video is properly sized
        const wrapper = this.videoPlayer.parentElement;
        if (wrapper) {
            const aspectRatio = this.videoPlayer.videoWidth / this.videoPlayer.videoHeight;

            // Update wrapper aspect ratio to match video
            wrapper.style.aspectRatio = `${aspectRatio}`;
        }

        // Hide overlay when video loads
        if (this.videoOverlay) {
            this.videoOverlay.style.display = 'none';
        }

        // Enable export button
        if (this.exportBtn) {
            this.exportBtn.disabled = false;
        }

        // Update output duration display
        const outputDuration = document.getElementById('output-duration');
        if (outputDuration) {
            outputDuration.textContent = this.formatTime(this.videoPlayer.duration);
        }

        // Set default filename if empty
        const filenameInput = document.getElementById('export-filename');
        if (filenameInput && !filenameInput.value && this.currentVideo) {
            // Extract base filename without extension
            const filename = this.currentVideo.split(/[\\\/]/).pop();
            const baseName = filename.substring(0, filename.lastIndexOf('.')) || filename;
            filenameInput.value = baseName + '_edited';
        }

        // Update audio tracks UI
        this.updateAudioTracksUI();

        // Reset marks and update overlay
        this.markIn = null;
        this.markOut = null;
        this.updateClipBoundsOverlay();
    }
    
    /**
     * Called when video time updates during playback
     */
    onVideoTimeUpdate() {
        if (!this.videoPlayer) return;

        const currentTime = this.videoPlayer.currentTime;

        // Only enforce mark out boundary during active playback, not manual seeking
        if (this.isPlaying && this.markOut !== null && currentTime >= this.markOut) {
            this.videoPlayer.pause();
            this.videoPlayer.currentTime = this.markOut; // Ensure we're exactly at mark out
            console.log('Playback stopped at mark out point');
        }

        // Update audio track volumes based on segments
        this.updateAudioTracksForSegments(currentTime);

        // Only check events if we have them
        if (!this.currentEvents.length) return;
        
        // Find the current event based on video time
        let currentEventIndex = -1;
        for (let i = this.currentEvents.length - 1; i >= 0; i--) {
            const event = this.currentEvents[i];
            const eventTime = event.videoOffset || 0;
            
            // Check if we're at or past this event (with 0.5 second threshold)
            if (currentTime >= eventTime - 0.5) {
                currentEventIndex = i;
                break;
            }
        }
        
        // Highlight the current event if found
        if (currentEventIndex >= 0 && currentEventIndex !== this.lastHighlightedEvent) {
            this.highlightEvent(currentEventIndex);
            this.lastHighlightedEvent = currentEventIndex;
        }
    }
    
    /**
     * Update audio track volumes based on segments at current time
     */
    updateAudioTracksForSegments(currentTime) {
        // Only apply segment-based muting if multi-track mode is enabled
        if (!this.isMultiTrackMode || !this.webAudioManager || !this.audioTracks.length) return;

        // For each audio track, check if current time is within any of its segments
        this.audioTracks.forEach(track => {
            const segments = this.audioSegments[track.id] || [];
            let isInSegment = false;

            // Check if current time falls within any segment for this track
            for (const segment of segments) {
                if (currentTime >= segment.startTime && currentTime <= segment.endTime) {
                    isInSegment = true;
                    break;
                }
            }

            // Update the track's effective volume based on segment status
            // We'll use a property to track the segment mute state separately from user mute
            if (!track.hasOwnProperty('userVolume')) {
                track.userVolume = track.volume || 50;
                track.userMuted = track.muted || false;
            }

            // Apply segment-based muting on top of user settings
            if (isInSegment) {
                // In segment: restore user volume/mute settings
                this.webAudioManager.setTrackVolume(track.id, track.userVolume);
                this.webAudioManager.setTrackMute(track.id, track.userMuted);
            } else {
                // Not in segment: mute the track
                this.webAudioManager.setTrackMute(track.id, true);
            }
        });
    }

    /**
     * Handle video loading errors
     */
    onVideoError(event) {
        console.error('Video loading error:', event);
        
        // Show overlay with error message
        if (this.videoOverlay) {
            this.videoOverlay.style.display = 'flex';
            const message = this.videoOverlay.querySelector('.overlay-message');
            if (message) {
                message.textContent = 'Error loading video';
            }
        }
    }
    
    /**
     * Mark the in point at current playback position
     */
    markInPoint() {
        if (!this.videoPlayer || !this.videoPlayer.duration) return;

        this.markIn = this.videoPlayer.currentTime;

        // Update display
        const markInTime = document.getElementById('mark-in-time');
        if (markInTime) {
            markInTime.textContent = this.formatTime(this.markIn);
        }

        // Update clip duration if both marks are set
        this.updateClipDuration();

        // Update visual indicators
        this.updateClipBoundsOverlay();

        // Update timeline to dim out-of-bounds events
        this.updateTimeline();

        // Update audio mixer mark lines
        this.updateMixerMarkLines();
    }
    
    /**
     * Mark the out point at current playback position
     */
    markOutPoint() {
        if (!this.videoPlayer || !this.videoPlayer.duration) return;

        this.markOut = this.videoPlayer.currentTime;

        // Update display
        const markOutTime = document.getElementById('mark-out-time');
        if (markOutTime) {
            markOutTime.textContent = this.formatTime(this.markOut);
        }

        // Update clip duration if both marks are set
        this.updateClipDuration();

        // Update visual indicators
        this.updateClipBoundsOverlay();

        // Update timeline to dim out-of-bounds events
        this.updateTimeline();

        // Update audio mixer mark lines
        this.updateMixerMarkLines();
    }
    
    /**
     * Clear the in point
     */
    clearInPoint() {
        this.markIn = null;

        const markInTime = document.getElementById('mark-in-time');
        if (markInTime) {
            markInTime.textContent = '--:--:--';
        }

        this.updateClipDuration();
        this.updateClipBoundsOverlay();
        this.updateTimeline();
        this.updateMixerMarkLines();
    }

    /**
     * Clear the out point
     */
    clearOutPoint() {
        this.markOut = null;

        const markOutTime = document.getElementById('mark-out-time');
        if (markOutTime) {
            markOutTime.textContent = '--:--:--';
        }

        this.updateClipDuration();
        this.updateClipBoundsOverlay();
        this.updateTimeline();
        this.updateMixerMarkLines();
    }
    
    /**
     * Step forward or backward by frames
     */
    stepFrames(direction) {
        if (!this.videoPlayer || !this.videoPlayer.duration) return;
        
        // Get number of frames from input
        const frameStepInput = document.getElementById('frame-step');
        const frameCount = frameStepInput ? parseInt(frameStepInput.value) : 1;
        
        // Calculate time per frame (assuming fps)
        const timePerFrame = 1 / this.fps;
        const timeStep = timePerFrame * frameCount * direction;
        
        // Update video position
        const newTime = Math.max(0, Math.min(this.videoPlayer.duration, this.videoPlayer.currentTime + timeStep));
        this.videoPlayer.currentTime = newTime;
        
    }
    
    /**
     * Restart playback from mark in point
     */
    restartFromMarkIn() {
        if (!this.videoPlayer) return;
        
        const startTime = this.markIn !== null ? this.markIn : 0;
        this.videoPlayer.currentTime = startTime;
        this.videoPlayer.play();
        console.log(`Restarting playback from ${this.markIn !== null ? 'mark in' : 'beginning'}`);
    }
    
    /**
     * Update clip duration display
     */
    updateClipDuration() {
        const clipDurationEl = document.getElementById('clip-duration');
        const outputDurationEl = document.getElementById('output-duration');
        
        if (this.markIn !== null && this.markOut !== null && this.markOut > this.markIn) {
            const duration = this.markOut - this.markIn;
            
            if (clipDurationEl) {
                clipDurationEl.textContent = this.formatTime(duration);
            }
            
            // Update output duration for export
            if (outputDurationEl && this.currentMode === 'clip') {
                outputDurationEl.textContent = this.formatTime(duration);
            }
        } else {
            if (clipDurationEl) {
                clipDurationEl.textContent = '--:--:--';
            }
            
            // Reset to full duration if no clip
            if (outputDurationEl && this.videoPlayer && this.currentMode === 'clip') {
                outputDurationEl.textContent = this.formatTime(this.videoPlayer.duration);
            }
        }
    }
    
    /**
     * Check if an event time is outside clip bounds
     */
    isEventOutOfClipBounds(eventTime) {
        if (this.markIn !== null && eventTime < this.markIn) {
            return true;
        }
        if (this.markOut !== null && eventTime > this.markOut) {
            return true;
        }
        return false;
    }
    
    /**
     * Update audio tracks UI based on loaded video
     */
    updateAudioTracksUI() {
        const audioTracksList = document.getElementById('audio-tracks-list');
        if (!audioTracksList) return;

        // Clear existing tracks except the template
        audioTracksList.innerHTML = '';

        // Try multiple ways to get configuration
        let audioSettings = null;

        // Try from configManager
        if (window.configManager && window.configManager.config) {
            audioSettings = window.configManager.config.settings?.audio;
        }

        // If not found, try from localStorage
        if (!audioSettings) {
            try {
                const storedConfig = localStorage.getItem('sc-recorder-config');
                if (storedConfig) {
                    const config = JSON.parse(storedConfig);
                    audioSettings = config.settings?.audio;
                }
            } catch (e) {
                console.warn('Failed to load config from localStorage:', e);
            }
        }

        if (!audioSettings) {
            // No audio configuration available - show default tracks
            console.log('No audio configuration found, showing default tracks');
            audioSettings = {
                track1: { enabled: true },
                track2: { enabled: true },
                track3: { enabled: true }
            };
        }

        // Track definitions based on configuration
        const tracks = [];

        // Track 1: Star Citizen (always present)
        tracks.push({
            id: 'track-1',
            name: 'Track 1: Star Citizen',
            enabled: true,
            volume: 100
        });

        // Track 2: Voice Application
        if (audioSettings.track2?.enabled) {
            tracks.push({
                id: 'track-2',
                name: 'Track 2: Voice Application',
                enabled: true,
                volume: 100
            });
        }

        // Track 3: Microphone
        if (audioSettings.track3?.enabled) {
            tracks.push({
                id: 'track-3',
                name: 'Track 3: Microphone',
                enabled: true,
                volume: 100
            });
        }

        // Create UI for each track
        tracks.forEach((track, index) => {
            const trackEl = document.createElement('div');
            trackEl.className = 'audio-track-item';
            trackEl.innerHTML = `
                <input type="checkbox" id="audio-${track.id}" checked>
                <label for="audio-${track.id}">${track.name}</label>
                <div class="volume-control">
                    <input type="range" id="volume-${track.id}" min="0" max="200" value="${track.volume}" class="volume-slider">
                    <span class="volume-value">${track.volume}%</span>
                </div>
            `;

            // Add event listeners for the new elements
            const checkbox = trackEl.querySelector('input[type="checkbox"]');
            const volumeSlider = trackEl.querySelector('.volume-slider');
            const volumeValue = trackEl.querySelector('.volume-value');

            // Store track index for audio control
            checkbox.dataset.trackIndex = index;
            volumeSlider.dataset.trackIndex = index;

            // Checkbox toggle handler
            checkbox.addEventListener('change', (e) => {
                this.toggleAudioTrack(index, e.target.checked);
            });

            // Volume slider handler
            volumeSlider.addEventListener('input', (e) => {
                volumeValue.textContent = e.target.value + '%';
                this.setAudioTrackVolume(index, e.target.value);
            });

            audioTracksList.appendChild(trackEl);
        });

        // If no tracks configured, show message
        if (tracks.length === 0) {
            audioTracksList.innerHTML = '<div class="no-tracks-message">No audio tracks configured</div>';
        }
    }

    /**
     * Toggle audio track on/off
     */
    toggleAudioTrack(trackIndex, enabled) {
        // Note: HTML5 video doesn't support individual track control for MKV files
        // This would need to be handled during export with FFmpeg
        // Store the state for export
        if (!this.audioTrackStates) {
            this.audioTrackStates = {};
        }
        this.audioTrackStates[trackIndex] = { enabled };
    }

    /**
     * Set audio track volume
     */
    setAudioTrackVolume(trackIndex, volume) {
        // Note: HTML5 video doesn't support individual track volume for MKV files
        // This would need to be handled during export with FFmpeg
        // Store the state for export
        if (!this.audioTrackStates) {
            this.audioTrackStates = {};
        }
        if (!this.audioTrackStates[trackIndex]) {
            this.audioTrackStates[trackIndex] = { enabled: true };
        }
        this.audioTrackStates[trackIndex].volume = volume;
    }

    /**
     * Update visual clip bounds overlay on progress bar
     */
    updateClipBoundsOverlay() {
        const overlay = document.getElementById('clip-bounds-overlay');
        if (!overlay || !this.videoPlayer || !this.videoPlayer.duration) {
            // Hide overlay if no video loaded
            if (overlay) overlay.style.display = 'none';
            return;
        }
        
        const duration = this.videoPlayer.duration;
        const markInPos = this.markIn !== null ? (this.markIn / duration) * 100 : 0;
        const markOutPos = this.markOut !== null ? (this.markOut / duration) * 100 : 100;
        
        // Get the overlay regions
        const clipOutStart = document.getElementById('clip-out-start');
        const clipInRegion = document.getElementById('clip-in-region');
        const clipOutEnd = document.getElementById('clip-out-end');
        const clipMarkerIn = document.getElementById('clip-marker-in');
        const clipMarkerOut = document.getElementById('clip-marker-out');
        
        if (clipOutStart && clipInRegion && clipOutEnd) {
            // Position the regions
            clipOutStart.style.left = '0';
            clipOutStart.style.width = markInPos + '%';
            
            clipInRegion.style.left = markInPos + '%';
            clipInRegion.style.width = (markOutPos - markInPos) + '%';
            
            clipOutEnd.style.left = markOutPos + '%';
            clipOutEnd.style.width = (100 - markOutPos) + '%';
        }
        
        // Position the markers
        if (clipMarkerIn) {
            clipMarkerIn.style.left = markInPos + '%';
            clipMarkerIn.style.display = this.markIn !== null ? 'block' : 'none';
        }
        
        if (clipMarkerOut) {
            clipMarkerOut.style.left = markOutPos + '%';
            clipMarkerOut.style.display = this.markOut !== null ? 'block' : 'none';
        }
        
        // Show overlay
        overlay.style.display = 'block';
    }
    
    /**
     * Test function to load a video directly (for Phase 2 testing)
     */
    testLoadVideo(videoPath) {
        
        if (this.videoPlayer) {
            this.currentVideo = videoPath;
            // Convert path for video element
            const fileUrl = `file://${videoPath.replace(/\\/g, '/')}`;
            this.videoPlayer.src = fileUrl;
            this.videoPlayer.load();

            // Hide the overlay when video is loaded
            if (this.videoOverlay) {
                this.videoOverlay.classList.add('hidden');
            }
        }
    }

    /**
     * Initialize audio mixer functionality
     */
    initializeAudioMixer() {
        console.log('Initializing audio mixer...');

        // Get DOM elements
        this.mixerContent = document.getElementById('mixer-content');
        this.toggleMixerBtn = document.getElementById('toggle-mixer');
        this.tracksContainer = document.getElementById('audio-tracks-container');
        this.segmentEditor = document.getElementById('segment-editor');
        this.mixerPlayhead = document.getElementById('mixer-playhead');

        // Setup mixer toggle
        if (this.toggleMixerBtn) {
            this.toggleMixerBtn.addEventListener('click', () => this.toggleMixer());
        }

        // Setup multi-track toggle
        this.setupMultiTrackToggle();

        // Setup control buttons
        document.getElementById('clear-all-btn')?.addEventListener('click', () => this.clearAllSegments());

        // Setup segment editor controls
        document.getElementById('segment-start-time')?.addEventListener('input', (e) => this.updateSegmentTime('start', e.target.value));
        document.getElementById('segment-end-time')?.addEventListener('input', (e) => this.updateSegmentTime('end', e.target.value));
        document.getElementById('delete-segment-btn')?.addEventListener('click', () => this.deleteSelectedSegment());
        document.getElementById('save-segment-btn')?.addEventListener('click', () => this.saveSegmentChanges());
        document.getElementById('set-start-current')?.addEventListener('click', () => this.setSegmentTimeFromVideo('start'));
        document.getElementById('set-end-current')?.addEventListener('click', () => this.setSegmentTimeFromVideo('end'));
        document.getElementById('set-all-duration-btn')?.addEventListener('click', () => this.setSegmentToFullDuration());

        // Volume slider
        const volumeSlider = document.getElementById('segment-volume');
        const volumeValue = document.getElementById('segment-volume-value');
        if (volumeSlider && volumeValue) {
            volumeSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                volumeValue.textContent = value === 0 ? '0 dB' : (value > 0 ? `+${value} dB` : `${value} dB`);
            });
        }

        // Setup timeline interaction
        if (this.tracksContainer) {
            this.tracksContainer.addEventListener('mousedown', (e) => this.handleTimelineMouseDown(e));
            this.tracksContainer.addEventListener('dblclick', (e) => this.handleTimelineDoubleClick(e));
            this.tracksContainer.addEventListener('contextmenu', (e) => this.handleTimelineRightClick(e));
            document.addEventListener('mousemove', (e) => this.handleTimelineMouseMove(e));
            document.addEventListener('mouseup', (e) => this.handleTimelineMouseUp(e));
        }

        // Initialize with default tracks when video loads
        if (this.videoPlayer) {
            this.videoPlayer.addEventListener('loadedmetadata', () => {
                this.detectAudioTracks();
                this.updateMixerMarkLines();
            });

            // Sync playhead with video time
            this.videoPlayer.addEventListener('timeupdate', () => {
                this.updateMixerPlayhead();
            });
        }
    }

    /**
     * Setup multi-track toggle functionality
     */
    setupMultiTrackToggle() {
        const toggleCheckbox = document.getElementById('multi-track-enabled');
        const statusText = document.getElementById('multi-track-status');

        if (!toggleCheckbox) return;

        // Set initial state based on whether we have multi-track audio
        toggleCheckbox.checked = this.isMultiTrackMode;
        if (statusText) {
            statusText.textContent = this.isMultiTrackMode ? 'Enabled' : 'Disabled';
        }

        // Handle toggle changes
        toggleCheckbox.addEventListener('change', (e) => {
            const enabled = e.target.checked;

            if (statusText) {
                statusText.textContent = enabled ? 'Enabled' : 'Disabled';
            }

            // Toggle multi-track mode
            this.setMultiTrackMode(enabled);
        });
    }

    /**
     * Set multi-track mode on/off
     */
    setMultiTrackMode(enabled) {
        if (enabled && this.webAudioManager) {
            // Enable multi-track mode
            this.isMultiTrackMode = true;

            // Mute video element and use Web Audio
            this.videoPlayer.muted = true;

            // If we're playing, sync Web Audio
            if (!this.videoPlayer.paused) {
                // The video sync handlers will automatically start Web Audio playback
            }

            console.log('[VideoEditor] Multi-track mode enabled');
        } else {
            // Disable multi-track mode
            this.isMultiTrackMode = false;

            // Stop Web Audio playback if active
            if (this.webAudioManager) {
                this.webAudioManager.stop();
            }

            // Unmute video element to play pre-mixed audio
            this.videoPlayer.muted = false;

            console.log('[VideoEditor] Multi-track mode disabled - using pre-mixed audio');
        }
    }

    /**
     * Toggle mixer panel visibility
     */
    toggleMixer() {
        if (!this.mixerContent || !this.toggleMixerBtn) return;

        const isVisible = this.mixerContent.style.display !== 'none';
        this.mixerContent.style.display = isVisible ? 'none' : 'block';

        const icon = this.toggleMixerBtn.querySelector('.toggle-icon');
        if (icon) {
            icon.textContent = isVisible ? '▶' : '▼';
        }
    }

    /**
     * Check for multi-track audio and extract if needed
     */
    async checkAndExtractAudioTracks(videoPath) {
        if (!this.audioTrackManager) {
            console.log('AudioTrackManager not available, skipping multi-track detection');
            return;
        }

        try {
            // Show loading indicator
            this.showLoadingOverlay('Analyzing audio tracks...');

            // Detect tracks via IPC
            const detectResult = await ipcRenderer.invoke('detect-audio-tracks', videoPath);

            if (!detectResult.success) {
                console.error('Failed to detect audio tracks:', detectResult.error);
                this.hasMultipleTracks = false;
                this.extractedAudioTracks = [];
                this.disableMultiTrackMode();
                this.hideLoadingOverlay();
                return;
            }

            const tracks = detectResult.tracks || [];

            if (tracks.length > 1) {
                this.hasMultipleTracks = true;

                // Show initial extraction message
                this.showLoadingOverlay('Starting audio extraction... (0%)');

                // Listen for progress updates from backend
                const progressHandler = (event, progress) => {
                    if (progress.message) {
                        this.showLoadingOverlay(progress.message);
                    }
                };
                ipcRenderer.on('audio-extraction-progress', progressHandler);

                // Extract tracks via IPC
                const extractResult = await ipcRenderer.invoke('extract-audio-tracks', videoPath);

                // Remove progress listener
                ipcRenderer.removeListener('audio-extraction-progress', progressHandler);

                if (extractResult.success) {
                    this.extractedAudioTracks = extractResult.tracks || [];
                    // Don't log the entire result object - it might be large or have circular references

                    // Enable multi-track mode in UI - defer to prevent blocking

                    // Use requestAnimationFrame to ensure UI is ready
                    requestAnimationFrame(() => {
                        setTimeout(async () => {
                            try {
                                // Check if window is still valid before proceeding
                                if (typeof window === 'undefined' || !document.body) {
                                    console.error('Window context lost during audio extraction');
                                    return;
                                }


                                // Add extra delay to ensure video element is fully loaded
                                await new Promise(resolve => setTimeout(resolve, 200));

                                await this.enableMultiTrackMode();

                                // Ensure video is visible after extraction completes
                                if (this.videoPlayer) {
                                    this.videoPlayer.style.display = 'block';
                                    this.videoPlayer.style.visibility = 'visible';
                                    // Force container to be visible too
                                    const container = this.videoPlayer.parentElement;
                                    if (container) {
                                        container.style.display = 'block';
                                        container.style.visibility = 'visible';
                                    }
                                }
                            } catch (error) {
                                console.error('Error enabling multi-track mode:', error);
                                // Clean up extracted tracks on error
                                this.extractedAudioTracks = [];
                                this.hasMultipleTracks = false;
                                this.disableMultiTrackMode();

                                // Only show alert if window is still valid
                                if (typeof window !== 'undefined' && document.body) {
                                    this.showAlert('Failed to load multi-track audio. You can still edit with the main audio track.', 'warning');
                                }
                            }
                        }, 500); // Give UI time to stabilize
                    });
                } else {
                    console.error('Failed to extract audio tracks:', extractResult.error);
                    this.hasMultipleTracks = false;
                    this.extractedAudioTracks = [];
                    this.disableMultiTrackMode();
                    this.hideLoadingOverlay();
                }
            } else {
                this.hasMultipleTracks = false;
                this.extractedAudioTracks = [];
                this.disableMultiTrackMode();
                this.hideLoadingOverlay();
            }

            // Don't hide overlay here for multi-track - it will be hidden after tracks are loaded

            // Final safety check to ensure video remains visible
            if (this.videoPlayer) {
                this.videoPlayer.style.display = 'block';
                this.videoPlayer.style.visibility = 'visible';
            }
        } catch (error) {
            console.error('Failed to check/extract audio tracks:', error);
            this.hideLoadingOverlay();
            // Continue with single-track mode on error
            this.hasMultipleTracks = false;
            this.disableMultiTrackMode();
        }
    }

    /**
     * Show loading overlay with message
     */
    showLoadingOverlay(message) {
        if (this.videoOverlay) {
            this.videoOverlay.classList.remove('hidden');
            this.videoOverlay.style.display = 'flex';
            const messageEl = this.videoOverlay.querySelector('.overlay-message');
            if (messageEl) {
                messageEl.textContent = message;
            }

            // Parse progress from message if it contains percentage
            const progressMatch = message.match(/\((\d+)%\)/);
            const progressEl = document.getElementById('edit-overlay-progress');
            const progressFill = document.getElementById('edit-progress-fill');
            const progressText = document.getElementById('edit-progress-text');

            if (progressMatch && progressEl && progressFill && progressText) {
                const progress = parseInt(progressMatch[1]);
                progressEl.style.display = 'block';
                progressFill.style.width = `${progress}%`;
                progressText.textContent = `${progress}%`;
            } else if (progressEl) {
                // Hide progress if no percentage in message
                progressEl.style.display = 'none';
            }
        }
    }

    /**
     * Hide loading overlay
     */
    hideLoadingOverlay() {
        if (this.videoOverlay) {
            this.videoOverlay.classList.add('hidden');
            this.videoOverlay.style.display = 'none';

            // Reset progress display
            const progressEl = document.getElementById('edit-overlay-progress');
            if (progressEl) {
                progressEl.style.display = 'none';
            }
        }
    }

    /**
     * Enable multi-track mode in UI
     */
    async enableMultiTrackMode() {
        this.isMultiTrackMode = true;

        // Add multi-track indicator to UI
        const indicator = document.getElementById('multi-track-indicator');
        if (indicator) {
            indicator.style.display = 'block';
            indicator.textContent = `Multi-track mode (${this.extractedAudioTracks.length + 1} tracks)`;
        }

        // Update toggle checkbox
        const toggleCheckbox = document.getElementById('multi-track-enabled');
        const statusText = document.getElementById('multi-track-status');
        if (toggleCheckbox) {
            toggleCheckbox.checked = true;
        }
        if (statusText) {
            statusText.textContent = 'Enabled';
        }

        // Initialize Web Audio Manager for multi-track playback with error handling
        try {
            await this.initializeWebAudio();
        } catch (error) {
            console.error('[VideoEditor] Failed to initialize Web Audio:', error);
            this.showAlert('Failed to initialize multi-track audio. The video may have unsupported audio formats.', 'error');
            // Disable multi-track mode if initialization fails
            this.disableMultiTrackMode();
        }
    }

    /**
     * Disable multi-track mode in UI
     */
    disableMultiTrackMode() {
        this.isMultiTrackMode = false;
        // Hide multi-track indicator
        const indicator = document.getElementById('multi-track-indicator');
        if (indicator) {
            indicator.style.display = 'none';
        }

        // Update toggle checkbox
        const toggleCheckbox = document.getElementById('multi-track-enabled');
        const statusText = document.getElementById('multi-track-status');
        if (toggleCheckbox) {
            toggleCheckbox.checked = false;
        }
        if (statusText) {
            statusText.textContent = 'Disabled';
        }

        // Clean up Web Audio Manager
        if (this.webAudioManager) {
            this.webAudioManager.dispose();
            this.webAudioManager = null;
        }

        // Clean up Web Audio Manager
        if (this.webAudioManager) {
            this.webAudioManager.dispose();
            this.webAudioManager = null;
        }

        // Unmute video element
        this.videoPlayer.muted = false;
    }

    /**
     * Initialize Web Audio for multi-track playback
     */
    async initializeWebAudio() {
        if (!this.extractedAudioTracks || this.extractedAudioTracks.length === 0) {
            return;
        }

        try {

            // Give the renderer MORE time to breathe before heavy operations - increased from 100ms to 250ms
            await new Promise(resolve => setTimeout(resolve, 250));

            // Check if WebAudioManager is available
            if (typeof WebAudioManager === 'undefined') {
                // Try to load it
                const script = document.createElement('script');
                script.src = './lib/web-audio-manager.js';
                document.head.appendChild(script);

                // Wait for script to load
                await new Promise((resolve) => {
                    script.onload = resolve;
                });
            }

            // Create Web Audio Manager instance
            this.webAudioManager = new WebAudioManager();

            // Initialize with video element
            const initialized = await this.webAudioManager.initialize(this.videoPlayer);

            if (!initialized) {
                console.error('[VideoEditor] Failed to initialize Web Audio Manager');
                return;
            }

            // Load extracted tracks

            for (const track of this.extractedAudioTracks) {
                try {

                    // Skip file verification here - let WebAudioManager handle it asynchronously
                    // This avoids blocking the renderer with synchronous fs operations

                    // Give renderer MORE time to process between tracks - increased from 50ms to 150ms
                    await new Promise(resolve => setTimeout(resolve, 150));

                    const success = await this.webAudioManager.loadTrack(
                        `track-${track.trackIndex}`,
                        track.path,
                        track.label,
                        (message, progress) => {
                            // Update loading overlay with decode progress
                            const progressText = progress !== undefined
                                ? `${message} (${Math.round(progress * 100)}%)`
                                : message;
                            this.showLoadingOverlay(progressText);
                        }
                    );

                    if (!success) {
                        console.error(`[VideoEditor] Failed to load track ${track.trackIndex}`);
                    } else {
                    }
                } catch (error) {
                    console.error(`[VideoEditor] Error loading track ${track.trackIndex}:`, error);
                    console.error('[VideoEditor] Error stack:', error.stack);
                    // Continue loading other tracks even if one fails
                }
            }


            // Mute video element audio when using Web Audio
            this.videoPlayer.muted = true;

            // Update the track timeline UI with extracted tracks
            this.detectAudioTracks();

            // Now hide the loading overlay since everything is ready
            this.hideLoadingOverlay();

            // Expose to window for debugging
            window.webAudioManager = this.webAudioManager;

        } catch (error) {
            console.error('[VideoEditor] Failed to initialize Web Audio:', error);
        }
    }

    /**
     * Detect and load audio tracks from video
     */
    detectAudioTracks() {

        // Clear existing tracks
        this.audioTracks = [];
        this.audioSegments = {};
        if (this.tracksContainer) {
            this.tracksContainer.innerHTML = '';
        }

        // Get video duration
        const duration = this.videoPlayer.duration || 0;

        let tracksToCreate = [];

        // Use extracted tracks if available (multi-track mode)
        if (this.hasMultipleTracks && this.extractedAudioTracks.length > 0) {
            // Track 1 is always the pre-mixed (in the video element)
            tracksToCreate.push({
                id: 'track-1',
                name: 'Pre-mixed Audio',
                color: '#4a9eff',
                isInVideo: true
            });

            // Add extracted tracks
            this.extractedAudioTracks.forEach((track, index) => {
                const colors = ['#ff9e4a', '#9e4aff', '#4aff9e'];
                tracksToCreate.push({
                    id: `track-${track.trackIndex}`,
                    name: track.label,
                    color: colors[index % colors.length],
                    extractedPath: track.path,
                    trackIndex: track.trackIndex
                });
            });
        } else {
            // Default tracks for single-track mode or when extraction not available
            const defaultTracks = [
                { id: 'track-1', name: 'Game Audio', color: '#4a9eff' },
                { id: 'track-2', name: 'Voice Chat', color: '#ff9e4a' },
                { id: 'track-3', name: 'Microphone', color: '#9e4aff' }
            ];

            // Only create tracks that are configured as enabled
            const audioSettings = window.configManager?.config?.settings?.audio;
            if (audioSettings) {
                if (audioSettings.track1?.enabled !== false) {
                    tracksToCreate.push(defaultTracks[0]);
                }
                if (audioSettings.track2?.enabled) {
                    tracksToCreate.push(defaultTracks[1]);
                }
                if (audioSettings.track3?.enabled) {
                    tracksToCreate.push(defaultTracks[2]);
                }
            } else {
                // If no config, use first track only
                tracksToCreate.push(defaultTracks[0]);
            }
        }

        // Create tracks in UI
        tracksToCreate.forEach(trackInfo => {
            this.createAudioTrack(trackInfo, duration);
        });

        // Update segment editor track select
        this.updateTrackSelect();

        // Initial update of audio tracks based on segments (all should be muted initially)
        if (this.videoPlayer && this.webAudioManager) {
            this.updateAudioTracksForSegments(this.videoPlayer.currentTime);
        }
    }

    /**
     * Create an audio track
     */
    createAudioTrack(trackInfo, duration) {
        const track = {
            id: trackInfo.id,
            name: trackInfo.name,
            color: trackInfo.color,
            enabled: true,
            isInVideo: trackInfo.isInVideo || false,
            extractedPath: trackInfo.extractedPath || null,
            trackIndex: trackInfo.trackIndex || null
        };

        this.audioTracks.push(track);
        this.audioSegments[track.id] = [];

        // Create DOM element
        const trackEl = document.createElement('div');
        trackEl.className = 'audio-track';
        trackEl.dataset.trackId = track.id;

        trackEl.innerHTML = `
            <div class="track-header">
                <span class="track-name">${track.name}</span>
                <div class="track-buttons">
                    <button class="track-toggle-btn enabled" data-track-id="${track.id}">
                        Enabled
                    </button>
                </div>
            </div>
            <div class="track-timeline" data-track-id="${track.id}">
                <!-- Segments will be added here -->
            </div>
        `;

        // Add event listeners
        const toggleBtn = trackEl.querySelector('.track-toggle-btn');
        toggleBtn.addEventListener('click', () => {
            track.enabled = !track.enabled;
            toggleBtn.classList.toggle('enabled', track.enabled);
            toggleBtn.classList.toggle('disabled', !track.enabled);
            toggleBtn.textContent = track.enabled ? 'Enabled' : 'Disabled';
            trackEl.classList.toggle('disabled', !track.enabled);
        });

        if (this.tracksContainer) {
            this.tracksContainer.appendChild(trackEl);
        }
    }

    // Removed toggleTrackAll - no longer needed

    /**
     * Handle double-click on timeline segments
     */
    handleTimelineDoubleClick(e) {
        const segment = e.target.closest('.track-segment');
        if (!segment) return;

        const segmentId = segment.dataset.segmentId;
        const timeline = segment.parentElement;
        const trackId = timeline.dataset.trackId;

        // Find the segment
        const segmentObj = this.audioSegments[trackId]?.find(s => s.id === segmentId);
        if (!segmentObj || !this.videoPlayer) return;

        // Get all other segments on this track, sorted by start time
        const otherSegments = this.audioSegments[trackId]
            .filter(s => s.id !== segmentId)
            .sort((a, b) => a.startTime - b.startTime);

        // Find the previous and next segments
        let prevSegment = null;
        let nextSegment = null;

        for (const otherSeg of otherSegments) {
            if (otherSeg.endTime <= segmentObj.startTime) {
                // This segment ends before our segment starts - it's a candidate for previous
                if (!prevSegment || otherSeg.endTime > prevSegment.endTime) {
                    prevSegment = otherSeg;
                }
            } else if (otherSeg.startTime >= segmentObj.endTime) {
                // This segment starts after our segment ends - it's the next segment
                if (!nextSegment || otherSeg.startTime < nextSegment.startTime) {
                    nextSegment = otherSeg;
                }
            }
        }

        // Determine new boundaries based on segments
        let newStartTime = prevSegment ? prevSegment.endTime + 0.01 : 0;
        let newEndTime = nextSegment ? nextSegment.startTime - 0.01 : this.videoPlayer.duration;

        // Also consider mark in/out as boundaries
        if (this.markIn !== null && this.markIn !== undefined) {
            // If mark in is between the previous segment (or start) and current segment
            if (this.markIn > (prevSegment ? prevSegment.endTime : 0) && this.markIn < segmentObj.startTime) {
                newStartTime = Math.max(newStartTime, this.markIn);
            }
        }

        if (this.markOut !== null && this.markOut !== undefined) {
            // If mark out is between the current segment and next segment (or end)
            if (this.markOut > segmentObj.endTime && this.markOut < (nextSegment ? nextSegment.startTime : this.videoPlayer.duration)) {
                newEndTime = Math.min(newEndTime, this.markOut);
            }
        }

        // Expand the segment to fill available space
        segmentObj.startTime = newStartTime;
        segmentObj.endTime = newEndTime;

        // Update the segment element
        this.updateSegmentElement(segmentObj);

        // Select it and show in editor
        this.selectedSegment = segmentObj;
        this.selectSegment(segment);
        this.showSegmentEditor(segmentObj);

        // Show a brief notification
        if (window.NotificationManager) {
            window.NotificationManager.success('Segment expanded to fill available space', 2000);
        }
    }

    /**
     * Handle right-click on timeline to delete segments
     */
    handleTimelineRightClick(e) {
        e.preventDefault();

        const segment = e.target.closest('.track-segment');
        if (segment) {
            const segmentId = segment.dataset.segmentId;
            const timeline = segment.parentElement;
            const trackId = timeline.dataset.trackId;

            // Remove from array
            this.audioSegments[trackId] = this.audioSegments[trackId].filter(s => s.id !== segmentId);

            // Remove element
            segment.remove();

            // Update audio tracks for current position
            if (this.videoPlayer) {
                this.updateAudioTracksForSegments(this.videoPlayer.currentTime);
            }

            // Hide editor if this was the selected segment
            if (this.selectedSegment?.id === segmentId) {
                this.selectedSegment = null;
                if (this.segmentEditor) {
                    this.segmentEditor.style.display = 'none';
                }
            }
        }
    }

    /**
     * Handle mouse down on timeline
     */
    handleTimelineMouseDown(e) {
        if (!this.videoPlayer || !this.videoPlayer.duration) return;

        const timeline = e.target.closest('.track-timeline');
        const segment = e.target.closest('.track-segment');

        if (segment) {
            // Handle segment interaction
            this.handleSegmentMouseDown(e, segment);
        } else if (timeline) {
            // Start creating new segment
            this.startSegmentCreation(e, timeline);
        }
    }

    /**
     * Start creating a new segment
     */
    startSegmentCreation(e, timeline) {
        const trackId = timeline.dataset.trackId;
        const rect = timeline.getBoundingClientRect();
        const x = e.clientX - rect.left;
        let time = (x / rect.width) * this.videoPlayer.duration;

        // Apply snap to marks for the initial placement
        time = this.applySnapToMarks(time);

        // Check if click position overlaps with existing segment
        const existingSegments = this.audioSegments[trackId] || [];
        for (const segment of existingSegments) {
            if (time >= segment.startTime && time <= segment.endTime) {
                // Click is on an existing segment, don't create new one
                return;
            }
        }

        // Hide any existing segment editor first
        if (this.segmentEditor) {
            this.segmentEditor.style.display = 'none';
        }

        // Create new segment
        const segment = {
            id: `segment-${Date.now()}`,
            trackId: trackId,
            startTime: time,
            endTime: time,
            creating: true
        };

        this.audioSegments[trackId].push(segment);
        this.selectedSegment = segment;
        this.isDragging = true;
        this.dragType = 'create';
        this.dragStartX = e.clientX;
        this.dragStartTime = time;

        // Create segment element
        this.createSegmentElement(segment, timeline);

        // Update audio tracks for current position
        if (this.videoPlayer) {
            this.updateAudioTracksForSegments(this.videoPlayer.currentTime);
        }
    }

    /**
     * Handle segment mouse down
     */
    handleSegmentMouseDown(e, segmentEl) {
        e.stopPropagation();

        const segmentId = segmentEl.dataset.segmentId;
        const trackId = segmentEl.parentElement.dataset.trackId;

        // Find segment
        const segment = this.audioSegments[trackId]?.find(s => s.id === segmentId);
        if (!segment) return;

        this.selectedSegment = segment;
        this.selectSegment(segmentEl);
        this.showSegmentEditor(segment);

        // Determine drag type
        const rect = segmentEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;

        // Check if clicking on resize handles
        if (e.target.classList.contains('segment-handle-left')) {
            this.dragType = 'resize-left';
            this.dragStartTime = segment.startTime;
        } else if (e.target.classList.contains('segment-handle-right')) {
            this.dragType = 'resize-right';
            this.dragStartTime = segment.endTime;
        } else {
            this.dragType = 'move';
            this.dragStartTime = segment.startTime;
        }

        this.isDragging = true;
        this.dragStartX = e.clientX;

        // Prevent text selection
        e.preventDefault();
    }

    /**
     * Apply gentle snap to mark points
     */
    applySnapToMarks(time) {
        if (!this.videoPlayer) return time;

        const snapThreshold = this.videoPlayer.duration * 0.01; // 1% of duration as snap threshold

        // Check snap to mark in
        if (this.markIn !== null && this.markIn !== undefined) {
            const distToMarkIn = Math.abs(time - this.markIn);
            if (distToMarkIn < snapThreshold) {
                return this.markIn;
            }
        }

        // Check snap to mark out
        if (this.markOut !== null && this.markOut !== undefined) {
            const distToMarkOut = Math.abs(time - this.markOut);
            if (distToMarkOut < snapThreshold) {
                return this.markOut;
            }
        }

        return time;
    }

    /**
     * Handle mouse move during drag
     */
    handleTimelineMouseMove(e) {
        if (!this.isDragging || !this.selectedSegment || !this.videoPlayer) return;

        const trackEl = this.tracksContainer?.querySelector(`[data-track-id="${this.selectedSegment.trackId}"]`);
        if (!trackEl) return;

        const rect = trackEl.getBoundingClientRect();
        const deltaX = e.clientX - this.dragStartX;
        const deltaTime = (deltaX / rect.width) * this.videoPlayer.duration;

        // Get other segments on the same track for collision detection
        const otherSegments = this.audioSegments[this.selectedSegment.trackId]
            .filter(s => s.id !== this.selectedSegment.id)
            .sort((a, b) => a.startTime - b.startTime);

        switch (this.dragType) {
            case 'create':
            case 'resize-right':
                let maxEndTime = this.videoPlayer.duration;

                // Find next segment to the right
                const nextSegment = otherSegments.find(s => s.startTime > this.selectedSegment.startTime);
                if (nextSegment) {
                    maxEndTime = Math.min(maxEndTime, nextSegment.startTime - 0.01);
                }

                let newEndTime = Math.max(
                    this.selectedSegment.startTime + 0.1,
                    Math.min(maxEndTime, this.dragStartTime + deltaTime)
                );

                // Apply snap to marks
                newEndTime = this.applySnapToMarks(newEndTime);

                // Ensure it doesn't go past collision bounds after snapping
                this.selectedSegment.endTime = Math.min(maxEndTime, newEndTime);
                break;

            case 'resize-left':
                let minStartTime = 0;

                // Find previous segment to the left
                const prevSegment = otherSegments.reverse().find(s => s.endTime < this.selectedSegment.endTime);
                if (prevSegment) {
                    minStartTime = Math.max(minStartTime, prevSegment.endTime + 0.01);
                }

                let newStartTime = Math.max(
                    minStartTime,
                    Math.min(this.selectedSegment.endTime - 0.1, this.dragStartTime + deltaTime)
                );

                // Apply snap to marks
                newStartTime = this.applySnapToMarks(newStartTime);

                // Ensure it doesn't go past collision bounds after snapping
                this.selectedSegment.startTime = Math.max(minStartTime, newStartTime);
                break;

            case 'move':
                const duration = this.selectedSegment.endTime - this.selectedSegment.startTime;
                let newStart = this.dragStartTime + deltaTime;
                let newEnd = newStart + duration;

                // Apply snap to marks for both start and end
                const snappedStart = this.applySnapToMarks(newStart);
                const snappedEnd = this.applySnapToMarks(newEnd);

                // Check which edge is closer to a snap point
                const startSnapDistance = Math.abs(snappedStart - newStart);
                const endSnapDistance = Math.abs(snappedEnd - newEnd);

                if (startSnapDistance < endSnapDistance && snappedStart !== newStart) {
                    // Snap by the start edge
                    newStart = snappedStart;
                } else if (endSnapDistance < startSnapDistance && snappedEnd !== newEnd) {
                    // Snap by the end edge
                    newStart = snappedEnd - duration;
                }

                // Constrain to timeline bounds
                newStart = Math.max(0, Math.min(this.videoPlayer.duration - duration, newStart));

                // Check for collisions
                let minStart = 0;
                let maxStart = this.videoPlayer.duration - duration;

                for (const segment of otherSegments) {
                    if (segment.endTime <= newStart) {
                        // Segment is to the left
                        minStart = Math.max(minStart, segment.endTime + 0.01);
                    } else if (segment.startTime >= newStart + duration) {
                        // Segment is to the right
                        maxStart = Math.min(maxStart, segment.startTime - duration - 0.01);
                    } else {
                        // Would overlap - snap to closest edge
                        const leftGap = newStart - segment.endTime;
                        const rightGap = segment.startTime - (newStart + duration);

                        if (Math.abs(leftGap) < Math.abs(rightGap)) {
                            newStart = segment.endTime + 0.01;
                        } else {
                            newStart = segment.startTime - duration - 0.01;
                        }
                    }
                }

                newStart = Math.max(minStart, Math.min(maxStart, newStart));

                this.selectedSegment.startTime = newStart;
                this.selectedSegment.endTime = newStart + duration;
                break;
        }

        // Update segment element
        this.updateSegmentElement(this.selectedSegment);
    }

    /**
     * Handle mouse up to end drag
     */
    handleTimelineMouseUp(e) {
        if (!this.isDragging) return;

        if (this.selectedSegment && this.selectedSegment.creating) {
            delete this.selectedSegment.creating;

            // If segment is too small, remove it
            if (this.selectedSegment.endTime - this.selectedSegment.startTime < 0.1) {
                this.deleteSelectedSegment();
            } else {
                // Show segment editor for the created segment
                this.showSegmentEditor(this.selectedSegment);
            }
        }

        this.isDragging = false;

        // Update audio tracks for current position after drag ends
        if (this.videoPlayer) {
            this.updateAudioTracksForSegments(this.videoPlayer.currentTime);
        }
        this.dragType = null;

        // Update segment editor if segment is selected
        if (this.selectedSegment) {
            this.showSegmentEditor(this.selectedSegment);
        }
    }

    /**
     * Create segment DOM element
     */
    createSegmentElement(segment, timeline) {
        const duration = this.videoPlayer.duration;
        const segmentEl = document.createElement('div');
        segmentEl.className = 'track-segment';
        segmentEl.dataset.segmentId = segment.id;

        // Find track for color
        const track = this.audioTracks.find(t => t.id === segment.trackId);
        if (track) {
            segmentEl.style.background = `linear-gradient(90deg, ${track.color}, ${track.color}dd)`;
        }

        // Position and size - ensure proper positioning
        const left = (segment.startTime / duration) * 100;
        const width = ((segment.endTime - segment.startTime) / duration) * 100;
        segmentEl.style.left = `${left}%`;
        segmentEl.style.width = `${width}%`;

        // Add resize handles and volume indicator if needed
        const volumeIndicator = segment.volume && segment.volume !== 0
            ? `<span class="volume-indicator">${segment.volume > 0 ? '+' : ''}${segment.volume}dB</span>`
            : '';

        segmentEl.innerHTML = `
            <div class="segment-handle segment-handle-left"></div>
            <div class="segment-handle segment-handle-right"></div>
            <div class="segment-label">${this.formatTime(segment.startTime)} - ${this.formatTime(segment.endTime)}</div>
            ${volumeIndicator}
        `;

        timeline.appendChild(segmentEl);
    }

    /**
     * Update segment element position and size
     */
    updateSegmentElement(segment) {
        const segmentEl = this.tracksContainer?.querySelector(`[data-segment-id="${segment.id}"]`);
        if (!segmentEl || !this.videoPlayer) return;

        const duration = this.videoPlayer.duration;
        const left = (segment.startTime / duration) * 100;
        const width = ((segment.endTime - segment.startTime) / duration) * 100;

        segmentEl.style.left = `${left}%`;
        segmentEl.style.width = `${width}%`;

        const label = segmentEl.querySelector('.segment-label');
        if (label) {
            label.textContent = `${this.formatTime(segment.startTime)} - ${this.formatTime(segment.endTime)}`;
        }

        // Update or add volume indicator
        let volumeIndicator = segmentEl.querySelector('.volume-indicator');
        if (segment.volume && segment.volume !== 0) {
            const volumeText = `${segment.volume > 0 ? '+' : ''}${segment.volume}dB`;
            if (volumeIndicator) {
                volumeIndicator.textContent = volumeText;
            } else {
                volumeIndicator = document.createElement('span');
                volumeIndicator.className = 'volume-indicator';
                volumeIndicator.textContent = volumeText;
                segmentEl.appendChild(volumeIndicator);
            }
        } else if (volumeIndicator) {
            volumeIndicator.remove();
        }
    }

    /**
     * Select a segment
     */
    selectSegment(segmentEl) {
        // Remove previous selection
        this.tracksContainer?.querySelectorAll('.track-segment.selected').forEach(el => {
            el.classList.remove('selected');
        });

        // Add selection to new segment
        segmentEl.classList.add('selected');
    }

    /**
     * Show segment editor
     */
    showSegmentEditor(segment) {
        if (!this.segmentEditor) return;

        this.segmentEditor.style.display = 'block';

        // Update fields
        const startInput = document.getElementById('segment-start-time');
        const endInput = document.getElementById('segment-end-time');
        const volumeSlider = document.getElementById('segment-volume');
        const volumeValue = document.getElementById('segment-volume-value');

        if (startInput) startInput.value = this.formatTime(segment.startTime);
        if (endInput) endInput.value = this.formatTime(segment.endTime);

        // Set volume (default to 0 if not set)
        const volume = segment.volume || 0;
        if (volumeSlider) {
            volumeSlider.value = volume;
        }
        if (volumeValue) {
            volumeValue.textContent = volume === 0 ? '0 dB' : (volume > 0 ? `+${volume} dB` : `${volume} dB`);
        }
    }

    /**
     * Update segment time from editor (but don't save yet)
     */
    updateSegmentTime(type, value) {
        // Just update the input field, actual saving happens when Save button is clicked
        // This allows users to type without immediate updates

        // Clear the flag if user is manually editing
        this.shouldClearOthersOnSave = false;
    }

    /**
     * Set segment time from current video position
     */
    setSegmentTimeFromVideo(type) {
        if (!this.selectedSegment || !this.videoPlayer) return;

        const currentTime = this.videoPlayer.currentTime;
        const inputId = type === 'start' ? 'segment-start-time' : 'segment-end-time';
        const input = document.getElementById(inputId);

        if (input) {
            input.value = this.formatTime(currentTime);
        }

        // Clear the flag since user is manually setting time
        this.shouldClearOthersOnSave = false;
    }

    /**
     * Set segment to full duration
     */
    setSegmentToFullDuration() {
        if (!this.selectedSegment || !this.videoPlayer) return;

        const startInput = document.getElementById('segment-start-time');
        const endInput = document.getElementById('segment-end-time');

        if (startInput && endInput) {
            startInput.value = this.formatTime(0);
            endInput.value = this.formatTime(this.videoPlayer.duration);

            // Flag that this is a full duration segment that should clear others when saved
            this.shouldClearOthersOnSave = true;
        }
    }

    /**
     * Save segment changes from editor
     */
    saveSegmentChanges() {
        if (!this.selectedSegment) return;

        const startInput = document.getElementById('segment-start-time');
        const endInput = document.getElementById('segment-end-time');

        if (!startInput || !endInput) return;

        const startTime = this.parseTime(startInput.value);
        const endTime = this.parseTime(endInput.value);

        // Validation
        if (isNaN(startTime) || isNaN(endTime)) {
            this.showSegmentError('Invalid time format. Use MM:SS format.');
            return;
        }

        // Ensure end > start
        if (endTime <= startTime) {
            this.showSegmentError('End time must be after start time.');
            return;
        }

        // If this is a full duration segment from the "All" button, clear other segments
        if (this.shouldClearOthersOnSave) {
            const trackId = this.selectedSegment.trackId;
            const timeline = this.tracksContainer?.querySelector(`[data-track-id="${trackId}"]`);

            // Remove all other segments
            this.audioSegments[trackId] = this.audioSegments[trackId].filter(s => s.id === this.selectedSegment.id);

            // Remove their DOM elements
            if (timeline) {
                timeline.querySelectorAll('.track-segment').forEach(el => {
                    if (el.dataset.segmentId !== this.selectedSegment.id) {
                        el.remove();
                    }
                });
            }

            // Reset the flag
            this.shouldClearOthersOnSave = false;
        } else {
            // Normal overlap checking for manual edits
            const otherSegments = this.audioSegments[this.selectedSegment.trackId]
                .filter(s => s.id !== this.selectedSegment.id);

            for (const segment of otherSegments) {
                if ((startTime >= segment.startTime && startTime < segment.endTime) ||
                    (endTime > segment.startTime && endTime <= segment.endTime) ||
                    (startTime <= segment.startTime && endTime >= segment.endTime)) {
                    this.showSegmentError(`Time range overlaps with another segment (${this.formatTime(segment.startTime)} - ${this.formatTime(segment.endTime)})`);
                    return;
                }
            }
        }

        // All validations passed - save the changes
        this.selectedSegment.startTime = startTime;
        this.selectedSegment.endTime = endTime;

        // Save volume adjustment
        const volumeSlider = document.getElementById('segment-volume');
        if (volumeSlider) {
            this.selectedSegment.volume = parseInt(volumeSlider.value);
        }

        // Update the visual element
        this.updateSegmentElement(this.selectedSegment);

        // Flash a save confirmation
        const saveBtn = document.getElementById('save-segment-btn');
        if (saveBtn) {
            const originalText = saveBtn.innerHTML;
            saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved';
            saveBtn.style.background = 'var(--accent)'; // Use theme color
            setTimeout(() => {
                saveBtn.innerHTML = originalText;
                saveBtn.style.background = ''; // Reset to default
            }, 1000);
        }

        // Clear any error message
        this.clearSegmentError();
    }

    /**
     * Show error message in segment editor
     */
    showSegmentError(message) {
        // Create or update error message element
        let errorEl = document.getElementById('segment-error-message');
        if (!errorEl) {
            errorEl = document.createElement('div');
            errorEl.id = 'segment-error-message';
            errorEl.className = 'segment-error-message';
            const segmentEditor = document.getElementById('segment-editor');
            if (segmentEditor) {
                segmentEditor.appendChild(errorEl);
            }
        }
        errorEl.textContent = message;
        errorEl.style.display = 'block';

        // Auto-hide after 5 seconds
        clearTimeout(this.errorTimeout);
        this.errorTimeout = setTimeout(() => {
            this.clearSegmentError();
        }, 5000);
    }

    /**
     * Clear segment error message
     */
    clearSegmentError() {
        const errorEl = document.getElementById('segment-error-message');
        if (errorEl) {
            errorEl.style.display = 'none';
        }
    }

    // Removed moveSegmentToTrack - no longer needed without track selector

    /**
     * Delete selected segment
     */
    deleteSelectedSegment() {
        if (!this.selectedSegment) return;

        const trackId = this.selectedSegment.trackId;

        // Remove from array
        this.audioSegments[trackId] = this.audioSegments[trackId].filter(s => s.id !== this.selectedSegment.id);

        // Remove element
        const segmentEl = this.tracksContainer?.querySelector(`[data-segment-id="${this.selectedSegment.id}"]`);
        if (segmentEl) segmentEl.remove();

        // Hide editor
        if (this.segmentEditor) {
            this.segmentEditor.style.display = 'none';
        }

        this.selectedSegment = null;
    }

    /**
     * Clear all segments
     */
    clearAllSegments() {
        // Clear all segments
        for (const trackId in this.audioSegments) {
            this.audioSegments[trackId] = [];
        }

        // Remove all segment elements
        this.tracksContainer?.querySelectorAll('.track-segment').forEach(el => el.remove());

        // Update audio tracks for current position
        if (this.videoPlayer) {
            this.updateAudioTracksForSegments(this.videoPlayer.currentTime);
        }

        // Hide editor
        if (this.segmentEditor) {
            this.segmentEditor.style.display = 'none';
        }

        this.selectedSegment = null;
    }

    /**
     * Generate thumbnails for exported video
     */
    async generateThumbnailsForExport(exportedVideoPath) {

        try {
            const parsed = path.parse(exportedVideoPath);
            const thumbnailFolder = path.join(parsed.dir, `${parsed.name}_thumbs`);

            // Filter events within mark in/out range if set
            let eventsToProcess = this.currentEvents;
            if (this.markIn !== null || this.markOut !== null) {
                const markIn = this.markIn || 0;
                const markOut = this.markOut || Infinity;

                eventsToProcess = this.currentEvents.filter(event => {
                    const eventTime = event.videoOffset || 0;
                    return eventTime >= markIn && eventTime <= markOut;
                }).map(event => {
                    // Adjust video offset to be relative to the new start time
                    return {
                        ...event,
                        videoOffset: (event.videoOffset || 0) - (markIn || 0)
                    };
                });
            }

            if (eventsToProcess.length === 0) {
                return;
            }

            // Use the selected main thumbnail event ID if available
            let mainEventId = this.selectedMainThumbnailEventId;

            // If a main event was selected but it's outside the clip bounds, don't use it
            if (mainEventId && (this.markIn !== null || this.markOut !== null)) {
                const selectedEvent = this.currentEvents.find(e => e.id === mainEventId);
                if (selectedEvent) {
                    const eventTime = selectedEvent.videoOffset || 0;
                    const markIn = this.markIn || 0;
                    const markOut = this.markOut || Infinity;
                    if (eventTime < markIn || eventTime > markOut) {
                        mainEventId = null; // Event is outside bounds, use random selection
                    }
                }
            }

            // Update export modal to show thumbnail generation step
            this.updateExportProgress('thumbnails');

            // Listen for thumbnail progress updates
            const progressListener = (event, progress) => {
                // Update the export modal's progress details with thumbnail progress
                const percentEl = document.getElementById('export-progress-percent');
                const detailsEl = document.getElementById('export-progress-time');
                if (percentEl) {
                    const percent = Math.round((progress.current / progress.total) * 100);
                    percentEl.textContent = `${percent}%`;
                }
                if (detailsEl) {
                    detailsEl.textContent = `Thumbnail ${progress.current} of ${progress.total}`;
                }
            };

            ipcRenderer.on('thumbnail-progress', progressListener);

            // Generate thumbnails
            const result = await ipcRenderer.invoke('generate-thumbnails', {
                videoPath: exportedVideoPath,
                events: eventsToProcess,
                outputFolder: thumbnailFolder,
                mainEventId: mainEventId
            });

            // Remove progress listener
            ipcRenderer.removeListener('thumbnail-progress', progressListener);

            if (result.success) {

                // Update the exported JSON file if it exists
                const jsonPath = exportedVideoPath.replace(/\.[^.]+$/, '.json');
                try {
                    const fs = require('fs').promises;
                    const jsonExists = await fs.access(jsonPath).then(() => true).catch(() => false);

                    if (jsonExists) {
                        // Build thumbnail map
                        const thumbnailMap = {};
                        result.thumbnails.forEach(thumb => {
                            if (thumb.success) {
                                thumbnailMap[thumb.eventId] = `${parsed.name}_thumbs/${thumb.eventId}.jpg`;
                            }
                        });

                        // Update JSON with thumbnails
                        const content = await fs.readFile(jsonPath, 'utf8');
                        const data = JSON.parse(content);

                        if (result.mainThumbnail) {
                            data.metadata = data.metadata || {};
                            data.metadata.videoThumbnail = result.mainThumbnail;
                        }

                        data.events.forEach(event => {
                            if (thumbnailMap[event.id]) {
                                event.thumbnail = thumbnailMap[event.id];
                            }
                        });

                        await fs.writeFile(jsonPath, JSON.stringify(data, null, 2));
                    }
                } catch (error) {
                    console.error('Failed to update exported JSON with thumbnails:', error);
                }
            } else {
                console.error('Thumbnail generation failed:', result.error);
            }
        } catch (error) {
            console.error('Error generating thumbnails for export:', error);
        }
    }

    /**
     * Apply preset configuration
     */
    applyPreset(preset) {
        if (!this.videoPlayer || !this.videoPlayer.duration) return;

        const duration = this.videoPlayer.duration;

        // Clear existing segments
        this.clearAllSegments();

        // Apply preset based on type
        switch (preset) {
            case 'all':
                // Enable all tracks for full duration
                this.audioTracks.forEach(track => {
                    this.audioSegments[track.id] = [{
                        id: `segment-${Date.now()}-${track.id}`,
                        trackId: track.id,
                        startTime: 0,
                        endTime: duration
                    }];
                });
                break;

            case 'game':
                // Only game audio
                const gameTrack = this.audioTracks.find(t => t.name.toLowerCase().includes('game'));
                if (gameTrack) {
                    this.audioSegments[gameTrack.id] = [{
                        id: `segment-${Date.now()}-${gameTrack.id}`,
                        trackId: gameTrack.id,
                        startTime: 0,
                        endTime: duration
                    }];
                }
                break;

            case 'voice':
                // Only voice chat
                const voiceTrack = this.audioTracks.find(t => t.name.toLowerCase().includes('voice'));
                if (voiceTrack) {
                    this.audioSegments[voiceTrack.id] = [{
                        id: `segment-${Date.now()}-${voiceTrack.id}`,
                        trackId: voiceTrack.id,
                        startTime: 0,
                        endTime: duration
                    }];
                }
                break;

            case 'microphone':
                // Only microphone
                const micTrack = this.audioTracks.find(t => t.name.toLowerCase().includes('microphone'));
                if (micTrack) {
                    this.audioSegments[micTrack.id] = [{
                        id: `segment-${Date.now()}-${micTrack.id}`,
                        trackId: micTrack.id,
                        startTime: 0,
                        endTime: duration
                    }];
                }
                break;
        }

        // Recreate all segment elements
        for (const trackId in this.audioSegments) {
            const timeline = this.tracksContainer?.querySelector(`[data-track-id="${trackId}"]`);
            if (timeline) {
                this.audioSegments[trackId].forEach(segment => {
                    this.createSegmentElement(segment, timeline);
                });
            }
        }
    }

    /**
     * Update mixer playhead position
     */
    updateMixerPlayhead() {
        if (!this.mixerPlayhead || !this.videoPlayer || !this.videoPlayer.duration) return;

        const currentTime = this.videoPlayer.currentTime;
        const duration = this.videoPlayer.duration;
        const position = (currentTime / duration) * 100;

        this.mixerPlayhead.style.left = `${position}%`;
    }

    /**
     * Update mixer mark in/out lines
     */
    updateMixerMarkLines() {
        if (!this.videoPlayer || !this.videoPlayer.duration) return;

        const duration = this.videoPlayer.duration;
        const markInLine = document.getElementById('mixer-mark-in');
        const markOutLine = document.getElementById('mixer-mark-out');

        // Update mark in line
        if (markInLine) {
            if (this.markIn !== null && this.markIn !== undefined) {
                const markInPosition = (this.markIn / duration) * 100;
                markInLine.style.left = `${markInPosition}%`;
                markInLine.style.display = 'block';
            } else {
                markInLine.style.display = 'none';
            }
        }

        // Update mark out line
        if (markOutLine) {
            if (this.markOut !== null && this.markOut !== undefined) {
                const markOutPosition = (this.markOut / duration) * 100;
                markOutLine.style.left = `${markOutPosition}%`;
                markOutLine.style.display = 'block';
            } else {
                markOutLine.style.display = 'none';
            }
        }
    }

    /**
     * Update track select options
     */
    updateTrackSelect() {
        // Track select removed from UI
    }

    /**
     * Format time in seconds to MM:SS
     */
    formatTime(seconds) {
        if (!seconds && seconds !== 0) return '00:00';

        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);

        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Parse time string to seconds
     */
    parseTime(timeStr) {
        const parts = timeStr.split(':');
        if (parts.length !== 2) return NaN;

        const mins = parseInt(parts[0]);
        const secs = parseInt(parts[1]);

        if (isNaN(mins) || isNaN(secs)) return NaN;

        return mins * 60 + secs;
    }

    /**
     * Get audio mixer configuration for export
     */
    getAudioMixerConfig() {
        const config = {
            tracks: [],
            segments: []
        };


        // Collect enabled tracks and their segments
        this.audioTracks.forEach(track => {
            if (track.enabled && this.audioSegments[track.id]?.length > 0) {
                config.tracks.push({
                    id: track.id,
                    name: track.name
                });

                this.audioSegments[track.id].forEach(segment => {
                    config.segments.push({
                        trackId: track.id,
                        startTime: segment.startTime,
                        endTime: segment.endTime,
                        volume: segment.volume || 0
                    });
                });
            }
        });

        return config;
    }

    /**
     * Show export progress modal
     */
    showExportModal() {
        const modal = document.getElementById('export-progress-modal');
        if (modal) {
            modal.style.display = 'flex';

            // Reset modal title
            const header = modal.querySelector('.modal-header h3');
            if (header) header.textContent = 'Exporting Video';

            // Reset all steps
            document.querySelectorAll('.progress-step').forEach(step => {
                step.classList.remove('active', 'completed');
                step.style.display = 'none';
            });

            // Show and activate prepare step
            const prepareStep = document.getElementById('step-prepare');
            if (prepareStep) {
                prepareStep.style.display = 'flex';
                prepareStep.classList.add('active');
            }

            // Reset progress bar
            const progressBar = document.getElementById('export-modal-progress');
            if (progressBar) progressBar.style.width = '0%';

            const progressPercent = document.getElementById('export-progress-percent');
            if (progressPercent) progressPercent.textContent = '0%';

            // Show cancel button, hide completion buttons
            const cancelBtn = document.getElementById('cancel-export-btn');
            const openFolderBtn = document.getElementById('open-output-folder-btn');
            const closeBtn = document.getElementById('close-export-modal-btn');

            if (cancelBtn) {
                cancelBtn.style.display = 'inline-block';
                cancelBtn.onclick = () => {
                    this.cancelExport();
                };
            }
            if (openFolderBtn) {
                openFolderBtn.style.display = 'none';
            }
            if (closeBtn) {
                closeBtn.style.display = 'none';
            }

            // Hide stats section
            const statsSection = document.getElementById('export-complete-stats');
            if (statsSection) {
                statsSection.style.display = 'none';
            }
        }
    }

    /**
     * Hide export progress modal
     */
    hideExportModal() {
        const modal = document.getElementById('export-progress-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    /**
     * Show alert message (non-blocking)
     */
    showAlert(message, type = 'info') {
        const alertDiv = document.createElement('div');
        alertDiv.className = `video-editor-alert alert-${type}`;
        alertDiv.textContent = message;

        // Style based on type
        const colors = {
            'info': '#4a9eff',
            'success': '#4aff9e',
            'warning': '#ff9e4a',
            'error': '#ff4444'
        };

        alertDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            color: white;
            background: ${colors[type] || colors.info};
            padding: 12px 20px;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            z-index: 10000;
            max-width: 400px;
            animation: slideIn 0.3s ease-out;
        `;

        document.body.appendChild(alertDiv);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            alertDiv.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => alertDiv.remove(), 300);
        }, 5000);
    }

    /**
     * Show error in export modal or as inline message
     */
    showExportError(message, isValidationError = false) {
        if (isValidationError) {
            // For validation errors, show inline message
            const errorDiv = document.createElement('div');
            errorDiv.className = 'export-error-message';
            errorDiv.textContent = message;
            errorDiv.style.cssText = 'color: #ff4444; padding: 10px; background: rgba(255,68,68,0.1); border-radius: 4px; margin: 10px 0;';

            // Find export button and insert error after it
            const exportBtn = document.querySelector('.export-btn');
            if (exportBtn && exportBtn.parentNode) {
                // Remove any existing error message
                const existing = exportBtn.parentNode.querySelector('.export-error-message');
                if (existing) existing.remove();

                exportBtn.parentNode.insertBefore(errorDiv, exportBtn.nextSibling);

                // Auto-remove after 5 seconds
                setTimeout(() => errorDiv.remove(), 5000);
            }
        } else {
            // For export errors, show in modal
            const modal = document.getElementById('export-progress-modal');
            if (modal) {
                const header = modal.querySelector('.modal-header h3');
                if (header) header.textContent = 'Export Failed';

                const statusEl = document.getElementById('export-status');
                if (statusEl) {
                    statusEl.innerHTML = `<div style="color: #ff4444;">${message}</div>`;
                }

                // Hide progress bar
                const progressBar = document.getElementById('export-modal-progress');
                if (progressBar) progressBar.style.display = 'none';

                // Show only close button
                const cancelBtn = document.getElementById('cancel-export-btn');
                const openFolderBtn = document.getElementById('open-output-folder-btn');
                const closeBtn = document.getElementById('close-export-modal-btn');

                if (cancelBtn) cancelBtn.style.display = 'none';
                if (openFolderBtn) openFolderBtn.style.display = 'none';
                if (closeBtn) closeBtn.style.display = 'inline-block';
            }
        }
    }

    /**
     * Show completion buttons in the export modal
     */
    showCompletionButtons(outputDir) {
        const cancelBtn = document.getElementById('cancel-export-btn');
        const openFolderBtn = document.getElementById('open-output-folder-btn');
        const closeBtn = document.getElementById('close-export-modal-btn');

        // Hide cancel button
        if (cancelBtn) {
            cancelBtn.style.display = 'none';
        }

        // Show and setup open folder button
        if (openFolderBtn) {
            openFolderBtn.style.display = 'inline-block';
            openFolderBtn.onclick = async () => {
                try {
                    await ipcRenderer.invoke('open-folder', outputDir);
                } catch (error) {
                    console.error('Failed to open folder:', error);
                }
            };
        }

        // Show and setup close button
        if (closeBtn) {
            closeBtn.style.display = 'inline-block';
            closeBtn.onclick = () => {
                this.hideExportModal();
            };
        }
    }

    /**
     * Show export statistics
     */
    async showExportStats(outputPath, exportTimeMs, exportData) {
        const statsSection = document.getElementById('export-complete-stats');
        if (!statsSection) return;

        // Show the stats section
        statsSection.style.display = 'block';

        // Get file size
        try {
            const fileStats = await ipcRenderer.invoke('get-file-stats', outputPath);
            const fileSizeElement = document.getElementById('export-file-size');
            if (fileSizeElement && fileStats && fileStats.size) {
                fileSizeElement.textContent = this.formatFileSize(fileStats.size);
            }
        } catch (error) {
            console.error('Failed to get file stats:', error);
        }

        // Calculate and display video duration
        const durationElement = document.getElementById('export-video-duration');
        if (durationElement) {
            let duration = 0;
            if (exportData.markIn !== undefined && exportData.markOut !== undefined) {
                duration = exportData.markOut - exportData.markIn;
            } else if (this.videoDuration) {
                duration = this.videoDuration;
            }
            durationElement.textContent = this.formatDuration(duration);
        }

        // Display export time
        const exportTimeElement = document.getElementById('export-time-taken');
        if (exportTimeElement) {
            exportTimeElement.textContent = this.formatExportTime(exportTimeMs);
        }

        // Display output path
        const pathElement = document.getElementById('export-output-path');
        if (pathElement) {
            pathElement.textContent = outputPath;
        }
    }

    /**
     * Format file size in human readable format
     */
    formatFileSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(2)} ${units[unitIndex]}`;
    }

    /**
     * Format duration in HH:MM:SS format
     */
    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Format export time in human readable format
     */
    formatExportTime(milliseconds) {
        const seconds = milliseconds / 1000;

        if (seconds < 60) {
            return `${seconds.toFixed(1)} seconds`;
        }

        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);

        if (minutes < 60) {
            return `${minutes}m ${remainingSeconds}s`;
        }

        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    }

    /**
     * Update export progress
     */
    updateExportProgress(step) {
        const steps = {
            'prepare': 'step-prepare',
            'cut': 'step-cut',
            'audio': 'step-audio',
            'encode': 'step-encode',
            'save': 'step-save',
            'thumbnails': 'step-thumbnails'
        };

        const stepElements = {
            'prepare': 0,
            'cut': 15,
            'audio': 30,
            'encode': 50,
            'save': 70,
            'thumbnails': 85,
            'completed': 100
        };

        if (step === 'completed') {
            // Mark all steps as completed
            Object.values(steps).forEach(stepId => {
                const element = document.getElementById(stepId);
                if (element) {
                    element.classList.remove('active');
                    element.classList.add('completed');
                    element.style.display = 'flex';
                }
            });

            // Update progress to 100%
            const progressBar = document.getElementById('export-modal-progress');
            if (progressBar) progressBar.style.width = '100%';

            const progressPercent = document.getElementById('export-progress-percent');
            if (progressPercent) progressPercent.textContent = '100%';
        } else if (steps[step]) {
            // Mark previous steps as completed
            const stepOrder = ['prepare', 'cut', 'audio', 'encode', 'save', 'thumbnails'];
            const currentIndex = stepOrder.indexOf(step);

            stepOrder.forEach((s, index) => {
                const element = document.getElementById(steps[s]);
                if (element) {
                    if (index < currentIndex) {
                        element.classList.remove('active');
                        element.classList.add('completed');
                        element.style.display = 'flex';
                    } else if (index === currentIndex) {
                        element.classList.add('active');
                        element.classList.remove('completed');
                        element.style.display = 'flex';
                    }
                }
            });

            // Update progress bar
            const progress = stepElements[step] || 0;
            const progressBar = document.getElementById('export-modal-progress');
            if (progressBar) progressBar.style.width = `${progress}%`;

            const progressPercent = document.getElementById('export-progress-percent');
            if (progressPercent) progressPercent.textContent = `${progress}%`;
        }
    }

    /**
     * Cancel export
     */
    cancelExport() {
        // TODO: Implement actual export cancellation
        this.hideExportModal();
        console.log('Export cancelled by user');
    }

    /**
     * Helper delay function
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Initialize when the edit video view is shown
window.videoEditorController = null;

window.initializeVideoEditor = function() {
    if (!window.videoEditorController) {
        console.log('Creating VideoEditorController instance...');
        window.videoEditorController = new VideoEditorController();
    }
};