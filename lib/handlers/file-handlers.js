/**
 * File and folder management handlers
 * Handles file operations, dialogs, and recording file management
 */

const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs').promises;
const path = require('path');

class FileHandlers {
  constructor(configManagerGetter, mainWindowGetter) {
    this.getConfigManager = configManagerGetter;
    this.getMainWindow = mainWindowGetter;
  }

  /**
   * Register all file-related IPC handlers
   */
  registerHandlers() {
    // File dialogs
    ipcMain.handle('show-open-dialog', async (event, options) => this.handleShowOpenDialog(options));
    ipcMain.handle('browse-folder', async (event, options) => this.handleBrowseFolder(options));
    ipcMain.handle('select-folder', async (event, options) => this.handleSelectFolder(options));

    // File operations
    ipcMain.handle('file-exists', async (event, filePath) => this.handleFileExists(filePath));
    ipcMain.handle('read-file', async (event, filePath) => this.handleReadFile(filePath));
    ipcMain.handle('get-file-stats', async (event, filePath) => this.handleGetFileStats(filePath));

    // Folder operations
    ipcMain.handle('open-folder', async (event, folderPath) => this.handleOpenFolder(folderPath));
    ipcMain.handle('open-recording-folder', async () => this.handleOpenRecordingFolder());

    // Recording management
    ipcMain.handle('get-recordings-list', async (event, folder = 'recordings') => this.handleGetRecordingsList(folder));
    ipcMain.handle('move-recording', async (event, recordingPath) => this.handleMoveRecording(recordingPath));
  }

  async handleShowOpenDialog(options) {
    const mainWindow = this.getMainWindow();
    return dialog.showOpenDialog(mainWindow, options);
  }

  async handleBrowseFolder(options) {
    const mainWindow = this.getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select Folder',
      defaultPath: options.defaultPath || '',
      properties: ['openDirectory', 'createDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] };
    }
    return { success: false };
  }

  async handleSelectFolder(options) {
    const mainWindow = this.getMainWindow();
    const defaultOptions = {
      properties: ['openDirectory', 'createDirectory']
    };

    const dialogOptions = { ...defaultOptions, ...options };

    // Show dialog and return result
    return dialog.showOpenDialog(mainWindow, dialogOptions);
  }

  async handleFileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async handleReadFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content;
    } catch (error) {
      console.error('Failed to read file:', error);
      throw error;
    }
  }

  async handleGetFileStats(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return {
        success: true,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime
      };
    } catch (error) {
      console.error('Failed to get file stats:', error);
      return { success: false, error: error.message };
    }
  }

  async handleOpenFolder(folderPath) {
    try {
      shell.openPath(folderPath);
      return { success: true };
    } catch (error) {
      console.error('Failed to open folder:', error);
      return { success: false, error: error.message };
    }
  }

  async handleOpenRecordingFolder() {
    try {
      const configManager = this.getConfigManager();
      const config = await configManager.load();
      const recordingPath = config?.settings?.recording?.outputPath ||
        path.join(process.env.USERPROFILE, 'Videos', 'SC-Recorder');

      // Ensure folder exists
      await fs.mkdir(recordingPath, { recursive: true });

      // Open folder in file explorer
      shell.openPath(recordingPath);

      return { success: true, path: recordingPath };
    } catch (error) {
      console.error('Error opening recording folder:', error);
      return { success: false, error: error.message };
    }
  }

  async handleGetRecordingsList(folder) {
    try {
      const configManager = this.getConfigManager();
      const config = configManager.get();
      const basePath = config?.settings?.recording?.outputPath || path.join(app.getPath('videos'), 'SC-Recorder');

      // Append the requested folder (recordings, saved, or edited)
      const recordingPath = path.join(basePath, folder);

      // Ensure directory exists
      try {
        await fs.access(recordingPath);
      } catch (error) {
        return [];
      }

      // Get all files in the directory
      const files = await fs.readdir(recordingPath);

      // Filter for video files
      const videoExtensions = ['.mp4', '.mkv', '.avi', '.webm', '.mov'];
      const videoFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return videoExtensions.includes(ext);
      });

      // Build list with metadata
      const recordings = [];
      for (const videoFile of videoFiles) {
        const videoPath = path.join(recordingPath, videoFile);
        const baseName = path.basename(videoFile, path.extname(videoFile));
        const jsonPath = path.join(recordingPath, `${baseName}.json`);

        try {
          // Get video file stats
          const stats = await fs.stat(videoPath);

          // Check for matching JSON file
          let hasEvents = false;
          let eventCount = 0;
          try {
            await fs.access(jsonPath);
            hasEvents = true;

            // Try to read event count
            try {
              const jsonContent = await fs.readFile(jsonPath, 'utf8');
              const eventData = JSON.parse(jsonContent);
              if (Array.isArray(eventData.events)) {
                eventCount = eventData.events.length;
              }
            } catch (e) {
              console.error(`Failed to parse JSON for ${baseName}:`, e);
            }
          } catch {
            // No JSON file
          }

          recordings.push({
            name: videoFile,
            path: videoPath,
            jsonPath: hasEvents ? jsonPath : null,
            hasEvents,
            eventCount,
            size: stats.size,
            modified: stats.mtime,
            created: stats.birthtime || stats.ctime
          });
        } catch (error) {
          console.error(`Failed to get stats for ${videoFile}:`, error);
        }
      }

      // Sort by modified date, newest first
      recordings.sort((a, b) => b.modified - a.modified);

      return recordings;
    } catch (error) {
      console.error('Failed to get recordings list:', error);
      return [];
    }
  }

  async handleMoveRecording(recordingPath) {
    try {
      console.log('Moving recording to saved folder:', recordingPath);

      const configManager = this.getConfigManager();
      // Get the base recording folder from config
      const config = configManager.get();
      const basePath = config?.settings?.recording?.outputPath || path.join(app.getPath('videos'), 'SC-Recorder');

      // Get filename
      const filename = path.basename(recordingPath);
      const baseName = path.basename(recordingPath, path.extname(recordingPath));

      // Determine source and destination folders
      const sourceFolder = path.dirname(recordingPath);
      const savedFolder = path.join(basePath, 'saved');

      // Ensure saved folder exists
      await fs.mkdir(savedFolder, { recursive: true });

      // Move video file
      const destVideoPath = path.join(savedFolder, filename);
      await fs.rename(recordingPath, destVideoPath);

      // Also move JSON file if it exists
      const jsonSourcePath = path.join(sourceFolder, `${baseName}.json`);
      let newEventsPath = null;
      try {
        await fs.access(jsonSourcePath);
        const jsonDestPath = path.join(savedFolder, `${baseName}.json`);
        await fs.rename(jsonSourcePath, jsonDestPath);
        newEventsPath = jsonDestPath;
      } catch (error) {
        // JSON file doesn't exist or couldn't be moved
      }

      return { success: true, newPath: destVideoPath, newEventsPath };
    } catch (error) {
      console.error('Failed to move recording:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = FileHandlers;
