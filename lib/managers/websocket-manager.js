const OBSWebSocket = require('obs-websocket-js').default;
const BaseManager = require('./base-manager');
const Logger = require('../logger');

/**
 * WebSocket Manager
 * Manages WebSocket connection to OBS
 */
class WebSocketManager extends BaseManager {
    constructor() {
        super('websocket');
        this.logger = new Logger('websocket-manager');
        this.obs = new OBSWebSocket();
        this.connected = false;
        this.connectionConfig = null;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectBackoff = 1000; // Start with 1 second
        this.shutdownRequested = false;
        this.forceReconnect = false; // Flag for forced reconnection after OBS restart
        this.lastConnectionTime = null;
        this.connectionFailures = 0;
        this.currentRecordingPath = null; // Store the current recording path
        
        // Setup OBS event handlers
        this.setupOBSEventHandlers();
    }

    /**
     * Handle commands from supervisor
     */
    async handleCommand(command) {
        switch (command.type) {
            case 'connect':
                await this.connect(command.config);
                break;
                
            case 'disconnect':
                await this.disconnect();
                break;
                
            case 'command':
                await this.executeCommand(command.command, command.params);
                break;
                
            case 'start-recording':
                await this.startRecording();
                break;
                
            case 'stop-recording':
                await this.stopRecording();
                break;
                
            case 'split-recording':
                await this.splitRecording();
                break;
                
            case 'get-recording-stats':
                await this.getRecordingStats();
                break;
                
            case 'check-status':
                this.checkStatus();
                break;
                
            case 'get-audio-devices':
                await this.getAudioDevices();
                break;
                
            case 'get-applications':
                await this.getApplications();
                break;
                
            case 'shutdown':
                await this.shutdown();
                break;
                
            default:
                this.logger.log(`Unknown command type: ${command.type}`);
        }
    }

    /**
     * Setup OBS WebSocket event handlers
     */
    setupOBSEventHandlers() {
        // Connection events
        this.obs.on('ConnectionOpened', () => {
            this.logger.log('Connected to OBS');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.connectionFailures = 0;
            this.lastConnectionTime = Date.now();
            this.forceReconnect = false;
            
            // Emit status update immediately
            this.emit('status-update', { websocket: 'connected' });
            
            // Also force a full status check after a short delay to ensure everything is synced
            setTimeout(() => {
                if (this.connected) {
                    this.logger.log('Forcing status check after WebSocket connection');
                    this.emit('status-update', { 
                        websocket: 'connected',
                        encoder: 'ready' // OBS always has at least software encoding
                    });
                }
            }, 500);
        });

        this.obs.on('ConnectionClosed', () => {
            this.logger.log('Disconnected from OBS');
            this.connected = false;
            this.lastDisconnectTime = Date.now();
            
            this.emit('status-update', { websocket: 'disconnected' });
            
            // Attempt reconnection if not shutting down
            if (!this.shutdownRequested && this.connectionConfig) {
                // If we were connected recently, this might be an OBS restart
                const wasRecentlyConnected = this.lastConnectionTime && 
                    (Date.now() - this.lastConnectionTime) < 60000; // Within last minute
                
                if (wasRecentlyConnected || this.forceReconnect) {
                    this.logger.log('Recent disconnection detected, attempting immediate reconnection');
                    this.reconnectAttempts = 0; // Reset attempts for OBS restart scenario
                }
                
                this.scheduleReconnect();
            }
        });

        this.obs.on('ConnectionError', (error) => {
            this.logger.error('Connection error:', error);
            this.connected = false;
            
            this.emit('status-update', { websocket: 'error', error: error.message });
        });

        // Recording events
        this.obs.on('RecordStateChanged', (data) => {
            this.logger.log('Recording state changed:', data);
            
            // Store the recording path when recording starts
            if (data.outputActive && data.outputPath) {
                this.currentRecordingPath = data.outputPath;
                this.logger.log('Recording started, path:', this.currentRecordingPath);
            } else if (!data.outputActive) {
                // Clear path when recording stops
                this.currentRecordingPath = null;
            }
            
            this.emit('recording-status', {
                active: data.outputActive,
                state: data.outputState,
                path: data.outputPath,
                outputPath: data.outputPath
            });
        });

        // RecordFileChanged event - updates the file path during recording (split)
        this.obs.on('RecordFileChanged', (data) => {
            this.logger.log('Recording file changed:', data);
            
            // The field name is newOutputPath in v5
            const newPath = data.newOutputPath || data.newPath;
            if (newPath) {
                const oldPath = this.currentRecordingPath;
                this.currentRecordingPath = newPath;
                this.logger.log('Recording file updated from:', oldPath, 'to:', newPath);
                
                // Emit event to notify supervisor about the file split
                this.emit('recording-split', {
                    oldPath: oldPath,
                    newPath: newPath,
                    timestamp: new Date().toISOString()
                });
            }
        });
        
        // Stream events (for monitoring)
        this.obs.on('StreamStateChanged', (data) => {
            this.logger.log('Stream state changed:', data);
        });
    }

    /**
     * Connect to OBS WebSocket
     */
    async connect(config) {
        if (this.connected) {
            this.logger.log('Already connected');
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.connectionConfig = config || {
            port: 4455,
            password: ''
        };

        const url = `ws://127.0.0.1:${this.connectionConfig.port}`;
        
        this.logger.log(`Connecting to ${url}...`);

        try {
            await this.obs.connect(url, this.connectionConfig.password);
            
            // Get initial status
            await this.getInitialStatus();
            
        } catch (error) {
            this.logger.error('Connection failed:', error);
            
            this.emit('status-update', { 
                websocket: 'error', 
                error: error.message 
            });
            
            // Schedule reconnection
            if (this.connectionConfig) {
                this.scheduleReconnect();
            }
        }
    }

    /**
     * Disconnect from OBS WebSocket
     */
    async disconnect() {
        if (!this.connected) {
            return;
        }

        this.logger.log('Disconnecting...');
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        try {
            await this.obs.disconnect();
        } catch (error) {
            this.logger.error('Disconnect error:', error);
        }

        this.connected = false;
        this.connectionConfig = null;
    }

    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        // Clear any existing timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        // Check if we've exceeded max attempts
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.connectionFailures++;
            
            // After multiple connection failures, notify supervisor to check OBS process
            if (this.connectionFailures >= 3) {
                this.logger.error('Multiple connection failures detected, OBS may need restart');
                this.emit('obs-connection-failed', { 
                    failures: this.connectionFailures,
                    message: 'Unable to connect to OBS after multiple attempts'
                });
                
                // Reset for next round of attempts after longer delay
                setTimeout(() => {
                    this.reconnectAttempts = 0;
                    this.scheduleReconnect();
                }, 60000); // Wait 1 minute before trying again
                return;
            }
            
            this.logger.error('Max reconnection attempts reached, will retry in 30 seconds');
            this.reconnectAttempts = 0; // Reset for next round
            
            // Schedule next round after delay
            this.reconnectTimer = setTimeout(() => {
                this.connect(this.connectionConfig);
            }, 30000);
            return;
        }

        // Calculate backoff time
        let backoffTime;
        if (this.forceReconnect || this.reconnectAttempts === 0) {
            // First attempt or forced reconnect: try quickly
            backoffTime = 1000; // 1 second
        } else {
            // Exponential backoff with max of 30 seconds
            backoffTime = Math.min(
                this.reconnectBackoff * Math.pow(2, this.reconnectAttempts - 1),
                30000
            );
        }

        this.logger.log(`Reconnecting in ${backoffTime}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
        
        this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect(this.connectionConfig);
        }, backoffTime);
    }
    
    /**
     * Force reconnection (used after OBS restart)
     */
    forceReconnection() {
        this.logger.log('Forcing reconnection to OBS');
        this.forceReconnect = true;
        this.reconnectAttempts = 0;
        this.connectionFailures = 0;
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        // Try to connect immediately
        if (this.connectionConfig) {
            this.connect(this.connectionConfig);
        }
    }

    /**
     * Get initial OBS status
     */
    async getInitialStatus() {
        try {
            // Get version info
            const version = await this.obs.call('GetVersion');
            this.logger.log('OBS Version:', version.obsVersion);
            
            // Get recording status
            const recordStatus = await this.obs.call('GetRecordStatus');
            
            this.emit('recording-status', {
                active: recordStatus.outputActive,
                duration: recordStatus.outputDuration,
                bytes: recordStatus.outputBytes
            });
            
            // Get available encoders
            await this.detectEncoders();
            
        } catch (error) {
            this.logger.error('Error getting initial status:', error);
        }
    }

    /**
     * Detect available encoders
     */
    async detectEncoders() {
        try {
            // Since we're connected to OBS, encoders are available
            // OBS will have at least software encoding available
            this.emit('status-update', { 
                encoder: 'ready'
            });
        } catch (error) {
            this.logger.error('Error detecting encoders:', error);
        }
    }

    /**
     * Get audio devices from OBS
     */
    async getAudioDevices() {
        if (!this.connected) {
            this.logger.error('Not connected to OBS');
            this.emit('audio-devices', { outputs: [], inputs: [] });
            return;
        }

        try {
            this.logger.log('Getting audio devices...');
            
            // For OBS WebSocket v5, we need to create temporary sources to detect devices
            // First, get or create a temporary scene
            const tempSceneName = '__SC_TEMP_AUDIO_DETECT__';
            
            // Try to create the scene (will fail if it exists, that's ok)
            try {
                await this.obs.call('CreateScene', { sceneName: tempSceneName });
            } catch (e) {
                // Scene might already exist, that's fine
            }
            
            const audioDevices = {
                outputs: [],
                inputs: []
            };
            
            // Create temporary audio sources to get device lists
            const tempInputName = '__temp_audio_input__';
            const tempOutputName = '__temp_audio_output__';
            
            try {
                // Create wasapi input capture to get input devices
                await this.obs.call('CreateInput', {
                    sceneName: tempSceneName,
                    inputName: tempInputName,
                    inputKind: 'wasapi_input_capture',
                    inputSettings: {}
                });
                
                // Get properties to see available devices
                const inputProps = await this.obs.call('GetInputPropertiesListPropertyItems', {
                    inputName: tempInputName,
                    propertyName: 'device_id'
                });
                
                if (inputProps && inputProps.propertyItems) {
                    inputProps.propertyItems.forEach(item => {
                        if (item.itemName && item.itemValue) {
                            audioDevices.inputs.push({
                                id: item.itemValue,
                                name: item.itemName,
                                isDefault: item.itemName.toLowerCase().includes('default')
                            });
                        }
                    });
                }
                
                // Remove temp input
                await this.obs.call('RemoveInput', { inputName: tempInputName });
                
            } catch (error) {
                this.logger.error('Error getting input devices:', error);
                // Add default input
                audioDevices.inputs.push({ 
                    id: 'default', 
                    name: 'Default Microphone', 
                    isDefault: true 
                });
            }
            
            try {
                // Create wasapi output capture to get output devices
                await this.obs.call('CreateInput', {
                    sceneName: tempSceneName,
                    inputName: tempOutputName,
                    inputKind: 'wasapi_output_capture',
                    inputSettings: {}
                });
                
                // Get properties to see available devices
                const outputProps = await this.obs.call('GetInputPropertiesListPropertyItems', {
                    inputName: tempOutputName,
                    propertyName: 'device_id'
                });
                
                if (outputProps && outputProps.propertyItems) {
                    outputProps.propertyItems.forEach(item => {
                        if (item.itemName && item.itemValue) {
                            audioDevices.outputs.push({
                                id: item.itemValue,
                                name: item.itemName,
                                isDefault: item.itemName.toLowerCase().includes('default')
                            });
                        }
                    });
                }
                
                // Remove temp output
                await this.obs.call('RemoveInput', { inputName: tempOutputName });
                
            } catch (error) {
                this.logger.error('Error getting output devices:', error);
                // Add default output
                audioDevices.outputs.push({ 
                    id: 'default', 
                    name: 'Default Speakers', 
                    isDefault: true 
                });
            }
            
            // Clean up temp scene
            try {
                await this.obs.call('RemoveScene', { sceneName: tempSceneName });
            } catch (e) {
                // Ignore cleanup errors
            }
            
            // If no devices found, add defaults
            if (audioDevices.inputs.length === 0) {
                audioDevices.inputs.push({ 
                    id: 'default', 
                    name: 'Default Microphone', 
                    isDefault: true 
                });
            }
            if (audioDevices.outputs.length === 0) {
                audioDevices.outputs.push({ 
                    id: 'default', 
                    name: 'Default Speakers', 
                    isDefault: true 
                });
            }
            
            this.logger.log('Found audio devices:', {
                inputs: audioDevices.inputs.length,
                outputs: audioDevices.outputs.length
            });
            
            // Send back to supervisor
            this.emit('audio-devices', audioDevices);
            
        } catch (error) {
            this.logger.error('Error getting audio devices:', error);
            this.emit('audio-devices', { 
                outputs: [{ id: 'default', name: 'Default Speakers', isDefault: true }],
                inputs: [{ id: 'default', name: 'Default Microphone', isDefault: true }]
            });
        }
    }

    /**
     * Get available applications for audio capture
     */
    async getApplications() {
        if (!this.connected) {
            this.logger.error('Not connected to OBS');
            this.emit('applications', []);
            return;
        }

        try {
            this.logger.log('Getting available applications...');
            
            const applications = [];
            const tempSceneName = '__SC_TEMP_APP_DETECT__';
            
            // Try to create the scene (will fail if it exists, that's ok)
            try {
                await this.obs.call('CreateScene', { sceneName: tempSceneName });
            } catch (e) {
                // Scene might already exist, that's fine
            }
            
            const tempAppName = '__temp_app_capture__';
            
            try {
                // Create process output capture to get application list
                await this.obs.call('CreateInput', {
                    sceneName: tempSceneName,
                    inputName: tempAppName,
                    inputKind: 'wasapi_process_output_capture',
                    inputSettings: {}
                });
                
                // Get properties to see available applications
                const appProps = await this.obs.call('GetInputPropertiesListPropertyItems', {
                    inputName: tempAppName,
                    propertyName: 'window'
                });
                
                if (appProps && appProps.propertyItems) {
                    appProps.propertyItems.forEach(item => {
                        if (item.itemValue && item.itemValue !== '') {
                            // itemValue format: "Title:WindowClass:Executable.exe"
                            const parts = item.itemValue.split(':');
                            if (parts.length === 3) {
                                const appName = parts[2].replace('.exe', '').replace('.EXE', '');
                                applications.push({
                                    id: item.itemValue,  // Full format for OBS
                                    name: item.itemName || appName,  // Display name
                                    executable: parts[2],  // Just the exe name
                                    windowClass: parts[1],  // Window class for matching
                                    fullFormat: item.itemValue  // Original full format
                                });
                            }
                        }
                    });
                }
                
                // Remove temp input
                await this.obs.call('RemoveInput', { inputName: tempAppName });
                
            } catch (error) {
                this.logger.error('Error getting applications:', error);
            }
            
            // Clean up temp scene
            try {
                await this.obs.call('RemoveScene', { sceneName: tempSceneName });
            } catch (e) {
                // Ignore cleanup errors
            }
            
            this.logger.log('Found applications:', applications.length);
            
            // Send back to supervisor
            this.emit('applications', applications);
            
        } catch (error) {
            this.logger.error('Error getting applications:', error);
            this.emit('applications', []);
        }
    }

    /**
     * Execute OBS command
     */
    async executeCommand(command, params = {}) {
        if (!this.connected) {
            this.logger.error('Not connected to OBS');
            this.emit('error', 'Not connected to OBS');
            return;
        }

        try {
            const result = await this.obs.call(command, params);
            
            this.emit('command-result', { command, result });
            
            return result;
        } catch (error) {
            this.logger.error(`Command ${command} failed:`, error);
            
            this.emit('error', `Command ${command} failed: ${error.message}`);
        }
    }

    /**
     * Start recording
     */
    async startRecording() {
        this.logger.log('Starting recording...');
        await this.executeCommand('StartRecord');
    }

    /**
     * Stop recording
     */
    async stopRecording() {
        this.logger.log('Stopping recording...');
        const result = await this.executeCommand('StopRecord');
        
        if (result && result.outputPath) {
            this.emit('recording-status', {
                active: false,
                path: result.outputPath,
                outputPath: result.outputPath
            });
        }
    }

    /**
     * Split recording to a new file
     */
    async splitRecording() {
        if (!this.connected) {
            this.logger.error('Not connected to OBS');
            throw new Error('Not connected to OBS');
        }
        
        this.logger.log('Splitting recording to new file...');
        try {
            // First check if we're actually recording
            const status = await this.obs.call('GetRecordStatus');
            if (!status.outputActive) {
                throw new Error('Not currently recording');
            }
            
            this.logger.log('Current recording status:', {
                active: status.outputActive,
                state: status.outputState,
                path: this.currentRecordingPath
            });
            
            // Use SplitRecordFile - this splits the recording into a new file
            // This only works with certain formats (MKV, FLV, but not MP4)
            const result = await this.obs.call('SplitRecordFile');
            this.logger.log('Recording split successfully, result:', result);
            
            // The RecordFileChanged event should fire with the new path
            // which we'll capture and store in currentRecordingPath
            
            return result;
        } catch (error) {
            this.logger.error('Failed to split recording. Full error:', JSON.stringify(error, null, 2));
            
            // Log more details about the error
            if (error.code) {
                this.logger.error('Error code:', error.code, 'Message:', error.message);
                
                if (error.code === 702) {
                    this.logger.error('Error 702: The recording output format may not support splitting. MKV format is required for file splitting.');
                } else if (error.code === 501) {
                    this.logger.error('Error 501: Not currently recording');
                } else if (error.code === 100) {
                    this.logger.error('Error 100: Request type not found - OBS version may not support SplitRecordFile');
                }
            }
            
            throw error;
        }
    }

    /**
     * Get recording statistics
     */
    async getRecordingStats() {
        if (!this.connected) {
            this.logger.error('Not connected to OBS');
            this.emit('recording-stats', null);
            return;
        }

        try {
            // Get recording status
            const recordStatus = await this.obs.call('GetRecordStatus');
            this.logger.debug('Record status:', recordStatus);
            
            // Try to get stats for additional info like FPS
            let stats = null;
            try {
                stats = await this.obs.call('GetStats');
            } catch (e) {
                // Stats might not be available
            }
            
            // Calculate bitrate if we have bytes and duration
            let kbitsPerSec = null;
            if (recordStatus.outputBytes && recordStatus.outputDuration) {
                const seconds = recordStatus.outputDuration / 1000;
                if (seconds > 0) {
                    kbitsPerSec = (recordStatus.outputBytes * 8 / 1000) / seconds;
                }
            }
            
            // Use the stored recording path from RecordStateChanged/RecordFileChanged events
            // OBS GetRecordStatus doesn't provide the path, only the events do
            let outputPath = null;
            if (recordStatus.outputActive && this.currentRecordingPath) {
                outputPath = this.currentRecordingPath;
            }
            
            this.emit('recording-stats', {
                active: recordStatus.outputActive,
                duration: recordStatus.outputDuration / 1000, // Convert ms to seconds
                bytes: recordStatus.outputBytes,
                timecode: recordStatus.outputTimecode,
                outputPath: outputPath,
                state: recordStatus.outputState,
                kbitsPerSec: kbitsPerSec,
                fps: stats?.activeFps || null
            });
            
        } catch (error) {
            this.logger.error('Error getting recording stats:', error);
            this.emit('recording-stats', null);
        }
    }

    /**
     * Check current status
     */
    checkStatus() {
        this.emit('status-update', { 
            websocket: this.connected ? 'connected' : 'disconnected'
        });
    }

    /**
     * Shutdown manager
     */
    async shutdown() {
        this.logger.log('Shutting down manager...');
        this.shutdownRequested = true;
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        
        await this.disconnect();
        await super.shutdown();
    }
}

module.exports = WebSocketManager;