/**
 * Upload-related IPC handlers
 * Handles all upload operations including account management and queue control
 */

const { ipcMain } = require('electron');

class UploadHandlers {
  constructor(supervisorGetter) {
    this.getSupervisor = supervisorGetter;
  }

  /**
   * Register all upload-related IPC handlers
   */
  registerHandlers() {
    // Account management
    ipcMain.handle('upload:add-account', async (event, data) => this.handleAddAccount(data));
    ipcMain.handle('upload:update-account', async (event, data) => this.handleUpdateAccount(data));
    ipcMain.handle('upload:delete-account', async (event, data) => this.handleDeleteAccount(data));
    ipcMain.handle('upload:list-accounts', async (event, data) => this.handleListAccounts(data));
    ipcMain.handle('upload:test-account', async (event, data) => this.handleTestAccount(data));

    // Upload operations
    ipcMain.handle('upload:upload-file', async (event, data) => this.handleUploadFile(data));
    ipcMain.handle('upload:cancel-upload', async (event, data) => this.handleCancelUpload(data));
    ipcMain.handle('upload:clear-completed', async () => this.handleClearCompleted());
    ipcMain.handle('upload:remove-from-queue', async (event, data) => this.handleRemoveFromQueue(data));
    ipcMain.handle('upload:remove-completed', async (event, data) => this.handleRemoveCompleted(data));

    // Queue management
    ipcMain.handle('upload:start-queue', async () => this.handleStartQueue());
    ipcMain.handle('upload:pause-queue', async () => this.handlePauseQueue());
    ipcMain.handle('upload:get-queue-status', async () => this.handleGetQueueStatus());
    ipcMain.handle('upload:get-status', async () => this.handleGetStatus());
    ipcMain.handle('upload:get-state', async () => this.handleGetState());
  }

  // Account management handlers
  async handleAddAccount(data) {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.addUploadAccount(data);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleUpdateAccount(data) {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.updateUploadAccount(data);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleDeleteAccount(data) {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.deleteUploadAccount(data);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleListAccounts(data) {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const accounts = await supervisor.listUploadAccounts(data);
        return { success: true, accounts };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleTestAccount(data) {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.testUploadAccount(data);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  // Upload operation handlers
  async handleUploadFile(data) {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.uploadFile(data);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleCancelUpload(data) {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.cancelUpload(data);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleClearCompleted() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.clearCompletedUploads();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleRemoveFromQueue(data) {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.removeFromQueue(data);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleRemoveCompleted(data) {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.removeCompletedUpload(data);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  // Queue management handlers
  async handleStartQueue() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.startUploadQueue();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handlePauseQueue() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.pauseUploadQueue();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleGetQueueStatus() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const result = await supervisor.getUploadQueueStatus();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleGetStatus() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const status = await supervisor.getUploadStatus();
        return { success: true, status };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }

  async handleGetState() {
    const supervisor = this.getSupervisor();
    if (supervisor) {
      try {
        const state = await supervisor.getUploadState();
        return { success: true, state };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Supervisor not initialized' };
  }
}

module.exports = UploadHandlers;
