const { app, dialog, shell } = require('electron');
const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

class AutoUpdater {
  constructor() {
    this.updateUrl = 'https://s3.starcapture.video/current.json';
    this.currentVersion = app.getVersion();
    this.updateInfo = null;
  }

  compareVersions(v1, v2) {
    const normalize = (v) => {
      const parts = v.replace(/^v/, '').split(/[-+]/)[0].split('.');
      return parts.map(p => parseInt(p) || 0);
    };

    const parts1 = normalize(v1);
    const parts2 = normalize(v2);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }

    const pre1 = v1.includes('-') ? v1.split('-')[1] : '';
    const pre2 = v2.includes('-') ? v2.split('-')[1] : '';

    if (!pre1 && pre2) return 1;
    if (pre1 && !pre2) return -1;
    if (pre1 && pre2) return pre1.localeCompare(pre2);

    return 0;
  }

  async checkForUpdates() {
    return new Promise((resolve, reject) => {
      https.get(this.updateUrl, (res) => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const updateInfo = JSON.parse(data);
            this.updateInfo = updateInfo;

            const hasUpdate = this.compareVersions(updateInfo.version, this.currentVersion) > 0;

            resolve({
              hasUpdate,
              currentVersion: this.currentVersion,
              latestVersion: updateInfo.version,
              installer: updateInfo.installer,
              timestamp: updateInfo.timestamp
            });
          } catch (error) {
            console.error('Failed to parse update info:', error);
            resolve({ hasUpdate: false, error: error.message });
          }
        });
      }).on('error', (error) => {
        console.error('Failed to check for updates:', error);
        resolve({ hasUpdate: false, error: error.message });
      });
    });
  }

  async promptUserForUpdate(updateInfo) {
    const response = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version of StarCapture is available!`,
      detail: `Current version: ${updateInfo.currentVersion}\nNew version: ${updateInfo.latestVersion}\n\nWould you like to download and install the update now?`,
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    });

    return response.response === 0;
  }

  async downloadInstaller(installerName) {
    return new Promise((resolve, reject) => {
      const tempDir = path.join(os.tmpdir(), 'starcapture-updates');
      const tempFile = path.join(tempDir, installerName);
      const downloadUrl = `https://s3.starcapture.video/${installerName}`;

      fs.mkdir(tempDir, { recursive: true }).then(() => {
        const file = require('fs').createWriteStream(tempFile);

        https.get(downloadUrl, (response) => {
          const totalSize = parseInt(response.headers['content-length'], 10);
          let downloadedSize = 0;

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            const progress = Math.round((downloadedSize / totalSize) * 100);

            if (this.progressCallback) {
              this.progressCallback(progress, downloadedSize, totalSize);
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close(() => {
              resolve(tempFile);
            });
          });
        }).on('error', (error) => {
          fs.unlink(tempFile).catch(() => {});
          reject(error);
        });

        file.on('error', (error) => {
          fs.unlink(tempFile).catch(() => {});
          reject(error);
        });
      }).catch(reject);
    });
  }

  async executeInstaller(installerPath) {
    return new Promise((resolve, reject) => {
      const installer = spawn(installerPath, [], {
        detached: true,
        stdio: 'ignore'
      });

      installer.unref();

      installer.on('error', (error) => {
        console.error('Failed to execute installer:', error);
        reject(error);
      });

      setTimeout(() => {
        app.quit();
        resolve();
      }, 1000);
    });
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  async performUpdate() {
    if (!this.updateInfo) {
      throw new Error('No update information available');
    }

    try {
      console.log('Downloading installer:', this.updateInfo.installer);
      const installerPath = await this.downloadInstaller(this.updateInfo.installer);

      console.log('Executing installer:', installerPath);
      await this.executeInstaller(installerPath);

      return true;
    } catch (error) {
      console.error('Update failed:', error);

      await dialog.showErrorBox(
        'Update Failed',
        `Failed to download or install the update: ${error.message}\n\nYou can manually download the latest version from the website.`
      );

      return false;
    }
  }

  async checkAndPromptForUpdate() {
    try {
      const updateInfo = await this.checkForUpdates();

      if (updateInfo.hasUpdate) {
        const shouldUpdate = await this.promptUserForUpdate(updateInfo);

        if (shouldUpdate) {
          return await this.performUpdate();
        }
      }

      return false;
    } catch (error) {
      console.error('Auto-update check failed:', error);
      return false;
    }
  }
}

module.exports = AutoUpdater;