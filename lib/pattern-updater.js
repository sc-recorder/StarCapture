const https = require('https');
const fs = require('fs').promises;
const path = require('path');

/**
 * PatternUpdater - Manages automatic updates for sc-log-patterns.json
 *
 * Fetches the latest patterns from S3 and applies compatible updates
 * based on semantic versioning (MAJOR.MINOR.PATCH)
 */
class PatternUpdater {
  constructor() {
    this.remoteUrl = 'https://s3.starcapture.video/sc-log-patterns.json';
    // Always use APPDATA for config/pattern storage
    const appDir = path.join(process.env.APPDATA || process.env.HOME, 'sc-recorder');
    this.localPath = path.join(appDir, 'sc-log-patterns.json');
    this.backupPath = path.join(appDir, 'sc-log-patterns.backup.json');

    // Define which major version of patterns this app supports
    // This is independent of the app version - patterns v1.x.x might work with app v2.x.x, v3.x.x, etc.
    this.SUPPORTED_PATTERN_MAJOR_VERSION = 1;
  }

  /**
   * Check if an update is available and compatible
   * @returns {Object|null} Update info if available, null otherwise
   */
  async checkForUpdate() {
    try {
      // First check if local file exists
      const localExists = await this.localFileExists();

      if (!localExists) {
        console.log('Local patterns file missing, will download from remote');
        const remotePatterns = await this.fetchRemote();

        if (remotePatterns && remotePatterns.version) {
          // Check if remote version is compatible with what this app supports
          const remoteMajorVersion = this.parseVersion(remotePatterns.version).major;

          if (remoteMajorVersion !== this.SUPPORTED_PATTERN_MAJOR_VERSION) {
            console.warn(`Pattern version incompatible: Remote v${remotePatterns.version} has major version ${remoteMajorVersion}, app supports v${this.SUPPORTED_PATTERN_MAJOR_VERSION}.x.x`);
            return {
              currentVersion: 'missing',
              newVersion: remotePatterns.version,
              patterns: null,
              isMissing: true,
              incompatible: true,
              supportedVersion: `${this.SUPPORTED_PATTERN_MAJOR_VERSION}.x.x`
            };
          }

          return {
            currentVersion: 'missing',
            newVersion: remotePatterns.version,
            patterns: remotePatterns,
            isMissing: true
          };
        }
        return null;
      }

      // Normal update check
      const [localPatterns, remotePatterns] = await Promise.all([
        this.loadLocal(),
        this.fetchRemote()
      ]);

      if (!localPatterns || !remotePatterns) {
        return null;
      }

      if (!localPatterns.version || !remotePatterns.version) {
        console.log('Pattern files missing version field');
        return null;
      }

      if (this.isCompatibleUpdate(localPatterns.version, remotePatterns.version)) {
        return {
          currentVersion: localPatterns.version,
          newVersion: remotePatterns.version,
          patterns: remotePatterns
        };
      }

      return null;
    } catch (error) {
      console.log('Pattern update check failed:', error.message);
      return null;
    }
  }

  /**
   * Check if local patterns file exists
   * @returns {Promise<boolean>} True if file exists
   */
  async localFileExists() {
    try {
      await fs.access(this.localPath);
      return true;
    } catch {
      return false;
    }
  }


  /**
   * Determine if remote version is a compatible update
   * @param {string} currentVersion - Current local version
   * @param {string} remoteVersion - Remote version to check
   * @returns {boolean} True if update is compatible
   */
  isCompatibleUpdate(currentVersion, remoteVersion) {
    try {
      const current = this.parseVersion(currentVersion);
      const remote = this.parseVersion(remoteVersion);

      // Don't update if major version differs from what we support
      if (remote.major !== this.SUPPORTED_PATTERN_MAJOR_VERSION) {
        console.log(`Remote version ${remoteVersion} has unsupported major version (app supports v${this.SUPPORTED_PATTERN_MAJOR_VERSION}.x.x)`);
        return false;
      }

      // Don't update if major version differs (breaking change)
      if (remote.major !== current.major) {
        console.log(`Major version mismatch: ${currentVersion} vs ${remoteVersion} - skipping update`);
        return false;
      }

      // Update if minor or patch is newer
      if (remote.minor > current.minor) {
        return true;
      }

      if (remote.minor === current.minor && remote.patch > current.patch) {
        return true;
      }

      return false;
    } catch (error) {
      console.error('Version comparison failed:', error);
      return false;
    }
  }

  /**
   * Parse semantic version string
   * @param {string} version - Version string (e.g., "1.0.0")
   * @returns {Object} Parsed version with major, minor, patch
   */
  parseVersion(version) {
    const parts = version.split('.');
    if (parts.length !== 3) {
      throw new Error(`Invalid version format: ${version}`);
    }

    const [major, minor, patch] = parts.map(Number);

    if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
      throw new Error(`Invalid version numbers: ${version}`);
    }

    return { major, minor, patch };
  }

  /**
   * Apply the pattern update
   * @param {Object} updateInfo - Update information with new patterns
   * @returns {boolean} True if update was successful
   */
  async applyUpdate(updateInfo) {
    try {
      // Only backup if file exists (not missing)
      if (!updateInfo.isMissing) {
        console.log(`Backing up current patterns to ${this.backupPath}`);
        const currentPatterns = await this.loadLocal();
        await fs.writeFile(this.backupPath, JSON.stringify(currentPatterns, null, 2));
      } else {
        console.log('No backup needed - patterns file was missing');
      }

      // Apply new patterns
      if (updateInfo.isMissing) {
        console.log(`Restoring missing patterns file with version ${updateInfo.newVersion}`);
      } else {
        console.log(`Applying pattern update: ${updateInfo.currentVersion} → ${updateInfo.newVersion}`);
      }

      await fs.writeFile(this.localPath, JSON.stringify(updateInfo.patterns, null, 2));

      return true;
    } catch (error) {
      console.error('Failed to apply pattern update:', error);

      // Try to restore from backup if update failed and backup exists
      if (!updateInfo.isMissing) {
        try {
          const backup = await fs.readFile(this.backupPath, 'utf8');
          await fs.writeFile(this.localPath, backup);
          console.log('Restored patterns from backup');
        } catch (restoreError) {
          console.error('Failed to restore from backup:', restoreError);
        }
      }

      return false;
    }
  }

  /**
   * Fetch patterns from remote S3 URL
   * @returns {Promise<Object>} Remote pattern data
   */
  async fetchRemote() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout (10s)'));
      }, 10000);

      https.get(this.remoteUrl, (res) => {
        clearTimeout(timeout);

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            reject(new Error('Invalid JSON from remote'));
          }
        });
      }).on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Load local pattern file
   * @returns {Promise<Object>} Local pattern data
   */
  async loadLocal() {
    try {
      const data = await fs.readFile(this.localPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Failed to load local patterns:', error);
      throw error;
    }
  }

  /**
   * Restore patterns from backup
   * @returns {Promise<boolean>} True if restore was successful
   */
  async restoreFromBackup() {
    try {
      const backup = await fs.readFile(this.backupPath, 'utf8');
      await fs.writeFile(this.localPath, backup);
      console.log('Successfully restored patterns from backup');
      return true;
    } catch (error) {
      console.error('Failed to restore from backup:', error);
      return false;
    }
  }
}

module.exports = PatternUpdater;