const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

class SetupWizard {
    constructor() {
        this.currentStep = 0;
        this.totalSteps = 10; // Increased for FFmpeg step
        this.configuration = {
            obs: {
                installed: false,
                path: null
            },
            ffmpeg: {
                installed: false,
                path: null,
                capabilities: null
            },
            encoders: {
                hardware: [],
                software: []
            },
            audio: {
                outputDevice: null,
                inputDevice: null,
                voiceApp: null
            },
            resolution: {
                width: 1920,
                height: 1080,
                preset: 'display'
            },
            recordingFolder: null,
            starCitizen: {
                path: null,
                hasLive: false,
                hasPTU: false
            }
        };
        
        this.init();
    }

    init() {
        // Navigation buttons
        document.getElementById('btn-next').addEventListener('click', () => this.nextStep());
        document.getElementById('btn-back').addEventListener('click', () => this.previousStep());
        
        // Step-specific listeners
        this.setupOBSStep();
        this.setupHardwareStep();
        this.setupAudioStep();
        this.setupVoiceAppStep();
        this.setupResolutionStep();
        this.setupFolderSteps();
        
        // Start with welcome screen
        this.updateUI();
    }
    
    setupHardwareStep() {
        // Rescan encoders button
        document.getElementById('rescan-encoders').addEventListener('click', () => {
            this.detectHardwareEncoders();
        });
    }

    setupOBSStep() {
        // Download option selection
        document.querySelectorAll('.download-option').forEach(option => {
            option.addEventListener('click', (e) => {
                document.querySelectorAll('.download-option').forEach(o => o.classList.remove('selected'));
                e.currentTarget.classList.add('selected');
                
                const selectedOption = e.currentTarget.dataset.option;
                if (selectedOption === 'auto') {
                    this.startOBSDownload();
                }
            });
        });
    }

    setupAudioStep() {
        document.getElementById('rescan-audio').addEventListener('click', () => {
            this.detectAudioDevices();
        });
    }

    setupVoiceAppStep() {
        document.getElementById('rescan-apps').addEventListener('click', () => {
            this.detectVoiceApplications();
        });
        
        document.getElementById('show-all-apps').addEventListener('change', (e) => {
            this.detectVoiceApplications(e.target.checked);
        });
    }

    setupFolderSteps() {
        // Recording folder browser
        document.getElementById('browse-recording-folder')?.addEventListener('click', async () => {
            const result = await ipcRenderer.invoke('select-folder', {
                title: 'Select Recording Folder',
                defaultPath: this.configuration.recordingFolder || require('os').homedir()
            });
            
            if (result && !result.canceled && result.filePaths.length > 0) {
                this.configuration.recordingFolder = result.filePaths[0];
                document.getElementById('recording-folder-path').value = result.filePaths[0];
                this.updateButtonState();
            }
        });
        
        // Star Citizen folder browser
        document.getElementById('browse-sc-folder')?.addEventListener('click', async () => {
            const result = await ipcRenderer.invoke('select-folder', {
                title: 'Select Star Citizen Installation Folder',
                defaultPath: 'C:\\Program Files\\Roberts Space Industries\\StarCitizen'
            });
            
            if (result && !result.canceled && result.filePaths.length > 0) {
                const selectedPath = result.filePaths[0];
                this.configuration.starCitizen.path = selectedPath;
                document.getElementById('sc-folder-path').value = selectedPath;
                
                // Check for LIVE and PTU folders
                await this.validateStarCitizenFolder(selectedPath);
                this.updateButtonState();
            }
        });
    }
    
    async validateStarCitizenFolder(folderPath) {
        const statusDiv = document.getElementById('sc-folder-status');
        const statusText = document.getElementById('sc-folder-status-text');
        
        try {
            // Check for LIVE folder
            const livePath = path.join(folderPath, 'LIVE');
            const ptuPath = path.join(folderPath, 'PTU');
            
            let hasLive = false;
            let hasPTU = false;
            
            try {
                await fs.promises.access(livePath, fs.constants.F_OK);
                hasLive = true;
            } catch {}
            
            try {
                await fs.promises.access(ptuPath, fs.constants.F_OK);
                hasPTU = true;
            } catch {}
            
            this.configuration.starCitizen.hasLive = hasLive;
            this.configuration.starCitizen.hasPTU = hasPTU;
            
            if (hasLive || hasPTU) {
                statusDiv.style.display = 'block';
                statusDiv.style.background = 'rgba(16, 185, 129, 0.1)';
                statusDiv.style.border = '1px solid rgba(16, 185, 129, 0.3)';
                
                const builds = [];
                if (hasLive) builds.push('LIVE');
                if (hasPTU) builds.push('PTU');
                
                statusText.style.color = '#10b981';
                statusText.textContent = `✓ Found Star Citizen builds: ${builds.join(', ')}`;
            } else {
                statusDiv.style.display = 'block';
                statusDiv.style.background = 'rgba(239, 68, 68, 0.1)';
                statusDiv.style.border = '1px solid rgba(239, 68, 68, 0.3)';
                statusText.style.color = '#ef4444';
                statusText.textContent = '✗ No LIVE or PTU folders found. Please select the correct Star Citizen folder.';
            }
        } catch (error) {
            console.error('Error validating Star Citizen folder:', error);
        }
    }

    async setupResolutionStep() {
        // Load displays when setting up this step
        await this.loadDisplays();
        
        document.querySelectorAll('.resolution-option').forEach(option => {
            option.addEventListener('click', (e) => {
                document.querySelectorAll('.resolution-option').forEach(o => o.classList.remove('selected'));
                e.currentTarget.classList.add('selected');
                
                const resolution = e.currentTarget.dataset.resolution;
                if (resolution === 'detected') {
                    // Use selected display's resolution
                    const displaySelect = document.getElementById('wizard-display-select');
                    const selectedOption = displaySelect.selectedOptions[0];
                    this.configuration.resolution.width = parseInt(selectedOption.dataset.width);
                    this.configuration.resolution.height = parseInt(selectedOption.dataset.height);
                    this.configuration.resolution.preset = 'display';
                } else if (resolution) {
                    const [width, height] = resolution.split('x').map(Number);
                    this.configuration.resolution.width = width;
                    this.configuration.resolution.height = height;
                    this.configuration.resolution.preset = 'custom';
                }
            });
        });
        
        // Handle display selection
        const displaySelect = document.getElementById('wizard-display-select');
        if (displaySelect) {
            displaySelect.addEventListener('change', (e) => {
                const selectedOption = e.target.selectedOptions[0];
                const width = parseInt(selectedOption.dataset.width);
                const height = parseInt(selectedOption.dataset.height);
                
                // Update detected resolution display
                const detectedElement = document.getElementById('detected-resolution');
                if (detectedElement) {
                    detectedElement.textContent = `${width}×${height}`;
                }
                
                // Update configuration
                this.configuration.display = {
                    id: parseInt(e.target.value),
                    width: width,
                    height: height
                };
                
                // If "Match Display" is selected, update resolution
                const selectedResOption = document.querySelector('.resolution-option.selected');
                if (selectedResOption && selectedResOption.dataset.resolution === 'detected') {
                    this.configuration.resolution.width = width;
                    this.configuration.resolution.height = height;
                }
            });
        }
        
        document.getElementById('apply-custom').addEventListener('click', () => {
            const width = parseInt(document.getElementById('custom-width').value);
            const height = parseInt(document.getElementById('custom-height').value);
            
            if (width && height) {
                this.configuration.resolution.width = width;
                this.configuration.resolution.height = height;
                this.configuration.resolution.preset = 'custom';
                
                // Clear other selections
                document.querySelectorAll('.resolution-option').forEach(o => o.classList.remove('selected'));
            }
        });
    }
    
    async loadDisplays() {
        try {
            const displays = await ipcRenderer.invoke('get-displays');
            const displaySelect = document.getElementById('wizard-display-select');
            
            if (displaySelect) {
                displaySelect.innerHTML = '';
                
                displays.forEach(display => {
                    const option = document.createElement('option');
                    option.value = display.id;
                    option.textContent = display.label;
                    option.dataset.width = display.size.width;
                    option.dataset.height = display.size.height;
                    displaySelect.appendChild(option);
                });
                
                // Select primary display by default
                const primaryDisplay = displays.find(d => d.isPrimary);
                if (primaryDisplay) {
                    displaySelect.value = primaryDisplay.id;
                    // Update detected resolution display
                    const detectedElement = document.getElementById('detected-resolution');
                    if (detectedElement) {
                        detectedElement.textContent = `${primaryDisplay.size.width}×${primaryDisplay.size.height}`;
                    }
                    // Set initial config
                    this.configuration.display = {
                        id: primaryDisplay.id,
                        width: primaryDisplay.size.width,
                        height: primaryDisplay.size.height
                    };
                }
            }
        } catch (error) {
            console.error('Failed to load displays:', error);
        }
    }

    async nextStep() {
        // Validate current step before proceeding
        const canProceed = await this.validateStep(this.currentStep);
        if (!canProceed) return;
        
        if (this.currentStep < this.totalSteps - 1) {
            this.currentStep++;
            this.updateUI();
            
            // Execute step-specific actions
            this.onStepEnter(this.currentStep);
        } else {
            // Finish wizard
            this.completeSetup();
        }
    }

    previousStep() {
        if (this.currentStep > 0) {
            this.currentStep--;
            this.updateUI();
        }
    }

    updateUI() {
        // Progress bar is now indeterminate (auto-animating)
        // No need to update width
        
        // Update step indicator
        document.getElementById('step-indicator').textContent = `Step ${this.currentStep + 1} of ${this.totalSteps}`;
        
        // Show/hide steps
        document.querySelectorAll('.wizard-step').forEach((step, index) => {
            step.classList.toggle('active', index === this.currentStep);
        });
        
        // Update button states
        document.getElementById('btn-back').disabled = this.currentStep === 0;
        document.getElementById('btn-next').textContent = this.currentStep === this.totalSteps - 1 ? 'Finish' : 'Next';
        
        // Update button state based on step requirements
        this.updateButtonState();
    }

    updateButtonState() {
        const nextBtn = document.getElementById('btn-next');
        
        switch(this.currentStep) {
            case 0: // Welcome
                nextBtn.disabled = false;
                break;
            case 1: // OBS Check
                nextBtn.disabled = !this.configuration.obs.installed;
                break;
            case 2: // Hardware
                nextBtn.disabled = this.configuration.encoders.hardware.length === 0 && 
                                  this.configuration.encoders.software.length === 0;
                break;
            case 3: // Audio
                nextBtn.disabled = !this.configuration.audio.inputDevice;
                break;
            case 4: // Voice App
                nextBtn.disabled = false; // Voice app is optional
                break;
            case 5: // Resolution
                nextBtn.disabled = !this.configuration.resolution.width || !this.configuration.resolution.height;
                break;
            case 6: // Recording Folder
                nextBtn.disabled = !this.configuration.recordingFolder;
                break;
            case 7: // Star Citizen Folder
                nextBtn.disabled = false; // Optional, but warn if not valid
                break;
            case 8: // Review
                nextBtn.disabled = false;
                break;
            case 9: // Complete
                nextBtn.disabled = false;
                break;
        }
    }

    async onStepEnter(step) {
        switch(step) {
            case 1: // OBS Check
                await this.checkOBSInstallation();
                break;
            case 2: // Hardware Detection
                await this.detectHardwareEncoders();
                break;
            case 3: // Audio Detection
                await this.detectAudioDevices();
                break;
            case 4: // Voice App Detection
                await this.detectVoiceApplications();
                break;
            case 5: // Resolution
                this.setupResolutionDefaults();
                break;
            case 6: // Recording Folder
                // Set default recording folder if not set
                if (!this.configuration.recordingFolder) {
                    const defaultPath = path.join(require('os').homedir(), 'Videos', 'SC_Recordings');
                    this.configuration.recordingFolder = defaultPath;
                    document.getElementById('recording-folder-path').value = defaultPath;
                }
                break;
            case 7: // Star Citizen Folder
                // Try to auto-detect Star Citizen if not set
                if (!this.configuration.starCitizen.path) {
                    const defaultPath = 'C:\\Program Files\\Roberts Space Industries\\StarCitizen';
                    try {
                        await fs.promises.access(defaultPath, fs.constants.F_OK);
                        this.configuration.starCitizen.path = defaultPath;
                        document.getElementById('sc-folder-path').value = defaultPath;
                        await this.validateStarCitizenFolder(defaultPath);
                    } catch {}
                }
                break;
            case 8: // Review
                this.updateSummary();
                break;
            case 9: // Complete
                // Nothing to do on the completion step
                break;
        }
    }

    async validateStep(step) {
        switch(step) {
            case 1: // OBS Check
                if (!this.configuration.obs.installed) {
                    const selected = document.querySelector('.download-option.selected');
                    if (!selected) {
                        alert('Please choose how to install OBS Studio');
                        return false;
                    }
                }
                break;
            case 3: // Audio
                if (!this.configuration.audio.inputDevice) {
                    alert('Please select a microphone device');
                    return false;
                }
                break;
            case 6: // Recording Folder
                if (!this.configuration.recordingFolder) {
                    alert('Please select a folder for saving recordings');
                    return false;
                }
                break;
        }
        return true;
    }

    async checkOBSInstallation() {
        const checkIcon = document.getElementById('obs-check-icon');
        const checkText = document.getElementById('obs-check-text');
        
        checkIcon.className = 'check-icon checking';
        checkText.textContent = 'Checking for required dependencies...';
        
        // Check if OBS exists in resources/obs-studio/
        const obsPath = path.join(process.cwd(), 'resources', 'obs-studio', 'bin', '64bit', 'obs64.exe');
        const ffmpegPath = path.join(process.cwd(), 'resources', 'ffmpeg', 'ffmpeg.exe');
        
        let hasOBS = false;
        let hasFFmpeg = false;
        
        try {
            await fs.promises.access(obsPath, fs.constants.F_OK);
            hasOBS = true;
        } catch {}
        
        try {
            await fs.promises.access(ffmpegPath, fs.constants.F_OK);
            hasFFmpeg = true;
        } catch {}
        
        if (hasOBS && hasFFmpeg) {
            // Both dependencies found - but still need to detect FFmpeg capabilities
            checkIcon.className = 'check-icon checking';
            checkIcon.textContent = '⟳';
            checkText.textContent = 'Detecting FFmpeg capabilities...';
            
            // Trigger FFmpeg capability detection
            ipcRenderer.send('download-dependencies');
            
            // Listen for the response
            const handleProgress = (event, data) => {
                if (data.type === 'complete') {
                    // Remove listener
                    ipcRenderer.removeListener('dependencies-download-progress', handleProgress);
                    
                    checkIcon.className = 'check-icon success';
                    checkIcon.textContent = '✓';
                    checkText.textContent = 'All dependencies installed and ready!';
                    
                    this.configuration.obs.installed = true;
                    this.configuration.obs.path = obsPath;
                    this.configuration.ffmpeg.installed = true;
                    this.configuration.ffmpeg.path = ffmpegPath;
                    this.configuration.ffmpeg.capabilities = data.ffmpegCapabilities;
                    
                    document.getElementById('obs-download-options').style.display = 'none';
                    this.updateButtonState();
                } else if (data.type === 'error') {
                    // Remove listener
                    ipcRenderer.removeListener('dependencies-download-progress', handleProgress);
                    
                    checkIcon.className = 'check-icon error';
                    checkIcon.textContent = '✗';
                    checkText.textContent = 'Failed to detect FFmpeg capabilities';
                    console.error('FFmpeg detection error:', data.message);
                } else if (data.type === 'detecting') {
                    // Update status but keep listening
                    checkText.textContent = data.message || 'Detecting FFmpeg capabilities...';
                }
            };
            
            ipcRenderer.on('dependencies-download-progress', handleProgress);
            
        } else {
            // Dependencies not found
            checkIcon.className = 'check-icon error';
            checkIcon.textContent = '✗';
            
            let missingDeps = [];
            if (!hasOBS) missingDeps.push('OBS Studio');
            if (!hasFFmpeg) missingDeps.push('FFmpeg');
            
            checkText.textContent = `Missing: ${missingDeps.join(', ')}`;
            
            document.getElementById('obs-download-options').style.display = 'block';
            this.configuration.obs.installed = false;
            this.updateButtonState();
        }
    }

    async startOBSDownload() {
        const progressDiv = document.getElementById('download-progress');
        const statusText = document.getElementById('download-status');
        const progressFill = document.getElementById('download-progress-fill');
        const downloadOptions = document.getElementById('obs-download-options');
        
        // Hide download options immediately
        downloadOptions.style.display = 'none';
        
        // Show progress bar
        progressDiv.classList.add('active');
        
        // Send download request to main process for both OBS and FFmpeg
        ipcRenderer.send('download-dependencies');
        
        // Listen for download progress
        ipcRenderer.on('dependencies-download-progress', (event, data) => {
            if (data.type === 'progress') {
                // Just show simple status message, no percentages or sizes
                statusText.textContent = data.message || 'Downloading dependencies...';
                // Keep indeterminate animation always
                progressFill.classList.remove('determinate');
            } else if (data.type === 'extracting') {
                // Show extraction status
                statusText.textContent = data.message || 'Extracting files...';
            } else if (data.type === 'complete') {
                statusText.textContent = 'Dependencies installed successfully!';
                
                // Update UI
                const checkIcon = document.getElementById('obs-check-icon');
                const checkText = document.getElementById('obs-check-text');
                checkIcon.className = 'check-icon success';
                checkIcon.textContent = '✓';
                checkText.textContent = 'OBS Studio and FFmpeg installed successfully!';
                
                this.configuration.obs.installed = true;
                this.configuration.obs.path = data.path;
                
                // Hide progress bar after a short delay
                setTimeout(() => {
                    progressDiv.classList.remove('active');
                }, 2000);
                
                this.updateButtonState();
            } else if (data.type === 'error') {
                statusText.textContent = `Error: ${data.message}`;
                const checkIcon = document.getElementById('obs-check-icon');
                const checkText = document.getElementById('obs-check-text');
                checkIcon.className = 'check-icon error';
                checkIcon.textContent = '✗';
                checkText.textContent = 'Installation failed';
                
                // Show download options again so user can retry
                setTimeout(() => {
                    progressDiv.classList.remove('active');
                    downloadOptions.style.display = 'block';
                }, 2000);
            }
        });
    }

    async detectHardwareEncoders() {
        const checkIcon = document.getElementById('hardware-check-icon');
        const checkText = document.getElementById('hardware-check-text');
        const codecGrid = document.getElementById('codec-grid');
        const rescanButton = document.getElementById('rescan-encoders');
        const softwareWarning = document.getElementById('software-warning');
        
        checkIcon.className = 'check-icon checking';
        checkText.textContent = 'Detecting hardware encoders...';
        codecGrid.style.display = 'none';
        rescanButton.style.display = 'none';
        softwareWarning.style.display = 'none';
        
        // Request encoder detection from main process
        const result = await ipcRenderer.invoke('detect-encoders');
        
        // Expect consistent response format: { success: boolean, encoders?: {...}, error?: string }
        if (result.success && result.encoders) {
            const encoders = result.encoders;
            this.configuration.encoders = encoders;
            
            // Reset codec display
            const codecs = {
                av1: { element: 'av1', vendors: new Set() },
                h265: { element: 'h265', vendors: new Set() },
                h264: { element: 'h264', vendors: new Set() }
            };
            
            // Process hardware encoders
            let hasHardwareEncoders = false;
            if (encoders.hardware && Array.isArray(encoders.hardware)) {
                encoders.hardware.forEach(encoder => {
                    hasHardwareEncoders = true;
                    const codecType = encoder.codec.toLowerCase();
                    if (codecs[codecType]) {
                        codecs[codecType].vendors.add(encoder.vendor);
                    }
                });
            }
            
            // Update codec display
            Object.entries(codecs).forEach(([codec, data]) => {
                const statusEl = document.getElementById(`${data.element}-status`);
                const vendorEl = document.getElementById(`${data.element}-vendor`);
                
                if (data.vendors.size > 0) {
                    statusEl.textContent = '✅';
                    const vendorList = Array.from(data.vendors).join(', ');
                    vendorEl.textContent = vendorList;
                    vendorEl.style.color = '#10b981';
                } else {
                    statusEl.textContent = '❌';
                    vendorEl.textContent = 'Not Available';
                    vendorEl.style.color = '#9ca3af';
                }
            });
            
            // Update status text
            if (hasHardwareEncoders) {
                checkIcon.className = 'check-icon success';
                checkIcon.textContent = '✓';
                const totalEncoders = encoders.hardware.length;
                checkText.textContent = `Found ${totalEncoders} hardware encoder${totalEncoders > 1 ? 's' : ''}`;
            } else {
                checkIcon.className = 'check-icon error';
                checkIcon.textContent = '⚠';
                checkText.textContent = 'No hardware encoders detected';
                
                // Show software warning
                softwareWarning.style.display = 'block';
            }
            
            // Show codec grid
            codecGrid.style.display = 'block';
            
            // Show rescan button after detection
            rescanButton.style.display = 'inline-block';
            
            // Setup rescan handler
            if (!rescanButton.hasAttribute('data-handler-added')) {
                rescanButton.setAttribute('data-handler-added', 'true');
                rescanButton.addEventListener('click', async () => {
                    // Check if OBS is already running
                    const isRunning = await ipcRenderer.invoke('is-obs-running');
                    if (isRunning) {
                        alert('OBS is already running. Please close it first before rescanning.');
                        return;
                    }
                    
                    // Re-run detection
                    await this.detectHardwareEncoders();
                });
            }
        } else {
            // Handle error case
            checkIcon.className = 'check-icon error';
            checkIcon.textContent = '✗';
            checkText.textContent = result.error || 'Failed to detect encoders';
            
            // Still show rescan button to allow retry
            rescanButton.style.display = 'inline-block';
            if (!rescanButton.hasAttribute('data-handler-added')) {
                rescanButton.setAttribute('data-handler-added', 'true');
                rescanButton.addEventListener('click', async () => {
                    await this.detectHardwareEncoders();
                });
            }
        }
        
        this.updateButtonState();
    }

    async detectAudioDevices() {
        const outputSelect = document.getElementById('output-device-select');
        const inputSelect = document.getElementById('input-device-select');
        
        // Show scanning feedback
        outputSelect.innerHTML = '<option value="">Scanning audio devices...</option>';
        inputSelect.innerHTML = '<option value="">Scanning audio devices...</option>';
        outputSelect.disabled = true;
        inputSelect.disabled = true;
        
        // Request audio devices from main process
        const devices = await ipcRenderer.invoke('detect-audio-devices');
        
        if (devices) {
            // Populate output devices dropdown
            outputSelect.innerHTML = '<option value="">Select output device...</option>';
            devices.outputs.forEach(device => {
                const option = document.createElement('option');
                option.value = device.id;
                option.textContent = device.name + (device.isDefault ? ' (Default)' : '');
                option.dataset.device = JSON.stringify(device);
                outputSelect.appendChild(option);
                
                // Auto-select default
                if (device.isDefault) {
                    outputSelect.value = device.id;
                    this.configuration.audio.outputDevice = device;
                }
            });
            outputSelect.disabled = false;
            
            // Add change handler for output select
            outputSelect.onchange = (e) => {
                const selectedOption = e.target.options[e.target.selectedIndex];
                if (selectedOption && selectedOption.dataset.device) {
                    this.configuration.audio.outputDevice = JSON.parse(selectedOption.dataset.device);
                    this.updateButtonState();
                }
            };
            
            // Populate input devices dropdown
            inputSelect.innerHTML = '<option value="">Select input device...</option>';
            devices.inputs.forEach(device => {
                const option = document.createElement('option');
                option.value = device.id;
                option.textContent = device.name + (device.isDefault ? ' (Default)' : '');
                option.dataset.device = JSON.stringify(device);
                inputSelect.appendChild(option);
                
                // Auto-select default
                if (device.isDefault) {
                    inputSelect.value = device.id;
                    this.configuration.audio.inputDevice = device;
                }
            });
            inputSelect.disabled = false;
            
            // Add change handler for input select
            inputSelect.onchange = (e) => {
                const selectedOption = e.target.options[e.target.selectedIndex];
                if (selectedOption && selectedOption.dataset.device) {
                    this.configuration.audio.inputDevice = JSON.parse(selectedOption.dataset.device);
                    this.updateButtonState();
                }
            };

            // Update button state after auto-selection
            this.updateButtonState();
        }
    }

    async detectVoiceApplications(showAll = false) {
        const appList = document.getElementById('voice-app-list');
        
        // Request running applications from main process
        const applications = await ipcRenderer.invoke('detect-applications');
        
        if (applications) {
            appList.innerHTML = '';
            
            // Known voice apps
            const voiceApps = ['Discord', 'TeamSpeak', 'Mumble', 'Ventrilo', 'Steam', 'Skype', 'Zoom'];
            
            // Filter applications
            const filtered = showAll ? applications : applications.filter(app => {
                return voiceApps.some(voiceApp => app.name.toLowerCase().includes(voiceApp.toLowerCase()));
            });
            
            if (filtered.length === 0) {
                appList.innerHTML = '<div style="padding: 20px; text-align: center; color: #9ca3af;">No voice applications detected. Make sure your voice app is running.</div>';
            } else {
                filtered.forEach(app => {
                    const item = document.createElement('div');
                    item.className = 'device-item';
                    item.dataset.appId = app.id;
                    item.innerHTML = `
                        <span class="device-icon">💬</span>
                        <div>
                            <div style="font-weight: 500;">${app.name}</div>
                            <div style="font-size: 12px; color: #9ca3af;">${app.executable}</div>
                        </div>
                    `;
                    item.addEventListener('click', () => {
                        document.querySelectorAll('#voice-app-list .device-item').forEach(i => i.classList.remove('selected'));
                        item.classList.add('selected');
                        this.configuration.audio.voiceApp = app;
                    });
                    appList.appendChild(item);
                });
            }
        }
    }

    setupResolutionDefaults() {
        // Use the already selected display's resolution from configuration
        // This was set in loadDisplays() when the primary display was selected
        const width = this.configuration.display?.width || screen.width;
        const height = this.configuration.display?.height || screen.height;
        
        // Update the detected resolution display
        document.getElementById('detected-resolution').textContent = `${width}×${height}`;
        
        // Auto-select detected resolution
        document.querySelector('.resolution-option[data-resolution="detected"]').click();
    }

    getDetectedResolution() {
        // Get the selected display's resolution from configuration
        // This is set in loadDisplays() when the primary display is selected
        return {
            width: this.configuration.display?.width || screen.width,
            height: this.configuration.display?.height || screen.height
        };
    }

    updateSummary() {
        // Update summary values
        document.getElementById('summary-obs').textContent = this.configuration.obs.installed ? '✓ Installed' : '✗ Not Installed';
        
        // Select best encoder - prefer AV1 > H.265 > H.264
        let encoder = null;
        
        if (this.configuration.encoders.hardware.length > 0) {
            // First try to find AV1
            encoder = this.configuration.encoders.hardware.find(e => 
                e.codec === 'av1' || e.name.toLowerCase().includes('av1')
            );
            
            // If no AV1, try H.265/HEVC
            if (!encoder) {
                encoder = this.configuration.encoders.hardware.find(e => 
                    e.codec === 'h265' || e.name.toLowerCase().includes('h.265') || 
                    e.name.toLowerCase().includes('hevc') || e.name.toLowerCase().includes('h265')
                );
            }
            
            // If no H.264, use H.264
            if (!encoder) {
                encoder = this.configuration.encoders.hardware.find(e => 
                    e.codec === 'h264' || e.name.toLowerCase().includes('h.264') || 
                    e.name.toLowerCase().includes('h264') || e.name.toLowerCase().includes('avc')
                );
            }
            
            // Fallback to first available hardware encoder
            if (!encoder) {
                encoder = this.configuration.encoders.hardware[0];
            }
        }
        
        // Fallback to software if no hardware
        if (!encoder) {
            encoder = this.configuration.encoders.software[0];
        }
        
        document.getElementById('summary-encoder').textContent = encoder ? encoder.name : 'None';
        
        document.getElementById('summary-resolution').textContent = `${this.configuration.resolution.width}×${this.configuration.resolution.height}`;
        
        document.getElementById('summary-voice-app').textContent = this.configuration.audio.voiceApp?.name || 'None';
        
        document.getElementById('summary-microphone').textContent = this.configuration.audio.inputDevice?.name || 'None';
        
        // Update storage & game summary
        document.getElementById('summary-recording-folder').textContent = this.configuration.recordingFolder || 'Not selected';
        document.getElementById('summary-sc-folder').textContent = this.configuration.starCitizen.path || 'Not selected';
    }

    async completeSetup() {
        // Send configuration to main process
        const success = await ipcRenderer.invoke('save-configuration', this.configuration);
        
        if (success) {
            // Close wizard and proceed to main app
            ipcRenderer.send('setup-complete');
        } else {
            alert('Failed to save configuration. Please try again.');
        }
    }

    formatBytes(bytes) {
        if (!bytes || bytes === 0 || isNaN(bytes)) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
}

// Initialize wizard when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new SetupWizard();
});