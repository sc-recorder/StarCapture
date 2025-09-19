const fs = require('fs').promises;
const path = require('path');

class ConfigManager {
    constructor(configPath) {
        // Always use APPDATA for config storage
        const defaultConfigDir = path.join(process.env.APPDATA || process.env.HOME, 'sc-recorder');
            
        this.configPath = configPath || path.join(
            defaultConfigDir,
            'obs-config.json'
        );
        this.encodersPath = path.join(
            defaultConfigDir,
            'detected-encoders.json'
        );
        this.config = null;
        this.isFirstRun = false;
    }

    // Check if configuration exists
    async exists() {
        try {
            await fs.access(this.configPath);
            return true;
        } catch {
            return false;
        }
    }

    // Load configuration
    async load() {
        try {
            const data = await fs.readFile(this.configPath, 'utf8');
            this.config = JSON.parse(data);
            
            // Ensure performance settings exist (backward compatibility)
            if (this.config.settings && !this.config.settings.performance) {
                this.config.settings.performance = {
                    profile: 'custom',
                    resolutionScale: 'native',
                    bitrateMode: 'manual',
                    processPriority: null,
                    encoderPreset: null,
                    rateControl: 'VBR',
                    cqLevel: 23
                };
            }
            
            return this.config;
        } catch (error) {
            console.log('No existing configuration found');
            this.isFirstRun = true;
            return null;
        }
    }

    // Save configuration with detected capabilities
    async save(config) {
        try {
            // Ensure directory exists
            const dir = path.dirname(this.configPath);
            await fs.mkdir(dir, { recursive: true });
            
            // Save configuration
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
            this.config = config;
            this.isFirstRun = false;
            
            console.log('Configuration saved to:', this.configPath);
            return true;
        } catch (error) {
            console.error('Failed to save configuration:', error);
            return false;
        }
    }

    // Get detected capabilities structure
    getCapabilitiesTemplate() {
        return {
            version: '1.0.0',
            detectedAt: new Date().toISOString(),
            encoders: {
                hardware: [],
                software: []
            },
            audio: {
                outputDevices: [],
                inputDevices: [],
                applications: []
            },
            display: {
                width: null,
                height: null,
                refreshRate: 60
            },
            websocket: {
                port: 4455,
                password: 'screcorder123'
            },
            settings: {
                resolution: {
                    preset: 'native',
                    width: null,
                    height: null,
                    scaleFactor: 1
                },
                recording: {
                    codec: 'h264',
                    encoder: null,
                    quality: 'high',
                    framerate: 60,
                    bitrate: 50000,
                    outputPath: null
                },
                audio: {
                    track1: {
                        enabled: true,
                        source: 'Star Citizen:CryENGINE:StarCitizen.exe',
                        type: 'application'
                    },
                    track2: {
                        enabled: false,
                        source: null,
                        type: 'device'
                    },
                    track3: {
                        enabled: false,
                        source: null,
                        type: 'device'
                    }
                },
                starCitizen: {
                    path: null,
                    build: 'LIVE'
                },
                performance: {
                    profile: 'custom',              // custom, performance, balanced, quality
                    resolutionScale: 'native',      // native, 75, 50
                    bitrateMode: 'manual',          // auto, manual
                    processPriority: null,          // null, BelowNormal, Normal, AboveNormal, High
                    encoderPreset: null,            // null or encoder-specific preset
                    rateControl: 'VBR',             // VBR, CBR, CQP, CRF
                    cqLevel: 23                     // CQ/CRF level for constant quality modes
                }
            }
        };
    }

    // Update capabilities after detection
    updateCapabilities(capabilities) {
        if (!this.config) {
            this.config = this.getCapabilitiesTemplate();
        }
        
        // Update encoders
        if (capabilities.encoders) {
            this.config.encoders = capabilities.encoders;
            
            // Auto-select best encoder - prefer hardware, but don't set if none available
            if (!this.config.settings.recording.encoder) {
                if (capabilities.encoders.hardware.length > 0) {
                    // Prefer H.264 hardware encoder as most compatible
                    const h264Encoder = capabilities.encoders.hardware.find(e => e.name.includes('h264'));
                    this.config.settings.recording.encoder = h264Encoder ? h264Encoder.name : capabilities.encoders.hardware[0].name;
                } else if (capabilities.encoders.software.length > 0) {
                    // Fallback to software if no hardware available
                    this.config.settings.recording.encoder = capabilities.encoders.software[0].name;
                } else {
                    // No encoder available - this shouldn't happen but handle it
                    this.config.settings.recording.encoder = null;
                }
            }
        }
        
        // Update audio devices
        if (capabilities.audio) {
            this.config.audio = capabilities.audio;
        }
        
        // Update display info
        if (capabilities.display) {
            this.config.display = capabilities.display;
            
            // Update resolution settings to match display
            // Both 'display' and 'native' presets should use actual display resolution
            if (this.config.settings.resolution.preset === 'display' || 
                this.config.settings.resolution.preset === 'native' ||
                !this.config.settings.resolution.width) {
                this.config.settings.resolution.width = capabilities.display.width;
                this.config.settings.resolution.height = capabilities.display.height;
                // Normalize preset to 'native'
                if (this.config.settings.resolution.preset === 'display') {
                    this.config.settings.resolution.preset = 'native';
                }
            }
        }
        
        return this.config;
    }

    // Update user settings
    updateSettings(settings) {
        if (!this.config) {
            this.config = this.getCapabilitiesTemplate();
        }
        
        // Deep merge settings
        Object.keys(settings).forEach(key => {
            if (typeof settings[key] === 'object' && !Array.isArray(settings[key])) {
                this.config.settings[key] = {
                    ...this.config.settings[key],
                    ...settings[key]
                };
            } else {
                this.config.settings[key] = settings[key];
            }
        });
        
        return this.config;
    }

    // Check if configuration is valid
    isValid() {
        if (!this.config) return false;
        
        // Check required fields
        return !!(
            this.config.encoders &&
            this.config.settings &&
            this.config.settings.resolution &&
            this.config.settings.recording
        );
    }

    // Get current settings
    getSettings() {
        return this.config?.settings || null;
    }

    // Get full configuration
    get() {
        return this.config;
    }

    // Check if this is first run
    checkFirstRun() {
        return this.isFirstRun;
    }
    
    // Save detected encoders to cache file
    async saveEncodersCache(encoders) {
        try {
            // Ensure directory exists
            const dir = path.dirname(this.encodersPath);
            await fs.mkdir(dir, { recursive: true });
            
            // Save encoder data with metadata
            const encoderData = {
                version: '1.0.0',
                detectedAt: new Date().toISOString(),
                encoders: encoders
            };
            
            await fs.writeFile(this.encodersPath, JSON.stringify(encoderData, null, 2));
            console.log('Encoder cache saved to:', this.encodersPath);
            return true;
        } catch (error) {
            console.error('Failed to save encoder cache:', error);
            return false;
        }
    }
    
    // Load cached encoders
    async loadEncodersCache() {
        try {
            const data = await fs.readFile(this.encodersPath, 'utf8');
            const encoderData = JSON.parse(data);
            console.log('Loaded encoder cache from:', this.encodersPath);
            return encoderData.encoders;
        } catch (error) {
            console.log('No encoder cache found');
            return null;
        }
    }
    
    // Check if encoder cache exists
    async hasEncodersCache() {
        try {
            await fs.access(this.encodersPath);
            return true;
        } catch {
            return false;
        }
    }

    // Update pattern tracking information
    async updatePatternTracking(version) {
        try {
            if (!this.config) {
                await this.load();
            }

            // Initialize patternUpdates if it doesn't exist
            if (!this.config.patternUpdates) {
                this.config.patternUpdates = {};
            }

            this.config.patternUpdates = {
                lastChecked: new Date().toISOString(),
                lastVersion: version,
                autoUpdate: this.config.patternUpdates?.autoUpdate !== false // Default to true
            };

            await this.save(this.config);
            console.log(`Pattern tracking updated: v${version}`);
            return true;
        } catch (error) {
            console.error('Failed to update pattern tracking:', error);
            return false;
        }
    }

    // Get pattern update settings
    getPatternUpdateSettings() {
        return this.config?.patternUpdates || {
            lastChecked: null,
            lastVersion: null,
            autoUpdate: true
        };
    }

    // Get path for filter templates (user data)
    getFilterTemplatesPath() {
        // Use APPDATA for production, local config for development
        const configDir = path.join(process.env.APPDATA || process.env.HOME, 'sc-recorder');

        return path.join(configDir, 'filter-templates.json');
    }
}

module.exports = ConfigManager;