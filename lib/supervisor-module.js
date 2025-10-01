const EventEmitter = require('events');
const Logger = require('./logger');

// Import all managers
const OBSProcessManager = require('./managers/obs-process-manager');
const WebSocketManager = require('./managers/websocket-manager');
const SCProcessMonitor = require('./managers/sc-process-monitor');
const SCLogMonitor = require('./managers/sc-log-monitor');
const UploadManager = require('./managers/upload-manager');

/**
 * Supervisor Module
 * Coordinates all manager instances and maintains application state
 */
class SupervisorModule extends EventEmitter {
    constructor() {
        super();
        this.logger = new Logger('supervisor');
        this.managers = new Map();
        this.state = {
            obs: { process: 'stopped', websocket: 'disconnected', encoder: 'pending' },
            starCitizen: { running: false, instance: null },
            recording: { active: false, outputPath: null, startTime: null },
            events: []
        };
        this.config = null;
        this.shutdownRequested = false;
        this.currentRecording = null;
        this.capturedEvents = [];

        // Rate limiting for OBS restarts
        this.obsRestartAttempts = 0;
        this.lastOBSRestartTime = null;
        this.maxOBSRestartAttempts = 3;
        this.obsRestartCooldown = 60000; // 1 minute cooldown between restart attempts

        // Auto-start and file splitting
        this.autoStartEnabled = false;
        this.autoStartTriggered = false;
        this.fileSplitTimer = null;
        this.fileSplitDuration = 5; // minutes
        this.shadowPlayEnabled = false;
        this.maxStorageGB = 50;
        this.minFilesToKeep = 5;
        this.maxFilesToKeep = 0; // 0 = disabled

        // Metadata saving state
        this.savingMetadata = false;
    }

    /**
     * Initialize the supervisor with config
     */
    async initialize(config) {
        this.logger.log('Initializing supervisor module...');
        this.config = config;

        // Load recording options from config
        if (config?.settings?.recordingOptions) {
            const opts = config.settings.recordingOptions;
            this.autoStartEnabled = opts.autoStartRecording || false;
            this.shadowPlayEnabled = opts.enableShadowPlay || false;
            this.fileSplitDuration = opts.fileSplitDuration || 5;
            this.maxStorageGB = opts.maxStorageGB || 50;
            this.minFilesToKeep = opts.minFilesToKeep !== undefined ? opts.minFilesToKeep : 5;
            this.maxFilesToKeep = opts.maxFilesToKeep !== undefined ? opts.maxFilesToKeep : 0;

            this.logger.log('Recording options loaded:', {
                autoStart: this.autoStartEnabled,
                shadowPlay: this.shadowPlayEnabled,
                splitDuration: this.fileSplitDuration,
                maxStorage: this.maxStorageGB,
                minFiles: this.minFilesToKeep,
                maxFiles: this.maxFilesToKeep
            });
        }

        try {
            // Create and initialize all managers
            await this.createManagers();

            // Setup inter-manager communication
            this.setupManagerCommunication();
            
            // Start periodic health checks
            this.startHealthChecks();
            
            // Start initial services based on config
            if (config.autoStartOBS) {
                await this.startOBS();
            }
            
            if (config.autoMonitorSC) {
                await this.startSCMonitoring();
            }
            
            this.logger.log('Supervisor module initialized successfully');
            this.emit('initialized');
            
            return true;
        } catch (error) {
            this.logger.error('Failed to initialize supervisor:', error);
            throw error;
        }
    }

    /**
     * Create and initialize all managers
     */
    async createManagers() {
        this.logger.log('Creating managers...');

        // Create manager instances
        const obsManager = new OBSProcessManager();
        const wsManager = new WebSocketManager();
        const scProcessMonitor = new SCProcessMonitor();
        const scLogMonitor = new SCLogMonitor();
        const uploadManager = new UploadManager();

        // Store managers
        this.managers.set('obs-process', obsManager);
        this.managers.set('websocket', wsManager);
        this.managers.set('sc-process', scProcessMonitor);
        this.managers.set('sc-log', scLogMonitor);
        this.managers.set('upload', uploadManager);
        
        // Initialize all managers
        for (const [name, manager] of this.managers) {
            this.logger.log(`Initializing ${name} manager...`);
            // Pass config to upload manager
            if (name === 'upload') {
                await manager.initialize(this.config);
            } else {
                await manager.initialize();
            }
            
            // Setup heartbeat monitoring
            manager.on('heartbeat', () => {
                // Could track heartbeats if needed
            });
        }
        
        this.logger.log('All managers created and initialized');
    }

    /**
     * Setup communication between managers
     */
    setupManagerCommunication() {
        const obsManager = this.managers.get('obs-process');
        const wsManager = this.managers.get('websocket');
        const scProcessMonitor = this.managers.get('sc-process');
        const scLogMonitor = this.managers.get('sc-log');
        const uploadManager = this.managers.get('upload');
        
        // OBS Process Manager events
        obsManager.on('status-update', (data) => {
            // Only update process-related fields, not websocket status
            if (data.process !== undefined) {
                this.state.obs.process = data.process;
            }
            if (data.error !== undefined) {
                this.state.obs.error = data.error;
            }
            if (data.exitCode !== undefined) {
                this.state.obs.exitCode = data.exitCode;
            }
            this.emit('state-changed', this.state);
            this.checkAutoStart();
        });
        
        // Handle WebSocket config separately
        obsManager.on('websocket-config', (config) => {
            // When OBS provides WebSocket config, attempt to connect
            if (this.state.obs.process === 'running') {
                wsManager.handleCommand({
                    type: 'connect',
                    config: config
                });
            }
        });
        
        obsManager.on('error', (error) => {
            this.logger.error('OBS error:', error);
            this.emit('error', { source: 'obs-process', error });
        });
        
        // Handle unexpected OBS exits (crashes or manual closes)
        obsManager.on('unexpected-exit', async (exitInfo) => {
            this.logger.warn(`OBS exited unexpectedly: code=${exitInfo.code}, signal=${exitInfo.signal}`);
            
            // Check if auto-restart is enabled (default: true)
            const autoRestart = this.config?.obs?.autoRestart !== false;
            
            if (!autoRestart) {
                this.logger.log('Auto-restart is disabled, not attempting recovery');
                return;
            }
            
            // Check if we're within the restart limit
            const now = Date.now();
            if (this.lastOBSRestartTime && (now - this.lastOBSRestartTime) > this.obsRestartCooldown) {
                // Reset attempts if cooldown period has passed
                this.obsRestartAttempts = 0;
            }
            
            if (this.obsRestartAttempts >= this.maxOBSRestartAttempts) {
                this.logger.error(`OBS restart limit reached (${this.maxOBSRestartAttempts} attempts). Manual intervention required.`);
                this.emit('error', { 
                    source: 'obs-recovery', 
                    error: 'OBS keeps crashing. Please check OBS logs and restart manually.',
                    requiresManualIntervention: true 
                });
                return;
            }
            
            // Increment restart attempts
            this.obsRestartAttempts++;
            this.lastOBSRestartTime = now;
            
            // Wait a bit before restarting to avoid rapid restarts
            const restartDelay = Math.min(this.obsRestartAttempts * 2000, 10000); // Exponential backoff, max 10s
            
            this.logger.log(`Attempting to restart OBS (attempt ${this.obsRestartAttempts}/${this.maxOBSRestartAttempts}) after ${restartDelay}ms delay...`);
            
            setTimeout(async () => {
                try {
                    await this.startOBS();
                    this.logger.log('OBS recovered successfully');
                    
                    // Reset attempts on successful recovery
                    if (this.state.obs.process === 'running') {
                        this.obsRestartAttempts = 0;
                    }
                } catch (error) {
                    this.logger.error('Failed to recover OBS:', error);
                    // The next unexpected exit will trigger another attempt
                }
            }, restartDelay);
        });
        
        // WebSocket Manager events
        wsManager.on('status-update', (data) => {
            this.state.obs = { ...this.state.obs, ...data };
            this.emit('state-changed', this.state);
            this.checkAutoStart();
        });
        
        wsManager.on('recording-status', (data) => {
            this.state.recording = { ...this.state.recording, ...data };
            
            // Track recording start/stop for metadata
            // Check both 'active' and 'outputActive' for compatibility
            const isActive = data.active || data.outputActive;
            const recordingPath = data.path || data.outputPath;
            
            if (isActive && recordingPath && !this.currentRecording) {
                // Recording started
                const startTime = new Date();
                this.currentRecording = {
                    path: recordingPath,
                    startTime: startTime.toISOString(),
                    startTimestamp: startTime.getTime(),
                    events: []
                };
                this.capturedEvents = [];
                this.logger.log(`Recording started: ${recordingPath}`);
                
                // Add recording start event
                const startEvent = {
                    id: `evt_${startTime.getTime()}_${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: startTime.toISOString(),
                    videoOffset: 0,
                    videoTimecode: "00:00:00.000",
                    type: "system",
                    subtype: "recording_start",
                    name: "Recording Started",
                    message: "Recording started",
                    severity: "low",
                    category: "system",
                    categoryInfo: {},
                    data: {
                        startTime: startTime.toISOString()
                    },
                    raw: null
                };
                this.capturedEvents.push(startEvent);
            } else if (!isActive && this.currentRecording) {
                // Recording stopped - save metadata (only if not already saving)
                const lastPath = this.currentRecording.path;

                if (!this.savingMetadata) {
                    this.savingMetadata = true;
                    this.logger.log(`Recording stopped, saving metadata...`);

                    // Save metadata asynchronously and handle completion
                    this.saveRecordingMetadata().finally(() => {
                        this.savingMetadata = false;
                    });
                } else {
                    this.logger.log('Metadata save already in progress, skipping duplicate save');
                }

                // Include the last recording path in the status
                data.lastRecordingPath = lastPath;
            }

            this.emit('state-changed', this.state);
            this.checkAutoStart();
            this.emit('recording-status', data);
        });
        
        // Handle recording split (file changed during recording)
        wsManager.on('recording-split', async (data) => {
            this.logger.log('Recording split detected:', data);
            
            if (this.currentRecording && data.newPath) {
                // Save the current events to JSON for the old file
                this.logger.log(`Saving metadata for split file: ${this.currentRecording.path}`);
                await this.saveRecordingMetadata();
                
                // Start new recording metadata for the new file
                const startTime = new Date();
                this.currentRecording = {
                    path: data.newPath,
                    startTime: startTime.toISOString(),
                    startTimestamp: startTime.getTime(),
                    events: []
                };
                this.capturedEvents = [];
                
                // Add recording start event for the new split file
                const startEvent = {
                    id: `evt_${startTime.getTime()}_${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: startTime.toISOString(),
                    videoOffset: 0,
                    videoTimecode: "00:00:00.000",
                    type: "system",
                    subtype: "recording_split",
                    name: "Recording Split",
                    message: "Recording continued in new file",
                    severity: "low",
                    category: "system",
                    categoryInfo: {},
                    data: {
                        previousPath: data.oldPath,
                        splitTime: startTime.toISOString()
                    },
                    raw: null
                };
                this.capturedEvents.push(startEvent);
                
                this.logger.log(`Started new recording metadata for: ${data.newPath}`);
                
                // Notify UI about the split
                this.emit('recording-split', {
                    oldPath: data.oldPath,
                    newPath: data.newPath,
                    timestamp: data.timestamp
                });

                // Check storage and cleanup after split
                if (this.shadowPlayEnabled) {
                    this.checkStorageAndCleanup();
                }
            }
        });
        
        wsManager.on('recording-stats', (data) => {
            this.emit('recording-stats', data);
        });
        
        wsManager.on('audio-devices', (data) => {
            this.emit('audio-devices', data);
        });
        
        wsManager.on('applications', (data) => {
            this.emit('applications', data);
        });
        
        wsManager.on('error', (error) => {
            this.logger.error('WebSocket error:', error);
            this.emit('error', { source: 'websocket', error });
        });
        
        wsManager.on('obs-connection-failed', async (data) => {
            this.logger.error('OBS connection failed:', data.message);
            
            // Check rate limiting
            const now = Date.now();
            const timeSinceLastRestart = this.lastOBSRestartTime ? 
                now - this.lastOBSRestartTime : this.obsRestartCooldown;
            
            // Reset attempts if cooldown has passed
            if (timeSinceLastRestart >= this.obsRestartCooldown) {
                this.obsRestartAttempts = 0;
            }
            
            // Check if we've exceeded max attempts
            if (this.obsRestartAttempts >= this.maxOBSRestartAttempts) {
                this.logger.error(`OBS restart limit reached (${this.maxOBSRestartAttempts} attempts)`);
                this.emit('error', { 
                    source: 'obs-connection', 
                    error: `OBS connection failed after ${this.maxOBSRestartAttempts} restart attempts`,
                    requiresManualIntervention: true,
                    canRetryAfter: new Date(this.lastOBSRestartTime + this.obsRestartCooldown).toISOString()
                });
                return;
            }
            
            // Check if OBS is actually running
            const obsManager = this.managers.get('obs-process');
            const obsRunning = await obsManager.isOBSRunning();
            
            if (!obsRunning) {
                this.logger.log(`OBS not running, attempting restart (attempt ${this.obsRestartAttempts + 1}/${this.maxOBSRestartAttempts})...`);
                this.obsRestartAttempts++;
                this.lastOBSRestartTime = now;
                await this.restartOBS();
            } else {
                // OBS is running but WebSocket can't connect - this might be a WebSocket issue
                this.logger.log('OBS is running but WebSocket cannot connect, forcing WebSocket reconnection...');
                
                // Try forcing a WebSocket reconnection first
                const wsManager = this.managers.get('websocket');
                wsManager.forceReconnection();
                
                // If this fails again, it will trigger another event
                this.emit('warning', { 
                    source: 'obs-connection', 
                    message: 'OBS is running but WebSocket connection failed, attempting reconnection'
                });
            }
        });
        
        // SC Process Monitor events
        scProcessMonitor.on('sc-status', (data) => {
            this.state.starCitizen = { ...this.state.starCitizen, ...data };
            this.emit('state-changed', this.state);
            this.checkAutoStart();
        });
        
        scProcessMonitor.on('monitor-logs', (data) => {
            // Forward to log monitor
            scLogMonitor.handleCommand({
                type: 'monitor-multiple',
                data: data
            });
        });
        
        scProcessMonitor.on('sc-stopped', () => {
            scLogMonitor.handleCommand({ type: 'stop-monitoring' });
        });
        
        // SC Log Monitor events
        scLogMonitor.on('sc-status', (data) => {
            this.state.starCitizen = { ...this.state.starCitizen, ...data };
            this.emit('state-changed', this.state);
            this.checkAutoStart();
        });
        
        scLogMonitor.on('sc-instance-detected', (data) => {
            // Notify process monitor
            scProcessMonitor.handleCommand({
                type: 'sc-instance-detected',
                data: data
            });
        });
        
        scLogMonitor.on('event', (event) => {
            // Add to events list (keep last 100)
            this.state.events.unshift(event);
            if (this.state.events.length > 100) {
                this.state.events.pop();
            }
            
            // Capture event if recording
            if (this.currentRecording) {
                const now = Date.now();
                const videoOffset = (now - new Date(this.currentRecording.startTime).getTime()) / 1000;
                
                const capturedEvent = {
                    id: `evt_${now}_${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: new Date().toISOString(),
                    videoOffset: videoOffset,
                    videoTimecode: this.formatTimecode(videoOffset),
                    type: event.type,
                    subtype: event.subtype,
                    name: event.name,
                    message: event.message,
                    severity: event.severity || 'medium',
                    category: event.type,
                    categoryInfo: event.categoryInfo || {},
                    data: event.data || {},
                    raw: event.raw || null
                };
                
                this.capturedEvents.push(capturedEvent);
                this.logger.log(`Event captured during recording: ${event.type}/${event.subtype}`);
                
                // Emit event with captured wrapper for UI
                this.emit('event', { captured: capturedEvent });
            } else {
                // Not recording, just forward the event
                this.emit('event', event);
            }
        });

        // Upload Manager events
        uploadManager.on('state-changed', (state) => {
            this.state.upload = state;
            this.emit('state-changed', this.state);
            this.emit('upload-state-changed', state);
        });

        uploadManager.on('upload-queued', (upload) => {
            this.emit('upload-queued', upload);
        });

        uploadManager.on('upload-started', (upload) => {
            this.emit('upload-started', upload);
        });

        uploadManager.on('upload-progress', (progress) => {
            this.emit('upload-progress', progress);
        });

        uploadManager.on('upload-completed', (upload) => {
            this.emit('upload-completed', upload);
        });

        uploadManager.on('upload-failed', (upload) => {
            this.emit('upload-failed', upload);
        });

        uploadManager.on('upload-cancelled', (upload) => {
            this.emit('upload-cancelled', upload);
        });

        uploadManager.on('account-added', (account) => {
            this.emit('account-added', account);
        });

        uploadManager.on('account-updated', (account) => {
            this.emit('account-updated', account);
        });

        uploadManager.on('account-deleted', (accountId) => {
            this.emit('account-deleted', accountId);
        });

        uploadManager.on('error', (error) => {
            this.logger.error('Upload manager error:', error);
            this.emit('error', { source: 'upload', error });
        });

        uploadManager.on('log', (message) => {
            this.logger.log(`[Upload] ${message}`);
        });
    }

    /**
     * Start OBS
     */
    async startOBS() {
        this.logger.log('Starting OBS...');
        const obsManager = this.managers.get('obs-process');
        await obsManager.handleCommand({
            type: 'start',
            config: this.config?.obs || {}
        });
    }

    /**
     * Stop OBS
     */
    async stopOBS() {
        this.logger.log('Stopping OBS...');
        const obsManager = this.managers.get('obs-process');
        await obsManager.handleCommand({ type: 'stop' });
    }

    /**
     * Restart OBS
     */
    async restartOBS() {
        this.logger.log('Restarting OBS...');
        const obsManager = this.managers.get('obs-process');
        const wsManager = this.managers.get('websocket');
        
        // Disconnect WebSocket first
        await wsManager.handleCommand({ type: 'disconnect' });
        
        // Restart OBS
        await obsManager.handleCommand({
            type: 'restart',
            config: this.config?.obs || {}
        });
        
        // Force reconnection after OBS restarts
        setTimeout(() => {
            wsManager.forceReconnection();
        }, 3000);
    }

    /**
     * Start Star Citizen monitoring
     */
    async startSCMonitoring() {
        this.logger.log('Starting Star Citizen monitoring...');
        const scProcessMonitor = this.managers.get('sc-process');
        
        // Get the Star Citizen path from the config
        const scPath = this.config?.settings?.starCitizen?.path || 
                      this.config?.starCitizenPath;
        
        if (scPath) {
            this.logger.log(`Using Star Citizen path: ${scPath}`);
        } else {
            this.logger.log('No Star Citizen path configured');
        }
        
        await scProcessMonitor.handleCommand({
            type: 'start-monitoring',
            config: { starCitizenPath: scPath }
        });
    }

    /**
     * Check if auto-start should trigger
     */
    checkAutoStart() {
        if (!this.autoStartEnabled || this.autoStartTriggered) {
            return;
        }

        // Check if all systems are ready
        const isReady =
            this.state.obs?.process === 'running' &&
            this.state.obs?.websocket === 'connected' &&
            this.state.starCitizen?.running === true;

        if (isReady && !this.state.recording?.active) {
            this.logger.log('All systems ready - triggering auto-start recording');
            this.autoStartTriggered = true;
            this.startRecording();
        }
    }

    /**
     * Start file split timer
     */
    startFileSplitTimer() {
        if (!this.shadowPlayEnabled || this.fileSplitDuration <= 0) {
            return;
        }

        // Clear any existing timer
        if (this.fileSplitTimer) {
            clearTimeout(this.fileSplitTimer);
        }

        const splitDurationMs = this.fileSplitDuration * 60 * 1000; // Convert minutes to ms
        this.logger.log(`Starting file split timer for ${this.fileSplitDuration} minutes`);

        this.fileSplitTimer = setTimeout(() => {
            if (this.state.recording?.active) {
                this.logger.log('File split timer triggered - splitting recording');
                this.splitRecording();
            }
        }, splitDurationMs);
    }

    /**
     * Stop file split timer
     */
    stopFileSplitTimer() {
        if (this.fileSplitTimer) {
            clearTimeout(this.fileSplitTimer);
            this.fileSplitTimer = null;
            this.logger.log('File split timer stopped');
        }
    }

    /**
     * Start recording
     */
    async startRecording() {
        this.logger.log('Starting recording...');
        const wsManager = this.managers.get('websocket');
        await wsManager.handleCommand({ type: 'start-recording' });

        // Start file split timer if shadow play is enabled
        this.startFileSplitTimer();

        // Check storage if shadow play is enabled
        if (this.shadowPlayEnabled) {
            this.checkStorageAndCleanup();
        }
    }

    /**
     * Stop recording
     */
    async stopRecording() {
        this.logger.log('Stopping recording...');
        const wsManager = this.managers.get('websocket');
        await wsManager.handleCommand({ type: 'stop-recording' });

        // Stop file split timer
        this.stopFileSplitTimer();
    }

    /**
     * Split recording to a new file
     */
    async splitRecording() {
        this.logger.log('Splitting recording to new file...');
        const wsManager = this.managers.get('websocket');
        await wsManager.handleCommand({ type: 'split-recording' });

        // Restart the split timer for the next split
        if (this.shadowPlayEnabled) {
            this.startFileSplitTimer();
        }

        // Check storage and cleanup after split
        if (this.shadowPlayEnabled) {
            this.checkStorageAndCleanup();
        }
    }

    /**
     * Toggle recording on/off
     */
    async toggleRecording() {
        const state = this.getState();
        if (state.recording && state.recording.active) {
            this.logger.log('Toggling recording OFF');
            await this.stopRecording();
        } else {
            this.logger.log('Toggling recording ON');
            await this.startRecording();
        }
    }

    /**
     * Add a manual event marker
     */
    addManualEvent(event) {
        this.logger.log('Adding manual event:', event);

        // Check if we're recording
        if (!this.currentRecording) {
            this.logger.warn('Cannot add manual event - no active recording');
            return;
        }

        // Create captured event with proper timestamps (same pattern as SC log events)
        const now = Date.now();
        const videoOffset = (now - new Date(this.currentRecording.startTime).getTime()) / 1000;

        const capturedEvent = {
            id: `evt_${now}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            videoOffset: videoOffset,
            videoTimecode: this.formatTimecode(videoOffset),
            type: event.type,
            subtype: event.subtype,
            name: event.name,
            message: event.message,
            severity: event.severity || 'medium',
            category: event.category || event.type,
            categoryInfo: event.categoryInfo || {},
            data: event.data || {},
            raw: event.raw || null
        };

        // Add to captured events array (will be saved with recording)
        this.capturedEvents.push(capturedEvent);
        this.logger.log(`Manual event captured: ${event.type}/${event.subtype}`);

        // Emit event for UI with captured wrapper
        this.emit('event', { captured: capturedEvent });

        const state = this.getState();
        if (state.recording && state.recording.active) {
            this.logger.log('Manual event added and will be saved with current recording');
        }
    }

    /**
     * Get recording stats
     */
    async getRecordingStats() {
        const wsManager = this.managers.get('websocket');
        await wsManager.handleCommand({ type: 'get-recording-stats' });
    }

    /**
     * Get audio devices
     */
    async getAudioDevices() {
        const wsManager = this.managers.get('websocket');
        await wsManager.handleCommand({ type: 'get-audio-devices' });
    }

    /**
     * Get applications
     */
    async getApplications() {
        const wsManager = this.managers.get('websocket');
        await wsManager.handleCommand({ type: 'get-applications' });
    }

    /**
     * Check storage and cleanup old recordings if needed
     */
    async checkStorageAndCleanup() {
        if (!this.shadowPlayEnabled || !this.config?.settings?.recording?.outputPath) {
            return;
        }

        const fs = require('fs').promises;
        const path = require('path');

        try {
            const recordingsPath = path.join(this.config.settings.recording.outputPath, 'recordings');

            // Get all files in recordings folder
            const files = await fs.readdir(recordingsPath);
            const videoFiles = files.filter(f => f.endsWith('.mkv') || f.endsWith('.mp4'));

            // Check if we need to do any cleanup
            if (videoFiles.length === 0) return;

            // Get file stats
            const fileStats = await Promise.all(
                videoFiles.map(async (file) => {
                    const filePath = path.join(recordingsPath, file);
                    const stats = await fs.stat(filePath);
                    return {
                        name: file,
                        path: filePath,
                        size: stats.size,
                        mtime: stats.mtime
                    };
                })
            );

            // Sort by modification time (oldest first)
            fileStats.sort((a, b) => a.mtime - b.mtime);

            let filesToDelete = [];

            // PRIORITY 1: Check storage limit first (most critical)
            const totalSizeBytes = fileStats.reduce((sum, file) => sum + file.size, 0);
            const totalSizeGB = totalSizeBytes / (1024 * 1024 * 1024);

            if (this.maxStorageGB > 0 && totalSizeGB > this.maxStorageGB) {
                this.logger.log(`Storage limit exceeded: ${totalSizeGB.toFixed(2)}GB / ${this.maxStorageGB}GB`);

                // Delete oldest files until we're under the limit
                let currentSize = totalSizeGB;

                for (const file of fileStats) {
                    // Check if we should stop deleting
                    const remainingFiles = fileStats.length - filesToDelete.length;
                    const wouldViolateMinimum = this.minFilesToKeep > 0 && remainingFiles <= this.minFilesToKeep;
                    const underStorageTarget = currentSize <= this.maxStorageGB * 0.9; // 90% threshold

                    if (underStorageTarget) {
                        break; // We're under the storage target
                    }

                    if (wouldViolateMinimum) {
                        this.logger.warn(`Cannot delete more files - would violate minimum files setting (${this.minFilesToKeep})`);
                        this.logger.warn(`Storage still over limit: ${currentSize.toFixed(2)}GB / ${this.maxStorageGB}GB`);
                        break;
                    }

                    filesToDelete.push(file);
                    currentSize -= file.size / (1024 * 1024 * 1024);
                }
            }

            // PRIORITY 2: Check maximum file count (if enabled and not already over storage)
            if (this.maxFilesToKeep > 0 && fileStats.length > this.maxFilesToKeep) {
                const currentDeleteCount = filesToDelete.length;
                const remainingFiles = fileStats.length - currentDeleteCount;

                if (remainingFiles > this.maxFilesToKeep) {
                    const excessFiles = remainingFiles - this.maxFilesToKeep;
                    this.logger.log(`File count limit exceeded: ${fileStats.length} files / max ${this.maxFilesToKeep}`);

                    // Mark additional oldest files for deletion
                    let additionalDeletes = 0;
                    for (let i = 0; i < fileStats.length && additionalDeletes < excessFiles; i++) {
                        if (!filesToDelete.includes(fileStats[i])) {
                            // Check minimum files constraint
                            const wouldViolateMinimum = this.minFilesToKeep > 0 &&
                                (fileStats.length - filesToDelete.length - 1) < this.minFilesToKeep;

                            if (wouldViolateMinimum) {
                                this.logger.warn(`Cannot delete more files - would violate minimum files setting (${this.minFilesToKeep})`);
                                break;
                            }

                            filesToDelete.push(fileStats[i]);
                            additionalDeletes++;
                        }
                    }
                }
            }

            // Delete the files
            if (filesToDelete.length > 0) {
                for (const file of filesToDelete) {
                    try {
                        await fs.unlink(file.path);
                        // Also try to delete associated JSON file
                        const jsonPath = file.path.replace(/\.(mkv|mp4)$/, '.json');
                        await fs.unlink(jsonPath).catch(() => {}); // Ignore if doesn't exist
                        this.logger.log(`Deleted old recording: ${file.name}`);
                    } catch (error) {
                        this.logger.error(`Failed to delete ${file.name}:`, error);
                    }
                }

                this.logger.log(`Cleaned up ${filesToDelete.length} old recordings`);
            }
        } catch (error) {
            this.logger.error('Error checking storage:', error);
        }
    }

    /**
     * Get current state
     */
    getState() {
        return this.state;
    }

    /**
     * Start periodic health checks
     */
    startHealthChecks() {
        // Check OBS health every 30 seconds
        this.healthCheckInterval = setInterval(async () => {
            if (this.state.obs.process === 'running') {
                const obsManager = this.managers.get('obs-process');
                const wsManager = this.managers.get('websocket');
                
                // Check if OBS process is still running
                const obsRunning = await obsManager.isOBSRunning();
                
                if (!obsRunning) {
                    this.logger.error('OBS process died unexpectedly');
                    this.state.obs.process = 'stopped';
                    this.emit('state-changed', this.state);
            this.checkAutoStart();
                    
                    // Only attempt restart if we haven't exceeded limits
                    const now = Date.now();
                    const timeSinceLastRestart = this.lastOBSRestartTime ? 
                        now - this.lastOBSRestartTime : this.obsRestartCooldown;
                    
                    if (timeSinceLastRestart >= this.obsRestartCooldown) {
                        this.obsRestartAttempts = 0;
                    }
                    
                    if (this.obsRestartAttempts < this.maxOBSRestartAttempts) {
                        this.logger.log('Attempting to restart OBS...');
                        this.obsRestartAttempts++;
                        this.lastOBSRestartTime = now;
                        await this.restartOBS();
                    } else {
                        this.emit('error', { 
                            source: 'obs-health-check', 
                            error: 'OBS process died and restart limit reached',
                            requiresManualIntervention: true 
                        });
                    }
                } else if (this.state.obs.websocket === 'disconnected') {
                    // OBS is running but WebSocket is disconnected
                    const disconnectedTime = wsManager.lastDisconnectTime || 0;
                    const timeSinceDisconnect = Date.now() - disconnectedTime;
                    
                    // If WebSocket has been disconnected for more than 60 seconds, try to force reconnect
                    if (timeSinceDisconnect > 60000) {
                        this.logger.log('WebSocket disconnected for too long, forcing reconnection...');
                        wsManager.forceReconnection();
                    }
                }
            }
        }, 30000); // Check every 30 seconds
    }

    /**
     * Stop health checks
     */
    stopHealthChecks() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    /**
     * Format seconds to timecode string
     */
    formatTimecode(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }
    
    /**
     * Save recording metadata to JSON file
     */
    async saveRecordingMetadata() {
        if (!this.currentRecording || !this.currentRecording.path) {
            this.logger.log('No recording metadata to save');
            return;
        }
        
        try {
            const fs = require('fs').promises;
            const path = require('path');
            
            // Get the base name without extension
            const videoPath = this.currentRecording.path.replace(/\//g, path.sep);
            const baseName = path.basename(videoPath, path.extname(videoPath));
            const dirName = path.dirname(videoPath);
            const jsonPath = path.join(dirName, `${baseName}.json`);
            
            // Calculate recording duration
            const endTime = new Date();
            const startTime = new Date(this.currentRecording.startTime);
            const duration = (endTime - startTime) / 1000;
            
            // Add recording stop event
            const stopEvent = {
                id: `evt_${endTime.getTime()}_${Math.random().toString(36).substr(2, 9)}`,
                timestamp: endTime.toISOString(),
                videoOffset: duration,
                videoTimecode: this.formatTimecode(duration),
                type: "system",
                subtype: "recording_stop",
                name: "Recording Stopped",
                message: `Recording stopped after ${this.formatTimecode(duration)}`,
                severity: "low",
                category: "system",
                categoryInfo: {},
                data: {
                    stopTime: endTime.toISOString(),
                    duration: duration
                },
                raw: null
            };
            this.capturedEvents.push(stopEvent);
            
            // Build category summary
            const categories = {};
            for (const event of this.capturedEvents) {
                if (!categories[event.type]) {
                    categories[event.type] = {
                        count: 0,
                        types: {}
                    };
                }
                categories[event.type].count++;
                const subtype = event.subtype || 'default';
                categories[event.type].types[subtype] = (categories[event.type].types[subtype] || 0) + 1;
            }
            
            // Prepare metadata in exact format
            const metadata = {
                metadata: {
                    version: '1.0.0',
                    recorder: 'SC-Recorder',
                    recordingStartTime: this.currentRecording.startTime,
                    recordingStartTimecode: new Date(this.currentRecording.startTime).getTime(),
                    recordingDuration: duration,
                    eventCount: this.capturedEvents.length,
                    categories: categories,
                    savedAt: endTime.toISOString()
                },
                events: this.capturedEvents
            };
            
            // Save to file atomically to prevent corruption
            const jsonContent = JSON.stringify(metadata, null, 2);
            const tempPath = jsonPath + '.tmp.' + Date.now();

            try {
                // Write to temporary file first
                await fs.writeFile(tempPath, jsonContent);

                // Atomically rename temp file to final location
                await fs.rename(tempPath, jsonPath);

                this.logger.log(`Recording metadata saved: ${jsonPath} (${this.capturedEvents.length} events)`);
            } catch (err) {
                // Clean up temp file if rename failed
                try {
                    await fs.unlink(tempPath);
                } catch (cleanupErr) {
                    // Ignore cleanup errors
                }
                throw err;
            }
            
            // Emit event for UI notification
            this.emit('events-saved', {
                success: true,
                path: jsonPath,
                eventCount: this.capturedEvents.length
            });
            
            // Clear current recording
            this.currentRecording = null;
            this.capturedEvents = [];
        } catch (error) {
            this.logger.error('Failed to save recording metadata:', error);
            this.emit('events-saved', {
                success: false,
                error: error.message
            });
        }
    }

    /**
     * Update recording options from new config
     */
    updateRecordingOptions(config) {
        if (config?.settings?.recordingOptions) {
            const opts = config.settings.recordingOptions;
            const wasAutoStartEnabled = this.autoStartEnabled;

            this.autoStartEnabled = opts.autoStartRecording || false;
            this.shadowPlayEnabled = opts.enableShadowPlay || false;
            this.fileSplitDuration = opts.fileSplitDuration || 5;
            this.maxStorageGB = opts.maxStorageGB || 50;
            this.minFilesToKeep = opts.minFilesToKeep !== undefined ? opts.minFilesToKeep : 5;
            this.maxFilesToKeep = opts.maxFilesToKeep !== undefined ? opts.maxFilesToKeep : 0;

            // Reset auto-start trigger if it was disabled and re-enabled
            if (!wasAutoStartEnabled && this.autoStartEnabled) {
                this.autoStartTriggered = false;
            }

            this.logger.log('Recording options updated:', {
                autoStart: this.autoStartEnabled,
                shadowPlay: this.shadowPlayEnabled,
                splitDuration: this.fileSplitDuration,
                maxStorage: this.maxStorageGB,
                minFiles: this.minFilesToKeep,
                maxFiles: this.maxFilesToKeep
            });

            // If recording is active and split duration changed, restart timer
            if (this.state.recording?.active && this.shadowPlayEnabled) {
                this.startFileSplitTimer();
            }
        }
    }

    /**
     * Shutdown the supervisor
     */
    async shutdown() {
        if (this.shutdownRequested) return;
        
        this.logger.log('Shutting down supervisor...');
        this.shutdownRequested = true;
        
        // Stop health checks
        this.stopHealthChecks();
        
        // Shutdown all managers
        for (const [name, manager] of this.managers) {
            this.logger.log(`Shutting down ${name}...`);
            try {
                await manager.shutdown();
            } catch (error) {
                this.logger.error(`Error shutting down ${name}:`, error);
            }
        }
        
        this.logger.log('Supervisor shutdown complete');
        this.emit('shutdown');
    }

    /**
     * Handle upload-related commands
     */
    async handleUploadCommand(command) {
        const uploadManager = this.managers.get('upload');
        if (!uploadManager) {
            throw new Error('Upload manager not initialized');
        }
        return await uploadManager.handleCommand(command);
    }

    /**
     * Add an account for uploading
     */
    async addUploadAccount(data) {
        return await this.handleUploadCommand({
            action: 'ADD_ACCOUNT',
            data
        });
    }

    /**
     * Update an upload account
     */
    async updateUploadAccount(data) {
        return await this.handleUploadCommand({
            action: 'UPDATE_ACCOUNT',
            data
        });
    }

    /**
     * Delete an upload account
     */
    async deleteUploadAccount(data) {
        return await this.handleUploadCommand({
            action: 'DELETE_ACCOUNT',
            data
        });
    }

    /**
     * List upload accounts
     */
    async listUploadAccounts(data) {
        return await this.handleUploadCommand({
            action: 'LIST_ACCOUNTS',
            data
        });
    }

    /**
     * Test an upload account
     */
    async testUploadAccount(data) {
        return await this.handleUploadCommand({
            action: 'TEST_ACCOUNT',
            data
        });
    }

    /**
     * Queue a file for upload
     */
    async uploadFile(data) {
        return await this.handleUploadCommand({
            action: 'UPLOAD_FILE',
            data
        });
    }

    /**
     * Cancel an upload
     */
    async cancelUpload(data) {
        return await this.handleUploadCommand({
            action: 'CANCEL_UPLOAD',
            data
        });
    }

    /**
     * Get upload status
     */
    async getUploadStatus() {
        return await this.handleUploadCommand({
            action: 'GET_UPLOAD_STATUS'
        });
    }

    /**
     * Get upload manager state
     */
    async getUploadState() {
        return await this.handleUploadCommand({
            action: 'GET_STATE'
        });
    }

    /**
     * Clear completed uploads
     */
    async clearCompletedUploads() {
        return await this.handleUploadCommand({
            action: 'CLEAR_COMPLETED'
        });
    }

    /**
     * Remove from upload queue
     */
    async removeFromQueue(data) {
        return await this.handleUploadCommand({
            action: 'REMOVE_FROM_QUEUE',
            data: data
        });
    }

    /**
     * Remove completed upload
     */
    async removeCompletedUpload(data) {
        return await this.handleUploadCommand({
            action: 'REMOVE_COMPLETED',
            data: data
        });
    }

    /**
     * Start upload queue
     */
    async startUploadQueue() {
        return await this.handleUploadCommand({
            action: 'START_QUEUE'
        });
    }

    /**
     * Pause upload queue
     */
    async pauseUploadQueue() {
        return await this.handleUploadCommand({
            action: 'PAUSE_QUEUE'
        });
    }

    /**
     * Get upload queue status
     */
    async getUploadQueueStatus() {
        return await this.handleUploadCommand({
            action: 'GET_QUEUE_STATUS'
        });
    }
}

module.exports = SupervisorModule;