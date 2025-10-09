/**
 * Recording-related IPC handlers
 * Handles recording control, status, events, and manual event marking
 */

const { ipcMain } = require('electron');

class RecordingHandlers {
  constructor(supervisorGetter, mainWindowGetter, recordingStatsPromiseRef, clearLockCallback) {
    this.getSupervisor = supervisorGetter;
    this.getMainWindow = mainWindowGetter;
    // Store reference to the promise container object
    this.recordingStatsPromiseRef = recordingStatsPromiseRef;
    this.clearRecordingStatsLock = clearLockCallback;
  }

  /**
   * Register all recording-related IPC handlers
   */
  registerHandlers() {
    ipcMain.handle('get-status', () => this.handleGetStatus());
    ipcMain.handle('start-recording', async () => this.handleStartRecording());
    ipcMain.handle('stop-recording', async () => this.handleStopRecording());
    ipcMain.handle('split-recording', async () => this.handleSplitRecording());
    ipcMain.handle('mark-manual-event', async () => this.handleMarkManualEvent());
    ipcMain.handle('get-recording-stats', async () => this.handleGetRecordingStats());
    ipcMain.handle('get-event-capture-status', () => this.handleGetEventCaptureStatus());
    ipcMain.handle('get-captured-events', () => this.handleGetCapturedEvents());
    ipcMain.handle('save-events', async () => this.handleSaveEvents());
  }

  handleGetStatus() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      return supervisor.getState();
    }

    return {
      supervisor: 'not-initialized',
      obs: { process: 'stopped', websocket: 'disconnected' },
      recording: { active: false },
      starCitizen: { running: false }
    };
  }

  async handleStartRecording() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      await supervisor.startRecording();
      return { success: true };
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleStopRecording() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      await supervisor.stopRecording();
      this.clearRecordingStatsLock(); // Clear lock when recording stops
      return { success: true };
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleSplitRecording() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      await supervisor.splitRecording();
      return { success: true };
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleMarkManualEvent() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      const manualEvent = {
        type: 'manual',
        subtype: 'user_marked',
        name: 'Manual Event',
        message: 'User marked event - click to edit description',
        severity: 'medium',
        category: 'manual',
        data: {
          userNote: 'Click to add description',
          editable: true,
          markedAt: new Date().toISOString()
        }
      };
      supervisor.addManualEvent(manualEvent);
      return { success: true, event: manualEvent };
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleGetRecordingStats() {
    const supervisor = this.getSupervisor();
    if (!supervisor) {
      return null;
    }

    // If there's already a pending request, return that promise instead of creating a new one
    if (this.recordingStatsPromiseRef.value) {
      return this.recordingStatsPromiseRef.value;
    }

    // Create new promise and store it globally
    this.recordingStatsPromiseRef.value = new Promise((resolve) => {
      let resolved = false;
      let timeoutHandle;

      // Set up one-time listener for the response
      const handler = (data) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          supervisor.removeListener('recording-stats', handler);
          this.clearRecordingStatsLock(); // Clear the lock
          resolve(data);
        }
      };

      supervisor.on('recording-stats', handler);

      // Call getRecordingStats - but check if supervisor method exists first
      if (supervisor.getRecordingStats && typeof supervisor.getRecordingStats === 'function') {
        try {
          supervisor.getRecordingStats();
        } catch (error) {
          console.error('[get-recording-stats] Error calling getRecordingStats:', error);
          resolved = true;
          clearTimeout(timeoutHandle);
          supervisor.removeListener('recording-stats', handler);
          this.clearRecordingStatsLock();
          resolve(null);
          return;
        }
      } else {
        // Supervisor doesn't have this method (maybe during restart), return null
        console.warn('[get-recording-stats] Supervisor missing getRecordingStats method');
        resolved = true;
        clearTimeout(timeoutHandle);
        supervisor.removeListener('recording-stats', handler);
        this.clearRecordingStatsLock();
        resolve(null);
        return;
      }

      // Timeout after 2 seconds
      timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          supervisor.removeListener('recording-stats', handler);
          this.clearRecordingStatsLock(); // Clear the lock
          console.warn('[get-recording-stats] Request timed out after 2s');
          resolve(null);
        }
      }, 2000);
    });

    return this.recordingStatsPromiseRef.value;
  }

  handleGetEventCaptureStatus() {
    const supervisor = this.getSupervisor();
    if (supervisor && supervisor.eventCapture) {
      return supervisor.eventCapture.getStatus();
    }
    return {
      recordingActive: false,
      eventCount: 0,
      categories: {}
    };
  }

  handleGetCapturedEvents() {
    const supervisor = this.getSupervisor();
    if (supervisor && supervisor.eventCapture) {
      return supervisor.eventCapture.getAllEvents();
    }
    return [];
  }

  async handleSaveEvents() {
    const supervisor = this.getSupervisor();
    if (supervisor && supervisor.eventCapture) {
      const result = await supervisor.eventCapture.saveEvents();
      return result;
    }
    return { success: false, error: 'Event capture not available' };
  }
}

module.exports = RecordingHandlers;
