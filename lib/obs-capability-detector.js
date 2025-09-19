const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const OBSWebSocket = require('obs-websocket-js').default;

class OBSCapabilityDetector {
    constructor() {
        // Use LOCALAPPDATA for downloaded resources
        const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
        const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
        this.obsPath = path.join(resourcesBase, 'obs-studio', 'bin', '64bit', 'obs64.exe');
        this.obs = new OBSWebSocket();
        this.obsProcess = null;
        // Use standard port to avoid conflicts
        this.websocketPort = 4455;
        this.websocketPassword = 'screcorder123';
        
        // Map from log encoder IDs to actual OBS encoder IDs
        // After research, the log IDs ARE the correct OBS encoder IDs
        this.encoderIdMap = {
            // AMD encoders - use directly as detected
            'h264_texture_amf': 'h264_texture_amf',
            'h265_texture_amf': 'h265_texture_amf', 
            'av1_texture_amf': 'av1_texture_amf',
            
            // NVIDIA encoders - use directly as they appear in logs
            'jim_nvenc': 'jim_nvenc',
            'jim_hevc_nvenc': 'jim_hevc_nvenc',
            'jim_av1_nvenc': 'jim_av1_nvenc',
            'ffmpeg_nvenc': 'ffmpeg_nvenc',
            'ffmpeg_hevc_nvenc': 'ffmpeg_hevc_nvenc',
            'ffmpeg_av1_nvenc': 'ffmpeg_av1_nvenc',
            'obs_nvenc': 'obs_nvenc',
            
            // Intel QuickSync encoders - use directly as they appear in logs
            'obs_qsv11': 'obs_qsv11',
            'obs_qsv11_hevc': 'obs_qsv11_hevc',
            'obs_qsv11_av1': 'obs_qsv11_av1',
            
            // Software encoders
            'obs_x264': 'obs_x264',
            'x264': 'obs_x264',
            'obs_x265': 'obs_x265',
            'x265': 'obs_x265',
            'ffmpeg_svt_av1': 'ffmpeg_svt_av1',
            'ffmpeg_aom_av1': 'ffmpeg_aom_av1',
            'libx264': 'obs_x264',
            'libx265': 'obs_x265'
        };
    }

    async detectCapabilities(keepAlive = false) {
        try {
            console.log('Starting OBS for capability detection...');
            
            // Generate WebSocket config BEFORE starting OBS
            await this.generateWebSocketConfig();
            
            // Start OBS with minimal config
            await this.startOBS();
            
            // Smart wait for OBS to be ready
            await this.waitForOBSReady();
            
            // Detect capabilities
            const capabilities = {
                encoders: await this.detectEncoders(),
                audio: await this.detectAudioDevices(),
                display: await this.detectDisplay()
            };
            
            // Only clean up if not keeping alive for further operations
            if (!keepAlive) {
                await this.cleanup();
            } else {
                console.log('Keeping OBS alive for further operations...');
            }
            
            return capabilities;
        } catch (error) {
            console.error('Failed to detect capabilities:', error);
            await this.cleanup();
            throw error;
        }
    }

    async generateWebSocketConfig() {
        // Use LOCALAPPDATA for downloaded resources
        const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
        const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
        const obsRootPath = path.join(resourcesBase, 'obs-studio');
        const configPath = path.join(obsRootPath, 'config', 'obs-studio');
        const profilePath = path.join(configPath, 'basic', 'profiles', 'CapabilityDetection');
        const scenesPath = path.join(configPath, 'basic', 'scenes');
        const globalIniPath = path.join(configPath, 'global.ini');
        const websocketConfigPath = path.join(configPath, 'plugin_config', 'obs-websocket');
        const portableModePath = path.join(obsRootPath, 'portable_mode.txt');
        
        // Create portable mode file
        await fs.writeFile(portableModePath, 'This file enables portable mode for OBS Studio.\nAll settings will be saved in the config folder next to this file.\n');
        
        // Create directories
        await fs.mkdir(profilePath, { recursive: true });
        await fs.mkdir(scenesPath, { recursive: true });
        await fs.mkdir(websocketConfigPath, { recursive: true });
        
        // Generate profile basic.ini
        const basicIni = `[General]
Name=CapabilityDetection

[Video]
BaseCX=1920
BaseCY=1080
OutputCX=1920
OutputCY=1080
FPSType=0
FPSCommon=60

[Output]
Mode=Simple

[Audio]
SampleRate=48000
ChannelSetup=Stereo
`;
        await fs.writeFile(path.join(profilePath, 'basic.ini'), basicIni);
        
        // Generate scene collection
        const sceneCollection = {
            "current_program_scene": "Detection",
            "current_scene": "Detection",
            "current_transition": "Fade",
            "name": "Detection",
            "scene_order": [{"name": "Detection"}],
            "sources": [
                {
                    "enabled": true,
                    "id": "scene",
                    "name": "Detection",
                    "settings": {},
                    "private_settings": {}
                }
            ],
            "transitions": []
        };
        await fs.writeFile(
            path.join(scenesPath, 'Detection.json'), 
            JSON.stringify(sceneCollection, null, 2)
        );
        
        // Generate global.ini
        const globalIni = `[General]
Pre31Migrated=true
FirstRun=false
LastVersion=520093699

[Locations]
Configuration=../../config
SceneCollections=../../config
Profiles=../../config

[Basic]
Profile=CapabilityDetection
ProfileDir=CapabilityDetection
SceneCollection=Detection
SceneCollectionFile=Detection
`;
        await fs.writeFile(globalIniPath, globalIni);
        
        // Generate WebSocket config as JSON (use standard port)
        const websocketConfig = {
            "alerts_enabled": false,
            "auth_required": true,
            "first_load": false,
            "server_enabled": true,
            "server_password": "screcorder123",
            "server_port": 4455
        };
        await fs.writeFile(
            path.join(websocketConfigPath, 'config.json'),
            JSON.stringify(websocketConfig, null, 2)
        );
        
        console.log('Generated WebSocket config at:', path.join(websocketConfigPath, 'config.json'));
        console.log('WebSocket will be on port:', this.websocketPort);
    }

    async startOBS() {
        // Check if OBS is already running before starting a new instance
        const existingOBS = await this.checkOBSProcess();
        
        if (existingOBS) {
            console.log('OBS is already running, attempting to use existing instance');
            
            // Try to connect to existing instance
            try {
                // Update port to use standard port if another instance is running
                this.websocketPort = 4455;
                this.websocketPassword = 'screcorder123';
                
                await this.obs.connect(`ws://127.0.0.1:${this.websocketPort}`, this.websocketPassword);
                console.log('Connected to existing OBS instance');
                return; // Use existing instance
            } catch (err) {
                console.log('Could not connect to existing OBS instance:', err.message);
                console.log('Killing existing OBS to start fresh...');
                
                // Kill existing OBS
                const { exec } = require('child_process');
                await new Promise((resolve) => {
                    exec('taskkill /F /IM obs64.exe', (error) => {
                        if (error) {
                            console.log('Error killing OBS:', error.message);
                        }
                        setTimeout(resolve, 2000); // Wait for process to terminate
                    });
                });
            }
        }
        
        return new Promise((resolve, reject) => {
            // For portable mode, OBS looks for config in the same directory as the exe
            const obsDir = path.dirname(this.obsPath);
            
            const args = [
                '--portable',
                '--minimize-to-tray', 
                '--disable-updater',
                '--disable-shutdown-check',
                '--profile', 'CapabilityDetection',
                '--collection', 'Detection'
            ];

            console.log('Launching OBS from:', obsDir);
            console.log('With args:', args);

            this.obsProcess = spawn(this.obsPath, args, {
                detached: false,
                stdio: 'ignore',
                windowsHide: true,  // Hide window in production
                cwd: obsDir
            });

            this.obsProcess.on('error', (error) => {
                console.error('Failed to start OBS:', error);
                reject(error);
            });

            this.obsProcess.on('spawn', () => {
                console.log('OBS process spawned successfully');
                resolve();
            });
            
            this.obsProcess.on('exit', (code, signal) => {
                console.log(`OBS process exited with code ${code} and signal ${signal}`);
                this.obsProcess = null;
            });
        });
    }

    async waitForOBSReady() {
        const maxAttempts = 10;
        const retryDelay = 2000; // 2 seconds between retries
        let obsRestartCount = 0;
        const maxOBSRestarts = 3;
        
        console.log('Waiting for OBS to be ready...');
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`Attempt ${attempt}/${maxAttempts} to verify OBS is ready`);
            
            // Step 1: Check if OBS process is running
            const isRunning = await this.checkOBSProcess();
            
            if (!isRunning) {
                console.log('OBS process not detected');
                
                // Try to restart OBS if we haven't exceeded restart limit
                if (obsRestartCount < maxOBSRestarts) {
                    obsRestartCount++;
                    console.log(`Attempting to restart OBS (restart ${obsRestartCount}/${maxOBSRestarts})`);
                    
                    try {
                        await this.startOBS();
                        await this.sleep(3000); // Give OBS time to start
                        continue; // Try checking again
                    } catch (err) {
                        console.error('Failed to restart OBS:', err.message);
                    }
                } else {
                    throw new Error(`OBS process failed to start after ${maxOBSRestarts} attempts`);
                }
            }
            
            // Step 2: Try WebSocket connection
            try {
                console.log(`Attempting WebSocket connection to ws://127.0.0.1:${this.websocketPort}`);
                await this.obs.connect(`ws://127.0.0.1:${this.websocketPort}`, this.websocketPassword);
                console.log('✓ OBS is ready - process running and WebSocket connected');
                return; // Success!
            } catch (error) {
                console.log(`WebSocket connection failed: ${error.message}`);
                
                if (attempt < maxAttempts) {
                    console.log(`Waiting ${retryDelay}ms before retry...`);
                    await this.sleep(retryDelay);
                }
            }
        }
        
        // If we get here, all attempts failed
        throw new Error(`Failed to connect to OBS after ${maxAttempts} attempts. OBS may not be starting correctly or WebSocket may not be enabled.`);
    }
    
    async checkOBSProcess() {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        try {
            const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq obs64.exe" /FO CSV');
            const isRunning = stdout && stdout.includes('obs64.exe');
            
            if (isRunning) {
                // Also check if our spawned process is still alive
                if (this.obsProcess && !this.obsProcess.killed) {
                    console.log('OBS process is running (spawned by us)');
                } else {
                    console.log('OBS process is running (external)');
                }
            }
            
            return isRunning;
        } catch (err) {
            console.error('Error checking OBS process:', err.message);
            return false;
        }
    }
    
    async connectWebSocket() {
        // This method is now simplified - just a single connection attempt
        // The retry logic is handled by waitForOBSReady
        try {
            await this.obs.connect(`ws://localhost:${this.websocketPort}`, this.websocketPassword);
            console.log('WebSocket connected successfully');
        } catch (error) {
            throw new Error(`WebSocket connection failed: ${error.message}`);
        }
    }

    async detectEncoders() {
        try {
            console.log('Detecting encoders...');
            
            const hardwareEncoders = [];
            const softwareEncoders = [];
            
            // Parse OBS log for encoder information - this is the most reliable method
            console.log('Parsing OBS log for encoder information...');
            
            // Wait a moment for OBS to write encoder info to log
            await this.sleep(3000);
            
            // Parse OBS log for encoder information
            const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
            const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
            const logPath = path.join(resourcesBase, 'obs-studio', 'config', 'obs-studio', 'logs');
            try {
                // Get the most recent log file
                const files = await fs.readdir(logPath);
                const logFiles = files.filter(f => f.endsWith('.txt')).sort((a, b) => b.localeCompare(a));
                
                if (logFiles.length > 0) {
                    const latestLog = path.join(logPath, logFiles[0]);
                    const logContent = await fs.readFile(latestLog, 'utf8');
                    
                    // Parse encoder section - look for "Available Encoders:" section
                    // Handle both Unix and Windows line endings
                    const encoderMatch = logContent.match(/Available Encoders:([\s\S]*?)(?:====|$)/);
                    if (encoderMatch) {
                        console.log('Found encoder section in OBS log');
                        const encoderSection = encoderMatch[1];
                        console.log(`Encoder section length: ${encoderSection.length} characters`);
                        // Split by either Unix or Windows line endings
                        const lines = encoderSection.split(/\r?\n/);
                        
                        let inVideoEncoders = false;
                        
                        for (const line of lines) {
                            // Remove timestamp prefix if present (e.g., "22:19:07.217: ")
                            const lineContent = line.replace(/^\d{2}:\d{2}:\d{2}\.\d{3}:\s*/, '');
                            
                            // Check if we're in the Video Encoders section
                            if (lineContent.includes('Video Encoders:')) {
                                console.log('Found Video Encoders section');
                                inVideoEncoders = true;
                                continue;
                            }
                            
                            // Stop when we reach Audio Encoders
                            if (lineContent.includes('Audio Encoders:')) {
                                console.log('Reached Audio Encoders section, stopping');
                                break;
                            }
                            
                            if (inVideoEncoders && lineContent.trim()) {
                                // Match encoder lines - OBS uses tabs: "	- encoder_id (Encoder Name)"
                                // Handle Windows line endings and tabs
                                const cleanLine = lineContent.trim();
                                
                                // Only process lines that start with a dash
                                if (cleanLine.startsWith('-')) {
                                    console.log(`Processing encoder line: "${cleanLine}"`);
                                    const match = cleanLine.match(/^-\s*(\S+)\s*\(([^)]+)\)/);
                                    if (match) {
                                        const encoderId = match[1];
                                        const encoderName = match[2];
                                        
                                        console.log(`Found encoder: ${encoderId} (${encoderName})`);
                                        
                                        // Skip software AV1 encoders as they're not useful for real-time recording
                                        if (encoderId.includes('ffmpeg_svt_av1') || encoderId.includes('ffmpeg_aom_av1')) {
                                            console.log(`Skipping software AV1 encoder: ${encoderId}`);
                                            // Don't add to any list
                                        }
                                        // Categorize based on ID and name
                                        else if (encoderId.includes('amf') || encoderId.includes('amd') || encoderName.includes('AMD')) {
                                            hardwareEncoders.push({
                                                name: encoderName,
                                                vendor: 'AMD',
                                                codec: encoderId.includes('h265') || encoderId.includes('hevc') ? 'h265' :
                                                       encoderId.includes('av1') ? 'av1' : 'h264',
                                                id: this.getObsEncoderId(encoderId)
                                            });
                                        } else if (encoderId.includes('nvenc') || encoderId.includes('nvidia') || encoderName.includes('NVENC') || encoderName.includes('NVIDIA')) {
                                            hardwareEncoders.push({
                                                name: encoderName,
                                                vendor: 'NVIDIA',
                                                codec: encoderId.includes('hevc') || encoderId.includes('h265') ? 'h265' :
                                                       encoderId.includes('av1') ? 'av1' : 'h264',
                                                id: this.getObsEncoderId(encoderId)
                                            });
                                        } else if (encoderId.includes('qsv') || encoderId.includes('intel') || encoderName.includes('QuickSync') || encoderName.includes('Intel') || encoderName.includes('QSV')) {
                                            hardwareEncoders.push({
                                                name: encoderName,
                                                vendor: 'Intel',
                                                codec: encoderId.includes('hevc') || encoderId.includes('h265') ? 'h265' :
                                                       encoderId.includes('av1') ? 'av1' : 'h264',
                                                id: this.getObsEncoderId(encoderId)
                                            });
                                        } else if (encoderId === 'obs_x264' || encoderName.includes('x264')) {
                                            softwareEncoders.push({
                                                name: encoderName,
                                                vendor: 'Software',
                                                codec: 'h264',
                                                id: this.getObsEncoderId(encoderId)
                                            });
                                        } else if (encoderId === 'obs_x265' || encoderName.includes('x265')) {
                                            softwareEncoders.push({
                                                name: encoderName,
                                                vendor: 'Software',
                                                codec: 'h265',
                                                id: this.getObsEncoderId(encoderId)
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        console.log(`Parsed ${hardwareEncoders.length} hardware and ${softwareEncoders.length} software encoders from log`);
                        
                        if (hardwareEncoders.length > 0 || softwareEncoders.length > 0) {
                            return { hardware: hardwareEncoders, software: softwareEncoders };
                        }
                    } else {
                        console.log('Could not find encoder section in OBS log');
                    }
                }
            } catch (e) {
                console.log('Could not parse OBS log:', e.message);
                
                // Fall back to GPU detection
                const { exec } = require('child_process');
                const { promisify } = require('util');
                const execAsync = promisify(exec);
                
                try {
                    const { stdout: gpuInfo } = await execAsync('wmic path win32_VideoController get name');
                    console.log('GPU Info:', gpuInfo);
                    
                    if (gpuInfo.toLowerCase().includes('amd') || gpuInfo.toLowerCase().includes('radeon')) {
                        console.log('Detected AMD GPU - adding AMF encoders');
                        hardwareEncoders.push(
                            { name: 'AMD HW H.264 (AVC)', vendor: 'AMD', codec: 'h264', id: 'amd' },
                            { name: 'AMD HW H.265 (HEVC)', vendor: 'AMD', codec: 'h265', id: 'amd_hevc' },
                            { name: 'AMD HW AV1', vendor: 'AMD', codec: 'av1', id: 'amd_av1' }
                        );
                    }
                    
                    if (gpuInfo.toLowerCase().includes('nvidia')) {
                        console.log('Detected NVIDIA GPU - adding NVENC encoders');
                        hardwareEncoders.push(
                            { name: 'NVIDIA NVENC H.264', vendor: 'NVIDIA', codec: 'h264', id: 'nvenc_h264' },
                            { name: 'NVIDIA NVENC H.265', vendor: 'NVIDIA', codec: 'h265', id: 'nvenc_hevc' },
                            { name: 'NVIDIA NVENC AV1', vendor: 'NVIDIA', codec: 'av1', id: 'nvenc_av1' }
                        );
                    }
                    
                    if (gpuInfo.toLowerCase().includes('intel')) {
                        console.log('Detected Intel GPU - adding QuickSync encoders');
                        hardwareEncoders.push(
                            { name: 'Intel QuickSync H.264', vendor: 'Intel', codec: 'h264', id: 'qsv_h264' },
                            { name: 'Intel QuickSync H.265', vendor: 'Intel', codec: 'h265', id: 'qsv_hevc' },
                            { name: 'Intel QuickSync AV1', vendor: 'Intel', codec: 'av1', id: 'qsv_av1' }
                        );
                    }
                } catch (e) {
                    console.log('Could not detect GPU:', e.message);
                }
            }
            
            // Ensure we always have at least x264
            if (softwareEncoders.length === 0) {
                softwareEncoders.push(
                    { name: 'x264', vendor: 'Software', codec: 'h264', id: 'obs_x264' }
                );
            }
            
            
            console.log(`Found ${hardwareEncoders.length} hardware encoders and ${softwareEncoders.length} software encoders`);
            
            return {
                hardware: hardwareEncoders,
                software: softwareEncoders
            };
        } catch (error) {
            console.error('Error detecting encoders:', error);
            // Return default software encoder as fallback
            return {
                hardware: [],
                software: [{ name: 'x264', vendor: 'Software', codec: 'h264', id: 'obs_x264' }]
            };
        }
    }

    async detectAudioDevices() {
        const maxRetries = 3;
        const retryDelay = 2000;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`Detecting audio devices (attempt ${attempt}/${maxRetries})...`);
                
                // Create temporary audio sources to detect devices
                const outputDevices = [];
                const inputDevices = [];
                
                // Ensure we have a scene to work with
                try {
                    await this.obs.call('GetSceneList');
                } catch (err) {
                    console.log('Scene not ready, waiting...');
                    if (attempt < maxRetries) {
                        await this.sleep(retryDelay);
                        continue;
                    }
                    throw err;
                }
                
                // Try to create desktop audio source to list output devices
                let desktopAudioId = null;
                try {
                    desktopAudioId = 'temp_desktop_audio_' + Date.now();
                    await this.obs.call('CreateInput', {
                        sceneName: 'Detection',
                        inputName: desktopAudioId,
                        inputKind: 'wasapi_output_capture',
                        inputSettings: {}
                    });
                    
                    // Small delay to ensure source is ready
                    await this.sleep(500);
                    
                    // Get properties to see available devices
                    const props = await this.obs.call('GetInputPropertiesListPropertyItems', {
                        inputName: desktopAudioId,
                        propertyName: 'device_id'
                    });
                    
                    if (props.propertyItems && props.propertyItems.length > 0) {
                        props.propertyItems.forEach(item => {
                            // Include all devices, even default
                            outputDevices.push({
                                id: item.itemValue,
                                name: item.itemName,
                                isDefault: item.itemValue === 'default'
                            });
                        });
                        console.log(`Found ${outputDevices.length} output devices`);
                    } else {
                        console.log('No output devices found in properties');
                    }
                } catch (error) {
                    console.log('Could not enumerate output devices:', error.message);
                } finally {
                    // Always try to clean up
                    if (desktopAudioId) {
                        try {
                            await this.obs.call('RemoveInput', { inputName: desktopAudioId });
                        } catch (err) {
                            console.log('Could not remove desktop audio source:', err.message);
                        }
                    }
                }
                
                // Try to create mic audio source to list input devices
                let micAudioId = null;
                try {
                    micAudioId = 'temp_mic_audio_' + Date.now();
                    await this.obs.call('CreateInput', {
                        sceneName: 'Detection',
                        inputName: micAudioId,
                        inputKind: 'wasapi_input_capture',
                        inputSettings: {}
                    });
                    
                    // Small delay to ensure source is ready
                    await this.sleep(500);
                    
                    // Get properties to see available devices
                    const props = await this.obs.call('GetInputPropertiesListPropertyItems', {
                        inputName: micAudioId,
                        propertyName: 'device_id'
                    });
                    
                    if (props.propertyItems && props.propertyItems.length > 0) {
                        props.propertyItems.forEach(item => {
                            // Include all devices, even default
                            inputDevices.push({
                                id: item.itemValue,
                                name: item.itemName,
                                isDefault: item.itemValue === 'default'
                            });
                        });
                        console.log(`Found ${inputDevices.length} input devices`);
                    } else {
                        console.log('No input devices found in properties');
                    }
                } catch (error) {
                    console.log('Could not enumerate input devices:', error.message);
                } finally {
                    // Always try to clean up
                    if (micAudioId) {
                        try {
                            await this.obs.call('RemoveInput', { inputName: micAudioId });
                        } catch (err) {
                            console.log('Could not remove mic audio source:', err.message);
                        }
                    }
                }
                
                // If we didn't find any devices but no errors occurred, retry
                if (outputDevices.length === 0 && inputDevices.length === 0 && attempt < maxRetries) {
                    console.log(`No devices found, retrying in ${retryDelay}ms...`);
                    await this.sleep(retryDelay);
                    continue;
                }
                
                // Ensure default devices are in the list
                const hasDefaultOutput = outputDevices.some(d => d.id === 'default');
                if (!hasDefaultOutput && outputDevices.length > 0) {
                    outputDevices.unshift({
                        id: 'default',
                        name: 'Default Speakers',
                        isDefault: true
                    });
                }
                
                const hasDefaultInput = inputDevices.some(d => d.id === 'default');
                if (!hasDefaultInput && inputDevices.length > 0) {
                    inputDevices.unshift({
                        id: 'default',
                        name: 'Default Microphone',
                        isDefault: true
                    });
                }
                
                // If we still have no devices, add defaults as fallback
                if (outputDevices.length === 0) {
                    console.log('No output devices detected, using default fallback');
                    outputDevices.push({
                        id: 'default',
                        name: 'Default Speakers',
                        isDefault: true
                    });
                }
                
                if (inputDevices.length === 0) {
                    console.log('No input devices detected, using default fallback');
                    inputDevices.push({
                        id: 'default',
                        name: 'Default Microphone',
                        isDefault: true
                    });
                }
                
                console.log(`Audio device detection complete: ${outputDevices.length} outputs, ${inputDevices.length} inputs`);
                
                return {
                    outputs: outputDevices,
                    inputs: inputDevices
                };
                
            } catch (error) {
                console.error(`Error detecting audio devices (attempt ${attempt}/${maxRetries}):`, error.message);
                
                if (attempt === maxRetries) {
                    // Final attempt failed, return defaults
                    console.log('All attempts failed, returning default devices');
                    return {
                        outputs: [{ id: 'default', name: 'Default Speakers', isDefault: true }],
                        inputs: [{ id: 'default', name: 'Default Microphone', isDefault: true }]
                    };
                }
                
                // Wait before retry
                await this.sleep(retryDelay);
            }
        }
    }

    async detectDisplay() {
        try {
            console.log('Detecting display settings...');
            
            // Get video settings
            const videoSettings = await this.obs.call('GetVideoSettings');
            
            return {
                width: videoSettings.baseWidth || 1920,
                height: videoSettings.baseHeight || 1080,
                fps: videoSettings.fpsNumerator || 60
            };
        } catch (error) {
            console.error('Error detecting display:', error);
            // Return defaults
            return {
                width: 1920,
                height: 1080,
                fps: 60
            };
        }
    }

    async parseEncodersFromLog() {
        try {
            const hardwareEncoders = [];
            const softwareEncoders = [];
            
            // Parse OBS log for encoder information
            const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
            const resourcesBase = path.join(localAppData, 'sc-recorder', 'resources');
            const logPath = path.join(resourcesBase, 'obs-studio', 'config', 'obs-studio', 'logs');
            
            // Check if log directory exists
            try {
                await fs.access(logPath);
            } catch (err) {
                console.error('OBS log directory not found:', logPath);
                return { hardware: [], software: [] };
            }
            
            // Get all log files sorted by modification time
            const files = await fs.readdir(logPath);
            const logFiles = [];
            
            for (const file of files) {
                if (file.endsWith('.txt')) {
                    const filePath = path.join(logPath, file);
                    try {
                        const stats = await fs.stat(filePath);
                        // Only include files larger than 1KB to avoid empty logs
                        if (stats.size > 1024) {
                            logFiles.push({
                                name: file,
                                path: filePath,
                                mtime: stats.mtime,
                                size: stats.size
                            });
                        }
                    } catch (err) {
                        console.log(`Could not stat file ${file}:`, err.message);
                    }
                }
            }
            
            // Sort by modification time, newest first
            logFiles.sort((a, b) => b.mtime - a.mtime);
            
            if (logFiles.length === 0) {
                console.log('No valid OBS log files found');
                return { hardware: [], software: [] };
            }
            
            console.log(`Found ${logFiles.length} log files, checking for encoder information...`);
            
            // Try up to 3 most recent log files
            for (let i = 0; i < Math.min(3, logFiles.length); i++) {
                const logFile = logFiles[i];
                console.log(`Checking log file ${i + 1}/${Math.min(3, logFiles.length)}: ${logFile.name} (${(logFile.size / 1024).toFixed(1)}KB)`);
                
                try {
                    const logContent = await fs.readFile(logFile.path, 'utf8');
                    
                    // Look for different possible encoder section formats
                    // OBS may use different formatting in different versions
                    const patterns = [
                        /Available Encoders:([\s\S]*?)(?:={4,}|$)/i,
                        /Loading up encoders([\s\S]*?)(?:={4,}|$)/i,
                        /\[CoreAudio encoder\]:([\s\S]*?)(?:={4,}|$)/i
                    ];
                    
                    let encoderSection = null;
                    for (const pattern of patterns) {
                        const match = logContent.match(pattern);
                        if (match) {
                            encoderSection = match[1];
                            console.log(`Found encoder section using pattern: ${pattern.source.substring(0, 30)}...`);
                            break;
                        }
                    }
                    
                    if (!encoderSection) {
                        console.log(`No encoder section found in ${logFile.name}`);
                        continue; // Try next log file
                    }
                    
                    // Parse the encoder section
                    console.log(`Encoder section found, length: ${encoderSection.length} characters`);
                    
                    // Find Video Encoders subsection with more flexible matching
                    const videoPatterns = [
                        /Video Encoders:([\s\S]*?)(?:Audio Encoders:|\n\n|$)/i,
                        /\s+Video:([\s\S]*?)(?:Audio:|\n\n|$)/i
                    ];
                    
                    let videoSection = null;
                    for (const pattern of videoPatterns) {
                        const match = encoderSection.match(pattern);
                        if (match) {
                            videoSection = match[1];
                            break;
                        }
                    }
                    
                    if (!videoSection) {
                        // If no video section found, try to parse the entire encoder section
                        videoSection = encoderSection;
                        console.log('No specific video section found, parsing entire encoder section');
                    }
                    
                    // Split into lines and parse
                    const lines = videoSection.split(/\r?\n/);
                    console.log(`Processing ${lines.length} lines from encoder section`);
                    
                    for (const line of lines) {
                        // Remove timestamp if present (multiple formats)
                        const cleanLine = line
                            .replace(/^\d{2}:\d{2}:\d{2}\.\d{3}:\s*/, '') // HH:MM:SS.mmm: format
                            .replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/, '') // [YYYY-MM-DD HH:MM:SS] format
                            .replace(/^\s*\t+/, '') // Remove leading tabs
                            .trim();
                        
                        // Skip empty lines
                        if (!cleanLine) continue;
                        
                        // Match encoder lines with more flexible patterns
                        // Format: "- encoder_id (Encoder Name)" or "encoder_id: Encoder Name"
                        const patterns = [
                            /^-\s*([\w_]+)\s*\(([^)]+)\)/,  // - encoder_id (Name)
                            /^([\w_]+):\s*(.+)$/,              // encoder_id: Name
                            /^\s*([\w_]+)\s+\(([^)]+)\)/     // encoder_id (Name) without dash
                        ];
                        
                        let match = null;
                        for (const pattern of patterns) {
                            match = cleanLine.match(pattern);
                            if (match) break;
                        }
                        
                        if (match) {
                            const encoderId = match[1];
                            const encoderName = match[2];
                            
                            console.log(`Found encoder: ${encoderId} (${encoderName})`);
                            
                            // Skip software AV1 encoders as they're too slow for real-time
                            if (encoderId.includes('ffmpeg_svt_av1') || encoderId.includes('ffmpeg_aom_av1')) {
                                console.log(`Skipping slow software AV1 encoder: ${encoderId}`);
                                continue;
                            }
                            
                            // Categorize encoder
                            if (encoderId.includes('amf') || encoderId.includes('amd') || encoderName.includes('AMD')) {
                                hardwareEncoders.push({
                                    name: encoderName,
                                    vendor: 'AMD',
                                    codec: encoderId.includes('h265') || encoderId.includes('hevc') ? 'h265' :
                                           encoderId.includes('av1') ? 'av1' : 'h264',
                                    id: this.getObsEncoderId(encoderId)
                                });
                            } else if (encoderId.includes('nvenc') || encoderId.includes('nvidia') || encoderName.includes('NVENC')) {
                                hardwareEncoders.push({
                                    name: encoderName,
                                    vendor: 'NVIDIA',
                                    codec: encoderId.includes('hevc') || encoderId.includes('h265') ? 'h265' :
                                           encoderId.includes('av1') ? 'av1' : 'h264',
                                    id: this.getObsEncoderId(encoderId)
                                });
                            } else if (encoderId.includes('qsv') || encoderId.includes('intel') || encoderName.includes('QuickSync')) {
                                hardwareEncoders.push({
                                    name: encoderName,
                                    vendor: 'Intel',
                                    codec: encoderId.includes('hevc') || encoderId.includes('h265') ? 'h265' :
                                           encoderId.includes('av1') ? 'av1' : 'h264',
                                    id: this.getObsEncoderId(encoderId)
                                });
                            } else if (encoderId === 'obs_x264' || encoderId.includes('x264')) {
                                softwareEncoders.push({
                                    name: encoderName,
                                    vendor: 'Software',
                                    codec: 'h264',
                                    id: this.getObsEncoderId(encoderId)
                                });
                            } else if (encoderId === 'obs_x265' || encoderId.includes('x265')) {
                                softwareEncoders.push({
                                    name: encoderName,
                                    vendor: 'Software', 
                                    codec: 'h265',
                                    id: this.getObsEncoderId(encoderId)
                                });
                            }
                        }
                    }
                    
                    // If we found encoders, return them
                    if (hardwareEncoders.length > 0 || softwareEncoders.length > 0) {
                        console.log(`Successfully parsed ${hardwareEncoders.length} hardware and ${softwareEncoders.length} software encoders from ${logFile.name}`);
                        return { hardware: hardwareEncoders, software: softwareEncoders };
                    } else {
                        console.log(`No encoders found in ${logFile.name}, trying next log file...`);
                    }
                    
                } catch (err) {
                    console.error(`Error reading log file ${logFile.name}:`, err.message);
                }
            }
            
            console.log('No encoders found in any log file');
            return { hardware: [], software: [] };
            
        } catch (error) {
            console.error('Failed to parse encoders from log:', error);
            return { hardware: [], software: [] };
        }
    }

    async cleanup() {
        try {
            // Disconnect WebSocket
            if (this.obs) {
                await this.obs.disconnect().catch(() => {});
            }
            
            // Kill OBS process
            if (this.obsProcess) {
                this.obsProcess.kill('SIGTERM');
                await this.sleep(1000);
                
                if (!this.obsProcess.killed) {
                    this.obsProcess.kill('SIGKILL');
                }
            }
            
            // Also kill by name to be sure
            const { exec } = require('child_process');
            exec('taskkill /F /IM obs64.exe', (error) => {
                // Ignore errors
            });
            
            // Clean up ONLY temporary profile and scene, keep portable mode and WebSocket config
            const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
            const obsRootPath = path.join(localAppData, 'sc-recorder', 'resources', 'obs-studio');
            const configPath = path.join(obsRootPath, 'config', 'obs-studio');
            const tempProfilePath = path.join(configPath, 'basic', 'profiles', 'CapabilityDetection');
            const tempScenePath = path.join(configPath, 'basic', 'scenes', 'Detection.json');
            
            await fs.rm(tempProfilePath, { recursive: true, force: true }).catch(() => {});
            await fs.unlink(tempScenePath).catch(() => {});
            
            // Update WebSocket config for normal operation (standard port 4455)
            const websocketConfigPath = path.join(configPath, 'plugin_config', 'obs-websocket');
            const normalWebsocketConfig = {
                "alerts_enabled": false,
                "auth_required": true,
                "first_load": false,
                "server_enabled": true,
                "server_password": "screcorder123",
                "server_port": 4455
            };
            await fs.writeFile(
                path.join(websocketConfigPath, 'config.json'),
                JSON.stringify(normalWebsocketConfig, null, 2)
            );
            
            console.log('WebSocket config updated for normal operation on port 4455');
            
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }

    categorizeEncoder(encoderId, hardwareEncoders, softwareEncoders) {
        // NVIDIA encoders
        if (encoderId.includes('nvenc') || encoderId.includes('NVENC')) {
            hardwareEncoders.push({
                name: encoderId.includes('hevc') || encoderId.includes('h265') ? 'NVIDIA NVENC H.265' :
                      encoderId.includes('av1') ? 'NVIDIA NVENC AV1' : 'NVIDIA NVENC H.264',
                vendor: 'NVIDIA',
                codec: encoderId.includes('hevc') || encoderId.includes('h265') ? 'h265' :
                       encoderId.includes('av1') ? 'av1' : 'h264',
                id: encoderId
            });
        }
        // AMD encoders
        else if (encoderId.includes('amf') || encoderId.includes('AMF')) {
            hardwareEncoders.push({
                name: encoderId.includes('hevc') || encoderId.includes('h265') ? 'AMD AMF H.265' :
                      encoderId.includes('av1') ? 'AMD AMF AV1' : 'AMD AMF H.264',
                vendor: 'AMD',
                codec: encoderId.includes('hevc') || encoderId.includes('h265') ? 'h265' :
                       encoderId.includes('av1') ? 'av1' : 'h264',
                id: encoderId
            });
        }
        // Intel encoders
        else if (encoderId.includes('qsv') || encoderId.includes('QSV')) {
            hardwareEncoders.push({
                name: encoderId.includes('hevc') || encoderId.includes('h265') ? 'Intel QuickSync H.265' :
                      encoderId.includes('av1') ? 'Intel QuickSync AV1' : 'Intel QuickSync H.264',
                vendor: 'Intel',
                codec: encoderId.includes('hevc') || encoderId.includes('h265') ? 'h265' :
                       encoderId.includes('av1') ? 'av1' : 'h264',
                id: encoderId
            });
        }
        // Software encoders
        else if (encoderId.includes('x264') || encoderId === 'obs_x264') {
            softwareEncoders.push({
                name: 'x264',
                vendor: 'Software',
                codec: 'h264',
                id: encoderId
            });
        }
        else if (encoderId.includes('x265') || encoderId === 'obs_x265') {
            softwareEncoders.push({
                name: 'x265',
                vendor: 'Software',
                codec: 'h265',
                id: encoderId
            });
        }
    }

    getObsEncoderId(logEncoderId) {
        // Get the mapped OBS encoder ID, or return the original if no mapping exists
        const mappedId = this.encoderIdMap[logEncoderId];
        if (mappedId) {
            if (mappedId !== logEncoderId) {
                console.log(`Mapped encoder ID: ${logEncoderId} -> ${mappedId}`);
            } else {
                console.log(`Using encoder ID as-is: ${logEncoderId}`);
            }
            return mappedId;
        }
        
        // For unknown encoders, log a warning but use them as-is
        // since OBS generally uses the log IDs directly
        console.warn(`⚠️ Unknown encoder ID detected: "${logEncoderId}" - using as-is. Consider adding to encoderIdMap if needed.`);
        return logEncoderId;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = OBSCapabilityDetector;