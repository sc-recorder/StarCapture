const path = require('path');

/**
 * Helper to get the correct config path
 * Always uses APPDATA for consistent location regardless of how app is run
 */
function getConfigPath(filename) {
    // Always use APPDATA for config storage
    const appDir = path.join(process.env.APPDATA || process.env.HOME, 'sc-recorder');
    return path.join(appDir, filename);
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