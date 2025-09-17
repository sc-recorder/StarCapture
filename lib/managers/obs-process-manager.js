const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const execAsync = promisify(exec);
const BaseManager = require('./base-manager');
const Logger = require('../logger');
const { app } = require('electron');

/**
 * OBS Process Manager
 * Manages the OBS Studio process lifecycle
 */
class OBSProcessManager extends BaseManager {
    constructor() {
        super('obs-process');
        this.logger = new Logger('obs-process-manager');
        this.obsProcess = null;
        
        // Determine correct path based on environment
        const exePath = app.getPath('exe');
        const baseDir = app.isPackaged 
            ? path.dirname(exePath)
            : path.join(__dirname, '..', '..');
            
        this.obsPath = path.join(baseDir, 'resources', 'obs-studio', 'bin', '64bit', 'obs64.exe');
        this.configPath = path.join(baseDir, 'resources', 'obs-studio', 'config');
        
        this.logger.log('OBS Process Manager initialized');
        this.logger.log('Base directory:', baseDir);
        this.logger.log('OBS path:', this.obsPath);
        this.logger.log('Config path:', this.configPath);
        this.logger.log('OBS exists:', fs.existsSync(this.obsPath));
        
        this.shutdownRequested = false;
    }

    /**
     * Handle commands from supervisor
     */
    async handleCommand(command) {
        switch (command.type) {
            case 'start':
                await this.startOBS(command.config);
                break;
                
            case 'stop':
                await this.stopOBS();
                break;
                
            case 'restart':
                await this.restartOBS(command.config);
                break;
                
            case 'check-status':
                await this.checkStatus();
                break;
                
            case 'shutdown':
                await this.shutdown();
                break;
                
            default:
                this.logger.log(`Unknown command type: ${command.type}`);
        }
    }

    /**
     * Start OBS process
     */
    async startOBS(config = {}) {
        if (this.isRunning) {
            this.logger.log('OBS is already running');
            return;
        }

        this.logger.log('Starting OBS...');
        this.logger.log('Config:', config);

        // Check if OBS executable exists
        if (!fs.existsSync(this.obsPath)) {
            const error = `OBS executable not found at ${this.obsPath}`;
            this.logger.error(error);
            this.logger.error('Current working directory:', process.cwd());
            
            // List what's in the resources folder
            const resourcesDir = path.join(path.dirname(this.obsPath), '..', '..', '..');
            if (fs.existsSync(resourcesDir)) {
                this.logger.log('Resources directory contents:', fs.readdirSync(resourcesDir));
                const obsDir = path.join(resourcesDir, 'obs-studio');
                if (fs.existsSync(obsDir)) {
                    this.logger.log('OBS directory contents:', fs.readdirSync(obsDir));
                }
            }
            
            this.emit('error', error);
            return;
        }

        // Kill any existing OBS processes first
        await this.killExistingOBS();

        const args = [
            '--portable',
            '--minimize-to-tray',
            '--disable-updater',
            '--disable-shutdown-check',
            '--profile', config.profile || 'SC-Recorder',
            '--collection', config.collection || 'SC-Recording'
        ];

        try {
            this.obsProcess = spawn(this.obsPath, args, {
                detached: false,
                stdio: 'ignore',
                windowsHide: true,
                cwd: path.dirname(this.obsPath)
            });

            this.obsProcess.on('error', (error) => {
                this.logger.error('Process error:', error);
                this.isRunning = false;
                this.emit('status-update', { process: 'error', error: error.message });
            });

            this.obsProcess.on('exit', (code, signal) => {
                this.logger.log(`OBS exited with code ${code}, signal ${signal}`);
                this.isRunning = false;
                this.obsProcess = null;
                
                if (!this.shutdownRequested) {
                    // Emit status update
                    this.emit('status-update', { process: 'stopped', exitCode: code });
                    
                    // Emit unexpected exit event for supervisor to handle recovery
                    this.emit('unexpected-exit', { 
                        code: code, 
                        signal: signal,
                        crashed: code !== 0 
                    });
                } else {
                    this.logger.log('OBS shutdown was requested, not treating as unexpected');
                }
            });

            // Wait a bit for OBS to start
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Verify OBS is running
            const isRunning = await this.isOBSRunning();
            
            if (isRunning) {
                this.isRunning = true;
                this.logger.log('OBS started successfully');
                
                // WebSocket info is now in the config file (port 4455, password: screcorder123)
                // Emit process status
                this.emit('status-update', { 
                    process: 'running'
                });
                
                // Emit websocket config separately so it doesn't overwrite connection status
                this.emit('websocket-config', {
                    port: 4455,
                    password: 'screcorder123'
                });
            } else {
                throw new Error('OBS failed to start');
            }
        } catch (error) {
            this.logger.error('Failed to start OBS:', error);
            this.emit('status-update', { process: 'error', error: error.message });
        }
    }

    /**
     * Stop OBS process
     */
    async stopOBS() {
        if (!this.isRunning) {
            this.logger.log('OBS is not running');
            return;
        }

        this.logger.log('Stopping OBS...');

        if (this.obsProcess) {
            // Try graceful shutdown first
            this.obsProcess.kill('SIGTERM');
            
            // Wait for process to exit
            await new Promise(resolve => {
                const timeout = setTimeout(() => {
                    // Force kill if not exited
                    if (this.obsProcess) {
                        this.logger.log('Force killing OBS...');
                        this.obsProcess.kill('SIGKILL');
                    }
                    resolve();
                }, 5000);

                this.obsProcess.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }

        // Also kill by name to be sure
        await this.killExistingOBS();

        this.isRunning = false;
        this.obsProcess = null;

        this.emit('status-update', { process: 'stopped' });
    }

    /**
     * Restart OBS process
     */
    async restartOBS(config) {
        this.logger.log('Restarting OBS...');
        await this.stopOBS();
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.startOBS(config);
    }

    /**
     * Check if OBS is running
     */
    async isOBSRunning() {
        try {
            const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq obs64.exe" /FO CSV');
            return stdout.toLowerCase().includes('obs64.exe');
        } catch (error) {
            this.logger.error('Error checking OBS status:', error);
            return false;
        }
    }

    /**
     * Kill existing OBS processes
     */
    async killExistingOBS() {
        try {
            this.logger.log('Checking for existing OBS processes...');
            const isRunning = await this.isOBSRunning();
            
            if (isRunning) {
                this.logger.log('Killing existing OBS processes...');
                await execAsync('taskkill /F /IM obs64.exe');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            // Ignore errors - process might not exist
        }
    }

    /**
     * Check current status
     */
    async checkStatus() {
        const isRunning = await this.isOBSRunning();
        this.emit('status-update', { 
            process: isRunning ? 'running' : 'stopped' 
        });
    }

    /**
     * Shutdown manager
     */
    async shutdown() {
        this.logger.log('Shutting down manager...');
        this.shutdownRequested = true;
        await this.stopOBS();
        await super.shutdown();
    }
}

module.exports = OBSProcessManager;