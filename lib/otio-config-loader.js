const fs = require('fs').promises;
const path = require('path');

class OTIOConfigLoader {

    static configPath = null;

    /**
     * Set custom config path (for testing or alternative locations)
     */
    static setConfigPath(configPath) {
        this.configPath = configPath;
    }

    /**
     * Get the default config path
     */
    static getDefaultConfigPath() {
        // Get the directory where this module is located
        // Then go up to project root and into config folder
        const moduleDir = path.dirname(__filename);
        const projectRoot = path.resolve(moduleDir, '..');
        return path.join(projectRoot, 'config', 'otio-config.json');
    }

    /**
     * Load OTIO configuration
     */
    static async loadConfig() {
        const configPath = this.configPath || this.getDefaultConfigPath();

        try {
            const configData = await fs.readFile(configPath, 'utf8');
            const config = JSON.parse(configData);

            // Validate config structure
            this.validateConfig(config);

            return config;

        } catch (error) {
            console.warn(`Could not load OTIO config from ${configPath}, using defaults:`, error.message);
            return this.getDefaultConfig();
        }
    }

    /**
     * Load specific settings with preset support
     */
    static async loadSettings(presetName = null) {
        const config = await this.loadConfig();

        // Start with default settings
        let settings = { ...config.defaultSettings };

        // Apply preset override if specified
        if (presetName && config.exportPresets && config.exportPresets[presetName]) {
            const preset = config.exportPresets[presetName];
            settings = { ...settings, ...preset };
            console.log(`Using OTIO preset: ${presetName} (${preset.description || 'no description'})`);
        }

        return settings;
    }

    /**
     * Save configuration
     */
    static async saveConfig(config) {
        const configPath = this.configPath || this.getDefaultConfigPath();
        const configDir = path.dirname(configPath);

        try {
            // Ensure config directory exists
            await fs.mkdir(configDir, { recursive: true });

            // Validate config before saving
            this.validateConfig(config);

            // Write config
            await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
            console.log(`OTIO config saved to: ${configPath}`);

        } catch (error) {
            console.error('Error saving OTIO config:', error);
            throw error;
        }
    }

    /**
     * Validate configuration structure
     */
    static validateConfig(config) {
        if (!config || typeof config !== 'object') {
            throw new Error('Invalid config: must be an object');
        }

        // Required sections
        if (!config.defaultSettings) {
            throw new Error('Invalid config: missing defaultSettings');
        }

        // Validate defaultSettings structure
        const requiredSettings = ['frameRate', 'includeFilterMetadata', 'clipDurationMode'];
        for (const setting of requiredSettings) {
            if (!(setting in config.defaultSettings)) {
                throw new Error(`Invalid config: missing defaultSetting '${setting}'`);
            }
        }

        // Validate frame rates
        if (config.frameRates && !Array.isArray(config.frameRates)) {
            throw new Error('Invalid config: frameRates must be an array');
        }

        // Validate duration modes
        if (config.durationModes && !Array.isArray(config.durationModes)) {
            throw new Error('Invalid config: durationModes must be an array');
        }
    }

    /**
     * Get default configuration (fallback)
     */
    static getDefaultConfig() {
        return {
            "defaultSettings": {
                "frameRate": "auto",
                "includeFilterMetadata": true,
                "clipDurationMode": "auto",
                "fixedClipDuration": 1.0,
                "minimalClipDuration": 0.1,
                "trackName": "Events Track",
                "autoSavePath": true,
                "autoReplaceFile": false,
                "exportPreset": "daVinciResolve"
            },
            "frameRates": [
                { "value": "auto", "label": "Auto-detect from video" },
                { "value": 24, "label": "24 fps (Film)" },
                { "value": 25, "label": "25 fps (PAL)" },
                { "value": 30, "label": "30 fps (NTSC)" },
                { "value": 50, "label": "50 fps (HD)" },
                { "value": 60, "label": "60 fps (HD)" }
            ],
            "durationModes": [
                { "value": "auto", "label": "Auto (Bis zum nächsten Event)" },
                { "value": "fixed", "label": "Feste Dauer (konfigurierbar)" },
                { "value": "minimal", "label": "Minimal (0.1s Marker)" }
            ],
            "exportPresets": {
                "daVinciResolve": {
                    "frameRate": "auto",
                    "includeFilterMetadata": true,
                    "clipDurationMode": "auto",
                    "description": "Optimierte Einstellungen für DaVinci Resolve"
                },
                "minimal": {
                    "frameRate": 30,
                    "includeFilterMetadata": false,
                    "clipDurationMode": "minimal",
                    "description": "Schneller Export mit minimalen Daten"
                }
            }
        };
    }

    /**
     * Get available frame rate options
     */
    static async getFrameRateOptions() {
        const config = await this.loadConfig();
        return config.frameRates || this.getDefaultConfig().frameRates;
    }

    /**
     * Get available duration mode options
     */
    static async getDurationModeOptions() {
        const config = await this.loadConfig();
        return config.durationModes || this.getDefaultConfig().durationModes;
    }

    /**
     * Get available export presets
     */
    static async getExportPresets() {
        const config = await this.loadConfig();
        return config.exportPresets || this.getDefaultConfig().exportPresets;
    }

    /**
     * Check if config file exists
     */
    static async configExists() {
        const configPath = this.configPath || this.getDefaultConfigPath();
        try {
            await fs.access(configPath);
            return true;
        } catch {
            return false;
        }
    }
}

module.exports = OTIOConfigLoader;
