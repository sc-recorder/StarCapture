/**
 * Window Manager
 * Manages all application windows (splash, setup, main) and supervisor event listeners
 */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

class WindowManager {
  constructor(supervisorGetter, isPackaged) {
    this.getSupervisor = supervisorGetter;
    this.isPackaged = isPackaged;
    this.mainWindow = null;
    this.splashWindow = null;
    this.setupWindow = null;
    this.supervisorListenersAttached = false;
  }

  getMainWindow() {
    return this.mainWindow;
  }

  getSplashWindow() {
    return this.splashWindow;
  }

  getSetupWindow() {
    return this.setupWindow;
  }

  /**
   * Create splash window
   */
  createSplashWindow() {
    return new Promise((resolve) => {
      this.splashWindow = new BrowserWindow({
        width: 600,
        height: 600,
        frame: false,
        alwaysOnTop: false,
        transparent: false,
        resizable: false,
        show: false,
        icon: path.join(__dirname, '..', 'build', 'icon.ico'),
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        }
      });

      this.splashWindow.loadFile('splash.html');

      this.splashWindow.once('ready-to-show', () => {
        this.splashWindow.center();
        this.splashWindow.show();
        resolve();
      });
    });
  }

  /**
   * Create setup wizard window
   */
  createSetupWindow() {
    this.setupWindow = new BrowserWindow({
      width: 800,
      height: 775,
      frame: true,
      resizable: false,
      show: false,
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      title: 'StarCapture Setup',
      autoHideMenuBar: true
    });

    this.setupWindow.loadFile('setup-wizard.html');

    this.setupWindow.once('ready-to-show', () => {
      // Add 2 second delay before closing splash and showing setup window
      setTimeout(() => {
        if (this.splashWindow) {
          this.splashWindow.close();
          this.splashWindow = null;
        }
        this.setupWindow.center();
        this.setupWindow.show();
      }, 2000);
    });

    this.setupWindow.on('closed', () => {
      this.setupWindow = null;
    });
  }

  /**
   * Create main application window
   */
  createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1600,
      height: 900,
      show: false,
      frame: false,  // Remove default title bar
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: true
      },
      title: 'StarCapture',
      autoHideMenuBar: true,
      backgroundColor: '#080d18'
    });

    require('@electron/remote/main').initialize();
    require('@electron/remote/main').enable(this.mainWindow.webContents);

    this.mainWindow.loadFile('index.html');

    // Handle window controls for frameless window
    ipcMain.on('window-control', (event, action) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        switch (action) {
          case 'minimize':
            this.mainWindow.minimize();
            break;
          case 'maximize':
            if (this.mainWindow.isMaximized()) {
              this.mainWindow.unmaximize();
            } else {
              this.mainWindow.maximize();
            }
            break;
          case 'close':
            this.mainWindow.close();
            break;
        }
      }
    });

    this.mainWindow.once('ready-to-show', () => {
      // Add 2 second delay before closing splash and showing main window
      setTimeout(() => {
        if (this.splashWindow) {
          this.splashWindow.close();
          this.splashWindow = null;
        }
        this.mainWindow.show();

        // Send initial status update
        const supervisor = this.getSupervisor();
        if (supervisor) {
          const initialState = supervisor.getState();
          this.mainWindow.webContents.send('status-update', initialState);
        }
      }, 2000);

      // Set up periodic status sync to catch any missed updates
      setInterval(() => {
        const supervisor = this.getSupervisor();
        if (supervisor && this.mainWindow && !this.mainWindow.isDestroyed()) {
          try {
            const currentState = supervisor.getState();
            // Check if webContents is valid and ready before sending
            if (this.mainWindow.webContents &&
                !this.mainWindow.webContents.isDestroyed() &&
                !this.mainWindow.webContents.isCrashed() &&
                !this.mainWindow.webContents.isLoading()) {
              // Use executeJavaScript to check if renderer is responsive
              this.mainWindow.webContents.executeJavaScript('true', true)
                .then(() => {
                  // Renderer is responsive, safe to send
                  this.mainWindow.webContents.send('status-update', currentState);
                })
                .catch(() => {
                  // Renderer not responsive, skip this update
                });
            }
          } catch (error) {
            // Silently ignore errors from disposed frames
            if (!error.message?.includes('disposed') && !error.message?.includes('WebFrameMain')) {
              console.error('Error sending status update:', error);
            }
          }
        }
      }, 3000); // Sync every 3 seconds

      // Open DevTools for development
      if (!this.isPackaged) {
        this.mainWindow.webContents.openDevTools();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
  }

  /**
   * Attach supervisor event listeners (only once)
   */
  attachSupervisorListeners() {
    const supervisor = this.getSupervisor();
    if (this.supervisorListenersAttached || !supervisor) {
      return;
    }

    console.log('Attaching supervisor event listeners...');

    supervisor.on('state-changed', (state) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('status-update', state);
      }
    });

    supervisor.on('event', (event) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('event', event);
      }
    });

    supervisor.on('recording-status', (data) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('recording-status', data);
      }
    });

    supervisor.on('events-saved', (result) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('events-saved', result);
      }
    });

    supervisor.on('recording-stats', (data) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('recording-stats', data);
      }
    });

    supervisor.on('audio-devices', (data) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('audio-devices', data);
      }
    });

    supervisor.on('applications', (data) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('applications', data);
      }
    });

    supervisor.on('upload-state-changed', (state) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('upload-state-changed', state);
      }
    });

    supervisor.on('upload-started', (upload) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('upload-started', upload);
      }
    });

    supervisor.on('upload-progress', (progress) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('upload-progress', progress);
      }
    });

    supervisor.on('upload-completed', (upload) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('upload-completed', upload);
      }
    });

    supervisor.on('upload-failed', (upload) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('upload-failed', upload);
      }
    });

    supervisor.on('error', (data) => {
      console.error('Supervisor error:', data);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('supervisor-error', data);
      }
    });

    this.supervisorListenersAttached = true;
    console.log('Supervisor event listeners attached');
  }

  /**
   * Send message to splash window
   */
  sendSplashProgress(data) {
    if (this.splashWindow && !this.splashWindow.isDestroyed()) {
      this.splashWindow.webContents.send('splash-progress', data);
    }
  }

  /**
   * Send "first-run" message to main window
   */
  sendFirstRunMessage() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      setTimeout(() => {
        this.mainWindow.webContents.send('first-run');
      }, 100);
    }
  }
}

module.exports = WindowManager;
