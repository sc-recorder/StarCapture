// New Settings Manager for multi-view settings
class NewSettingsManager {
    constructor() {
        this.config = null;
        this.hasChanges = false;
        this.currentDisplay = null;
        this.nativeResolution = null;
        this.performanceProfile = 'custom';
        this.currentView = null;
        this.initialize();
    }

    async initialize() {
        // Load initial configuration once
        await this.loadConfig();

        // Set up event listeners for all views
        this.setupGeneralSettings();
        this.setupCaptureSettings();
        this.setupAdvancedSettings();

        // Initialize UI for all views
        this.populateAllViews();
    }

    async loadConfig() {
        try {
            this.config = await ipcRenderer.invoke('load-config');
            console.log('[NewSettings] Configuration loaded:', this.config);
            return this.config;
        } catch (error) {
            console.error('[NewSettings] Failed to load configuration:', error);
            // Initialize with empty config if load fails
            this.config = { settings: {} };
        }
    }

    setupGeneralSettings() {
        // Save/Reload buttons
        document.getElementById('save-general-config')?.addEventListener('click', () => this.saveGeneralSettings());
        document.getElementById('reload-general-config')?.addEventListener('click', () => this.reloadGeneralSettings());

        // Browse button
        document.getElementById('browse-sc-general')?.addEventListener('click', async () => {
            const result = await ipcRenderer.invoke('browse-folder', {
                title: 'Select Star Citizen Installation Folder',
                defaultPath: this.config?.settings?.starCitizen?.path || ''
            });

            if (result.success) {
                document.getElementById('sc-path-general').value = result.path;
                this.hasChanges = true;
            }
        });

        // Setup hotkey inputs
        this.setupHotkeyInputs();
    }

    setupHotkeyInputs() {
        // Track if we're currently recording a hotkey
        this.recordingHotkey = null;

        // Setup each hotkey input
        const hotkeyInputs = document.querySelectorAll('.hotkey-input');
        hotkeyInputs.forEach(input => {
            input.addEventListener('click', (e) => {
                e.preventDefault();
                this.startHotkeyRecording(input);
            });
        });

        // Setup clear buttons
        const clearButtons = document.querySelectorAll('.clear-hotkey');
        clearButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                const hotkeyType = button.dataset.hotkey;
                const input = document.getElementById(`hotkey-${hotkeyType}`);
                if (input) {
                    input.value = '';
                    input.placeholder = 'Click to set hotkey';
                    this.hasChanges = true;
                }
            });
        });
    }

    startHotkeyRecording(input) {
        // If already recording, cancel previous
        if (this.recordingHotkey) {
            this.recordingHotkey.placeholder = 'Click to set hotkey';
            this.recordingHotkey.classList.remove('recording');
        }

        // Start recording new hotkey
        this.recordingHotkey = input;
        input.placeholder = 'Press key combination...';
        input.classList.add('recording');
        input.value = '';

        // Listen for key combination
        const keydownHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Build hotkey string
            const keys = [];
            if (e.ctrlKey) keys.push('Ctrl');
            if (e.altKey) keys.push('Alt');
            if (e.shiftKey) keys.push('Shift');
            if (e.metaKey) keys.push('Super');

            // Add the actual key (ignore modifier-only presses)
            if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
                // Format the key name
                let key = e.key;
                if (key === ' ') key = 'Space';
                else if (key.length === 1) key = key.toUpperCase();
                else key = key.charAt(0).toUpperCase() + key.slice(1);

                keys.push(key);

                // Set the hotkey
                input.value = keys.join('+');
                input.placeholder = 'Click to set hotkey';
                input.classList.remove('recording');
                this.recordingHotkey = null;
                this.hasChanges = true;

                // Remove listener
                document.removeEventListener('keydown', keydownHandler);
                document.removeEventListener('click', clickHandler);
            }
        };

        // Cancel on click outside
        const clickHandler = (e) => {
            if (e.target !== input) {
                input.placeholder = 'Click to set hotkey';
                input.classList.remove('recording');
                this.recordingHotkey = null;
                document.removeEventListener('keydown', keydownHandler);
                document.removeEventListener('click', clickHandler);
            }
        };

        // Add listeners
        document.addEventListener('keydown', keydownHandler);
        setTimeout(() => {
            document.addEventListener('click', clickHandler);
        }, 100);
    }

    setupCaptureSettings() {
        // Save/Reload buttons
        document.getElementById('save-capture-config')?.addEventListener('click', () => this.saveCaptureSettings());
        document.getElementById('reload-capture-config')?.addEventListener('click', () => this.reloadCaptureSettings());

        // Encoder detection
        document.getElementById('detect-encoders-capture')?.addEventListener('click', () => this.detectEncoders());

        // Audio detection
        document.getElementById('detect-audio-capture')?.addEventListener('click', () => this.detectAudioDevices());

        // Browse output folder
        document.getElementById('browse-output-capture')?.addEventListener('click', async () => {
            const result = await ipcRenderer.invoke('browse-folder', {
                title: 'Select Output Folder',
                defaultPath: this.config?.settings?.recording?.outputPath || ''
            });

            if (result.success) {
                document.getElementById('output-path-capture').value = result.path;
                this.hasChanges = true;
            }
        });

        // Quality changes
        document.getElementById('quality-select-capture')?.addEventListener('change', (e) => {
            const isCustom = e.target.value === 'custom';
            document.getElementById('custom-bitrate-container-capture').style.display = isCustom ? 'block' : 'none';
        });

        // Resolution changes
        document.getElementById('resolution-select-capture')?.addEventListener('change', (e) => {
            const isCustom = e.target.value === 'custom';
            document.getElementById('custom-resolution-container-capture').style.display = isCustom ? 'block' : 'none';
        });

        // Display changes
        document.getElementById('display-select-capture')?.addEventListener('change', (e) => {
            const isCustom = e.target.value === 'custom';
            document.getElementById('custom-display-container-capture').style.display = isCustom ? 'block' : 'none';

            if (!isCustom) {
                // Update native resolution from selected display
                const selectedOption = e.target.options[e.target.selectedIndex];
                if (selectedOption && selectedOption.dataset.width) {
                    this.nativeResolution = {
                        width: parseInt(selectedOption.dataset.width),
                        height: parseInt(selectedOption.dataset.height)
                    };
                    console.log('[NewSettings] Native resolution updated to:', this.nativeResolution);
                }
            }
        });

        // Custom display resolution changes
        document.getElementById('custom-width-input-capture')?.addEventListener('change', (e) => {
            if (document.getElementById('display-select-capture').value === 'custom') {
                this.nativeResolution = {
                    width: parseInt(e.target.value) || 1920,
                    height: parseInt(document.getElementById('custom-height-input-capture').value) || 1080
                };
                console.log('[NewSettings] Custom resolution updated to:', this.nativeResolution);
            }
        });

        document.getElementById('custom-height-input-capture')?.addEventListener('change', (e) => {
            if (document.getElementById('display-select-capture').value === 'custom') {
                this.nativeResolution = {
                    width: parseInt(document.getElementById('custom-width-input-capture').value) || 1920,
                    height: parseInt(e.target.value) || 1080
                };
                console.log('[NewSettings] Custom resolution updated to:', this.nativeResolution);
            }
        });

        // Audio track enables
        document.getElementById('track2-enabled-capture')?.addEventListener('change', (e) => {
            document.getElementById('track2-type-capture').disabled = !e.target.checked;
            document.getElementById('track2-source-capture').disabled = !e.target.checked;
        });

        // Track 2 type change (application vs device)
        document.getElementById('track2-type-capture')?.addEventListener('change', async () => {
            // Re-detect and update audio sources when type changes
            await this.detectAudioDevices();
        });

        document.getElementById('track3-enabled-capture')?.addEventListener('change', (e) => {
            document.getElementById('track3-source-capture').disabled = !e.target.checked;
        });
    }

    setupAdvancedSettings() {
        // Save/Reload buttons
        document.getElementById('save-advanced-config')?.addEventListener('click', () => this.saveAdvancedSettings());
        document.getElementById('reload-advanced-config')?.addEventListener('click', () => this.reloadAdvancedSettings());

        // Regenerate templates
        document.getElementById('regenerate-templates-advanced')?.addEventListener('click', () => this.regenerateTemplates());

        // Re-run wizard
        document.getElementById('rerun-wizard-advanced')?.addEventListener('click', () => {
            ipcRenderer.send('rerun-wizard');
        });

        // Custom OBS file uploads
        this.setupCustomOBSFileHandlers();
    }

    setupCustomOBSFileHandlers() {
        const profileUploadBtn = document.getElementById('upload-obs-profile-btn');
        const profileFileInput = document.getElementById('custom-obs-profile-file');
        const sceneUploadBtn = document.getElementById('upload-obs-scene-btn');
        const sceneFileInput = document.getElementById('custom-obs-scene-file');
        const clearFilesBtn = document.getElementById('clear-custom-obs-files');

        // Profile upload
        profileUploadBtn?.addEventListener('click', () => profileFileInput?.click());
        profileFileInput?.addEventListener('change', (e) => this.handleCustomProfileUpload(e));

        // Scene upload
        sceneUploadBtn?.addEventListener('click', () => sceneFileInput?.click());
        sceneFileInput?.addEventListener('change', (e) => this.handleCustomSceneUpload(e));

        // Clear files
        clearFilesBtn?.addEventListener('click', () => this.clearCustomOBSFiles());
    }

    async handleCustomProfileUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const content = await this.readFileAsText(file);
            const result = await ipcRenderer.invoke('save-custom-obs-profile', {
                filename: file.name,
                content: content
            });

            if (result.success) {
                document.getElementById('custom-profile-filename').textContent = file.name;
                window.NotificationManager.success('Custom profile uploaded successfully');
            } else {
                window.NotificationManager.error('Failed to save custom profile');
            }
        } catch (error) {
            console.error('[NewSettings] Error uploading custom profile:', error);
            window.NotificationManager.error('Error uploading custom profile');
        }

        // Clear the input for future uploads
        event.target.value = '';
    }

    async handleCustomSceneUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const content = await this.readFileAsText(file);
            // Validate JSON
            try {
                JSON.parse(content);
            } catch (jsonError) {
                window.NotificationManager.error('Invalid JSON file');
                return;
            }

            const result = await ipcRenderer.invoke('save-custom-obs-scene', {
                filename: file.name,
                content: content
            });

            if (result.success) {
                document.getElementById('custom-scene-filename').textContent = file.name;
                window.NotificationManager.success('Custom scene collection uploaded successfully');
            } else {
                window.NotificationManager.error('Failed to save custom scene collection');
            }
        } catch (error) {
            console.error('[NewSettings] Error uploading custom scene:', error);
            window.NotificationManager.error('Error uploading custom scene collection');
        }

        // Clear the input for future uploads
        event.target.value = '';
    }

    async clearCustomOBSFiles() {
        try {
            const result = await ipcRenderer.invoke('clear-custom-obs-files');
            if (result.success) {
                document.getElementById('custom-profile-filename').textContent = '';
                document.getElementById('custom-scene-filename').textContent = '';
                document.getElementById('use-custom-obs-profile').checked = false;
                document.getElementById('use-custom-obs-scene').checked = false;
                window.NotificationManager.success('Custom OBS files cleared');
            }
        } catch (error) {
            console.error('[NewSettings] Error clearing custom files:', error);
            window.NotificationManager.error('Error clearing custom files');
        }
    }

    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }

    // Populate all views with config data
    populateAllViews() {
        this.populateGeneralSettings();
        this.populateCaptureSettings();
        this.populateAdvancedSettings();
        this.populateEncoders();
        this.populateDisplays();
        // Auto-detect audio devices on load
        this.detectAudioDevices();
    }

    populateGeneralSettings() {
        if (!this.config?.settings) return;

        // Star Citizen path
        if (this.config.settings.starCitizen?.path) {
            document.getElementById('sc-path-general').value = this.config.settings.starCitizen.path;
        }

        // Hotkeys
        if (this.config.settings.hotkeys) {
            if (this.config.settings.hotkeys.startStop) {
                document.getElementById('hotkey-start-stop').value = this.config.settings.hotkeys.startStop;
            }
            if (this.config.settings.hotkeys.split) {
                document.getElementById('hotkey-split').value = this.config.settings.hotkeys.split;
            }
            if (this.config.settings.hotkeys.markEvent) {
                document.getElementById('hotkey-mark-event').value = this.config.settings.hotkeys.markEvent;
            }
        }

        // Load auto-update setting
        if (this.config.settings.autoUpdateEnabled !== undefined) {
            document.getElementById('auto-update-enabled').checked = this.config.settings.autoUpdateEnabled;
        } else {
            document.getElementById('auto-update-enabled').checked = true; // Default enabled
        }

        // Recording options
        if (this.config.settings.recordingOptions) {
            const opts = this.config.settings.recordingOptions;
            document.getElementById('auto-start-recording').checked = opts.autoStartRecording || false;
            document.getElementById('enable-shadow-play').checked = opts.enableShadowPlay || false;
            document.getElementById('file-split-duration').value = opts.fileSplitDuration || 5;
            document.getElementById('max-storage-gb').value = opts.maxStorageGB || 50;
            document.getElementById('min-files-to-keep').value = opts.minFilesToKeep !== undefined ? opts.minFilesToKeep : 5;
            document.getElementById('max-files-to-keep').value = opts.maxFilesToKeep !== undefined ? opts.maxFilesToKeep : 0;
        } else {
            // Set defaults if not configured
            document.getElementById('auto-start-recording').checked = false;
            document.getElementById('enable-shadow-play').checked = false;
            document.getElementById('file-split-duration').value = 5;
            document.getElementById('max-storage-gb').value = 50;
            document.getElementById('min-files-to-keep').value = 5;
            document.getElementById('max-files-to-keep').value = 0;
        }
    }

    populateCaptureSettings() {
        if (!this.config?.settings) return;
        const settings = this.config.settings;

        // Recording settings
        if (settings.recording) {
            // Encoder
            if (settings.recording.encoderId) {
                document.getElementById('encoder-select-capture').value = settings.recording.encoderId;
            }

            // Performance profile
            if (settings.performance?.profile) {
                document.getElementById('performance-profile-capture').value = settings.performance.profile;
            }

            // Bitrate mode
            if (settings.recording.bitrateMode) {
                document.getElementById('bitrate-mode-capture').value = settings.recording.bitrateMode;
            }

            // Quality
            if (settings.recording.quality) {
                document.getElementById('quality-select-capture').value = settings.recording.quality;
                if (settings.recording.quality === 'custom') {
                    document.getElementById('custom-bitrate-container-capture').style.display = 'block';
                    document.getElementById('bitrate-input-capture').value = settings.recording.bitrate;
                }
            }

            // Framerate
            if (settings.recording.framerate) {
                document.getElementById('framerate-select-capture').value = settings.recording.framerate;
            }

            // Output path
            if (settings.recording.outputPath) {
                document.getElementById('output-path-capture').value = settings.recording.outputPath;
            }
        }

        // Resolution settings
        if (settings.resolution) {
            const resSelect = document.getElementById('resolution-select-capture');
            if (settings.resolution.preset === 'custom') {
                resSelect.value = 'custom';
                document.getElementById('custom-resolution-container-capture').style.display = 'block';
                document.getElementById('width-input-capture').value = settings.resolution.width;
                document.getElementById('height-input-capture').value = settings.resolution.height;
            } else if (settings.resolution.preset) {
                resSelect.value = settings.resolution.preset;
            }
        }

        // Display settings
        if (settings.display) {
            const displaySelect = document.getElementById('display-select-capture');
            if (settings.display.id === 'custom') {
                displaySelect.value = 'custom';
                document.getElementById('custom-display-container-capture').style.display = 'block';
                document.getElementById('custom-width-input-capture').value = settings.display.width || 1920;
                document.getElementById('custom-height-input-capture').value = settings.display.height || 1080;
                // Update native resolution for custom
                this.nativeResolution = {
                    width: settings.display.width || 1920,
                    height: settings.display.height || 1080
                };
            } else if (settings.display?.id) {
                // Try to select the saved display
                displaySelect.value = settings.display.id;
                // Update native resolution from selected display
                const selectedOption = displaySelect.options[displaySelect.selectedIndex];
                if (selectedOption && selectedOption.dataset.width) {
                    this.nativeResolution = {
                        width: parseInt(selectedOption.dataset.width),
                        height: parseInt(selectedOption.dataset.height)
                    };
                }
            }
        }

        // Audio settings
        if (settings.audio) {
            // Track 1
            if (settings.audio.track1) {
                document.getElementById('track1-enabled-capture').checked = settings.audio.track1.enabled;
            }

            // Track 2
            if (settings.audio.track2) {
                document.getElementById('track2-enabled-capture').checked = settings.audio.track2.enabled;
                document.getElementById('track2-type-capture').value = settings.audio.track2.type || 'application';
                document.getElementById('track2-type-capture').disabled = !settings.audio.track2.enabled;
                document.getElementById('track2-source-capture').value = settings.audio.track2.source || '';
                document.getElementById('track2-source-capture').disabled = !settings.audio.track2.enabled;
            }

            // Track 3
            if (settings.audio.track3) {
                document.getElementById('track3-enabled-capture').checked = settings.audio.track3.enabled;
                document.getElementById('track3-source-capture').value = settings.audio.track3.source || '';
                document.getElementById('track3-source-capture').disabled = !settings.audio.track3.enabled;
            }
        }
    }

    populateAdvancedSettings() {
        if (!this.config?.settings) return;

        // OBS auto-restart
        if (this.config.settings.obs?.autoRestart !== undefined) {
            document.getElementById('obs-auto-restart-advanced').checked = this.config.settings.obs.autoRestart;
        }

        // Custom OBS files
        if (this.config.settings.customOBS) {
            const customOBS = this.config.settings.customOBS;

            // Profile settings
            if (customOBS.useCustomProfile !== undefined) {
                document.getElementById('use-custom-obs-profile').checked = customOBS.useCustomProfile;
            }
            if (customOBS.customProfileFilename) {
                document.getElementById('custom-profile-filename').textContent = customOBS.customProfileFilename;
            }

            // Scene settings
            if (customOBS.useCustomScene !== undefined) {
                document.getElementById('use-custom-obs-scene').checked = customOBS.useCustomScene;
            }
            if (customOBS.customSceneFilename) {
                document.getElementById('custom-scene-filename').textContent = customOBS.customSceneFilename;
            }
        }
    }

    async populateEncoders() {
        try {
            // Try to get cached encoders first
            const cachedEncoders = await ipcRenderer.invoke('get-cached-encoders');
            if (cachedEncoders) {
                this.updateEncoderDropdown(cachedEncoders);
            }
        } catch (error) {
            console.error('[NewSettings] Failed to populate encoders:', error);
        }
    }

    async populateDisplays() {
        try {
            const displays = await ipcRenderer.invoke('get-displays');
            const select = document.getElementById('display-select-capture');

            if (!select) return;

            console.log('[NewSettings] Displays received:', displays);
            select.innerHTML = '';

            displays.forEach((display, index) => {
                const option = document.createElement('option');
                // Check for bounds property which Electron uses
                const width = display.bounds?.width || display.size?.width || display.width;
                const height = display.bounds?.height || display.size?.height || display.height;

                option.value = display.id;
                option.textContent = `Display ${index + 1} - ${width}×${height}`;
                option.dataset.width = width;
                option.dataset.height = height;
                select.appendChild(option);
            });

            // Add custom option
            const customOption = document.createElement('option');
            customOption.value = 'custom';
            customOption.textContent = 'Custom Resolution';
            select.appendChild(customOption);

            // Don't automatically set native resolution to first display
            // It will be set when we restore the saved selection below

            // Restore saved selection or use first display as default
            if (this.config?.settings?.display?.id) {
                select.value = this.config.settings.display.id;
                if (this.config.settings.display.id === 'custom') {
                    document.getElementById('custom-display-container-capture').style.display = 'block';
                    document.getElementById('custom-width-input-capture').value = this.config.settings.display.width;
                    document.getElementById('custom-height-input-capture').value = this.config.settings.display.height;

                    // Update native resolution for custom
                    this.nativeResolution = {
                        width: this.config.settings.display.width,
                        height: this.config.settings.display.height
                    };
                } else {
                    // Update native resolution from the selected display (not just custom)
                    const selectedOption = select.options[select.selectedIndex];
                    if (selectedOption && selectedOption.dataset.width) {
                        this.nativeResolution = {
                            width: parseInt(selectedOption.dataset.width),
                            height: parseInt(selectedOption.dataset.height)
                        };
                        console.log('[NewSettings] Native resolution updated from restored display:', this.nativeResolution);
                    }
                }
            } else if (displays.length > 0) {
                // No saved selection, use first display as default
                const firstDisplay = displays[0];
                const width = firstDisplay.bounds?.width || firstDisplay.size?.width || firstDisplay.width;
                const height = firstDisplay.bounds?.height || firstDisplay.size?.height || firstDisplay.height;
                this.nativeResolution = {
                    width: width,
                    height: height
                };
                console.log('[NewSettings] Native resolution set to first display (no saved config):', this.nativeResolution);
            }
        } catch (error) {
            console.error('[NewSettings] Failed to populate displays:', error);
        }
    }

    updateEncoderDropdown(encoders) {
        const select = document.getElementById('encoder-select-capture');
        if (!select) return;

        select.innerHTML = '';

        // Add hardware encoders
        if (encoders.hardware && encoders.hardware.length > 0) {
            const hwGroup = document.createElement('optgroup');
            hwGroup.label = 'Hardware Encoders';
            encoders.hardware.forEach(encoder => {
                const option = document.createElement('option');
                option.value = encoder.id;
                option.textContent = encoder.name;
                hwGroup.appendChild(option);
            });
            select.appendChild(hwGroup);
        }

        // Add software encoders
        if (encoders.software && encoders.software.length > 0) {
            const swGroup = document.createElement('optgroup');
            swGroup.label = 'Software Encoders';
            encoders.software.forEach(encoder => {
                const option = document.createElement('option');
                option.value = encoder.id;
                option.textContent = encoder.name;
                swGroup.appendChild(option);
            });
            select.appendChild(swGroup);
        }

        // Restore saved selection
        if (this.config?.settings?.recording?.encoderId) {
            select.value = this.config.settings.recording.encoderId;
        }
    }

    // Gather settings from specific views
    gatherGeneralSettings() {
        return {
            starCitizen: {
                path: document.getElementById('sc-path-general').value
            },
            autoUpdateEnabled: document.getElementById('auto-update-enabled').checked,
            hotkeys: {
                startStop: document.getElementById('hotkey-start-stop').value || '',
                split: document.getElementById('hotkey-split').value || '',
                markEvent: document.getElementById('hotkey-mark-event').value || ''
            },
            recordingOptions: {
                autoStartRecording: document.getElementById('auto-start-recording').checked,
                enableShadowPlay: document.getElementById('enable-shadow-play').checked,
                fileSplitDuration: parseInt(document.getElementById('file-split-duration').value) || 5,
                maxStorageGB: parseInt(document.getElementById('max-storage-gb').value) || 50,
                minFilesToKeep: parseInt(document.getElementById('min-files-to-keep').value) || 0,
                maxFilesToKeep: parseInt(document.getElementById('max-files-to-keep').value) || 0
            }
        };
    }

    getSelectedDisplayResolution() {
        const displaySelect = document.getElementById('display-select-capture');
        if (!displaySelect || displaySelect.value === 'custom') {
            return null;
        }

        const selectedOption = displaySelect.options[displaySelect.selectedIndex];
        if (selectedOption && selectedOption.dataset.width) {
            return {
                width: parseInt(selectedOption.dataset.width),
                height: parseInt(selectedOption.dataset.height)
            };
        }
        return null;
    }

    gatherCaptureSettings() {
        const resolutionSettings = this.gatherResolutionSettings();

        return {
            resolution: resolutionSettings,
            recording: {
                codec: this.getCodecFromEncoderId(document.getElementById('encoder-select-capture').value),
                encoder: document.getElementById('encoder-select-capture').selectedOptions[0]?.text || '',
                encoderId: document.getElementById('encoder-select-capture').value,
                quality: document.getElementById('quality-select-capture').value,
                framerate: parseInt(document.getElementById('framerate-select-capture').value),
                bitrate: this.calculateBitrate(),
                bitrateMode: document.getElementById('bitrate-mode-capture').value,
                outputPath: document.getElementById('output-path-capture').value
            },
            audio: {
                track1: {
                    enabled: document.getElementById('track1-enabled-capture').checked,
                    source: 'Star Citizen:CryENGINE:StarCitizen.exe',
                    type: 'application'
                },
                track2: {
                    enabled: document.getElementById('track2-enabled-capture').checked,
                    source: document.getElementById('track2-source-capture').value,
                    type: document.getElementById('track2-type-capture').value || 'application'
                },
                track3: {
                    enabled: document.getElementById('track3-enabled-capture').checked,
                    source: document.getElementById('track3-source-capture').value,
                    type: 'device'
                }
            },
            display: {
                id: document.getElementById('display-select-capture')?.value === 'custom' ?
                    'custom' : parseInt(document.getElementById('display-select-capture')?.value || 0),
                width: document.getElementById('display-select-capture')?.value === 'custom' ?
                    parseInt(document.getElementById('custom-width-input-capture').value) :
                    this.getSelectedDisplayResolution()?.width || this.nativeResolution?.width,
                height: document.getElementById('display-select-capture')?.value === 'custom' ?
                    parseInt(document.getElementById('custom-height-input-capture').value) :
                    this.getSelectedDisplayResolution()?.height || this.nativeResolution?.height
            },
            performance: {
                profile: document.getElementById('performance-profile-capture').value,
                resolutionScale: document.getElementById('resolution-select-capture').value.includes('scale') ?
                    document.getElementById('resolution-select-capture').value.replace('scale-', '') : 'native',
                bitrateMode: document.getElementById('bitrate-mode-capture').value
            }
        };
    }

    gatherAdvancedSettings() {
        return {
            obs: {
                autoRestart: document.getElementById('obs-auto-restart-advanced').checked
            },
            customOBS: {
                useCustomProfile: document.getElementById('use-custom-obs-profile').checked,
                useCustomScene: document.getElementById('use-custom-obs-scene').checked,
                customProfileFilename: document.getElementById('custom-profile-filename').textContent || null,
                customSceneFilename: document.getElementById('custom-scene-filename').textContent || null
            }
        };
    }

    gatherResolutionSettings() {
        const resolutionSelect = document.getElementById('resolution-select-capture');
        const selected = resolutionSelect.value;

        const baseWidth = this.nativeResolution?.width || 1920;
        const baseHeight = this.nativeResolution?.height || 1080;

        if (selected === 'custom') {
            return {
                preset: 'custom',
                width: parseInt(document.getElementById('width-input-capture').value),
                height: parseInt(document.getElementById('height-input-capture').value),
                scaleFactor: 1
            };
        } else if (selected === 'native' || selected === 'scale-75' || selected === 'scale-50') {
            const scaleFactor = selected === 'scale-75' ? 0.75 : (selected === 'scale-50' ? 0.5 : 1.0);
            return {
                preset: selected,
                width: baseWidth,
                height: baseHeight,
                scaleFactor: scaleFactor
            };
        } else {
            // Fixed resolution like "1920x1080"
            const [width, height] = selected.split('x').map(n => parseInt(n));
            return {
                preset: 'fixed',
                width: width,
                height: height,
                scaleFactor: 1
            };
        }
    }

    calculateBitrate() {
        const bitrateMode = document.getElementById('bitrate-mode-capture').value;
        const quality = document.getElementById('quality-select-capture').value;

        if (bitrateMode === 'auto') {
            const resolution = this.gatherResolutionSettings();
            const fps = parseInt(document.getElementById('framerate-select-capture').value);
            const profile = document.getElementById('performance-profile-capture').value;

            let width = resolution.width;
            let height = resolution.height;
            if (resolution.scaleFactor && resolution.scaleFactor !== 1) {
                width = Math.round((width * resolution.scaleFactor) / 2) * 2;
                height = Math.round((height * resolution.scaleFactor) / 2) * 2;
            }

            return this.calculateOptimalBitrate(width, height, fps, profile);
        } else {
            if (quality === 'custom') {
                return parseInt(document.getElementById('bitrate-input-capture').value);
            } else {
                const bitrates = {
                    low: 15000,
                    medium: 25000,
                    high: 50000,
                    ultra: 80000
                };
                return bitrates[quality] || 50000;
            }
        }
    }

    calculateOptimalBitrate(width, height, fps, profile) {
        const pixels = width * height;
        const motionFactor = fps / 30;

        const qualityMultipliers = {
            performance: 3,
            balanced: 6,
            quality: 12,
            custom: 10
        };

        const multiplier = qualityMultipliers[profile] || qualityMultipliers.custom;
        const baseBitrate = (pixels / 1000000) * multiplier * motionFactor;
        return Math.round(baseBitrate * 1000);
    }

    getCodecFromEncoderId(encoderId) {
        if (!encoderId) return 'h264';
        if (encoderId.includes('av1')) return 'av1';
        if (encoderId.includes('h265') || encoderId.includes('hevc')) return 'h265';
        return 'h264';
    }

    // Save functions for each view
    async saveGeneralSettings() {
        try {
            const generalSettings = this.gatherGeneralSettings();

            // Merge with existing config
            const mergedSettings = {
                ...this.config.settings,
                ...generalSettings
            };

            // Update local config
            this.config.settings = mergedSettings;

            // Save via IPC
            const result = await ipcRenderer.invoke('update-config', mergedSettings);

            if (result.success) {
                window.NotificationManager.success('General settings saved successfully');
                this.hasChanges = false;
            } else {
                window.NotificationManager.error('Failed to save general settings');
            }
        } catch (error) {
            console.error('[NewSettings] Error saving general settings:', error);
            window.NotificationManager.error('Error saving general settings');
        }
    }

    async saveCaptureSettings() {
        try {
            const captureSettings = this.gatherCaptureSettings();

            // Merge with existing config, preserving other settings
            const mergedSettings = {
                ...this.config.settings,
                ...captureSettings
            };

            // Update local config
            this.config.settings = mergedSettings;

            // Save via IPC
            const result = await ipcRenderer.invoke('update-config', mergedSettings);

            if (result.success) {
                if (result.regenerated) {
                    window.NotificationManager.success('Capture settings saved and templates updated');
                } else {
                    window.NotificationManager.success('Capture settings saved successfully');
                }
                this.hasChanges = false;
            } else {
                window.NotificationManager.error('Failed to save capture settings');
            }
        } catch (error) {
            console.error('[NewSettings] Error saving capture settings:', error);
            window.NotificationManager.error('Error saving capture settings');
        }
    }

    async saveAdvancedSettings() {
        try {
            const advancedSettings = this.gatherAdvancedSettings();

            // Check if custom OBS settings changed
            const customOBSChanged = (
                this.config.settings?.customOBS?.useCustomProfile !== advancedSettings.customOBS?.useCustomProfile ||
                this.config.settings?.customOBS?.useCustomScene !== advancedSettings.customOBS?.useCustomScene
            );

            // Merge with existing config
            const mergedSettings = {
                ...this.config.settings,
                ...advancedSettings
            };

            // Update local config
            this.config.settings = mergedSettings;

            // Save via IPC
            const result = await ipcRenderer.invoke('update-config', mergedSettings);

            if (result.success) {
                // If custom OBS settings changed, regenerate templates
                if (customOBSChanged) {
                    const regenerateResult = await ipcRenderer.invoke('regenerate-templates', this.config);
                    if (regenerateResult.success) {
                        window.NotificationManager.success('Advanced settings saved and OBS configuration updated');
                    } else {
                        window.NotificationManager.warning('Settings saved but OBS update failed');
                    }
                } else {
                    window.NotificationManager.success('Advanced settings saved successfully');
                }
                this.hasChanges = false;
            } else {
                window.NotificationManager.error('Failed to save advanced settings');
            }
        } catch (error) {
            console.error('[NewSettings] Error saving advanced settings:', error);
            window.NotificationManager.error('Error saving advanced settings');
        }
    }

    // Reload functions for each view
    async reloadGeneralSettings() {
        await this.loadConfig();
        this.populateGeneralSettings();
        window.NotificationManager.info('General settings reloaded');
    }

    async reloadCaptureSettings() {
        await this.loadConfig();
        this.populateCaptureSettings();
        this.populateEncoders();
        this.populateDisplays();
        window.NotificationManager.info('Capture settings reloaded');
    }

    async reloadAdvancedSettings() {
        await this.loadConfig();
        this.populateAdvancedSettings();
        window.NotificationManager.info('Advanced settings reloaded');
    }

    // Utility functions
    async detectEncoders() {
        try {
            const button = document.getElementById('detect-encoders-capture');
            button.disabled = true;
            button.style.color = '#ffffff';
            button.textContent = 'Detecting...';

            const result = await ipcRenderer.invoke('detect-encoders', true);

            if (result.success && result.encoders) {
                this.updateEncoderDropdown(result.encoders);
                window.NotificationManager.success('Encoders detected successfully');
            } else {
                window.NotificationManager.error('Failed to detect encoders');
            }
        } catch (error) {
            console.error('[NewSettings] Error detecting encoders:', error);
            window.NotificationManager.error('Error detecting encoders');
        } finally {
            const button = document.getElementById('detect-encoders-capture');
            button.disabled = false;
            button.style.color = '#ffffff';
            button.textContent = 'Detect Encoders';
        }
    }

    async detectAudioDevices() {
        try {
            const button = document.getElementById('detect-audio-capture');
            if (button) {
                button.disabled = true;
                button.style.color = '#ffffff';
            button.textContent = 'Detecting...';
            }

            const result = await ipcRenderer.invoke('detect-audio-devices');
            console.log('[NewSettings] Audio devices detected:', result);

            if (result.success) {
                // Update audio source dropdowns with the correct device arrays
                this.updateAudioSources(result.inputDevices || result.inputs, result.outputDevices || result.outputs, result.applications);

                // Restore saved selections after populating
                if (this.config?.settings?.audio) {
                    if (this.config.settings.audio.track2?.source) {
                        const track2Source = document.getElementById('track2-source-capture');
                        if (track2Source) {
                            track2Source.value = this.config.settings.audio.track2.source;
                        }
                    }
                    if (this.config.settings.audio.track3?.source) {
                        const track3Source = document.getElementById('track3-source-capture');
                        if (track3Source) {
                            track3Source.value = this.config.settings.audio.track3.source;
                        }
                    }
                }

                if (button) {
                    window.NotificationManager.success('Audio devices detected successfully');
                }
            } else {
                if (button) {
                    window.NotificationManager.error('Failed to detect audio devices');
                }
            }
        } catch (error) {
            console.error('[NewSettings] Error detecting audio devices:', error);
            if (document.getElementById('detect-audio-capture')) {
                window.NotificationManager.error('Error detecting audio devices');
            }
        } finally {
            const button = document.getElementById('detect-audio-capture');
            if (button) {
                button.disabled = false;
                button.style.color = '#ffffff';
                button.textContent = 'Detect Audio';
            }
        }
    }

    updateAudioSources(inputDevices, outputDevices, applications) {
        console.log('[NewSettings] Updating audio sources:', { inputDevices, outputDevices, applications });

        // Update track 2 source dropdown
        const track2Source = document.getElementById('track2-source-capture');
        const track2Type = document.getElementById('track2-type-capture')?.value;

        if (track2Source) {
            track2Source.innerHTML = '<option value="">Select source...</option>';

            if (track2Type === 'application' && applications) {
                applications.forEach(app => {
                    const option = document.createElement('option');
                    // Handle if app is an object with id and name properties
                    const appId = typeof app === 'string' ? app : (app.id || app.name || String(app));
                    let appName = typeof app === 'string' ? app : (app.name || app.id || String(app));

                    // Truncate very long application names
                    if (appName.length > 50) {
                        appName = appName.substring(0, 47) + '...';
                    }

                    option.value = appId;
                    option.textContent = appName;
                    option.title = typeof app === 'string' ? app : (app.name || app.id || String(app)); // Full name on hover
                    track2Source.appendChild(option);
                });
            } else if (track2Type === 'device' && inputDevices) {
                inputDevices.forEach(device => {
                    const option = document.createElement('option');
                    option.value = device.id || device.deviceId || device.name;
                    option.textContent = device.name || device.label || device.id;
                    track2Source.appendChild(option);
                });
            }
        }

        // Update track 3 microphone dropdown
        const track3Source = document.getElementById('track3-source-capture');
        if (track3Source) {
            track3Source.innerHTML = '<option value="">Select microphone...</option>';

            if (inputDevices && Array.isArray(inputDevices)) {
                inputDevices.forEach(device => {
                    const option = document.createElement('option');
                    option.value = device.id || device.deviceId || device.name;
                    option.textContent = device.name || device.label || device.id;
                    track3Source.appendChild(option);
                });
            }
        }
    }

    async regenerateTemplates() {
        try {
            const button = document.getElementById('regenerate-templates-advanced');
            button.disabled = true;
            button.textContent = 'Regenerating...';

            const result = await ipcRenderer.invoke('regenerate-templates', this.config);

            if (result.success) {
                window.NotificationManager.success('Templates regenerated successfully');
            } else {
                window.NotificationManager.error('Failed to regenerate templates');
            }
        } catch (error) {
            console.error('[NewSettings] Error regenerating templates:', error);
            window.NotificationManager.error('Error regenerating templates');
        } finally {
            const button = document.getElementById('regenerate-templates-advanced');
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-sync"></i> Regenerate Templates';
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Only initialize if we're on a settings view
    const hasNewSettings = document.getElementById('general-settings-view') ||
                          document.getElementById('capture-settings-view') ||
                          document.getElementById('advanced-settings-view');

    if (hasNewSettings) {
        console.log('[NewSettings] Initializing new settings manager');
        window.newSettingsManager = new NewSettingsManager();
    }
});