const path = require('path');

/**
 * Helper to get the correct config path in both development and production
 */
function getConfigPath(filename) {
    // In production, config files are in resources/config
    // In development, they're in the root config folder

    // Check if we're in main process or renderer
    let isPackaged = false;
    let resourcesPath = '';

    try {
        // Try to get app from electron (main process)
        const { app } = require('electron');
        isPackaged = app.isPackaged;
        resourcesPath = process.resourcesPath;
    } catch (e) {
        // In renderer process, check for remote
        try {
            const { app } = require('@electron/remote');
            isPackaged = app.isPackaged;
            resourcesPath = process.resourcesPath;
        } catch (e2) {
            // Fallback for renderer without remote
            isPackaged = false;
        }
    }

    if (isPackaged) {
        // Production: config is in resources folder next to the app
        return path.join(resourcesPath, 'config', filename);
    } else {
        // Development: config is in the project root
        return path.join(process.cwd(), 'config', filename);
    }
}

/**
 * Get the patterns file path
 */
function getPatternsPath() {
    return getConfigPath('sc-log-patterns.json');
}

/**
 * Get the filter templates path
 */
function getFilterTemplatesPath() {
    return getConfigPath('filter-templates.json');
}

module.exports = {
    getConfigPath,
    getPatternsPath,
    getFilterTemplatesPath
};