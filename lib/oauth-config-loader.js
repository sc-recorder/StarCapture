const fs = require('fs');
const path = require('path');

class OAuthConfigLoader {
    constructor() {
        this.config = null;
        this.configPath = path.join(__dirname, '..', 'oauth-config.json');
        this.templatePath = path.join(__dirname, '..', 'oauth-config.template.json');
    }

    /**
     * Load OAuth configuration
     * @returns {Object|null} OAuth config or null if not configured
     */
    load() {
        try {
            // Log the path being checked for debugging
            console.log('[OAuthConfig] Looking for oauth-config.json at:', this.configPath);

            // Check if oauth-config.json exists
            if (!fs.existsSync(this.configPath)) {
                console.log('[OAuthConfig] No oauth-config.json found. OAuth features will be disabled.');
                console.log('[OAuthConfig] To enable OAuth, copy oauth-config.template.json to oauth-config.json and add your credentials.');
                return null;
            }

            // Load the config
            const configContent = fs.readFileSync(this.configPath, 'utf8');
            this.config = JSON.parse(configContent);

            // Validate Twitch config
            if (this.config.twitch) {
                if (this.config.twitch.clientId === 'YOUR_TWITCH_CLIENT_ID' ||
                    this.config.twitch.clientId === 'YOUR_TWITCH_CLIENT_ID_HERE' ||
                    !this.config.twitch.clientId) {
                    console.warn('[OAuthConfig] Twitch OAuth not configured. Please update oauth-config.json with your Twitch Client ID.');
                    this.config.twitch = null;
                } else {
                    console.log('[OAuthConfig] Twitch OAuth configured (PKCE mode - no secret required)');
                    // Ensure PKCE is set
                    this.config.twitch.authMethod = this.config.twitch.authMethod || 'PKCE';
                }
            }

            // Validate Google config
            if (this.config.google) {
                if (this.config.google.clientId === 'YOUR_GOOGLE_CLIENT_ID_HERE' ||
                    this.config.google.clientId === 'YOUR_GOOGLE_CLIENT_ID_HERE.apps.googleusercontent.com' ||
                    !this.config.google.clientId ||
                    this.config.google.clientId.includes('YOUR_')) {
                    console.warn('[OAuthConfig] Google/YouTube OAuth not configured. Please update oauth-config.json with your Google Client ID.');
                    this.config.google = null;
                } else {
                    console.log('[OAuthConfig] Google/YouTube OAuth configured (PKCE mode - no secret required)');
                    // Ensure PKCE is set
                    this.config.google.authMethod = this.config.google.authMethod || 'PKCE';
                }
            }

            return this.config;
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('[OAuthConfig] OAuth config file not found. OAuth features disabled.');
            } else {
                console.error('[OAuthConfig] Error loading OAuth config:', error.message);
            }
            return null;
        }
    }

    /**
     * Get Twitch OAuth configuration
     * @returns {Object|null} Twitch config or null if not configured
     */
    getTwitchConfig() {
        if (!this.config) {
            this.load();
        }
        return this.config?.twitch || null;
    }

    /**
     * Get Google/YouTube OAuth configuration
     * @returns {Object|null} Google config or null if not configured
     */
    getGoogleConfig() {
        if (!this.config) {
            this.load();
        }
        return this.config?.google || null;
    }

    /**
     * Check if OAuth is available for a specific service
     * @param {string} service - 'twitch' or 'google'
     * @returns {boolean} True if service is configured
     */
    isServiceAvailable(service) {
        if (!this.config) {
            this.load();
        }

        switch(service.toLowerCase()) {
            case 'twitch':
                return this.config?.twitch !== null && this.config?.twitch !== undefined;
            case 'google':
            case 'youtube':
                return this.config?.google !== null && this.config?.google !== undefined;
            default:
                return false;
        }
    }

    /**
     * Create config from template if it doesn't exist
     * @returns {boolean} True if created, false if already exists
     */
    createFromTemplate() {
        try {
            if (fs.existsSync(this.configPath)) {
                console.log('[OAuthConfig] Config already exists');
                return false;
            }

            if (!fs.existsSync(this.templatePath)) {
                console.error('[OAuthConfig] Template file not found');
                return false;
            }

            const templateContent = fs.readFileSync(this.templatePath, 'utf8');
            fs.writeFileSync(this.configPath, templateContent);
            console.log('[OAuthConfig] Created oauth-config.json from template');
            console.log('[OAuthConfig] Please edit oauth-config.json with your OAuth credentials');
            return true;
        } catch (error) {
            console.error('[OAuthConfig] Error creating config from template:', error);
            return false;
        }
    }
}

// Export singleton instance
module.exports = new OAuthConfigLoader();